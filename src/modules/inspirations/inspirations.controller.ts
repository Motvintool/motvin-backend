import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { createReadStream, existsSync, mkdirSync } from 'fs';
import { rename, stat } from 'fs/promises';
import { dirname, extname, join } from 'path';
import { appCardScreens } from './app-cards';
import { InspirationsService } from './inspirations.service';
import { InspirationScreen, LoaderService } from './loader.service';

const sharp: typeof import('sharp').default = require('sharp');

/**
 * Read-only API over data/inspirations.
 *
 * Image routes stream files that the manifest lists. A path that is not
 * published — including anything with traversal in it — simply misses the
 * allow-list and 404s.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** The most apps one /app-cards request answers for. */
const MAX_APP_CARDS = 100;

function splitList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const list = value.split(',').map((v) => v.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

@Controller('inspirations')
export class InspirationsController {
  constructor(
    private readonly service: InspirationsService,
    private readonly loader: LoaderService,
  ) {}

  // GET /api/inspirations/meta — counts + taxonomy, for tabs and filters.
  // `?platform=web` (or a comma list) narrows both to what exists there.
  @Get('meta')
  async getMeta(@Query('platform') platform?: string) {
    return { success: true, data: await this.service.getCounts(splitList(platform)) };
  }

  // GET /api/inspirations/screens
  @Get('screens')
  async getScreens(
    @Query('platform') platform?: string,
    @Query('type') type?: string,
    @Query('state') state?: string,
    @Query('industry') industry?: string,
    @Query('style') style?: string,
    @Query('element') element?: string,
    @Query('app') app?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: 'newest' | 'oldest' | 'app' | 'curated',
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    const data = await this.service.getScreens({
      platform: splitList(platform),
      screenType: splitList(type),
      state: splitList(state),
      industry: splitList(industry),
      style: splitList(style),
      element: splitList(element),
      app,
      q,
      sort,
      limit,
      offset,
    });
    return { success: true, data };
  }

  // GET /api/inspirations/site-screens?kind=page&type=pricing — every website's pages (or sections) of one type,
  // for a website's Z grid. Websites only: web apps and iOS screens are never in it.
  // With no type: every page (or section) — the Website pages page.
  @Get('site-screens')
  async getSiteScreens(@Query('kind') kind?: string, @Query('type') type?: string, @Query('limit') limit = 80) {
    const data = await this.service.getSiteScreens(kind === 'section' ? 'section' : 'page', type || '', Math.min(Number(limit) || 80, 1000));
    return { success: true, data };
  }

  // GET /api/inspirations/screen/:id
  @Get('screen/:id')
  async getScreen(@Param('id') id: string) {
    const data = await this.service.getScreen(id);
    if (!data) throw new NotFoundException(`Screen '${id}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/screen/:id/similar
  @Get('screen/:id/similar')
  async getSimilar(@Param('id') id: string, @Query('limit') limit = 12) {
    const data = await this.service.getSimilar(id, Math.min(Number(limit) || 12, 60));
    if (!data) throw new NotFoundException(`Screen '${id}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/screen/:id/analysis
  @Get('screen/:id/analysis')
  async getAnalysis(@Param('id') id: string) {
    const screen = await this.loader.getScreen(id);
    if (!screen) throw new NotFoundException(`Screen '${id}' not found`);
    const data = await this.service.getAnalysis(id);
    // A screen with no stored analysis is reported as such rather than
    // answered with invented findings.
    return { success: true, data, analyzed: Boolean(data) };
  }

  // GET /api/inspirations/apps
  @Get('apps')
  async getApps(@Query('industry') industry?: string, @Query('sort') sort?: 'newest' | 'oldest' | 'az' | 'rating') {
    return { success: true, data: await this.service.getApps(industry, sort) };
  }

  // GET /api/inspirations/app-cards?ids=a,b&platform=ios — the few screens
  // each app's grid card shows, keyed by app id: a grid's cards without every
  // app's full screen list. `platform` keeps each card to those platforms'
  // screens. Unknown ids are left out.
  @Get('app-cards')
  async getAppCards(@Query('ids') ids?: string, @Query('platform') platform?: string) {
    const wanted = new Set((splitList(ids) ?? []).slice(0, MAX_APP_CARDS));
    const platforms = splitList(platform);
    const byApp = new Map<string, InspirationScreen[]>();
    for (const screen of await this.loader.getScreens()) {
      if (!wanted.has(screen.appId) || (platforms && !platforms.includes(screen.platform))) continue;
      // A website's card shows its pages, not the parts cut out of them.
      if (screen.site?.kind === 'section') continue;
      const list = byApp.get(screen.appId);
      if (list) list.push(screen);
      else byApp.set(screen.appId, [screen]);
    }
    const data: Record<string, InspirationScreen[]> = {};
    for (const app of await this.loader.getApps()) {
      if (wanted.has(app.id)) data[app.id] = appCardScreens(app, byApp.get(app.id) ?? []);
    }
    return { success: true, data };
  }

  // GET /api/inspirations/app-facets?platform=ios — what each app holds on
  // those platforms, keyed by app id, for the apps Filters panel: its screen
  // types, UI elements, flow categories and styles. One small answer instead
  // of every app's full screen list.
  @Get('app-facets')
  async getAppFacets(@Query('platform') platform?: string) {
    const platforms = splitList(platform);
    const on = (p: string) => !platforms || platforms.includes(p);
    const facets = new Map<string, { screens: Set<string>; ui: Set<string>; flows: Set<string>; looks: Set<string> }>();
    const of = (appId: string) => {
      let f = facets.get(appId);
      if (!f) facets.set(appId, (f = { screens: new Set(), ui: new Set(), flows: new Set(), looks: new Set() }));
      return f;
    };
    // Library screens only: a website's pages are not screens, so they never give an app a screen type or a look.
    for (const s of await this.loader.getLibraryScreens()) {
      if (!on(s.platform)) continue;
      const f = of(s.appId);
      if (s.screenType !== 'other') f.screens.add(s.screenType);
      for (const e of s.elements ?? []) f.ui.add(e);
      for (const v of s.style ?? []) f.looks.add(v);
    }
    for (const flow of await this.loader.getFlows()) {
      if (on(flow.platform) && flow.category) of(flow.appId).flows.add(flow.category);
    }
    const data: Record<string, Record<'screens' | 'ui' | 'flows' | 'looks', string[]>> = {};
    for (const [appId, f] of facets) {
      data[appId] = { screens: [...f.screens], ui: [...f.ui], flows: [...f.flows], looks: [...f.looks] };
    }
    return { success: true, data };
  }

  // GET /api/inspirations/app/:slug
  @Get('app/:slug')
  async getApp(@Param('slug') slug: string) {
    const data = await this.service.getApp(slug);
    if (!data) throw new NotFoundException(`App '${slug}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/flows
  @Get('flows')
  async getFlows(@Query('category') category?: string, @Query('platform') platform?: string) {
    return { success: true, data: await this.service.getFlows(category, platform) };
  }

  // GET /api/inspirations/flow/:id
  @Get('flow/:id')
  async getFlow(@Param('id') id: string) {
    const data = await this.service.getFlow(id);
    if (!data) throw new NotFoundException(`Flow '${id}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/patterns
  @Get('patterns')
  async getPatterns(@Query('category') category?: string) {
    return { success: true, data: await this.service.getPatterns(category) };
  }

  // GET /api/inspirations/pattern/:slug
  @Get('pattern/:slug')
  async getPattern(@Param('slug') slug: string) {
    const data = await this.service.getPattern(slug);
    if (!data) throw new NotFoundException(`Pattern '${slug}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/elements
  // `?platform=ios` (or a comma list) counts only the screens on those platforms.
  @Get('elements')
  async getElements(@Query('platform') platform?: string) {
    return { success: true, data: await this.service.getElements(splitList(platform)) };
  }

  // GET /api/inspirations/search?q=
  @Get('search')
  async search(
    @Query('q') q = '',
    @Query('mode') mode?: string,
    @Query('limit') limit = 50,
    @Query('offset') offset = 0,
    @Query('appId') appId?: string,
    @Query('platform') platform?: string,
    @Query('type') type?: string,
    @Query('state') state?: string,
    @Query('industry') industry?: string,
    @Query('style') style?: string,
    @Query('element') element?: string,
    @Query('app') app?: string,
    @Query('literal') literal?: string,
  ) {
    const safeLimit = Math.min(Number(limit) || 50, 200);
    const safeOffset = Number(offset) || 0;
    const data = mode === 'text'
      ? await this.service.searchScreenshotText(q, safeLimit, safeOffset, appId || undefined)
      : await this.service.search(q, safeLimit, safeOffset, {
          platform: splitList(platform),
          screenType: splitList(type),
          state: splitList(state),
          industry: splitList(industry),
          style: splitList(style),
          element: splitList(element),
          apps: splitList(app),
        }, literal === '1' || literal === 'true');
    return { success: true, data };
  }

  // GET /api/inspirations/screens/:platform/:app/:file — the image bytes
  @Get('screens/:platform/:app/:file')
  async getScreenFile(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('file') file: string,
    @Query('download') download: string,
    @Res() reply: FastifyReply,
  ) {
    return this.sendFile(`screens/${platform}/${app}/${file}`, file, download === '1', reply);
  }

  /**
   * GET /api/inspirations/screens/:platform/:app/:flow/:file — the image bytes
   * for a screen stored inside a flow folder.
   *
   * Declared as its own route rather than a wildcard, because exactly one extra
   * level exists and naming it keeps the path a set of ordinary segments. The
   * real gate is the servable-file map, which is built from the manifest, so an
   * unpublished path cannot resolve either way.
   */
  @Get('screens/:platform/:app/:flow/:file')
  async getFlowScreenFile(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('flow') flow: string,
    @Param('file') file: string,
    @Query('download') download: string,
    @Res() reply: FastifyReply,
  ) {
    return this.sendFile(`screens/${platform}/${app}/${flow}/${file}`, file, download === '1', reply);
  }

  /**
   * GET /api/inspirations/screens/:platform/:app/versions/:version/:file —
   * a loose screen inside a dated version folder.
   */
  @Get('screens/:platform/:app/versions/:version/:file')
  async getVersionedScreenFile(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('version') version: string,
    @Param('file') file: string,
    @Query('download') download: string,
    @Res() reply: FastifyReply,
  ) {
    return this.sendFile(`screens/${platform}/${app}/versions/${version}/${file}`, file, download === '1', reply);
  }

  /**
   * GET /api/inspirations/screens/:platform/:app/versions/:version/:flow/:file
   * — a screen inside a flow folder inside a dated version folder.
   */
  @Get('screens/:platform/:app/versions/:version/:flow/:file')
  async getVersionedFlowScreenFile(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('version') version: string,
    @Param('flow') flow: string,
    @Param('file') file: string,
    @Query('download') download: string,
    @Query('cover') cover: string,
    @Res() reply: FastifyReply,
  ) {
    return this.sendFile(`screens/${platform}/${app}/versions/${version}/${flow}/${file}`, file, download === '1', reply, cover === '1');
  }

  // GET /api/inspirations/store/:platform/:app/:date/:file
  @Get('store/:platform/:app/:date/:file')
  async getStoreFile(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('date') date: string,
    @Param('file') file: string,
    @Res() reply: FastifyReply,
  ) {
    return this.sendFile(`store/${platform}/${app}/${date}/${file}`, file, false, reply);
  }

  // GET /api/inspirations/logos/:file
  @Get('logos/:file')
  async getLogoFile(@Param('file') file: string, @Res() reply: FastifyReply) {
    return this.sendFile(`logos/${file}`, file, false, reply);
  }

  private async sendFile(
    key: string,
    fileName: string,
    asDownload: boolean,
    reply: FastifyReply,
    cover = false,
  ) {
    let absolute = await this.loader.resolveServableFile(key);
    if (!absolute) {
      return reply.code(404).send({ success: false, error: 'Not found' });
    }
    // A website's whole page, for a card: only its top, as the card shows it. The page itself can be 16,000 px
    // tall; sent whole, every card that shows it makes the grid lag.
    if (cover && !asDownload && /^screens\/site\/[^/]+\/versions\/[^/]+\/pages\/[^/]+$/.test(key)) {
      absolute = (await pageCover(absolute).catch(() => null)) ?? absolute;
    }

    if (asDownload) {
      // Download is gated on the licence recorded for the app, not on the
      // request: view-only material is displayed but never handed over.
      const screenId = key.startsWith('screens/') ? this.screenIdForKey(key) : null;
      const screen = screenId ? await this.loader.getScreen(screenId) : null;
      if (!screen?.downloadable) {
        return reply.code(403).send({
          success: false,
          error: 'This screenshot is view-only under its recorded licence',
        });
      }
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    }

    let size: number;
    let mtime: Date;
    try {
      const info = await stat(absolute);
      size = info.size;
      mtime = info.mtime;
    } catch {
      return reply.code(404).send({ success: false, error: 'Not found' });
    }

    reply.header('Content-Type', CONTENT_TYPES[extname(absolute).toLowerCase()] || 'application/octet-stream');
    reply.header('Content-Length', size);
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
    reply.header('ETag', `"${size}-${mtime.getTime()}"`);
    return reply.send(createReadStream(absolute));
  }

  /**
   * screens/<platform>/<app>/<file>, screens/<platform>/<app>/<flow>/<file>,
   * or either shape again inside screens/<platform>/<app>/versions/<id>/… →
   * the screen id the build script assigned. Every segment after the app
   * becomes part of the id, exactly as manifest.builder.ts's `screenIdFor`
   * derives it, so this needs no separate case for a version folder.
   */
  private screenIdForKey(key: string): string | null {
    const parts = key.split('/');
    if (parts.length < 4) return null;
    const [, platform, app, ...rest] = parts;
    const file = rest.join('/');
    const base = file.replace(/\.[^.]+$/, '').split('/').join('-');
    return `${app}-${platform}-${base}`;
  }
}

/** How much of a page a cover keeps, as a share of its width (a card shows about 0.62 of it), and how wide it is. */
const COVER_HEIGHT_SHARE = 0.8;
const COVER_WIDTH = 1440;
const coversBeingMade = new Map<string, Promise<string>>();

/**
 * The top of a website page as a small picture, made once and kept beside the library (in cache/site-covers,
 * outside screens/, so it is never taken for a screen). A page changed on disk gets a new cover (its name
 * carries the page's size and time).
 */
async function pageCover(page: string): Promise<string> {
  const at = page.lastIndexOf('/screens/');
  if (at < 0) return page;
  const info = await stat(page);
  const rel = page.slice(at + '/screens/'.length).replace(/[^a-zA-Z0-9.-]+/g, '_');
  const out = join(page.slice(0, at), '..', 'cache', 'site-covers', `${rel}-${info.size}-${info.mtimeMs | 0}.webp`);
  if (existsSync(out)) return out;
  const making = coversBeingMade.get(out);
  if (making) return making;
  const job = (async () => {
    mkdirSync(dirname(out), { recursive: true });
    const meta = await sharp(page, { limitInputPixels: false }).metadata();
    const width = meta.width || 0; const height = meta.height || 0;
    if (!width || !height) return page;
    const keep = Math.min(height, Math.round(width * COVER_HEIGHT_SHARE));
    const temp = `${out}.part`;
    await sharp(page, { limitInputPixels: false }).extract({ left: 0, top: 0, width, height: keep })
      .resize({ width: Math.min(width, COVER_WIDTH) }).webp({ quality: 82 }).toFile(temp);
    await rename(temp, out);
    return out;
  })().finally(() => coversBeingMade.delete(out));
  coversBeingMade.set(out, job);
  return job;
}
