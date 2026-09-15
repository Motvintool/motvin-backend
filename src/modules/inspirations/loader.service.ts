import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';

/**
 * Loads data/inspirations/manifest.json — the index the build script writes
 * from what is actually stored on disk.
 *
 * The manifest is small (metadata only, no image bytes) so it is held in
 * memory and reloaded when its mtime changes, which lets an ingest run appear
 * without a restart.
 */

export interface InspirationScreen {
  id: string;
  appId: string;
  name: string;
  file: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  platform: string;
  screenType: string;
  industry: string;
  tags: string[];
  elements: string[];
  style: string[];
  capturedAt: string | null;
  hasAnalysis: boolean;
  downloadable: boolean;
  source: {
    url: string | null;
    license: string | null;
    licenseUrl: string | null;
    attribution: string | null;
    permission: string | null;
  };
}

export interface InspirationApp {
  id: string;
  name: string;
  slug: string;
  industry: string;
  platforms: string[];
  website: string | null;
  tagline: string | null;
  logo: string | null;
  screenCount: number;
  flowCount: number;
  license: string | null;
  attribution: string;
}

export interface InspirationFlow {
  id: string;
  appId: string;
  name: string;
  category: string;
  platform: string;
  screenIds: string[];
}

export interface InspirationPattern {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  screenIds: string[];
}

export interface InspirationsManifest {
  version: number;
  generatedAt: string;
  counts: Record<string, number>;
  taxonomy: {
    platforms: string[];
    screenTypes: string[];
    industries: string[];
    styles: string[];
    elements: string[];
  };
  apps: InspirationApp[];
  screens: InspirationScreen[];
  flows: InspirationFlow[];
  patterns: InspirationPattern[];
  elementCounts: Record<string, number>;
}

const EMPTY_MANIFEST: InspirationsManifest = {
  version: 1,
  generatedAt: new Date(0).toISOString(),
  counts: { apps: 0, screens: 0, flows: 0, patterns: 0, 'ui-elements': 0 },
  taxonomy: { platforms: [], screenTypes: [], industries: [], styles: [], elements: [] },
  apps: [],
  screens: [],
  flows: [],
  patterns: [],
  elementCounts: {},
};

@Injectable()
export class LoaderService implements OnModuleInit {
  private readonly logger = new Logger(LoaderService.name);
  private readonly dataRoot: string;
  private readonly root: string;

  private manifest: InspirationsManifest = EMPTY_MANIFEST;
  private manifestMtime = 0;
  private lastChecked = 0;

  private screensById = new Map<string, InspirationScreen>();
  private appsBySlug = new Map<string, InspirationApp>();
  private flowsById = new Map<string, InspirationFlow>();
  private patternsBySlug = new Map<string, InspirationPattern>();
  /** Published file path → absolute path. The only files the API will serve. */
  private servableFiles = new Map<string, string>();

  constructor(private readonly configService: ConfigService) {
    this.dataRoot = this.configService.get<string>('dataRoot') || './data';
    this.root = join(this.dataRoot, 'inspirations');
  }

  async onModuleInit() {
    await this.reloadIfChanged(true);
    if (this.manifest.counts.screens === 0) {
      this.logger.warn(
        'No inspiration screens published. Add images under data/inspirations/screens/<platform>/<app>/, approve the app in sources.json, then run: npm run build:inspirations',
      );
    } else {
      this.logger.log(
        `Loaded ${this.manifest.counts.screens} screens across ${this.manifest.counts.apps} apps`,
      );
    }
  }

  /** Re-reads the manifest when its mtime moved; checked at most once a second. */
  private async reloadIfChanged(force = false) {
    const now = Date.now();
    if (!force && now - this.lastChecked < 1000) return;
    this.lastChecked = now;

    const file = join(this.root, 'manifest.json');
    let mtime: number;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      if (force) {
        this.logger.warn(`No manifest at ${file} — serving an empty catalogue`);
      }
      return;
    }
    if (!force && mtime === this.manifestMtime) return;

    try {
      const parsed = JSON.parse(await readFile(file, 'utf-8')) as InspirationsManifest;
      this.manifest = { ...EMPTY_MANIFEST, ...parsed };
      this.manifestMtime = mtime;
      this.index();
    } catch (error) {
      this.logger.error(`Failed to read manifest.json: ${error.message}`);
    }
  }

  private index() {
    this.screensById = new Map(this.manifest.screens.map((s) => [s.id, s]));
    this.appsBySlug = new Map(this.manifest.apps.map((a) => [a.slug, a]));
    this.flowsById = new Map(this.manifest.flows.map((f) => [f.id, f]));
    this.patternsBySlug = new Map(this.manifest.patterns.map((p) => [p.slug, p]));

    // Allow-list of servable files, built from the manifest rather than from
    // the request: a path that is not published cannot be fetched.
    this.servableFiles = new Map();
    const screensRoot = resolve(join(this.root, 'screens'));
    const logosRoot = resolve(join(this.root, 'logos'));

    for (const screen of this.manifest.screens) {
      const abs = resolve(join(screensRoot, screen.file));
      if (abs.startsWith(screensRoot + sep)) {
        this.servableFiles.set(`screens/${screen.file}`, abs);
      }
    }
    for (const app of this.manifest.apps) {
      if (!app.logo) continue;
      const name = app.logo.split('/').pop();
      if (!name) continue;
      const abs = resolve(join(logosRoot, name));
      if (abs.startsWith(logosRoot + sep)) {
        this.servableFiles.set(`logos/${name}`, abs);
      }
    }
  }

  async getManifest(): Promise<InspirationsManifest> {
    await this.reloadIfChanged();
    return this.manifest;
  }

  async getScreens(): Promise<InspirationScreen[]> {
    return (await this.getManifest()).screens;
  }

  async getScreen(id: string): Promise<InspirationScreen | null> {
    await this.reloadIfChanged();
    return this.screensById.get(id) || null;
  }

  async getApps(): Promise<InspirationApp[]> {
    return (await this.getManifest()).apps;
  }

  async getApp(slug: string): Promise<InspirationApp | null> {
    await this.reloadIfChanged();
    return this.appsBySlug.get(slug) || null;
  }

  async getFlows(): Promise<InspirationFlow[]> {
    return (await this.getManifest()).flows;
  }

  async getFlow(id: string): Promise<InspirationFlow | null> {
    await this.reloadIfChanged();
    return this.flowsById.get(id) || null;
  }

  async getPatterns(): Promise<InspirationPattern[]> {
    return (await this.getManifest()).patterns;
  }

  async getPattern(slug: string): Promise<InspirationPattern | null> {
    await this.reloadIfChanged();
    return this.patternsBySlug.get(slug) || null;
  }

  /**
   * Absolute path for a published file, or null. Only paths present in the
   * manifest resolve, so a traversal attempt simply misses the map.
   */
  async resolveServableFile(key: string): Promise<string | null> {
    await this.reloadIfChanged();
    return this.servableFiles.get(key) || null;
  }

  /** Real analysis output for a screen, when an analyzer has produced it. */
  async getAnalysis(screenId: string): Promise<any | null> {
    const screen = await this.getScreen(screenId);
    if (!screen || !screen.hasAnalysis) return null;
    const safeId = screenId.replace(/[^a-zA-Z0-9._-]/g, '');
    if (safeId !== screenId) return null;
    try {
      const file = join(this.root, 'analysis', `${safeId}.json`);
      return JSON.parse(await readFile(file, 'utf-8'));
    } catch (error) {
      this.logger.warn(`Analysis for ${screenId} could not be read: ${error.message}`);
      return null;
    }
  }
}
