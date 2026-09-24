import { Injectable } from '@nestjs/common';
import { createWorker } from 'tesseract.js';
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
  state?: string[];
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

type TextHighlight = { left: number; top: number; width: number; height: number };
type RecognizedScreenshot = { text: string; words: Array<TextHighlight & { text: string }> };

/** Words that map onto the taxonomy, so plain-language queries still land. */
const SYNONYMS: Record<string, string[]> = {
  bank: ['fintech'], banking: ['fintech'], payments: ['fintech'], wallet: ['fintech'],
  invest: ['finance'], investing: ['finance'], stocks: ['finance'], portfolio: ['finance'],
  health: ['healthcare'], fitness: ['healthcare'], medical: ['healthcare'],
  shop: ['ecommerce'], shopping: ['ecommerce'], store: ['ecommerce'], retail: ['ecommerce'],
  learn: ['education'], course: ['education'], courses: ['education'],
  trip: ['travel'], hotel: ['travel'], booking: ['travel'], flights: ['travel'],
  tasks: ['productivity'], notes: ['productivity'], todo: ['productivity'],
  assistant: ['ai'], copilot: ['ai'], llm: ['ai'],
  food: ['food'], restaurant: ['food'], grocery: ['food'], delivery: ['food'],
  entertainment: ['entertainment'], streaming: ['entertainment'], movies: ['entertainment'],
  lifestyle: ['lifestyle'], dating: ['lifestyle'], wellness: ['lifestyle'],
  community: ['social'], creators: ['social'],
  b2b: ['saas'], software: ['saas'], analytics: ['saas', 'dashboard'],
  home: ['landing', 'feed'], homepage: ['landing'], hero: ['landing'], marketing: ['landing'],
  signin: ['login'], auth: ['login', 'signup'], register: ['signup'],
  overview: ['dashboard'], kpi: ['dashboard'], metrics: ['dashboard'], reports: ['dashboard'],
  results: ['search'], browse: ['search'], explore: ['search'],
  plans: ['pricing'], subscription: ['pricing'], billing: ['pricing'],
  payment: ['checkout'], cart: ['checkout'], order: ['checkout'],
  preferences: ['settings'], account: ['settings', 'profile'],
  welcome: ['onboarding'], intro: ['onboarding'], splash: ['splash'], launch: ['splash'],
  tutorial: ['onboarding'], tip: ['onboarding'], tips: ['onboarding'], walkthrough: ['onboarding'],
  timeline: ['feed'], activity: ['feed'],
  detail: ['detail', 'product'], listing: ['product'],
  empty: ['empty'], blank: ['empty'], nothing: ['empty'],
  loading: ['loading'], spinner: ['loading'], skeleton: ['loading'], loader: ['loading'],
  error: ['error'], errors: ['error'], failed: ['error'], offline: ['error'],
  success: ['success'], confirmation: ['success'], confirmed: ['success'], done: ['success'],
  modal: ['modal'], dialog: ['modal'], popup: ['modal'], sheet: ['modal'], alert: ['modal'], toast: ['modal'],
  permission: ['permission'], permissions: ['permission'], prompt: ['permission'],
  otp: ['login'], verification: ['login'], verify: ['login'], code: ['login'],
  chat: ['messages', 'ai'], chats: ['messages'], inbox: ['messages'], messaging: ['messages'],
  notifications: ['notifications'], alerts: ['notifications'],
  map: ['map'], maps: ['map'], location: ['map'], directions: ['map'],
  calendar: ['calendar'], dates: ['calendar'], schedule: ['calendar'],
  player: ['player'], video: ['player'], music: ['player'], podcast: ['player'],
  form: ['form'], input: ['form'], fields: ['form'],
  keyboard: ['keyboard'], scrolled: ['scrolled'],
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
  private readonly screenshotText = new Map<string, Promise<RecognizedScreenshot>>();

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
    if (query.state?.length) screens = screens.filter((s) => query.state.some((v) => s.states.includes(v)));
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

  async getApps(industry?: string, sort?: 'newest' | 'oldest' | 'az' | 'rating'): Promise<InspirationApp[]> {
    let apps = await this.loader.getApps();
    if (industry) apps = apps.filter((a) => a.industry === industry);

    if (sort === 'az') {
      apps = [...apps].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === 'newest' || sort === 'oldest') {
      // An app has no timestamp of its own — "newest"/"oldest" go by the
      // latest/earliest capturedAt among its own screens, the same signal
      // getScreens' own newest/oldest sort already orders by. Apps with no
      // dated screens have no ordering signal either way, so they sort last
      // regardless of direction rather than jumping to the front for "oldest".
      const screens = await this.loader.getScreens();
      const timesByApp = new Map<string, number[]>();
      for (const screen of screens) {
        if (!screen.capturedAt) continue;
        const ms = new Date(screen.capturedAt).getTime();
        if (Number.isNaN(ms)) continue;
        if (!timesByApp.has(screen.appId)) timesByApp.set(screen.appId, []);
        timesByApp.get(screen.appId)!.push(ms);
      }
      const metric = (id: string) => {
        const times = timesByApp.get(id);
        if (!times?.length) return null;
        return sort === 'newest' ? Math.max(...times) : Math.min(...times);
      };
      apps = [...apps].sort((a, b) => {
        const ma = metric(a.id);
        const mb = metric(b.id);
        if (ma === null || mb === null) return ma === mb ? 0 : ma === null ? 1 : -1;
        return sort === 'newest' ? mb - ma : ma - mb;
      });
    } else if (sort === 'rating') {
      // Unrated apps (both fields null) sort last, ordered by score then by
      // how many ratings back it up.
      apps = [...apps].sort((a, b) => {
        if (a.rating === null || b.rating === null) return a.rating === b.rating ? 0 : a.rating === null ? 1 : -1;
        return b.rating - a.rating || (b.ratingCount ?? 0) - (a.ratingCount ?? 0);
      });
    }

    return apps;
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
        if (s.fineType && s.fineType === screen.fineType && s.fineType !== s.screenType) score += 2;
        score += (s.states || []).filter((v) => (screen.states || []).includes(v)).length * 2;
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

  /** OCR-backed search is opt-in: the regular search remains metadata-only. */
  async searchScreenshotText(q: string, limit = 50, offset = 0) {
    const [screens, manifest] = await Promise.all([this.loader.getScreens(), this.loader.getManifest()]);
    const intent = this.interpret(q, manifest);
    const query = q.trim().toLocaleLowerCase();
    const queryTerms = query.split(/\s+/).filter(Boolean);
    if (!query) {
      return { intent, apps: [], screens: [], flows: [], patterns: [], total: 0, screenTotal: 0 };
    }

    const matchedScreens: InspirationScreen[] = [];
    const textHighlights: Record<string, TextHighlight[]> = {};
    for (const screen of screens) {
      const recognized = await this.textInScreenshot(screen);
      if (recognized.text.includes(query)) {
        matchedScreens.push(screen);
        textHighlights[screen.id] = recognized.words
          .filter(({ text }) => queryTerms.some((term) => text.includes(term)))
          .map(({ text: _text, ...highlight }) => highlight);
      }
    }

    return {
      intent,
      apps: [],
      screens: matchedScreens.slice(offset, offset + limit),
      flows: [],
      patterns: [],
      total: matchedScreens.length,
      screenTotal: matchedScreens.length,
      textHighlights,
    };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private textInScreenshot(screen: InspirationScreen): Promise<RecognizedScreenshot> {
    const cached = this.screenshotText.get(screen.id);
    if (cached) return cached;

    const extraction = (async () => {
      const file = await this.loader.resolveServableFile(`screens/${screen.file}`);
      if (!file) return { text: '', words: [] };
      try {
        const worker = await createWorker('eng');
        try {
          const { data } = await worker.recognize(file, {}, { text: true, tsv: true });
          return {
            text: data.text.toLocaleLowerCase(),
            words: this.ocrWords(data.tsv ?? '', screen),
          };
        } finally {
          await worker.terminate();
        }
      } catch {
        return { text: '', words: [] };
      }
    })();
    this.screenshotText.set(screen.id, extraction);
    return extraction;
  }

  private ocrWords(tsv: string, screen: InspirationScreen): RecognizedScreenshot['words'] {
    return tsv.split('\n').slice(1).flatMap((line) => {
      const [level, , , , , , left, top, width, height, , text] = line.split('\t');
      if (level !== '5' || !text?.trim()) return [];
      const x = Number(left);
      const y = Number(top);
      const w = Number(width);
      const h = Number(height);
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return [];
      return [{
        text: text.toLocaleLowerCase(),
        left: (x / screen.width) * 100,
        top: (y / screen.height) * 100,
        width: (w / screen.width) * 100,
        height: (h / screen.height) * 100,
      }];
    });
  }

  private interpret(raw: string, manifest: { taxonomy: any }) {
    const { platforms, screenTypes, industries, styles } = manifest.taxonomy;
    const states: string[] = manifest.taxonomy.states || [];
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
      states: [] as string[],
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
        if (states.includes(c)) { add(intent.states, c); matched = true; }
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
      states: Array.from(new Set(screens.flatMap((s) => s.states || []))),
    };
    const intent = this.interpret(q, { taxonomy });

    return screens
      .map((screen) => {
        if (intent.industries.length && !intent.industries.includes(screen.industry)) return null;
        if (intent.screenTypes.length && !intent.screenTypes.includes(screen.screenType)) return null;
        if (intent.platforms.length && !intent.platforms.includes(screen.platform)) return null;
        if (intent.styles.length && !intent.styles.some((s) => screen.style.includes(s))) return null;
        if (intent.states.length && !intent.states.some((s) => (screen.states || []).includes(s))) return null;

        let score = 0;
        if (intent.industries.includes(screen.industry)) score += 3;
        if (intent.screenTypes.includes(screen.screenType)) score += 4;
        if (intent.platforms.includes(screen.platform)) score += 2;
        score += intent.styles.filter((s) => screen.style.includes(s)).length * 2;
        score += intent.states.filter((s) => (screen.states || []).includes(s)).length * 4;

        const hay = `${screen.name} ${screen.description || ''} ${screen.fineType || ''} ${screen.tags.join(' ')} ${appNames.get(screen.appId) || ''}`.toLowerCase();
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
