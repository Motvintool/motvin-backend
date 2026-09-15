import { Injectable } from '@nestjs/common';
import {
  InspirationApp,
  InspirationFlow,
  InspirationPattern,
  InspirationScreen,
  LoaderService,
} from './loader.service';

/**
 * Query layer over the manifest. Everything here reads stored records — there
 * is no generated content, so an empty store yields empty results rather than
 * filler.
 */

export interface ScreenQuery {
  platform?: string[];
  screenType?: string[];
  industry?: string[];
  style?: string[];
  element?: string[];
  app?: string;
  q?: string;
  limit?: number;
  offset?: number;
  sort?: 'newest' | 'oldest' | 'app' | 'curated';
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

/** Words that map onto the taxonomy, so plain-language queries still land. */
const SYNONYMS: Record<string, string[]> = {
  bank: ['fintech'], banking: ['fintech'], payments: ['fintech'], wallet: ['fintech'],
  invest: ['finance'], investing: ['finance'], stocks: ['finance'], portfolio: ['finance'],
  health: ['healthcare'], fitness: ['healthcare'], medical: ['healthcare'],
  shop: ['ecommerce'], shopping: ['ecommerce'], store: ['ecommerce'], retail: ['ecommerce'],
  learn: ['education'], course: ['education'], courses: ['education'],
  trip: ['travel'], hotel: ['travel'], booking: ['travel'], flights: ['travel'],
  tasks: ['productivity'], notes: ['productivity'], todo: ['productivity'],
  chat: ['ai'], assistant: ['ai'], copilot: ['ai'], llm: ['ai'],
  community: ['social'], creators: ['social'],
  b2b: ['saas'], software: ['saas'], analytics: ['saas', 'dashboard'],
  home: ['landing', 'feed'], homepage: ['landing'], hero: ['landing'], marketing: ['landing'],
  signin: ['login'], auth: ['login', 'signup'], register: ['signup'],
  overview: ['dashboard'], kpi: ['dashboard'], metrics: ['dashboard'], reports: ['dashboard'],
  results: ['search'], browse: ['search'], explore: ['search'],
  plans: ['pricing'], subscription: ['pricing'], billing: ['pricing'],
  payment: ['checkout'], cart: ['checkout'], order: ['checkout'],
  preferences: ['settings'], account: ['settings', 'profile'],
  welcome: ['onboarding'], intro: ['onboarding'],
  timeline: ['feed'], activity: ['feed'],
  detail: ['product'], listing: ['product'],
  mobile: ['ios', 'android'], iphone: ['ios'], desktop: ['web'], website: ['web'],
  clean: ['minimal'], simple: ['minimal'], black: ['dark'], white: ['light'],
  enterprise: ['corporate'], professional: ['corporate'],
};

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'with', 'in', 'on', 'to', 'beautiful',
  'nice', 'best', 'good', 'great', 'ui', 'ux', 'design', 'designs', 'screen',
  'screens', 'page', 'pages', 'example', 'examples', 'inspiration',
]);

@Injectable()
export class InspirationsService {
  constructor(private readonly loader: LoaderService) {}

  async getCounts() {
    const manifest = await this.loader.getManifest();
    return {
      counts: manifest.counts,
      taxonomy: manifest.taxonomy,
      generatedAt: manifest.generatedAt,
    };
  }

  async getScreens(query: ScreenQuery): Promise<Page<InspirationScreen>> {
    let screens = await this.loader.getScreens();

    if (query.app) screens = screens.filter((s) => s.appId === query.app);
    if (query.platform?.length) screens = screens.filter((s) => query.platform.includes(s.platform));
    if (query.screenType?.length) screens = screens.filter((s) => query.screenType.includes(s.screenType));
    if (query.industry?.length) screens = screens.filter((s) => query.industry.includes(s.industry));
    if (query.style?.length) screens = screens.filter((s) => query.style.some((v) => s.style.includes(v)));
    if (query.element?.length) screens = screens.filter((s) => query.element.some((v) => s.elements.includes(v)));

    if (query.q?.trim()) {
      const apps = await this.loader.getApps();
      const ranked = this.rankScreens(screens, query.q, apps);
      screens = ranked;
    } else {
      screens = this.sortScreens(screens, query.sort || 'curated');
    }

    return this.paginate(screens, query.limit, query.offset);
  }

  async getApps(industry?: string): Promise<InspirationApp[]> {
    const apps = await this.loader.getApps();
    return industry ? apps.filter((a) => a.industry === industry) : apps;
  }

