import { Injectable } from '@nestjs/common';
import { InspirationsService } from '../inspirations/inspirations.service';
import { InspirationApp, InspirationFlow, InspirationScreen, LoaderService } from '../inspirations/loader.service';
import { arrange } from './mcp-ranking';

/**
 * The library searches behind both the MCP tools and the Figma plugin, so the
 * two answer the same question with the same screens in the same order.
 *
 * Every search takes one platform and returns that platform only: iOS, Web
 * Apps and Sites never mix. The MCP tools turn these results into text and
 * previews; the Figma plugin's API sends them as JSON.
 */

export const PLATFORMS = ['ios', 'webapp', 'site'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABEL: Record<Platform, string> = { ios: 'iOS', webapp: 'Web Apps', site: 'Sites' };

export interface ScreenSearch {
  query: string;
  platform: 'ios' | 'webapp';
  screen_type?: string;
  state?: string;
  industry?: string;
  style?: string;
  element?: string;
  app?: InspirationApp;
  /** Several apps at once (the Figma plugin's colour filter: every app of one brand colour). Ignored when `app` is set. */
  apps?: string[];
  offset: number;
  limit: number;
}

export interface SiteSearch {
  query: string;
  screen_type?: string;
  industry?: string;
  app?: InspirationApp;
  /** Several apps at once (the Figma plugin's colour filter: every app of one brand colour). Ignored when `app` is set. */
  apps?: string[];
  offset: number;
  limit: number;
}

/** How many of each value, most first. */
export function countBy(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function topEntries(tally: Record<string, number> | undefined, count: number): [string, number][] {
  return Object.entries(tally ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);
}

@Injectable()
export class LibrarySearchService {
  constructor(
    private readonly inspirations: InspirationsService,
    private readonly loader: LoaderService,
  ) {}

  /** Apps by id and by slug, lower-cased, so either names an app. */
  async appIndex(): Promise<Map<string, InspirationApp>> {
    const apps = await this.loader.getApps();
    const index = new Map<string, InspirationApp>();
    for (const app of apps) {
      index.set(app.id.toLowerCase(), app);
      index.set(app.slug.toLowerCase(), app);
    }
    return index;
  }

  /**
   * App screens on iOS or Web Apps, ranked as search_screens ranks them: the
   * search score first, then one screen per app per round (mcp-ranking.ts).
   */
  async screens(args: ScreenSearch) {
    const filters = {
      platform: [args.platform],
      screenType: args.screen_type ? [args.screen_type] : undefined,
      state: args.state ? [args.state] : undefined,
      industry: args.industry ? [args.industry] : undefined,
      style: args.style ? [args.style] : undefined,
      element: args.element ? [args.element] : undefined,
      apps: args.app ? [args.app.id] : args.apps,
    };
    // The search supplies the counts beside the screens; the screens themselves come
    // scored, whole, so the ordering (mcp-ranking.ts) is the same on every page.
    const [result, scored] = await Promise.all([
      this.inspirations.search(args.query, 0, 0, filters),
      this.inspirations.rankedScreens(args.query, filters),
    ]);
    const onPlatform = scored.filter((r) => r.screen.platform === args.platform);
    const ranked = arrange(onPlatform, args.query, args.app ? Infinity : 1);
    const page = ranked.slice(args.offset, args.offset + args.limit);
    return {
      total: ranked.length,
      screens: page,
      nextOffset: args.offset + page.length < ranked.length ? args.offset + page.length : null,
      screenTypes: topEntries(result.facets?.screenTypes, 8),
      matchedApps: result.apps,
      matchedFlows: result.flows.length,
    };
  }

  /**
   * Sites: every site's newest pages and sections, matched word by word on their page or section
   * type, heading, address and site; whole pages before sections on a tie.
   */
  async sitePages(args: SiteSearch, apps: Map<string, InspirationApp>) {
    const [pages, sections] = await Promise.all([this.inspirations.getSiteScreens('page', '', 10000), this.inspirations.getSiteScreens('section', '', 10000)]);
    const asked = args.query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);
    // "page" / "section" say which kind, not what it is about: "faq section" is FAQ sections, "landing page" pages.
    const kind = asked.some((word) => /^sections?$/.test(word)) ? 'section' : asked.some((word) => /^(?:pages?|full)$/.test(word)) ? 'page' : null;
    const words = asked.filter((word) => !/^(?:pages?|sections?|full|whole|site|sites|website|websites)$/.test(word));
    const stem = (word: string) => word.replace(/(?:ing|es|s)$/, '');
    const ownType = (screen: InspirationScreen) => (screen.site?.kind === 'section' ? screen.site.sectionType ?? 'content' : screen.site?.pageType ?? 'other');
    const matched = [...pages, ...sections]
      .filter((screen) => !kind || screen.site?.kind === kind)
      .filter((screen) => (args.app ? screen.appId === args.app.id : !args.apps || args.apps.includes(screen.appId)))
      .filter((screen) => !args.industry || apps.get(screen.appId.toLowerCase())?.industry === args.industry)
      .filter((screen) => !args.screen_type || ownType(screen) === args.screen_type)
      .map((screen) => {
        const site = screen.site;
        // A section is its own type ("pricing" section), not the page it sits on: that page goes with the words below.
        const typeWords = ownType(screen).replace(/-/g, ' ');
        const other = `${site?.kind === 'section' ? (site.pageType ?? '') : ''} ${site?.heading ?? ''} ${site?.pageUrl ?? ''} ${screen.name ?? ''} ${screen.description ?? ''} ${(screen.tags ?? []).join(' ')} ${apps.get(screen.appId.toLowerCase())?.name ?? ''}`.toLowerCase();
        const score = words.reduce((sum, word) => sum + (typeWords.includes(stem(word)) ? 3 : other.includes(stem(word)) ? 1 : 0), 0);
        return { screen, score: score + (site?.kind === 'page' ? 0.5 : 0) };
      })
      .filter((entry) => entry.score >= 1 || !words.length || Boolean(args.screen_type))
      .sort((a, b) => b.score - a.score);
    // A page or section of the type asked for ("pricing") is the answer; ones that only mention it in passing are not.
    const scored = matched.some((entry) => entry.score >= 3) ? matched.filter((entry) => entry.score >= 3) : matched;
    const shown = scored.slice(args.offset, args.offset + args.limit).map((entry) => entry.screen);
    return {
      total: scored.length,
      screens: shown,
      nextOffset: args.offset + shown.length < scored.length ? args.offset + shown.length : null,
      matchedPages: scored.filter((entry) => entry.screen.site?.kind === 'page').length,
      types: countBy(scored.map((entry) => (entry.screen.site?.kind === 'page' ? `${entry.screen.site.pageType ?? 'other'} page` : `${entry.screen.site?.sectionType ?? 'content'} section`))).slice(0, 8),
    };
  }

  /**
   * Flows on iOS or Web Apps, optionally about something: flows whose screens
   * match the words first, then flows whose own name or summary does.
   */
  async flows(args: { query?: string; platform: 'ios' | 'webapp'; category?: string; app?: InspirationApp; apps?: string[] }, apps: Map<string, InspirationApp>): Promise<InspirationFlow[]> {
    let flows = await this.inspirations.getFlows(args.category, args.platform);
    if (args.app) flows = flows.filter((flow) => flow.appId === args.app.id);
    else if (args.apps) flows = flows.filter((flow) => args.apps.includes(flow.appId));

    const query = (args.query ?? '').trim();
    if (query) {
      const matched = await this.inspirations.search(query, 1, 0, { platform: [args.platform], apps: args.app ? [args.app.id] : args.apps });
      const byScreens = new Set(matched.flows.map((flow) => flow.id));
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const byWords = (flow: InspirationFlow) => {
        const hay = `${flow.name} ${flow.kind ?? ''} ${flow.category} ${flow.summary ?? ''} ${apps.get(flow.appId)?.name ?? ''}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      };
      flows = [...flows.filter((flow) => byScreens.has(flow.id)), ...flows.filter((flow) => !byScreens.has(flow.id) && byWords(flow))];
    }
    return flows;
  }
}
