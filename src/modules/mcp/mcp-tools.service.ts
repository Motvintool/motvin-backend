import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { InspirationsService } from '../inspirations/inspirations.service';
import {
  InspirationApp,
  InspirationFlow,
  InspirationScreen,
  LoaderService,
} from '../inspirations/loader.service';
import { McpOAuthService, type McpIdentity } from './mcp-oauth.service';
import { appCount, arrange, diversify } from './mcp-ranking';
import { McpRateLimitService, waitText } from './mcp-rate-limit.service';
import { McpUsageService } from './mcp-usage.service';
import { PREVIEW_MIME, ScreenPreviewService } from './screen-preview.service';

/**
 * The tools an AI client gets from Motvin's MCP server.
 *
 * Every tool reads through InspirationsService, so search ranks exactly as it
 * does on motvin.com, and nothing here invents content: an empty store yields
 * empty results. Two rules shape the tool surface:
 *
 * 1. Platforms never mix. iOS, Web Apps and Webs are separate libraries, so
 *    every search names one platform and every result list holds one
 *    platform. Comparing platforms means calling once per platform.
 *
 * 2. Licences are respected. A screen whose licence is view-only gets a small
 *    inline preview (looking is allowed) but no full-resolution `image_url`,
 *    mirroring the 403 the download route returns.
 */

export const PLATFORMS = ['ios', 'webapp', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];
const PLATFORM_LABEL: Record<Platform, string> = { ios: 'iOS', webapp: 'Web Apps', web: 'Webs' };

/** Result sizes, chosen so a reply stays well under a megabyte with previews on. */
const LIMITS = {
  defaultScreens: 10,
  maxScreens: 24,
  /** Previews attached per result list; further items are text only. */
  images: 8,
  defaultFlows: 8,
  maxFlows: 20,
  /** Flows that get step previews, and steps per flow. */
  flowImages: 4,
  flowSteps: 3,
  previewWidth: 360,
  detailWidth: 720,
  textChars: 1500,
};

const INSTRUCTIONS = `Motvin is a library of real product UI: screens and multi-step flows captured from shipped apps, organised by platform.
Three platforms never mix — "ios" (iPhone apps), "webapp" (signed-in web applications) and "web" (marketing websites). Every search names one platform; to compare platforms, call once per platform.
Start with search_screens to look at individual screens, search_flows for step-by-step journeys, and get_taxonomy for the exact filter values. Results carry a small preview you can look at; image_url is the full-resolution file (present only when the licence allows download) and page_url opens the screen on motvin.com. Name the app when you describe a pattern you saw.`;

type Content = CallToolResult['content'][number];
type ToolResult = CallToolResult;

const platformSchema = z
  .enum(PLATFORMS)
  .describe('Which library: "ios" (iPhone apps), "webapp" (signed-in web applications) or "web" (marketing websites). Results never mix platforms.');

const text = (value: string): Content => ({ type: 'text', text: value });

