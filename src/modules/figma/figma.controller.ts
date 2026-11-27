import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InspirationsService } from '../inspirations/inspirations.service';
import { InspirationApp, InspirationFlow, InspirationScreen, LoaderService } from '../inspirations/loader.service';
import { countBy, LibrarySearchService, PLATFORMS, type Platform } from '../mcp/library-search.service';
import { McpOAuthService, OAuthError, type McpIdentity } from '../mcp/mcp-oauth.service';
import { McpRateLimitService, waitText } from '../mcp/mcp-rate-limit.service';
import { McpUsageService } from '../mcp/mcp-usage.service';
import { ScreenPreviewService } from '../mcp/screen-preview.service';
import { FigmaImageService, rendition } from './figma-image.service';
import { FigmaPairingService, KEY_PATTERN, PAIR_PATTERN, pairCode } from './figma-pairing.service';

/**
 * The API behind "Motvin — Inspiration", the Figma plugin.
 *
 *   POST /api/figma/pair/approve   motvin.com/figma/connect, after the person clicks Allow
 *   POST /api/figma/pair/claim     the plugin, waiting for that approval
 *   GET  /api/figma/meta           filter values on one platform
 *   GET  /api/figma/apps           apps on one platform, for the app filter
 *   GET  /api/figma/screens        search or browse screens on one platform
 *   GET  /api/figma/flows          search or browse flows on one platform
 *   GET  /api/figma/flow/:id       one flow, step by step
 *   GET  /api/figma/thumb/:id      a small JPEG for the results grid
 *   GET  /api/figma/image/:id      the JPEG that goes on the canvas, in parts
 *
 * Browsing — meta, apps, screens, flows, thumbnails — works signed out, so
 * the plugin opens straight onto the library; signed out, it is limited per
 * address. Putting a screen on the canvas (image) needs the plugin's access
 * token (Authorization: Bearer), an ordinary Motvin MCP access token:
 * refreshed at /api/mcp/oauth/token and revoked at /api/mcp/oauth/revoke. A
 * token that is sent but no longer valid is a 401 everywhere, so the plugin
 * knows to refresh it. Searches run
 * through the same LibrarySearchService as the MCP tools, so the plugin ranks
 * screens exactly as Claude sees them, and every list holds one platform —
 * iOS, Web Apps and Sites never mix.
 */

/** The plugin's OAuth client id: its refresh requests must name it. */
export const FIGMA_CLIENT_ID = 'motvin-figma-inspiration';
const FIGMA_CLIENT_NAME = 'Figma — Motvin Inspiration';

const PAGE = { default: 24, max: 60 };

/** An unauthenticated or refused request, answered with its status and message. */
class FigmaError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** The caller's address: Cloudflare's, which the client cannot forge, else Fastify's view. */
function address(request: FastifyRequest): string {
  return (request.headers['cf-connecting-ip'] as string) || request.ip || 'unknown';
}

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function platformOf(value: unknown): Platform {
  if (typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)) return value as Platform;
  throw new FigmaError(400, 'platform must be "ios", "webapp" or "site"');
}

function pageArgs(offset?: string, limit?: string) {
  return {
    offset: Math.max(0, Number(offset) || 0),
    limit: Math.min(Math.max(1, Number(limit) || PAGE.default), PAGE.max),
  };
}

/** `apps=a,b` — several apps at once (the panel's colour filter); undefined when not asked, [] when asked for none. */
function appList(value?: string): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  return value.split(',').map((id) => id.trim()).filter(Boolean).slice(0, 200);
}

const clean = (value?: string) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

@Controller('figma')
export class FigmaController {
  private readonly siteUrl: string;

  constructor(
    config: ConfigService,
    private readonly oauth: McpOAuthService,
    private readonly pairing: FigmaPairingService,
    private readonly search: LibrarySearchService,
    private readonly inspirations: InspirationsService,
    private readonly loader: LoaderService,
    private readonly previews: ScreenPreviewService,
    private readonly images: FigmaImageService,
    private readonly limits: McpRateLimitService,
    private readonly usage: McpUsageService,
  ) {
    this.siteUrl = config.get<string>('mcp.siteUrl');
  }

  // ──────────────────────────────────────────────────────────────── sign-in