  async getApp(slug: string) {
    const app = await this.loader.getApp(slug);
    if (!app) return null;
    const screens = (await this.loader.getScreens()).filter((s) => s.appId === app.id);
    const flows = (await this.loader.getFlows()).filter((f) => f.appId === app.id);
    const patterns = (await this.loader.getPatterns()).filter((p) =>
      p.screenIds.some((id) => screens.some((s) => s.id === id)),
    );
    return { app, screens, flows, patterns };
  }

  async getScreen(id: string) {
    const screen = await this.loader.getScreen(id);
    if (!screen) return null;
    const app = await this.loader.getApp(screen.appId);
    const flows = (await this.loader.getFlows()).filter((f) => f.screenIds.includes(id));
    const patterns = (await this.loader.getPatterns()).filter((p) => p.screenIds.includes(id));
    return { screen, app, flows, patterns };
  }

  async getFlows(category?: string, platform?: string): Promise<InspirationFlow[]> {
    let flows = await this.loader.getFlows();
    if (category) flows = flows.filter((f) => f.category === category);
    if (platform) flows = flows.filter((f) => f.platform === platform);
    return flows;
  }

  async getFlow(id: string) {
    const flow = await this.loader.getFlow(id);
    if (!flow) return null;
    const screens = await this.resolveScreens(flow.screenIds);
    const app = await this.loader.getApp(flow.appId);
    return { flow, screens, app };
  }

  async getPatterns(category?: string): Promise<InspirationPattern[]> {
    const patterns = await this.loader.getPatterns();
    return category ? patterns.filter((p) => p.category === category) : patterns;
  }

  async getPattern(slug: string) {
    const pattern = await this.loader.getPattern(slug);
    if (!pattern) return null;
    return { pattern, screens: await this.resolveScreens(pattern.screenIds) };
  }