function describeFilters(filters: Record<string, string | undefined>): string {
  const parts = Object.entries(filters)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`);
  return parts.length ? ` with ${parts.join(', ')}` : '';
}

function topEntries(tally: Record<string, number> | undefined, count: number): [string, number][] {
  return Object.entries(tally ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);
}

function clip(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

@Injectable()
export class McpToolsService {
  private readonly logger = new Logger(McpToolsService.name);
  private readonly apiUrl: string;
  private readonly siteUrl: string;
  /**
   * Who the running tool call belongs to, so the one helper that makes
   * previews (image) can charge them to that person's preview budget without
   * threading the identity through every tool.
   */
  private readonly call = new AsyncLocalStorage<{ uid: string; previewsSkipped: boolean; retryAfter: number }>();

  constructor(
    config: ConfigService,
    private readonly inspirations: InspirationsService,
    private readonly loader: LoaderService,
    private readonly previews: ScreenPreviewService,
    private readonly limits: McpRateLimitService,
    private readonly usage: McpUsageService,
    private readonly oauth: McpOAuthService,
  ) {
    this.apiUrl = config.get<string>('mcp.issuer');
    this.siteUrl = config.get<string>('mcp.siteUrl');
  }

  /** A server with every tool registered, bound to the person calling. */
  createServer(identity: McpIdentity): McpServer {
    // title, websiteUrl and icons let tools such as VS Code show "Motvin" with its logo.
    const server = new McpServer(
      {
        name: 'motvin',
        title: 'Motvin',
        version: '1.0.0',
        websiteUrl: this.siteUrl,
        icons: [{ src: `${this.siteUrl}/apple-touch-icon.png`, mimeType: 'image/png', sizes: ['180x180'] }],
      },
      { instructions: INSTRUCTIONS },
    );
    this.registerSearchScreens(server, identity);
    this.registerSearchFlows(server, identity);
    this.registerSearchScreenText(server, identity);
    this.registerGetScreen(server, identity);
    this.registerFindSimilar(server, identity);
    this.registerGetFlow(server, identity);
    this.registerListApps(server, identity);
    this.registerGetApp(server, identity);
    this.registerListPatterns(server, identity);
    this.registerGetPattern(server, identity);
    this.registerGetTaxonomy(server, identity);
    return server;
  }

  // ───────────────────────────────────────────────────────────────── search

  private registerSearchScreens(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'search_screens',
      {
        title: 'Search screens',
        description:
          'Find UI screens in the Motvin library by describing what you want in plain words, e.g. "paywall with annual toggle", "empty cart", "fintech onboarding". Returns ranked screens with a preview image each, mixed across apps (every app\u2019s best match first, then every app\u2019s next, near-copies last; set app to look inside one app), plus the screen types among the matches so you can narrow down. One platform per call.',
        inputSchema: {
          query: z.string().min(1).describe('What you are looking for, in plain words.'),
          platform: platformSchema,
          screen_type: z.string().optional().describe('One screen type from get_taxonomy, e.g. "login", "pricing", "checkout".'),
          state: z.string().optional().describe('A state from get_taxonomy, e.g. "empty", "loading", "modal", "bottom-sheet".'),
          industry: z.string().optional().describe('An industry from get_taxonomy, e.g. "saas", "travel", "healthcare".'),
          style: z.string().optional().describe('A visual style from get_taxonomy: "minimal", "bold", "dark", "light".'),
          element: z.string().optional().describe('A UI element the screen must contain, from get_taxonomy, e.g. "tab-bar", "stepper", "toast".'),
          app: z.string().optional().describe('An app id or slug from list_apps, to search inside one app.'),
          limit: z.number().int().min(1).max(LIMITS.maxScreens).default(LIMITS.defaultScreens),
          offset: z.number().int().min(0).default(0).describe('For the next page: the next_offset of the previous result.'),
          include_images: z.boolean().default(true).describe(`Attach a preview of the first ${LIMITS.images} screens. Turn off for a fast text-only list.`),
        },
      },
      async (args) => {
        const apps = await this.appIndex();
        const app = args.app ? apps.get(args.app.toLowerCase()) : undefined;
        if (args.app && !app) return this.fail(`Unknown app "${args.app}". list_apps gives the ids.`);

        const filters = {
          platform: [args.platform],
          screenType: args.screen_type ? [args.screen_type] : undefined,
          state: args.state ? [args.state] : undefined,
          industry: args.industry ? [args.industry] : undefined,
          style: args.style ? [args.style] : undefined,
          element: args.element ? [args.element] : undefined,
          apps: app ? [app.id] : undefined,
        };
        // The search supplies the counts beside the screens; the screens themselves come
        // scored, whole, so the ordering (mcp-ranking.ts) is the same on every page.
        const [result, scored] = await Promise.all([
          this.inspirations.search(args.query, 0, 0, filters),
          this.inspirations.rankedScreens(args.query, filters),
        ]);
        const onPlatform = scored.filter((r) => r.screen.platform === args.platform);
        const ranked = arrange(onPlatform, args.query, app ? Infinity : 1);
        const screens = ranked.slice(args.offset, args.offset + args.limit);
        const items = screens.map((screen) => this.screenItem(screen, apps));
        const label = PLATFORM_LABEL[args.platform];
        const described = describeFilters({
          screen_type: args.screen_type,
          state: args.state,
          industry: args.industry,
          style: args.style,
          element: args.element,
          app: app?.name,
        });
        const types = topEntries(result.facets?.screenTypes, 8);

        const lines: string[] = [];
        if (!screens.length) {
          lines.push(`No ${label} screens match "${args.query}"${described}. Try fewer filters or other words — or another platform, one call each.`);
        } else {
          lines.push(
            `${ranked.length} ${label} screens match "${args.query}"${described}. Showing ${args.offset + 1}–${args.offset + screens.length}, from ${appCount(screens)}.`,
          );
          if (types.length) lines.push(`Screen types among the matches: ${types.map(([type, count]) => `${type} (${count})`).join(', ')}.`);
          if (result.flows.length) lines.push(`${result.flows.length} ${label} flows also match — search_flows shows them step by step.`);
        }

        const content: Content[] = [text(lines.join('\n'))];
        await this.appendScreens(content, screens, items, args.include_images, LIMITS.previewWidth);
        const nextOffset = args.offset + screens.length < ranked.length ? args.offset + screens.length : null;
        return {
          content,
          structuredContent: {
            platform: args.platform,
            query: args.query,
            total: ranked.length,
            offset: args.offset,
            next_offset: nextOffset,
            screens: items,
            screen_types: Object.fromEntries(types),
            matched_apps: result.apps.slice(0, 10).map((a) => ({ id: a.id, name: a.name, slug: a.slug })),
            matched_flows: result.flows.length,
          },
        };
      },
    );
  }

  private registerSearchFlows(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'search_flows',
      {
        title: 'Search flows',
        description:
          'Find multi-step user journeys — onboarding, checkout, sign-up, creating something — recorded screen by screen from real apps. Each flow lists its steps; the first few flows come with previews of their opening screens. One platform per call. Use get_flow for every step of one flow.',
        inputSchema: {
          query: z.string().optional().describe('What the journey is about, e.g. "checkout with saved card", "onboarding", "cancel subscription". Leave empty to browse by category.'),
          platform: platformSchema,
          category: z.string().optional().describe('A flow category from get_taxonomy: authentication, checkout, creation, discovery, onboarding, search, settings.'),
          app: z.string().optional().describe('An app id or slug from list_apps.'),
          limit: z.number().int().min(1).max(LIMITS.maxFlows).default(LIMITS.defaultFlows),
          include_images: z.boolean().default(true).describe(`Attach previews of the first ${LIMITS.flowSteps} steps of the first ${LIMITS.flowImages} flows.`),
        },
      },
      async (args) => {
        const apps = await this.appIndex();
        const app = args.app ? apps.get(args.app.toLowerCase()) : undefined;
        if (args.app && !app) return this.fail(`Unknown app "${args.app}". list_apps gives the ids.`);

        let flows = await this.inspirations.getFlows(args.category, args.platform);
        if (app) flows = flows.filter((flow) => flow.appId === app.id);

        const query = (args.query ?? '').trim();
        if (query) {
          const matched = await this.inspirations.search(query, 1, 0, { platform: [args.platform], apps: app ? [app.id] : undefined });
          const byScreens = new Set(matched.flows.map((flow) => flow.id));
          const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
          const byWords = (flow: InspirationFlow) => {
            const hay = `${flow.name} ${flow.kind ?? ''} ${flow.category} ${flow.summary ?? ''} ${apps.get(flow.appId)?.name ?? ''}`.toLowerCase();
            return terms.every((term) => hay.includes(term));
          };
          flows = [...flows.filter((flow) => byScreens.has(flow.id)), ...flows.filter((flow) => !byScreens.has(flow.id) && byWords(flow))];
        }

        const total = flows.length;
        const page = flows.slice(0, args.limit);
        const items = page.map((flow) => this.flowItem(flow, apps));
        const label = PLATFORM_LABEL[args.platform];
        const filters = describeFilters({ category: args.category, app: app?.name });

        const lines: string[] = [];
        if (!page.length) {
          lines.push(`No ${label} flows${query ? ` match "${query}"` : ''}${filters}. Try other words, drop the category, or another platform (one call each).`);
        } else {
          lines.push(`${total} ${label} flows${query ? ` match "${query}"` : ''}${filters}. Showing ${page.length}.`);
        }

        const content: Content[] = [text(lines.join('\n'))];
        for (const [index, flow] of page.entries()) {
          const item = items[index];
          content.push(
            text(
              [
                `${index + 1}. ${item.app.name} — ${item.name} (${item.category}${item.kind ? `, ${item.kind}` : ''}; ${item.steps} steps)`,
                item.summary ? `   ${item.summary}` : null,
                `   id: ${item.id}`,
                `   page: ${item.page_url}`,
              ]
                .filter(Boolean)
                .join('\n'),
            ),
          );
          if (args.include_images && index < LIMITS.flowImages) {
            const screens = this.onPlatform(await this.inspirations.resolveScreens(flow.screenIds.slice(0, LIMITS.flowSteps)), args.platform);
            for (const [step, screen] of screens.entries()) {
              const image = await this.image(screen, LIMITS.previewWidth);
              if (image) {
                content.push(text(`   step ${step + 1}: ${screen.name} (${screen.screenType})`));
                content.push(image);
              }
            }
          }
        }
        return { content, structuredContent: { platform: args.platform, query: query || null, total, flows: items } };
      },
    );
  }

  private registerSearchScreenText(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'search_screen_text',
      {
        title: 'Search text on screens',
        description:
          'Find screens by the words printed on them — microcopy, button labels, headlines — e.g. "cancel anytime", "no credit card required", "verify your identity". Exact phrase, case-insensitive. One platform per call.',
        inputSchema: {
          query: z.string().min(2).describe('The phrase to look for on the screen.'),
          platform: platformSchema,
          app: z.string().optional().describe('An app id or slug from list_apps.'),
          limit: z.number().int().min(1).max(LIMITS.maxScreens).default(LIMITS.defaultScreens),
          include_images: z.boolean().default(true),
        },
      },
      async (args) => {
        const apps = await this.appIndex();
        const app = args.app ? apps.get(args.app.toLowerCase()) : undefined;
        if (args.app && !app) return this.fail(`Unknown app "${args.app}". list_apps gives the ids.`);

        // The text search is not platform-aware, so it is asked for a generous page and narrowed here.
        const result = await this.inspirations.searchScreenshotText(args.query, 200, 0, app?.id);
        // Every hit matches the phrase equally, so the ordering alone decides who comes first.
        const onPlatform = arrange(
          this.onPlatform(result.screens, args.platform).map((screen) => ({ screen, score: 1 })),
          args.query,
          app ? Infinity : 1,
        );
        const screens = onPlatform.slice(0, args.limit);
        const items = screens.map((screen) => this.screenItem(screen, apps));
        const label = PLATFORM_LABEL[args.platform];

        const content: Content[] = [
          text(
            screens.length
              ? `${onPlatform.length} ${label} screens show the text "${args.query}"${app ? ` in ${app.name}` : ''}. Showing ${screens.length}, from ${appCount(screens)}.`
              : `No ${label} screens show the text "${args.query}"${app ? ` in ${app.name}` : ''}. Try a shorter phrase.`,
          ),
        ];
        await this.appendScreens(content, screens, items, args.include_images, LIMITS.previewWidth);
        return { content, structuredContent: { platform: args.platform, query: args.query, total: onPlatform.length, screens: items } };
      },
    );
  }

  // ──────────────────────────────────────────────────────────────── details

  private registerGetScreen(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'get_screen',
      {
        title: 'Get a screen',
        description:
          'Everything recorded about one screen: a larger preview, its description and purpose, the UI elements on it, the text printed on it, and the flows and patterns it appears in. Use the id from a search result.',
        inputSchema: {
          screen_id: z.string().min(1),
          include_image: z.boolean().default(true),
        },
      },
      async (args) => {
        const found = await this.inspirations.getScreen(args.screen_id);
        if (!found) return this.fail(`No screen with id "${args.screen_id}".`);
        const apps = await this.appIndex();
        const item = this.screenItem(found.screen, apps);
        const analysis = await this.inspirations.getAnalysis(found.screen.id);
        const onScreen = clip(typeof analysis?.text === 'string' ? analysis.text.replace(/\s+/g, ' ').trim() : null, LIMITS.textChars);

        const lines = [
          `${item.app.name} — ${item.name} · ${PLATFORM_LABEL[item.platform as Platform] ?? item.platform} · ${item.screen_type}${item.states.length ? ` (${item.states.join(', ')})` : ''}`,
          item.description,
          item.purpose ? `Purpose: ${item.purpose}` : null,
          item.primary_action ? `Primary action: ${item.primary_action}` : null,
          item.elements.length ? `Elements: ${item.elements.join(', ')}` : null,
          item.style.length ? `Style: ${item.style.join(', ')}` : null,
          `Industry: ${item.industry}${item.captured_at ? ` · captured ${item.captured_at}` : ''}`,
          found.flows.length ? `In flows: ${found.flows.map((flow) => `${flow.name} (${flow.id})`).join('; ')}` : null,
          found.patterns.length ? `In patterns: ${found.patterns.map((pattern) => `${pattern.name} (${pattern.slug})`).join('; ')}` : null,
          onScreen ? `Text on screen: ${onScreen}` : null,
          item.image_url ? `Image: ${item.image_url}` : 'Image: view-only under its licence (preview only)',
          `Page: ${item.page_url}`,
        ].filter(Boolean) as string[];

        const content: Content[] = [text(lines.join('\n'))];
        if (args.include_image) {
          const image = await this.image(found.screen, LIMITS.detailWidth);
          if (image) content.push(image);
        }
        return {
          content,
          structuredContent: {
            screen: item,
            text_on_screen: onScreen,
            flows: found.flows.map((flow) => ({ id: flow.id, name: flow.name, category: flow.category })),
            patterns: found.patterns.map((pattern) => ({ slug: pattern.slug, name: pattern.name })),
          },
        };
      },
    );
  }

  private registerFindSimilar(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'find_similar_screens',
      {
        title: 'Find similar screens',
        description:
          'Screens like a given one — same type, states, industry and visual style — from other apps on the same platform. Good for "show me how other apps do this". Similarity is by recorded metadata, not by looking at pixels.',
        inputSchema: {
          screen_id: z.string().min(1),
          limit: z.number().int().min(1).max(LIMITS.maxScreens).default(8),
          include_images: z.boolean().default(true),
        },
      },
      async (args) => {
        const screen = await this.loader.getScreen(args.screen_id);
        if (!screen) return this.fail(`No screen with id "${args.screen_id}".`);
        const similar = await this.inspirations.getSimilar(screen.id, 80);
        const screens = diversify(this.onPlatform(similar?.items ?? [], screen.platform as Platform)).slice(0, args.limit);
        const apps = await this.appIndex();
        const items = screens.map((s) => this.screenItem(s, apps));
        const label = PLATFORM_LABEL[screen.platform as Platform] ?? screen.platform;

        const content: Content[] = [
          text(
            screens.length
              ? `${screens.length} ${label} screens similar to ${apps.get(screen.appId)?.name ?? screen.appId} — ${screen.name} (${screen.screenType}), by recorded metadata.`
              : `No other ${label} screens share enough with ${screen.name} to call similar.`,
          ),
        ];
        await this.appendScreens(content, screens, items, args.include_images, LIMITS.previewWidth);
        return { content, structuredContent: { platform: screen.platform, basis: similar?.basis ?? 'metadata', screens: items } };
      },
    );
  }

  private registerGetFlow(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'get_flow',
      {
        title: 'Get a flow',
        description:
          'One user journey step by step: every screen in order with the action that led to it, and a preview of each of the first steps. Use the id from search_flows.',
        inputSchema: {
          flow_id: z.string().min(1),
          include_images: z.boolean().default(true).describe(`Attach previews of the first ${LIMITS.images} steps.`),
        },
      },
      async (args) => {
        const found = await this.inspirations.getFlow(args.flow_id);
        if (!found) return this.fail(`No flow with id "${args.flow_id}".`);
        const apps = await this.appIndex();
        const flow = this.flowItem(found.flow, apps);
        const screens = this.onPlatform(found.screens, found.flow.platform as Platform);
        const steps = screens.map((screen, index) => {
          const item = this.screenItem(screen, apps);
          const action = found.flow.steps?.find((step) => step.screenId === screen.id)?.action ?? null;
          return { position: index + 1, action, ...item };
        });

        const lines = [
          `${flow.app.name} — ${flow.name} · ${PLATFORM_LABEL[found.flow.platform as Platform] ?? found.flow.platform} · ${flow.category}${flow.kind ? ` (${flow.kind})` : ''} · ${steps.length} steps`,
          flow.summary,
          `Page: ${flow.page_url}`,
        ].filter(Boolean) as string[];

        const content: Content[] = [text(lines.join('\n'))];
        for (const step of steps) {
          const via = step.action ? ` ← ${step.action.kind}${step.action.label ? ` "${step.action.label}"` : ''}` : '';
          const about = step.description && step.description !== step.name ? `\n   ${step.description}` : '';
          content.push(text(`Step ${step.position}: ${step.name} (${step.screen_type}${step.states.length ? `, ${step.states.join(', ')}` : ''})${via}${about}\n   id: ${step.id}`));
          if (args.include_images && step.position <= LIMITS.images) {
            const image = await this.image(screens[step.position - 1], LIMITS.previewWidth);
            if (image) content.push(image);
          }
        }
        return { content, structuredContent: { flow, steps } };
      },
    );
  }

  // ─────────────────────────────────────────────────────────── apps/patterns

  private registerListApps(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'list_apps',
      {
        title: 'List apps',
        description:
          'The apps in the library, with how many screens and flows each has. Filter by platform to see only apps captured there (counts are then for that platform), by industry, or by a word in the name or tagline.',
        inputSchema: {
          platform: platformSchema.optional(),
          industry: z.string().optional().describe('An industry from get_taxonomy.'),
          query: z.string().optional().describe('A word in the app name or tagline.'),
        },
      },
      async (args) => {
        let apps = await this.inspirations.getApps(args.industry, 'az');
        if (args.platform) apps = apps.filter((app) => app.platforms.includes(args.platform));
        if (args.query) {
          const needle = args.query.toLowerCase();
          apps = apps.filter((app) => `${app.name} ${app.tagline ?? ''} ${app.slug}`.toLowerCase().includes(needle));
        }
        const items = apps.map((app) => this.appItem(app, args.platform));
        const where = args.platform ? ` on ${PLATFORM_LABEL[args.platform]}` : '';
        const lines = [
          `${items.length} apps${where}${args.industry ? ` in ${args.industry}` : ''}${args.query ? ` matching "${args.query}"` : ''}.`,
          ...items.map((app) => `- ${app.name} (id: ${app.id}) · ${app.industry} · ${app.platforms.map((p) => PLATFORM_LABEL[p as Platform] ?? p).join(' + ')} · ${app.screens} screens, ${app.flows} flows${app.tagline ? ` — ${app.tagline}` : ''}`),
        ];
        return { content: [text(lines.join('\n'))], structuredContent: { platform: args.platform ?? null, apps: items } };
      },
    );
  }

  private registerGetApp(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'get_app',
      {
        title: 'Get an app',
        description:
          "One app on one platform: what it is, its flows grouped by category, which screen types it has, and previews of its representative screens. For the app's screens on a topic, use search_screens with app=<id>.",
        inputSchema: {
          app: z.string().min(1).describe('An app id or slug from list_apps.'),
          platform: platformSchema,
          include_images: z.boolean().default(true),
        },
      },
      async (args) => {
        const apps = await this.appIndex();
        const app = apps.get(args.app.toLowerCase());
        if (!app) return this.fail(`Unknown app "${args.app}". list_apps gives the ids.`);
        if (!app.platforms.includes(args.platform)) {
          return this.fail(`${app.name} is not captured on ${PLATFORM_LABEL[args.platform]}. It is on: ${app.platforms.map((p) => PLATFORM_LABEL[p as Platform] ?? p).join(', ')}.`);
        }
        const found = await this.inspirations.getApp(app.slug);
        if (!found) return this.fail(`Unknown app "${args.app}".`);

        const screens = this.onPlatform(found.screens, args.platform);
        const flows = found.flows.filter((flow) => flow.platform === args.platform);
        const types: Record<string, number> = {};
        for (const screen of screens) types[screen.screenType] = (types[screen.screenType] ?? 0) + 1;
        const byCategory: Record<string, { id: string; name: string; steps: number }[]> = {};
        for (const flow of flows) (byCategory[flow.category] ??= []).push({ id: flow.id, name: flow.name, steps: flow.screenIds.length });

        const item = this.appItem(app, args.platform);
        const lines = [
          `${app.name} · ${PLATFORM_LABEL[args.platform]} · ${app.industry}${app.tagline ? ` — ${app.tagline}` : ''}`,
          `${screens.length} screens, ${flows.length} flows${app.currentVersion ? ` · latest capture ${app.currentVersion}` : ''}`,
          `Screen types: ${topEntries(types, 30).map(([type, count]) => `${type} (${count})`).join(', ')}`,
          ...Object.entries(byCategory).map(([category, list]) => `Flows — ${category}: ${list.map((flow) => `${flow.name} [${flow.id}]`).join('; ')}`),
          `Page: ${item.page_url}`,
        ];

        const content: Content[] = [text(lines.join('\n'))];
        if (args.include_images) {
          const picked = app.cardScreens.map((id) => screens.find((screen) => screen.id === id)).filter(Boolean) as InspirationScreen[];
          const representative = (picked.length ? picked : screens).slice(0, 6);
          const items = representative.map((screen) => this.screenItem(screen, apps));
          await this.appendScreens(content, representative, items, true, LIMITS.previewWidth);
        }
        return {
          content,
          structuredContent: { app: item, platform: args.platform, screen_types: types, flows: byCategory },
        };
      },
    );
  }

  private registerListPatterns(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'list_patterns',
      {
        title: 'List patterns',
        description:
          'Curated UI patterns — recurring solutions such as progress steppers, soft paywalls or permission primers — each with the screens that show it. Use get_pattern to see the screens on one platform.',
        inputSchema: {
          category: z.string().optional(),
        },
      },
      async (args) => {
        const patterns = await this.inspirations.getPatterns(args.category);
        const items = patterns.map((pattern) => ({
          slug: pattern.slug,
          name: pattern.name,
          category: pattern.category,
          description: pattern.description,
          tags: pattern.tags,
          screens: pattern.screenIds.length,
          page_url: `${this.siteUrl}/inspirations/patterns`,
        }));
        const lines = [
          `${items.length} patterns${args.category ? ` in ${args.category}` : ''}.`,
          ...items.map((pattern) => `- ${pattern.name} (slug: ${pattern.slug}) · ${pattern.category} · ${pattern.screens} screens — ${pattern.description}`),
        ];
        return { content: [text(lines.join('\n'))], structuredContent: { patterns: items } };
      },
    );
  }

  private registerGetPattern(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'get_pattern',
      {
        title: 'Get a pattern',
        description: 'The screens that show one curated pattern, on one platform, with previews.',
        inputSchema: {
          pattern: z.string().min(1).describe('A pattern slug from list_patterns.'),
          platform: platformSchema,
          limit: z.number().int().min(1).max(LIMITS.maxScreens).default(LIMITS.defaultScreens),
          include_images: z.boolean().default(true),
        },
      },
      async (args) => {
        const found = await this.inspirations.getPattern(args.pattern);
        if (!found) return this.fail(`No pattern with slug "${args.pattern}". list_patterns gives the slugs.`);
        const apps = await this.appIndex();
        const onPlatform = diversify(this.onPlatform(found.screens, args.platform));
        const screens = onPlatform.slice(0, args.limit);
        const items = screens.map((screen) => this.screenItem(screen, apps));
        const label = PLATFORM_LABEL[args.platform];

        const content: Content[] = [
          text(
            [
              `${found.pattern.name} · ${found.pattern.category} — ${found.pattern.description}`,
              screens.length
                ? `${onPlatform.length} ${label} screens show it. Showing ${screens.length}, from ${appCount(screens)}.`
                : `No ${label} screens show it; ${found.screens.length} do on other platforms (one call per platform).`,
            ].join('\n'),
          ),
        ];
        await this.appendScreens(content, screens, items, args.include_images, LIMITS.previewWidth);
        return {
          content,
          structuredContent: {
            pattern: { slug: found.pattern.slug, name: found.pattern.name, category: found.pattern.category, description: found.pattern.description, tags: found.pattern.tags },
            platform: args.platform,
            total: onPlatform.length,
            screens: items,
          },
        };
      },
    );
  }

  private registerGetTaxonomy(server: McpServer, identity: McpIdentity) {
    this.tool(
      server,
      identity,
      'get_taxonomy',
      {
        title: 'Get filter values',
        description:
          'The exact values the filters accept on one platform — screen types, states, industries, styles, UI elements and flow categories — with how much the library holds there. Call this before filtering.',
        inputSchema: {
          platform: platformSchema,
        },
      },
      async (args) => {
        const meta = await this.inspirations.getCounts([args.platform]);
        const taxonomy = meta.taxonomy;
        const label = PLATFORM_LABEL[args.platform];
        const list = (values: string[] | undefined) => (values?.length ? values.join(', ') : '(none yet)');
        const lines = [
          `${label}: ${meta.counts?.screens ?? 0} screens, ${meta.counts?.flows ?? 0} flows, ${meta.counts?.apps ?? 0} apps.`,
          `screen_type: ${list(taxonomy.screenTypes)}`,
          `state: ${list(taxonomy.states)}`,
          `industry: ${list(taxonomy.industries)}`,
          `style: ${list(taxonomy.styles)}`,
          `element: ${list(taxonomy.elements)}`,
          `flow category: ${list(taxonomy.flowCategories)}`,
        ];
        return {
          content: [text(lines.join('\n'))],
          structuredContent: {
            platform: args.platform,
            counts: meta.counts,
            screen_types: taxonomy.screenTypes,
            states: taxonomy.states,
            industries: taxonomy.industries,
            styles: taxonomy.styles,
            elements: taxonomy.elements,
            flow_categories: taxonomy.flowCategories,
          },
        };
      },
    );
  }

  // ──────────────────────────────────────────────────────────────── helpers

  /**
   * Registers one read-only tool, logging each call and turning a thrown
   * error into a tool error result rather than a protocol failure. Every call
   * is charged to the person's rate limits first; over a limit it comes back
   * as a tool error the AI can read and pass on.
   */
  private tool<Args extends z.ZodRawShape>(
    server: McpServer,
    identity: McpIdentity,
    name: string,
    config: { title: string; description: string; inputSchema: Args },
    run: (args: z.infer<z.ZodObject<Args>>) => Promise<ToolResult>,
  ) {
    // The SDK's registerTool generics are deep enough that inferring them
    // through this wrapper exhausts the type checker; the shape is validated
    // at runtime by the SDK from `inputSchema` either way.
    (server.registerTool as (name: string, config: unknown, cb: unknown) => unknown)(
      name,
      { ...config, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      async (args: z.infer<z.ZodObject<Args>>) => {
        const started = Date.now();
        const asked = args as { query?: unknown; text?: unknown };
        const query = typeof asked.query === 'string' ? asked.query : typeof asked.text === 'string' ? asked.text : null;
        const record = (outcome: 'ok' | 'error' | 'rate_limited') => {
          this.usage.recordCall({ uid: identity.uid, client: identity.clientName, tool: name, query, outcome });
          // Counted on the connection too, for "used N times this week" in the person's settings.
          if (outcome !== 'rate_limited' && identity.connectionId) this.oauth.connections.countCall(identity.connectionId);
        };
        const limit = this.limits.takeCall(identity.uid);
        if (!limit.ok) {
          record('rate_limited');
          this.logger.warn(`${identity.email} ${name} rate-limited (${limit.window}), retry in ${limit.retryAfter}s`);
          return this.fail(
            limit.window === 'day'
              ? `Daily limit reached: Motvin allows ${this.limits.limits.callsPerDay} tool calls a day per person. Try again ${waitText(limit.retryAfter)}.`
              : `Too many requests: Motvin allows ${this.limits.limits.callsPerMinute} tool calls a minute per person. Try again ${waitText(limit.retryAfter)}.`,
          );
        }
        try {
          const context = { uid: identity.uid, previewsSkipped: false, retryAfter: 0 };
          const result = await this.call.run(context, () => run(args));
          if (context.previewsSkipped) {
            result.content.push(
              text(
                `Previews paused: the limit of ${this.limits.limits.previewsPerMinute} screen previews a minute was reached, so some screens above have no image. ` +
                  `Previews come back ${waitText(context.retryAfter)}; page_url (and image_url where present) still work.`,
              ),
            );
          }
          record(result.isError ? 'error' : 'ok');
          this.logger.log(`${identity.email} ${name} ${JSON.stringify(args)} ${Date.now() - started}ms`);
          return result;
        } catch (error) {
          record('error');
          this.logger.error(`${identity.email} ${name} failed: ${(error as Error).message}`);
          return this.fail(`${name} failed: ${(error as Error).message}`);
        }
      },
    );
  }

  private fail(message: string): ToolResult {
    return { isError: true, content: [text(message)] };
  }

  /** Apps by id and by slug, lower-cased, so either names an app. */
  private async appIndex(): Promise<Map<string, InspirationApp>> {
    const apps = await this.loader.getApps();
    const index = new Map<string, InspirationApp>();
    for (const app of apps) {
      index.set(app.id.toLowerCase(), app);
      index.set(app.slug.toLowerCase(), app);
    }
    return index;
  }

  /** The platform rule, enforced on every list that leaves this service. */
  private onPlatform<T extends { platform: string }>(items: T[], platform: Platform): T[] {
    return items.filter((item) => item.platform === platform);
  }

  private screenItem(screen: InspirationScreen, apps: Map<string, InspirationApp>) {
    const app = apps.get(screen.appId.toLowerCase());
    return {
      id: screen.id,
      name: screen.name,
      app: app ? { id: app.id, name: app.name, slug: app.slug } : { id: screen.appId, name: screen.appId, slug: screen.appId },
      platform: screen.platform,
      screen_type: screen.screenType,
      screen_types: screen.screenTypes ?? [screen.screenType],
      states: screen.states ?? [],
      description: screen.description,
      purpose: screen.purpose ?? null,
      primary_action: screen.primaryAction ?? null,
      industry: screen.industry,
      elements: screen.elements ?? [],
      style: screen.style ?? [],
      tags: screen.tags ?? [],
      captured_at: screen.capturedAt ?? null,
      // Full-resolution file only where the licence allows a download, matching the 403 on the image route.
      image_url: screen.downloadable ? `${this.apiUrl}${screen.url}` : null,
      page_url: `${this.siteUrl}/inspirations/screens?screen=${encodeURIComponent(screen.id)}`,
      downloadable: screen.downloadable,
      attribution: screen.source?.attribution ?? app?.attribution ?? null,
    };
  }

  private flowItem(flow: InspirationFlow, apps: Map<string, InspirationApp>) {
    const app = apps.get(flow.appId.toLowerCase());
    return {
      id: flow.id,
      name: flow.name,
      app: app ? { id: app.id, name: app.name, slug: app.slug } : { id: flow.appId, name: flow.appId, slug: flow.appId },
      platform: flow.platform,
      category: flow.category,
      kind: flow.kind ?? null,
      summary: flow.summary ?? null,
      steps: flow.screenIds.length,
      screen_ids: flow.screenIds,
      parent_id: flow.parentId ?? null,
      page_url: `${this.siteUrl}/inspirations/flows?flow=${encodeURIComponent(flow.id)}`,
    };
  }

  private appItem(app: InspirationApp, platform?: Platform) {
    const counts = platform ? app.platformCounts?.[platform] : undefined;
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      tagline: app.tagline ?? null,
      industry: app.industry,
      platforms: app.platforms,
      screens: counts?.screens ?? app.screenCount,
      flows: counts?.flows ?? app.flowCount,
      latest_capture: app.currentVersion ?? null,
      logo_url: app.logo ? `${this.apiUrl}${app.logo}` : null,
      page_url: `${this.siteUrl}/inspirations/app/${encodeURIComponent(app.slug)}`,
    };
  }

  /** One caption per screen, and a preview for the first few when asked. */
  private async appendScreens(
    content: Content[],
    screens: InspirationScreen[],
    items: ReturnType<McpToolsService['screenItem']>[],
    includeImages: boolean,
    width: number,
  ) {
    for (const [index, item] of items.entries()) {
      const meta = [item.screen_type, ...item.states].join(', ');
      const look = item.style.join(', ');
      content.push(
        text(
          [
            `${index + 1}. ${item.app.name} — ${item.name} (${meta}${look ? `; ${look}` : ''})`,
            // Some records describe a screen with its own name; repeating that says nothing.
            item.description && item.description !== item.name ? `   ${item.description}` : null,
            `   id: ${item.id}`,
            `   ${item.image_url ? `image: ${item.image_url}` : 'image: view-only under its licence (preview only)'}`,
            `   page: ${item.page_url}`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
      if (includeImages && index < LIMITS.images) {
        const image = await this.image(screens[index], width);
        if (image) content.push(image);
      }
    }
  }

  /**
   * `width` is sized for a portrait phone capture. A landscape capture (a web
   * app or website) gets more room, or its text would be too small to read.
   */
  private async image(screen: InspirationScreen, width: number): Promise<Content | null> {
    // Charged to the caller's preview budget; past it, the result goes without.
    const context = this.call.getStore();
    if (context) {
      const limit = this.limits.takePreview(context.uid);
      if (!limit.ok) {
        context.previewsSkipped = true;
        context.retryAfter = limit.retryAfter;
        return null;
      }
    }
    const landscape = screen.width > screen.height;
    const data = await this.previews.base64(screen, landscape ? Math.round(width * 1.6) : width);
    return data ? { type: 'image', data, mimeType: PREVIEW_MIME } : null;
  }
}