  /** What the connect page shows: the code to compare with the plugin's. */
  @Post('pair/approve')
  @HttpCode(200)
  approve(@Body() body: { pair?: string; idToken?: string }, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      this.takeAddress(reply.request);
      if (typeof body?.pair !== 'string' || !PAIR_PATTERN.test(body.pair)) {
        throw new FigmaError(400, 'This sign-in link is not complete — open it again from the plugin.');
      }
      const tokens = await this.oauth.connectFirstParty(body.idToken ?? '', FIGMA_CLIENT_ID, FIGMA_CLIENT_NAME);
      this.pairing.park(body.pair, tokens);
      return { code: pairCode(body.pair), email: tokens.email };
    });
  }

  /** The plugin's question every few seconds: approved yet? */
  @Post('pair/claim')
  @HttpCode(200)
  claim(@Body() body: { key?: string }, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      if (typeof body?.key !== 'string' || !KEY_PATTERN.test(body.key)) throw new FigmaError(400, 'key must be 64 hex characters');
      const tokens = this.pairing.claim(body.key);
      if (!tokens) return { status: 'waiting' };
      const { email, ...rest } = tokens;
      return { status: 'ready', email, client_id: FIGMA_CLIENT_ID, ...rest };
    });
  }

  // ─────────────────────────────────────────────────────────────── library

  @Get('meta')
  meta(@Query('platform') platform: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const on = platformOf(platform);
      this.take(request, 'figma_meta');
      if (on === 'site') {
        const [pages, sections] = await Promise.all([this.inspirations.getSiteScreens('page', '', 10000), this.inspirations.getSiteScreens('section', '', 10000)]);
        const apps = await this.search.appIndex();
        const industries = new Set([...pages, ...sections].map((screen) => apps.get(screen.appId.toLowerCase())?.industry).filter(Boolean) as string[]);
        return {
          platform: on,
          // A site's page or section type is what it is, the way a screen type is for an app screen.
          screen_types: [...new Set([...countBy(pages.map((s) => s.site?.pageType ?? 'other')), ...countBy(sections.map((s) => s.site?.sectionType ?? 'content'))].map(([type]) => type))],
          industries: [...industries].sort(),
          states: [],
          styles: [],
          elements: [],
          flow_categories: [],
        };
      }
      const meta = await this.inspirations.getCounts([on]);
      return {
        platform: on,
        screen_types: meta.taxonomy.screenTypes,
        industries: meta.taxonomy.industries,
        states: meta.taxonomy.states,
        styles: meta.taxonomy.styles,
        elements: meta.taxonomy.elements,
        flow_categories: meta.taxonomy.flowCategories,
      };
    });
  }

  @Get('apps')
  apps(@Query('platform') platform: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const on = platformOf(platform);
      this.take(request, 'figma_apps');
      const onPlatform = await this.appIdsOn(on);
      const apps = (await this.loader.getApps()).filter((app) => onPlatform.has(app.id));
      return apps.map((app) => ({ id: app.id, slug: app.slug, name: app.name, logo: app.logo ?? null })).sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  @Get('screens')
  screens(
    @Query() query: Record<string, string>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.respond(reply, async () => {
      const on = platformOf(query.platform);
      this.take(request, 'figma_search_screens', clean(query.q) ?? null);
      const apps = await this.search.appIndex();
      const app = await this.appFor(query.app, apps, on);
      const some = appList(query.apps);
      const { offset, limit } = pageArgs(query.offset, query.limit);
      const q = clean(query.q) ?? '';
      // A colour with no app on this platform: nothing to show, rather than everything.
      if (some && !some.length) return { platform: on, total: 0, next_offset: null, screens: [] };

      if (on === 'site') {
        const found = await this.search.sitePages({ query: q, screen_type: clean(query.type), industry: clean(query.industry), app, apps: some, offset, limit }, apps);
        return { platform: on, total: found.total, next_offset: found.nextOffset, screens: found.screens.map((s) => this.screenItem(s, apps)) };
      }
      const filters = {
        screen_type: clean(query.type),
        state: clean(query.state),
        industry: clean(query.industry),
        style: clean(query.style),
        element: clean(query.element),
      };
      if (!q) {
        // Browsing, nothing typed yet: the library's own curated order, as motvin.com shows it.
        const page = await this.inspirations.getScreens({
          platform: [on],
          screenType: filters.screen_type ? [filters.screen_type] : undefined,
          state: filters.state ? [filters.state] : undefined,
          industry: filters.industry ? [filters.industry] : undefined,
          style: filters.style ? [filters.style] : undefined,
          element: filters.element ? [filters.element] : undefined,
          app: app?.id ?? some?.join(','),
          sort: 'curated',
          limit,
          offset,
        });
        const items = page.items.filter((screen) => screen.platform === on);
        return { platform: on, total: page.total, next_offset: page.nextOffset ?? null, screens: items.map((s) => this.screenItem(s, apps)) };
      }
      const found = await this.search.screens({ query: q, platform: on, ...filters, app, apps: some, offset, limit });
      return { platform: on, total: found.total, next_offset: found.nextOffset, screens: found.screens.map((s) => this.screenItem(s, apps)) };
    });
  }

  @Get('flows')
  flows(@Query() query: Record<string, string>, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const on = platformOf(query.platform);
      if (on === 'site') throw new FigmaError(400, 'Sites have no flows: they are kept as whole pages and their sections.');
      this.take(request, 'figma_search_flows', clean(query.q) ?? null);
      const apps = await this.search.appIndex();
      const app = await this.appFor(query.app, apps, on);
      const { offset, limit } = pageArgs(query.offset, query.limit);
      const some = appList(query.apps);
      const flows = some && !some.length ? [] : (await this.search.flows({ query: clean(query.q), platform: on, category: clean(query.category), app, apps: some }, apps)).filter((flow) => flow.platform === on);
      const page = flows.slice(offset, offset + limit);
      return {
        platform: on,
        total: flows.length,
        next_offset: offset + page.length < flows.length ? offset + page.length : null,
        flows: page.map((flow) => this.flowItem(flow, apps)),
      };
    });
  }

  @Get('flow/:id')
  flow(@Param('id') id: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      this.take(request, 'figma_get_flow');
      const found = await this.inspirations.getFlow(id);
      if (!found) throw new FigmaError(404, 'That flow is no longer in the library.');
      const apps = await this.search.appIndex();
      // The flow's own platform only: a step from another platform never rides along.
      const screens = found.screens.filter((screen) => screen.platform === found.flow.platform);
      return {
        flow: this.flowItem(found.flow, apps),
        steps: screens.map((screen, index) => ({
          position: index + 1,
          action: found.flow.steps?.find((step) => step.screenId === screen.id)?.action ?? null,
          ...this.screenItem(screen, apps),
        })),
      };
    });
  }

  /** Screens by id, for a "Copy to Figma" code pasted into the plugin. One platform, or nothing. */
  @Get('resolve')
  resolve(@Query('platform') platform: string, @Query('ids') ids: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const on = platformOf(platform);
      this.take(request, 'figma_resolve');
      const wanted = (ids || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 100);
      const apps = await this.search.appIndex();
      const screens = (await this.inspirations.resolveScreens(wanted)).filter((screen) => screen.platform === on);
      return { platform: on, screens: screens.map((s) => this.screenItem(s, apps)), missing: wanted.length - screens.length };
    });
  }

  // ──────────────────────────────────────────────────────────────── images

  @Get('thumb/:id')
  thumb(@Param('id') id: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respondImage(reply, async () => {
      // A small preview, as motvin.com shows signed out: only a token that is sent must be good.
      if (bearer(request)) this.identify(request);
      const screen = await this.loader.getScreen(id);
      if (!screen) throw new FigmaError(404, 'Screen not found');
      return this.previews.jpeg(screen, screen.platform === 'ios' ? 360 : 576);
    });
  }

  @Get('image/:id')
  image(@Param('id') id: string, @Query('part') part: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respondImage(reply, async () => {
      this.identify(request);
      const screen = await this.loader.getScreen(id);
      if (!screen) throw new FigmaError(404, 'Screen not found');
      return this.images.part(screen, Number(part ?? 0));
    });
  }

  // ─────────────────────────────────────────────────────────────── helpers

  private screenItem(screen: InspirationScreen, apps: Map<string, InspirationApp>) {
    const app = apps.get(screen.appId.toLowerCase());
    const site = screen.site;
    return {
      id: screen.id,
      name: screen.name,
      app: this.appRef(app, screen.appId),
      platform: screen.platform,
      // A site's page or section says which: "pricing page", "hero section".
      screen_type: site ? (site.kind === 'section' ? `${site.sectionType ?? 'content'} section` : `${site.pageType ?? 'other'} page`) : screen.screenType,
      states: screen.states ?? [],
      description: screen.description ?? null,
      page_url: site
        ? `${this.siteUrl}/inspirations/app/${encodeURIComponent(app?.slug ?? screen.appId)}?screen=${encodeURIComponent(screen.id)}`
        : `${this.siteUrl}/inspirations/screens?screen=${encodeURIComponent(screen.id)}`,
      attribution: screen.source?.attribution ?? app?.attribution ?? null,
      image: rendition(screen),
    };
  }

  private flowItem(flow: InspirationFlow, apps: Map<string, InspirationApp>) {
    const app = apps.get(flow.appId.toLowerCase());
    return {
      id: flow.id,
      name: flow.name,
      app: this.appRef(app, flow.appId),
      platform: flow.platform,
      category: flow.category,
      summary: flow.summary ?? null,
      steps: flow.screenIds.length,
      cover_id: flow.screenIds[0] ?? null,
      page_url: `${this.siteUrl}/inspirations/flows?flow=${encodeURIComponent(flow.id)}`,
    };
  }

  /** An app as results name it; `logo` is a public image path on this API, for the panel to show beside the name. */
  private appRef(app: InspirationApp | undefined, id: string) {
    return app ? { id: app.id, name: app.name, slug: app.slug, logo: app.logo ?? null } : { id, name: id, slug: id, logo: null };
  }

  /** An app named in a filter, on the platform being searched; unknown or elsewhere is an error, not a silent mix. */
  private async appFor(value: string | undefined, apps: Map<string, InspirationApp>, on: Platform): Promise<InspirationApp | undefined> {
    const wanted = clean(value);
    if (!wanted) return undefined;
    const app = apps.get(wanted.toLowerCase());
    if (!app || !(await this.appIdsOn(on)).has(app.id)) throw new FigmaError(404, `"${wanted}" has nothing on this platform.`);
    return app;
  }

  /** The apps that have something on this platform. A site is an app whose website pages are kept; its `platforms` never says so. */
  private async appIdsOn(on: Platform): Promise<Set<string>> {
    if (on === 'site') return new Set((await this.inspirations.getSiteScreens('page', '', 10000)).map((screen) => screen.appId));
    return new Set((await this.loader.getApps()).filter((app) => app.platforms?.includes(on)).map((app) => app.id));
  }

  private identify(request: FastifyRequest): McpIdentity {
    if (!this.oauth.isConfigured) throw new FigmaError(503, 'Sign-in is not set up on this server.');
    const identity = this.oauth.verifyAccessToken(bearer(request));
    if (!identity) throw new FigmaError(401, 'Sign in again — your Motvin session has ended.');
    return identity;
  }

  /**
   * A browsing call. Signed in, it is charged to the person's call budget,
   * shared with their AI tools, and counted in usage under the plugin's name.
   * Signed out (no token at all), it is charged to the caller's address.
   */
  private take(request: FastifyRequest, tool: string, query: string | null = null): McpIdentity | null {
    if (!bearer(request)) {
      const limit = this.limits.takeCall(`figma-ip:${address(request)}`);
      if (!limit.ok) throw new FigmaError(429, `Too many searches — sign in, or try again ${waitText(limit.retryAfter)}.`, limit.retryAfter);
      return null;
    }
    const identity = this.identify(request);
    const limit = this.limits.takeCall(identity.uid);
    const record = (outcome: 'ok' | 'rate_limited') => this.usage.recordCall({ uid: identity.uid, client: identity.clientName, tool, query, outcome });
    if (!limit.ok) {
      record('rate_limited');
      throw new FigmaError(429, `Too many searches — try again ${waitText(limit.retryAfter)}.`, limit.retryAfter);
    }
    record('ok');
    if (identity.connectionId) this.oauth.connections.countCall(identity.connectionId);
    return identity;
  }

  /** Approving needs no token yet, so it is limited by address, like the OAuth endpoints. */
  private takeAddress(request: FastifyRequest) {
    const limit = this.limits.takeOAuth(address(request));
    if (!limit.ok) throw new FigmaError(429, `Too many requests — try again ${waitText(limit.retryAfter)}.`, limit.retryAfter);
  }

  private async respond(reply: FastifyReply, run: () => Promise<unknown>) {
    try {
      const data = await run();
      return reply.header('Cache-Control', 'no-store').send({ success: true, data });
    } catch (error) {
      return this.fail(reply, error);
    }
  }

  private async respondImage(reply: FastifyReply, run: () => Promise<Buffer | null>) {
    try {
      const buffer = await run();
      if (!buffer) throw new FigmaError(404, 'Image not found');
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=3600').send(buffer);
    } catch (error) {
      return this.fail(reply, error);
    }
  }

  private fail(reply: FastifyReply, error: unknown) {
    if (error instanceof FigmaError) {
      if (error.retryAfter) reply.header('Retry-After', String(error.retryAfter));
      return reply.code(error.status).send({ success: false, message: error.message });
    }
    if (error instanceof OAuthError) return reply.code(error.status).send({ success: false, message: error.description });
    const status = (error as { getStatus?: () => number }).getStatus?.();
    // The Firebase verifier throws Nest's 401/503: say so plainly instead of a stack trace.
    if (status) return reply.code(status).send({ success: false, message: status === 401 ? 'Your sign-in could not be verified — sign in again.' : (error as Error).message });
    throw error;
  }
}