  async getElements() {
    const manifest = await this.loader.getManifest();
    return Object.entries(manifest.elementCounts)
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count);
  }

  async resolveScreens(ids: string[]): Promise<InspirationScreen[]> {
    const out: InspirationScreen[] = [];
    for (const id of ids) {
      const screen = await this.loader.getScreen(id);
      if (screen) out.push(screen);
    }
    return out;
  }

  async getAnalysis(screenId: string) {
    return this.loader.getAnalysis(screenId);
  }

  /**
   * Similar screens, scored on the facets we actually store. This is a
   * metadata neighbourhood, not a visual embedding — the response says so, so
   * the UI can label it honestly.
   */
  async getSimilar(screenId: string, limit = 12) {
    const screen = await this.loader.getScreen(screenId);
    if (!screen) return null;
    const screens = await this.loader.getScreens();
    const items = screens
      .filter((s) => s.id !== screenId)
      .map((s) => {
        let score = 0;
        if (s.screenType === screen.screenType) score += 5;
        if (s.industry === screen.industry) score += 3;
        if (s.platform === screen.platform) score += 2;
        score += s.style.filter((v) => screen.style.includes(v)).length * 1.5;
        score += s.elements.filter((v) => screen.elements.includes(v)).length * 0.5;
        score += s.tags.filter((v) => screen.tags.includes(v)).length * 0.25;
        if (s.appId === screen.appId) score -= 2;
        return { s, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.s);
    return { basis: 'metadata', items };
  }

  async search(q: string, limit = 50, offset = 0) {
    const [screens, apps, flows, patterns] = await Promise.all([
      this.loader.getScreens(),
      this.loader.getApps(),
      this.loader.getFlows(),
      this.loader.getPatterns(),
    ]);

    const intent = this.interpret(q, await this.loader.getManifest());
    if (!intent.terms.length) {
      return { intent, apps: [], screens: [], flows: [], patterns: [], total: 0 };
    }

    const rankedScreens = this.rankScreens(screens, q, apps);
    const matchedApps = apps.filter((a) => {
      if (intent.industries.length && !intent.industries.includes(a.industry)) return false;
      const hay = `${a.name} ${a.tagline || ''}`.toLowerCase();
      return intent.industries.includes(a.industry) || intent.free.some((t) => hay.includes(t));
    });
    const screenIds = new Set(rankedScreens.map((s) => s.id));
    const matchedFlows = flows.filter(
      (f) =>
        f.screenIds.some((id) => screenIds.has(id)) ||
        intent.free.some((t) => f.name.toLowerCase().includes(t)),
    );
    const matchedPatterns = patterns.filter((p) => {
      const hay = `${p.name} ${p.category} ${p.tags.join(' ')}`.toLowerCase();
      return intent.free.some((t) => hay.includes(t)) || intent.screenTypes.some((t) => p.tags.includes(t));
    });

    return {
      intent,
      apps: matchedApps,
      screens: rankedScreens.slice(offset, offset + limit),
      flows: matchedFlows,
      patterns: matchedPatterns,
      total:
        matchedApps.length + rankedScreens.length + matchedFlows.length + matchedPatterns.length,
      screenTotal: rankedScreens.length,
    };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private interpret(raw: string, manifest: { taxonomy: any }) {
    const { platforms, screenTypes, industries, styles } = manifest.taxonomy;
    const terms = raw
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9-]/g, ''))
      .filter((t) => t && !STOP.has(t));

    const intent = {
      raw: raw.trim(),
      terms,
      industries: [] as string[],
      screenTypes: [] as string[],
      platforms: [] as string[],
      styles: [] as string[],
      free: [] as string[],
    };

    const add = (list: string[], value: string) => {
      if (!list.includes(value)) list.push(value);
    };

    for (const term of terms) {
      const candidates = [term, ...(SYNONYMS[term] || [])];
      let matched = false;
      for (const c of candidates) {
        if (industries.includes(c)) { add(intent.industries, c); matched = true; }
        if (screenTypes.includes(c)) { add(intent.screenTypes, c); matched = true; }
        if (platforms.includes(c)) { add(intent.platforms, c); matched = true; }
        if (styles.includes(c)) { add(intent.styles, c); matched = true; }
      }
      if (!matched || term.length > 3) intent.free.push(term);
    }
    return intent;
  }

  private rankScreens(screens: InspirationScreen[], q: string, apps: InspirationApp[]) {
    const appNames = new Map(apps.map((a) => [a.id, a.name.toLowerCase()]));
    const taxonomy = {
      platforms: Array.from(new Set(screens.map((s) => s.platform))),
      screenTypes: Array.from(new Set(screens.map((s) => s.screenType))),
      industries: Array.from(new Set(screens.map((s) => s.industry))),
      styles: Array.from(new Set(screens.flatMap((s) => s.style))),
    };
    const intent = this.interpret(q, { taxonomy });

    return screens
      .map((screen) => {
        if (intent.industries.length && !intent.industries.includes(screen.industry)) return null;
        if (intent.screenTypes.length && !intent.screenTypes.includes(screen.screenType)) return null;
        if (intent.platforms.length && !intent.platforms.includes(screen.platform)) return null;
        if (intent.styles.length && !intent.styles.some((s) => screen.style.includes(s))) return null;

        let score = 0;
        if (intent.industries.includes(screen.industry)) score += 3;
        if (intent.screenTypes.includes(screen.screenType)) score += 4;
        if (intent.platforms.includes(screen.platform)) score += 2;
        score += intent.styles.filter((s) => screen.style.includes(s)).length * 2;

        const hay = `${screen.name} ${screen.tags.join(' ')} ${appNames.get(screen.appId) || ''}`.toLowerCase();
        score += intent.free.filter((t) => hay.includes(t)).length;

        return score > 0 ? { screen, score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.screen.id.localeCompare(b.screen.id))
      .map((r) => r.screen);
  }

  private sortScreens(screens: InspirationScreen[], sort: string) {
    const list = [...screens];
    const byDate = (a: InspirationScreen, b: InspirationScreen) =>
      (b.capturedAt || '').localeCompare(a.capturedAt || '') || a.id.localeCompare(b.id);

    if (sort === 'newest') return list.sort(byDate);
    if (sort === 'oldest') return list.sort((a, b) => -byDate(a, b));
    if (sort === 'app') return list.sort((a, b) => a.appId.localeCompare(b.appId) || a.id.localeCompare(b.id));
    return this.interleaveByApp(list.sort(byDate));
  }

  /** Spreads consecutive cards across apps so a gallery reads as curated. */
  private interleaveByApp(screens: InspirationScreen[]) {
    const buckets = new Map<string, InspirationScreen[]>();
    for (const s of screens) {
      if (!buckets.has(s.appId)) buckets.set(s.appId, []);
      buckets.get(s.appId).push(s);
    }
    const lists = Array.from(buckets.values());
    const out: InspirationScreen[] = [];
    let remaining = screens.length;
    let i = 0;
    while (remaining > 0) {
      const list = lists[i % lists.length];
      if (list.length) {
        out.push(list.shift());
        remaining--;
      }
      i++;
    }
    return out;
  }

  private paginate<T>(items: T[], limit = 30, offset = 0): Page<T> {
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const page = items.slice(safeOffset, safeOffset + safeLimit);
    const next = safeOffset + safeLimit;
    return {
      items: page,
      total: items.length,
      limit: safeLimit,
      offset: safeOffset,
      nextOffset: next < items.length ? next : null,
    };
  }
}
