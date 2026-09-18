import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join, resolve, sep } from 'path';
import {
  APPROVED_STATUS,
  buildInspirationsManifest,
  FLOW_CATEGORIES,
  IMAGE_EXT,
  INDUSTRIES,
  LOGO_EXT,
  PERMISSIONS,
  PLATFORMS,
  readDimensions,
  readJson,
  REVIEW_STATUSES,
  screenIdFor,
  SCREEN_TYPES,
  STYLES,
  titleCase,
  type BuildReport,
} from './manifest.builder';
import { LoaderService } from './loader.service';

/**
 * Every write into data/inspirations goes through here.
 *
 * Three rules hold for all of them:
 *   1. Paths are rebuilt from validated parts, never taken from the request,
 *      and the result must resolve inside the store.
 *   2. An uploaded file must parse as a real image; the extension is not
 *      trusted on its own.
 *   3. The manifest is rebuilt after each change, so the public API and the
 *      admin view can never disagree about what is published.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BASENAME = /^[a-z0-9][a-z0-9-]{0,80}$/;

export type AdminScreenFile = {
  id: string;
  platform: string;
  appId: string;
  file: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sidecar: Record<string, unknown> | null;
  published: boolean;
  blockedReason: string | null;
};

@Injectable()
export class InspirationsAdminService {
  private readonly logger = new Logger(InspirationsAdminService.name);
  private readonly root: string;
  private readonly maxUploadBytes: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly loader: LoaderService,
  ) {
    const dataRoot = this.configService.get<string>('dataRoot') || './data';
    this.root = resolve(join(dataRoot, 'inspirations'));
    const mb = Number(process.env.INSPIRATIONS_MAX_UPLOAD_MB) || 25;
    this.maxUploadBytes = mb * 1024 * 1024;
  }

  // ─── Validation helpers ───────────────────────────────────────────────────

  private assertSlug(value: string, field: string): string {
    const v = (value || '').trim().toLowerCase();
    if (!SLUG.test(v)) {
      throw new BadRequestException(
        `${field} must be lower-case letters, digits and hyphens (got "${value}")`,
      );
    }
    return v;
  }

  private assertPlatform(platform: string): string {
    const v = (platform || '').trim().toLowerCase();
    if (!(PLATFORMS as readonly string[]).includes(v)) {
      throw new BadRequestException(`platform must be one of ${PLATFORMS.join(', ')}`);
    }
    return v;
  }

  private assertFileName(file: string, allowed: string[]): { base: string; ext: string } {
    const raw = (file || '').trim();
    // A separator or a parent reference in a file name is a mistake or an
    // attack. Refuse it outright: normalising it away would store the upload
    // under a name the caller never asked for.
    if (/[\\/]/.test(raw) || raw.split('.').includes('..')) {
      throw new BadRequestException('file name must not contain a path');
    }

    const name = basename(raw.toLowerCase());
    const ext = extname(name);
    const base = basename(name, ext);
    if (!allowed.includes(ext)) {
      throw new BadRequestException(`file type ${ext || '(none)'} is not accepted; use ${allowed.join(', ')}`);
    }
    if (!BASENAME.test(base)) {
      throw new BadRequestException('file name must be lower-case letters, digits and hyphens');
    }
    return { base, ext };
  }

  /** Rebuilds a path from validated parts and refuses anything outside the store. */
  private inStore(...parts: string[]): string {
    const target = resolve(join(this.root, ...parts));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new BadRequestException('Path is outside the store');
    }
    return target;
  }

  private writeJson(file: string, value: unknown) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  }

  // ─── Reading the whole admin view ─────────────────────────────────────────

  /**
   * Everything the admin UI needs in one call, including files the licensing
   * gate is holding back — those are exactly what the admin has to act on.
   */
  getState() {
    const apps = readJson<{ apps?: any[] }>(join(this.root, 'apps.json'), { apps: [] }).apps || [];
    const sources = readJson<{ sources?: Record<string, any> }>(join(this.root, 'sources.json'), { sources: {} }).sources || {};
    const flows = readJson<{ flows?: any[] }>(join(this.root, 'flows.json'), { flows: [] }).flows || [];
    const manifest = readJson<any>(join(this.root, 'manifest.json'), { counts: {}, screens: [] });
    const publishedIds = new Set<string>((manifest.screens || []).map((s: any) => s.id));

    const files: AdminScreenFile[] = [];
    for (const platform of PLATFORMS) {
      const platformDir = join(this.root, 'screens', platform);
      if (!existsSync(platformDir)) continue;
      for (const entry of readdirSync(platformDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const appId = entry.name;
        const appDir = join(platformDir, appId);
        for (const f of this.listAppImages(appDir)) {
          const abs = join(appDir, f);
          const id = screenIdFor(platform, appId, f);
          let dims: { width: number; height: number } | null = null;
          try {
            dims = readDimensions(abs);
          } catch {
            dims = null;
          }
          const source = sources[appId];
          const published = publishedIds.has(id);
          let blockedReason: string | null = null;
          if (!published) {
            if (!source) blockedReason = 'no licence entry yet';
            else if (source.status !== 'approved') blockedReason = `licence status is "${source.status || 'unset'}"`;
            else if (!apps.some((a) => a.id === appId)) blockedReason = 'app is not listed in apps.json';
            else if (!dims) blockedReason = 'image header could not be read';
            else blockedReason = 'not in the last build';
          }
          files.push({
            id,
            platform,
            appId,
            file: f,
            bytes: statSync(abs).size,
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            sidecar: readJson<Record<string, unknown> | null>(
              join(appDir, `${f.slice(0, f.length - extname(f).length)}.json`),
              null,
            ),
            published,
            blockedReason,
          });
        }
      }
    }

    const logosDir = join(this.root, 'logos');
    const logos = existsSync(logosDir)
      ? readdirSync(logosDir).filter((f) => LOGO_EXT.includes(extname(f).toLowerCase()))
      : [];

    return {
      apps,
      sources,
      flows,
      files: files.sort((a, b) => a.appId.localeCompare(b.appId) || a.file.localeCompare(b.file)),
      logos,
      counts: manifest.counts || {},
      generatedAt: manifest.generatedAt || null,
      vocabulary: {
        platforms: PLATFORMS,
        screenTypes: SCREEN_TYPES,
        industries: INDUSTRIES,
        styles: STYLES,
        // Presets first, then anything this library has actually used, so the
        // category box suggests real history rather than only the defaults.
        flowCategories: Array.from(
          new Set([...FLOW_CATEGORIES, ...flows.map((f: any) => f.category).filter(Boolean)]),
        ),
        permissions: PERMISSIONS,
        reviewStatuses: REVIEW_STATUSES,
      },
    };
  }

  rebuild(): BuildReport {
    const report = buildInspirationsManifest(this.root);
    // The public API caches the manifest; without this it would keep serving
    // the previous one, and a screen that was just approved would 404.
    this.loader.invalidate();
    return report;
  }

  // ─── Screens ──────────────────────────────────────────────────────────────

  uploadScreen(
    platformRaw: string,
    appIdRaw: string,
    fileNameRaw: string,
    body: Buffer,
    overwrite: boolean,
  ) {
    const platform = this.assertPlatform(platformRaw);
    const appId = this.assertSlug(appIdRaw, 'app');
    const { base, ext } = this.assertFileName(fileNameRaw, IMAGE_EXT);

    if (!body || body.length === 0) throw new BadRequestException('Upload was empty');
    if (body.length > this.maxUploadBytes) {
      throw new BadRequestException(
        `Image is larger than the ${Math.round(this.maxUploadBytes / 1024 / 1024)}MB limit`,
      );
    }

    const dir = this.inStore('screens', platform, appId);
    const target = this.inStore('screens', platform, appId, `${base}${ext}`);
    if (existsSync(target) && !overwrite) {
      throw new BadRequestException(`${base}${ext} already exists for ${appId} on ${platform}`);
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(target, body);

    // The extension is a hint; the header decides. A file we cannot measure
    // would be invisible in the gallery, so it is rejected and removed.
    let dims: { width: number; height: number } | null = null;
    try {
      dims = readDimensions(target);
    } catch {
      dims = null;
    }
    if (!dims || !dims.width || !dims.height) {
      rmSync(target, { force: true });
      throw new BadRequestException('That file is not a readable image');
    }

    this.ensurePublishable(appId);

    const report = this.rebuild();
    this.logger.log(`Uploaded screens/${platform}/${appId}/${base}${ext} (${dims.width}x${dims.height})`);
    return {
      id: screenIdFor(platform, appId, `${base}${ext}`),
      file: `${platform}/${appId}/${base}${ext}`,
      width: dims.width,
      height: dims.height,
      bytes: body.length,
      report,
    };
  }

  saveScreenMeta(platformRaw: string, appIdRaw: string, fileNameRaw: string, meta: any) {
    const platform = this.assertPlatform(platformRaw);
    const appId = this.assertSlug(appIdRaw, 'app');
    const { base, ext } = this.assertFileName(fileNameRaw, IMAGE_EXT);

    const image = this.inStore('screens', platform, appId, `${base}${ext}`);
    if (!existsSync(image)) throw new NotFoundException('That screen is not in the store');

    if (meta.screenType && !(SCREEN_TYPES as readonly string[]).includes(meta.screenType)) {
      throw new BadRequestException(`screenType must be one of ${SCREEN_TYPES.join(', ')}`);
    }
    const styles: string[] = Array.isArray(meta.style) ? meta.style : [];
    const badStyle = styles.find((s) => !(STYLES as readonly string[]).includes(s));
    if (badStyle) throw new BadRequestException(`unknown style "${badStyle}"`);

    const sidecar = {
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : titleCase(base),
      screenType: meta.screenType || undefined,
      tags: Array.isArray(meta.tags) ? meta.tags.map(String).filter(Boolean) : [],
      elements: Array.isArray(meta.elements) ? meta.elements.map(String).filter(Boolean) : [],
      style: styles,
      capturedAt: typeof meta.capturedAt === 'string' && meta.capturedAt ? meta.capturedAt : undefined,
    };

    this.writeJson(this.inStore('screens', platform, appId, `${base}.json`), sidecar);
    return { id: screenIdFor(platform, appId, `${base}${ext}`), sidecar, report: this.rebuild() };
  }

  deleteScreen(platformRaw: string, appIdRaw: string, fileNameRaw: string) {
    const platform = this.assertPlatform(platformRaw);
    const appId = this.assertSlug(appIdRaw, 'app');
    const { base, ext } = this.assertFileName(fileNameRaw, IMAGE_EXT);

    const image = this.inStore('screens', platform, appId, `${base}${ext}`);
    if (!existsSync(image)) throw new NotFoundException('That screen is not in the store');

    rmSync(image, { force: true });
    rmSync(this.inStore('screens', platform, appId, `${base}.json`), { force: true });
    rmSync(this.inStore('analysis', `${screenIdFor(platform, appId, `${base}${ext}`)}.json`), { force: true });

    this.logger.log(`Deleted screens/${platform}/${appId}/${base}${ext}`);
    return { report: this.rebuild() };
  }

  // ─── Logos ────────────────────────────────────────────────────────────────

  uploadLogo(appIdRaw: string, fileNameRaw: string, body: Buffer) {
    const appId = this.assertSlug(appIdRaw, 'app');
    const { ext } = this.assertFileName(fileNameRaw, LOGO_EXT);

    if (!body || body.length === 0) throw new BadRequestException('Upload was empty');
    if (body.length > this.maxUploadBytes) throw new BadRequestException('Logo is too large');

    if (ext === '.svg') {
      const text = body.toString('utf-8');
      if (!/<svg[\s>]/i.test(text)) throw new BadRequestException('That file is not an SVG');
      // An SVG is a document: scripts and handlers in one would run wherever
      // the mark is rendered, so they are refused rather than sanitised.
      if (/<script[\s>]|\son\w+\s*=/i.test(text)) {
        throw new BadRequestException('SVG contains script or event handlers');
      }
    }

    const target = this.inStore('logos', `${appId}${ext}`);
    mkdirSync(this.inStore('logos'), { recursive: true });
    writeFileSync(target, body);

    if (ext !== '.svg') {
      // Validate after writing so the header can be read from disk, and undo
      // the write if the file turns out not to be an image.
      const dims = readDimensionsSafe(target);
      if (!dims) {
        rmSync(target, { force: true });
        throw new BadRequestException('That file is not a readable image');
      }
    }

    // One mark per app: drop any other extension so the manifest cannot pick
    // up a stale file.
    for (const other of LOGO_EXT) {
      if (other !== ext) rmSync(this.inStore('logos', `${appId}${other}`), { force: true });
    }

    return { logo: `${appId}${ext}`, report: this.rebuild() };
  }

  // ─── Apps ─────────────────────────────────────────────────────────────────

  saveApp(input: any) {
    const id = this.assertSlug(input?.id, 'app id');
    if (!(INDUSTRIES as readonly string[]).includes(input?.industry)) {
      throw new BadRequestException(`industry must be one of ${INDUSTRIES.join(', ')}`);
    }
    const name = String(input?.name || '').trim();
    if (!name) throw new BadRequestException('name is required');

    const file = join(this.root, 'apps.json');
    const data = readJson<{ version?: number; apps?: any[] }>(file, { version: 1, apps: [] });
    const apps = data.apps || [];

    // Rating and count travel together: a score with no sample size, or a
    // sample size with no score, is half a fact. Sending neither leaves any
    // previously recorded pair untouched.
    const hasRating = input.rating !== undefined && input.rating !== null && input.rating !== '';
    const hasCount = input.ratingCount !== undefined && input.ratingCount !== null && input.ratingCount !== '';
    if (hasRating !== hasCount) {
      throw new BadRequestException('rating and ratingCount must be given together');
    }

    let ratingFields: Record<string, number> = {};
    if (hasRating) {
      const rating = Number(input.rating);
      const ratingCount = Number(input.ratingCount);
      if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
        throw new BadRequestException('rating must be between 0 and 5');
      }
      if (!Number.isInteger(ratingCount) || ratingCount < 0) {
        throw new BadRequestException('ratingCount must be a whole number');
      }
      ratingFields = { rating, ratingCount };
    }

    const record = {
      id,
      name,
      industry: input.industry,
      website: input.website ? String(input.website).trim() : '',
      tagline: input.tagline ? String(input.tagline).trim() : '',
      ...(input.logo ? { logo: String(input.logo) } : {}),
      ...ratingFields,
    };

    const index = apps.findIndex((a) => a.id === id);
    if (index === -1) apps.push(record);
    else apps[index] = { ...apps[index], ...record };

    this.writeJson(file, { version: data.version || 1, apps });
    this.ensurePublishable(id);
    return { app: record, report: this.rebuild() };
  }

  /**
   * Every image stored for one app, relative to its folder.
   *
   * Reads one level of nesting, because automatic capture files screens as
   * `<flow>/1.png` — the folder is the flow and the number is the order it was
   * walked. Manual uploads stay loose in the app folder. Both shapes are valid
   * and both appear here.
   */
  private listAppImages(appDir: string): string[] {
    if (!existsSync(appDir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(appDir, { withFileTypes: true })) {
      if (entry.isFile() && IMAGE_EXT.includes(extname(entry.name).toLowerCase())) {
        out.push(entry.name);
      } else if (entry.isDirectory()) {
        for (const inner of readdirSync(join(appDir, entry.name))) {
          if (IMAGE_EXT.includes(extname(inner).toLowerCase())) out.push(`${entry.name}/${inner}`);
        }
      }
    }
    return out;
  }

  /**
   * Makes sure an app's screens will publish.
   *
   * sources.json is still written — it is where a screen's origin, licence and
   * attribution live, and the manifest reads all of that. What it no longer
   * does is hold anything back: every app gets an approved entry as soon as it
   * has an app record or a screen, so captures reach the gallery without a
   * separate approval step.
   *
   * An entry that already exists keeps its recorded provenance; only its status
   * is raised, so nothing previously filled in by hand is overwritten.
   */
  private ensurePublishable(appId: string) {
    const file = join(this.root, 'sources.json');
    const data = readJson<{ version?: number; sources?: Record<string, any> }>(file, {
      version: 1,
      sources: {},
    });
    const sources = data.sources || {};
    const existing = sources[appId];

    if (existing?.status === APPROVED_STATUS) return;

    sources[appId] = {
      sourceUrl: '',
      capturedAt: new Date().toISOString().slice(0, 10),
      capturedBy: '',
      permission: '',
      license: '',
      licenseUrl: '',
      attribution: '',
      redistribution: 'allowed',
      notes: '',
      ...(existing || {}),
      status: APPROVED_STATUS,
    };

    this.writeJson(file, { version: data.version || 1, sources });
  }

  /**
   * Removes an app and everything stored for it: its screenshots on every
   * platform, their sidecars and analysis files, its logo, its licence entry
   * and its flows.
   *
   * This deletes files. Nothing is copied aside first, so the caller is
   * expected to have confirmed with the person asking; the admin UI names the
   * file count in its confirmation. The returned counts say what went, so the
   * result can be reported rather than assumed.
   */
  deleteApp(appIdRaw: string) {
    const id = this.assertSlug(appIdRaw, 'app id');

    let screensRemoved = 0;
    const analysisRemoved: string[] = [];

    for (const platform of PLATFORMS) {
      const dir = this.inStore('screens', platform, id);
      if (!existsSync(dir)) continue;

      for (const file of this.listAppImages(dir)) {
        screensRemoved++;
        const screenId = screenIdFor(platform, id, file);
        const analysis = this.inStore('analysis', `${screenId}.json`);
        if (existsSync(analysis)) {
          rmSync(analysis, { force: true });
          analysisRemoved.push(screenId);
        }
      }
      // Takes the images and their sidecars with it.
      rmSync(dir, { recursive: true, force: true });
    }

    let logoRemoved: string | null = null;
    for (const ext of LOGO_EXT) {
      const logo = this.inStore('logos', `${id}${ext}`);
      if (existsSync(logo)) {
        rmSync(logo, { force: true });
        logoRemoved = `${id}${ext}`;
      }
    }

    const appsFile = join(this.root, 'apps.json');
    const appsData = readJson<{ version?: number; apps?: any[] }>(appsFile, { version: 1, apps: [] });
    const appExisted = (appsData.apps || []).some((a) => a.id === id);
    this.writeJson(appsFile, {
      version: appsData.version || 1,
      apps: (appsData.apps || []).filter((a) => a.id !== id),
    });

    const sourcesFile = join(this.root, 'sources.json');
    const sourcesData = readJson<{ version?: number; sources?: Record<string, any> }>(sourcesFile, {
      version: 1,
      sources: {},
    });
    const sources = sourcesData.sources || {};
    const sourceExisted = Boolean(sources[id]);
    delete sources[id];
    this.writeJson(sourcesFile, { version: sourcesData.version || 1, sources });

    const flowsFile = join(this.root, 'flows.json');
    const flowsData = readJson<{ version?: number; flows?: any[] }>(flowsFile, { version: 1, flows: [] });
    const keptFlows = (flowsData.flows || []).filter((f) => f.appId !== id);
    const flowsRemoved = (flowsData.flows || []).length - keptFlows.length;
    this.writeJson(flowsFile, { version: flowsData.version || 1, flows: keptFlows });

    this.logger.log(
      `Deleted app ${id}: ${screensRemoved} screenshot(s), ${flowsRemoved} flow(s)` +
        (logoRemoved ? ', logo' : ''),
    );

    return {
      removed: {
        app: appExisted,
        screens: screensRemoved,
        analysis: analysisRemoved.length,
        flows: flowsRemoved,
        logo: logoRemoved,
        source: sourceExisted,
      },
      report: this.rebuild(),
    };
  }

  // ─── Licensing ────────────────────────────────────────────────────────────

  saveSource(appIdRaw: string, input: any) {
    const id = this.assertSlug(appIdRaw, 'app id');

    if (input?.permission && !(PERMISSIONS as readonly string[]).includes(input.permission)) {
      throw new BadRequestException(`permission must be one of ${PERMISSIONS.join(', ')}`);
    }
    const status = input?.status || 'pending';
    if (!(REVIEW_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of ${REVIEW_STATUSES.join(', ')}`);
    }
    const redistribution = input?.redistribution || 'view-only';
    if (!['allowed', 'view-only'].includes(redistribution)) {
      throw new BadRequestException('redistribution must be "allowed" or "view-only"');
    }
    // Approving is the act that publishes screenshots, so it still has to say
    // on what basis. Licence, licence URL and attribution are optional: they
    // are recorded when known and shown on the screen page when present, but
    // several honest bases (own work, editorial reference) have no licence
    // string to quote.
    if (status === 'approved' && !input?.permission) {
      throw new BadRequestException('approved entries need a permission basis');
    }

    const file = join(this.root, 'sources.json');
    const data = readJson<{ version?: number; sources?: Record<string, any> }>(file, { version: 1, sources: {} });
    const sources = data.sources || {};

    sources[id] = {
      sourceUrl: String(input?.sourceUrl || '').trim(),
      capturedAt: String(input?.capturedAt || '').trim(),
      capturedBy: String(input?.capturedBy || '').trim(),
      permission: input?.permission || '',
      license: String(input?.license || '').trim(),
      licenseUrl: String(input?.licenseUrl || '').trim(),
      attribution: String(input?.attribution || '').trim(),
      redistribution,
      status,
      notes: String(input?.notes || '').trim(),
    };

    this.writeJson(file, { version: data.version || 1, sources });
    this.logger.log(`Licence for ${id} set to ${status} / ${redistribution}`);
    return { source: sources[id], report: this.rebuild() };
  }

  // ─── Flows ────────────────────────────────────────────────────────────────

  saveFlow(input: any) {
    const id = this.assertSlug(input?.id, 'flow id');
    const appId = this.assertSlug(input?.appId, 'app id');
    const platform = this.assertPlatform(input?.platform);
    const name = String(input?.name || '').trim();
    if (!name) throw new BadRequestException('name is required');
    // Categories are free text. The presets are suggestions, not a closed set:
    // a library ends up with journeys ("Upgrade", "Invite a teammate") that no
    // fixed list anticipates.
    const category = String(input?.category || '').trim().slice(0, 40);
    if (!category) throw new BadRequestException('category is required');
    const screenIds: string[] = Array.isArray(input?.screenIds) ? input.screenIds.map(String) : [];
    if (screenIds.length < 2) throw new BadRequestException('a flow needs at least two screens');

    const file = join(this.root, 'flows.json');
    const data = readJson<{ version?: number; flows?: any[] }>(file, { version: 1, flows: [] });
    const flows = data.flows || [];
    const record = { id, appId, name, category, platform, screenIds };

    const index = flows.findIndex((f) => f.id === id);
    if (index === -1) flows.push(record);
    else flows[index] = record;

    this.writeJson(file, { version: data.version || 1, flows });
    return { flow: record, report: this.rebuild() };
  }

  deleteFlow(flowIdRaw: string) {
    const id = this.assertSlug(flowIdRaw, 'flow id');
    const file = join(this.root, 'flows.json');
    const data = readJson<{ version?: number; flows?: any[] }>(file, { version: 1, flows: [] });
    this.writeJson(file, { version: data.version || 1, flows: (data.flows || []).filter((f) => f.id !== id) });
    return { report: this.rebuild() };
  }
}

function readDimensionsSafe(file: string) {
  try {
    return readDimensions(file);
  } catch {
    return null;
  }
}
