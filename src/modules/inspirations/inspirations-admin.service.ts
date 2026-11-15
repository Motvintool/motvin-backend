import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join, resolve, sep } from 'path';
import {
  APPROVED_STATUS,
  buildInspirationsManifest,
  currentVersionId,
  dayLabel,
  localDateString,
  FLOW_CATEGORIES,
  IMAGE_EXT,
  INDUSTRIES,
  listAppScreenFiles,
  LOGO_EXT,
  PERMISSIONS,
  PLATFORMS,
  readDimensions,
  readJson,
  REVIEW_STATUSES,
  screenIdFor,
  SCREEN_STATES,
  SCREEN_TYPES,
  STYLES,
  MAX_FRESH_DAYS,
  readLibrarySettings,
  titleCase,
  VERSION_DIR_RE,
  VERSIONS_DIR_NAME,
  type BuildReport,
} from './manifest.builder';
import { LoaderService } from './loader.service';

/** The few image calls the tone check needs (see `tagScreenTone`). */
type ImageOps = {
  metadata(): Promise<{ width?: number; height?: number }>;
  extract(region: { left: number; top: number; width: number; height: number }): ImageOps;
  resize(width: number, height: number, options?: { fit?: string }): ImageOps;
  removeAlpha(): ImageOps;
  toColourspace(space: string): ImageOps;
  raw(): ImageOps;
  toBuffer(): Promise<Buffer>;
};
// sharp's types sit behind its package "exports", which this project's module resolution does not read.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp: (input: string) => ImageOps = require('sharp');

/**
 * How bright (0–1, perceived) the bottom of a screenshot can be and still
 * read as a dark screen — where the gallery's hover footer sits over it.
 * Measured on screens the recorder tagged: its dark ones all fall below
 * 0.43 there, its light ones at or above it.
 */
const DARK_BELOW = 0.42;

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
/** How many screens an app's card carousel can show — the web card caps its dots at the same number. */
const MAX_CARD_SCREENS = 4;
const BASENAME = /^[a-z0-9][a-z0-9-]{0,80}$/;

export type AdminScreenFile = {
  id: string;
  platform: string;
  appId: string;
  file: string;
  bytes: number;
  /** Modification time in ms — a cache-buster for the image URL, so a recapture never shows a cached frame. */
  mtime: number;
  width: number | null;
  height: number | null;
  sidecar: Record<string, unknown> | null;
  published: boolean;
  blockedReason: string | null;
  /** Which dated capture this file belongs to, e.g. "2026-09-29". */
  version: string;
};

export type AdminAppVersion = {
  id: string;
  label: string;
  capturedAt: string;
  isLatest: boolean;
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

  /** Empty (legacy, no subfolder) or a validated `YYYY-MM-DD` version segment. */
  private assertVersion(value: string | undefined | null): string {
    const v = (value || '').trim();
    if (!v) return '';
    if (!VERSION_DIR_RE.test(v)) throw new BadRequestException('version must be in YYYY-MM-DD form');
    return v;
  }

  /** Empty (loose file, no flow) or a validated flow folder name. */
  private assertFlow(value: string | undefined | null): string {
    const v = (value || '').trim().toLowerCase();
    if (!v) return '';
    if (!BASENAME.test(v)) throw new BadRequestException('flow must be lower-case letters, digits and hyphens');
    return v;
  }

  /**
   * The path segments for a screen file: `versions/<id>/` and the flow
   * folder included when there are any. Never lets either travel as part of
   * the file NAME — a version or a flow is always its own path segment, so
   * the leaf name callers pass in never has to carry a `/` that the route
   * layer would otherwise have to decode back out of a single `:file` param.
   */
  private screenPathParts(platform: string, appId: string, version: string, flow: string, name: string): string[] {
    const parts = ['screens', platform, appId];
    if (version) parts.push(VERSIONS_DIR_NAME, version);
    if (flow) parts.push(flow);
    parts.push(name);
    return parts;
  }

  /** The id/URL path for a screen file — version- and flow-qualified to match the manifest builder. */
  private qualifiedFile(version: string, flow: string, name: string): string {
    return `${version ? `${VERSIONS_DIR_NAME}/${version}/` : ''}${flow ? `${flow}/` : ''}${name}`;
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
    // Where each published screen sits in the manifest — the order the public
    // app page shows them in (by capture moment, then flow and step, then
    // name; see the builder). The admin tabs list files in that same order,
    // so a version's screens or a card-carousel pool reads like the app page
    // rather than like a folder walk that puts "browsing/1" before the splash.
    const manifestOrder = new Map<string, number>((manifest.screens || []).map((s: any, i: number) => [s.id, i]));

    const files: AdminScreenFile[] = [];
    for (const platform of PLATFORMS) {
      const platformDir = join(this.root, 'screens', platform);
      if (!existsSync(platformDir)) continue;
      for (const entry of readdirSync(platformDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const appId = entry.name;
        const appDir = join(platformDir, appId);
        const source = sources[appId];

        for (const entryFile of listAppScreenFiles(appDir)) {
          const { file: f, bucketRelFile, bucketRoot } = entryFile;
          const abs = join(bucketRoot, bucketRelFile);
          const id = screenIdFor(platform, appId, f);
          const sidecar = readJson<Record<string, unknown> | null>(
            join(bucketRoot, `${bucketRelFile.slice(0, bucketRelFile.length - extname(bucketRelFile).length)}.json`),
            null,
          );
          // A legacy screen's own recorded capture date decides its version
          // when it has one, mirroring the manifest builder's rule — a later
          // ingest overwriting the app's shared source record can't
          // retroactively relabel a screen that already carries its own date.
          const versionId =
            entryFile.versionId ||
            ((sidecar as any)?.capturedAt || source?.capturedAt || localDateString()).slice(0, 10);
          let dims: { width: number; height: number } | null = null;
          try {
            dims = readDimensions(abs);
          } catch {
            dims = null;
          }
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
            version: versionId,
            bytes: statSync(abs).size,
            mtime: Math.floor(statSync(abs).mtimeMs),
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            sidecar,
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
      apps: apps.map((a: any) => ({ ...a, versions: this.computeVersions(a.id, files) })),
      sources,
      flows,
      files: files.sort((a, b) => {
        if (a.appId !== b.appId) return a.appId.localeCompare(b.appId);
        // Published screens in manifest order; files held back come after, by name.
        const oa = manifestOrder.get(a.id) ?? Number.POSITIVE_INFINITY;
        const ob = manifestOrder.get(b.id) ?? Number.POSITIVE_INFINITY;
        if (oa !== ob) return oa - ob;
        return a.file.localeCompare(b.file, undefined, { numeric: true });
      }),
      logos,
      counts: manifest.counts || {},
      settings: readLibrarySettings(this.root),
      generatedAt: manifest.generatedAt || null,
      vocabulary: {
        platforms: PLATFORMS,
        // The built-in values first, then any new ones the library already uses, so the admin's pickers offer
        // everything a screen can be filed under.
        screenTypes: Array.from(new Set([...SCREEN_TYPES, ...(manifest.taxonomy?.screenTypes ?? [])])),
        states: Array.from(new Set([...SCREEN_STATES, ...(manifest.taxonomy?.states ?? [])])),
        industries: INDUSTRIES,
        styles: Array.from(new Set([...STYLES, ...(manifest.taxonomy?.styles ?? [])])),
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

  /** When the manifest was last rebuilt (ms), so the folder watcher can skip changes a rebuild already covered. */
  lastRebuildAt = 0;

  rebuild(): BuildReport {
    const report = buildInspirationsManifest(this.root);
    this.lastRebuildAt = Date.now();
    // The public API caches the manifest; without this it would keep serving
    // the previous one, and a screen that was just approved would 404.
    this.loader.invalidate();
    return report;
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  /**
   * Saves the library's general settings — for now how long the "Latest"
   * and "Updated" app tags last — and rebuilds, so the public pages pick them
   * up. Only the fields sent change; the rest keep their saved values.
   */
  saveSettings(input: unknown) {
    const body = (input && typeof input === 'object' ? input : {}) as { freshness?: Record<string, unknown> };
    const current = readLibrarySettings(this.root);
    const days = (key: 'newDays' | 'updatedDays', label: string) => {
      const value = body.freshness?.[key];
      if (value === undefined) return current.freshness[key];
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > MAX_FRESH_DAYS) {
        throw new BadRequestException(`${label} must be a whole number of days from 0 to ${MAX_FRESH_DAYS}`);
      }
      return n;
    };
    const settings = {
      ...current,
      freshness: { newDays: days('newDays', '"Latest"'), updatedDays: days('updatedDays', '"Updated"') },
    };
    this.writeJson(join(this.root, 'settings.json'), settings);
    return { settings, report: this.rebuild() };
  }

  // ─── Screens ──────────────────────────────────────────────────────────────

  uploadScreen(
    platformRaw: string,
    appIdRaw: string,
    fileNameRaw: string,
    body: Buffer,
    overwrite: boolean,
    versionRaw?: string,
    flowRaw?: string,
    /**
     * Filed as this screen type (lower-case letters, digits and hyphens), and
     * appended to the end of this flow of the same app (its recorded steps
     * kept) — what the admin's "Add screens" picks, so a screenshot added by
     * hand isn't left as an "Other" screen in no flow.
     */
    options: { screenType?: string; addToFlow?: string } = {},
  ) {
    const platform = this.assertPlatform(platformRaw);
    const appId = this.assertSlug(appIdRaw, 'app');
    const { base, ext } = this.assertFileName(fileNameRaw, IMAGE_EXT);
    const screenType = options.screenType?.trim().toLowerCase() || '';
    if (screenType && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(screenType)) {
      throw new BadRequestException('screenType must be lower-case letters, digits and hyphens');
    }
    const addToFlow = options.addToFlow?.trim() ? this.assertSlug(options.addToFlow.trim(), 'flow id') : '';
    const flowsFile = join(this.root, 'flows.json');
    const flowsData = addToFlow ? readJson<{ version?: number; flows?: any[] }>(flowsFile, { version: 1, flows: [] }) : null;
    const joining = flowsData?.flows?.find((f) => f.id === addToFlow && f.appId === appIdRaw) ?? null;
    if (addToFlow && !joining) throw new NotFoundException(`${addToFlow} is not a flow of ${appIdRaw}`);
    // A fresh upload with no version named defaults to the app's newest
    // existing version, or today when it has none yet — new screens land in
    // a dated folder rather than the undated legacy bucket.
    const version = versionRaw !== undefined ? this.assertVersion(versionRaw) : this.currentTargetVersion(appId);
    const flow = this.assertFlow(flowRaw);

    if (!body || body.length === 0) throw new BadRequestException('Upload was empty');
    if (body.length > this.maxUploadBytes) {
      throw new BadRequestException(
        `Image is larger than the ${Math.round(this.maxUploadBytes / 1024 / 1024)}MB limit`,
      );
    }

    const dirParts = ['screens', platform, appId];
    if (version) dirParts.push(VERSIONS_DIR_NAME, version);
    if (flow) dirParts.push(flow);
    const dir = this.inStore(...dirParts);
    const target = this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}${ext}`));
    if (existsSync(target) && !overwrite) {
      throw new BadRequestException(`${base}${ext} already exists for ${appId} on ${platform}${version ? ` (${version})` : ''}`);
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

    const file = this.qualifiedFile(version, flow, `${base}${ext}`);
    const id = screenIdFor(platform, appId, file);
    if (screenType) {
      const sidecarFile = this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}.json`));
      this.writeJson(sidecarFile, { ...readJson<Record<string, unknown>>(sidecarFile, {}), screenType });
    }
    if (joining && flowsData && !joining.screenIds.includes(id)) {
      joining.screenIds = [...joining.screenIds, id];
      if (Array.isArray(joining.steps)) joining.steps = [...joining.steps, { screenId: id, action: null }];
      this.writeJson(flowsFile, { version: flowsData.version || 1, flows: flowsData.flows });
    }

    const report = this.rebuild();
    this.logger.log(`Uploaded screens/${platform}/${appId}/${file} (${dims.width}x${dims.height})`);
    // Dark or light, told from its pixels, once the upload has answered (not under test, where the
    // throwaway store is gone by the time it would finish; tests call it directly).
    if (process.env.NODE_ENV !== 'test') {
      void this.tagScreenTone(platform, appId, `${base}${ext}`, version, flow);
    }
    return {
      id,
      file: `${platform}/${appId}/${file}`,
      width: dims.width,
      height: dims.height,
      bytes: body.length,
      report,
    };
  }

  saveScreenMeta(platformRaw: string, appIdRaw: string, fileNameRaw: string, meta: any, versionRaw?: string, flowRaw?: string) {
    const platform = this.assertPlatform(platformRaw);
    const appId = this.assertSlug(appIdRaw, 'app');
    const { base, ext } = this.assertFileName(fileNameRaw, IMAGE_EXT);
    const version = this.assertVersion(versionRaw);
    const flow = this.assertFlow(flowRaw);

    const image = this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}${ext}`));
    if (!existsSync(image)) throw new NotFoundException('That screen is not in the store');

    // Types, styles and states outside the built-in lists are new values, not errors — the library grows its
    // own vocabulary, and the filters pick a new value up on the next manifest build. They only have to be
    // filter-safe: lower-case letters, digits and hyphens.
    const TAXONOMY_VALUE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    const screenType = typeof meta.screenType === 'string' ? meta.screenType.trim().toLowerCase() : '';
    if (screenType && !TAXONOMY_VALUE.test(screenType)) {
      throw new BadRequestException('screenType must be lower-case letters, digits and hyphens');
    }
    const styles: string[] = Array.isArray(meta.style) ? meta.style.map((s: unknown) => String(s).trim().toLowerCase()) : [];
    const badStyle = styles.find((s) => !TAXONOMY_VALUE.test(s));
    if (badStyle) throw new BadRequestException(`style "${badStyle}" must be lower-case letters, digits and hyphens`);

    const states: string[] = Array.isArray(meta.states) ? meta.states.map((v: unknown) => String(v).trim().toLowerCase()) : [];
    const badState = states.find((v) => !TAXONOMY_VALUE.test(v));
    if (badState) throw new BadRequestException(`state "${badState}" must be lower-case letters, digits and hyphens`);

    // Fields automatic capture wrote and the form does not edit are carried
    // over, so saving a name never wipes a description or the capture facts.
    const sidecarFile = this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}.json`));
    const existing = readJson<Record<string, unknown>>(sidecarFile, {});
    const sidecar = {
      ...existing,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : titleCase(base),
      screenType: screenType || undefined,
      states,
      description:
        typeof meta.description === 'string' ? meta.description.trim().slice(0, 600) : (existing.description as string | undefined) ?? '',
      tags: Array.isArray(meta.tags) ? meta.tags.map(String).filter(Boolean) : [],
      // More types the screen also is, up to four; the main one is screenType.
      extraTypes: Array.isArray(meta.extraTypes)
        ? Array.from(new Set(meta.extraTypes.map((t: unknown) => String(t).trim().toLowerCase()).filter((t: string) => TAXONOMY_VALUE.test(t) && t !== screenType && t !== 'other'))).slice(0, 4)
        : (existing.extraTypes as string[] | undefined),
      elements: Array.isArray(meta.elements) ? meta.elements.map(String).filter(Boolean) : [],
      style: styles,
      capturedAt: typeof meta.capturedAt === 'string' && meta.capturedAt ? meta.capturedAt : (existing.capturedAt as string | undefined),
    };
    // A tag an admin typed is a word the library means to have: it joins the
    // shared list (tags.json), which is what the manifest keeps tags from.
    this.addToTagList(sidecar.tags);

    this.writeJson(sidecarFile, sidecar);
    const file = this.qualifiedFile(version, flow, `${base}${ext}`);
    return { id: screenIdFor(platform, appId, file), sidecar, report: this.rebuild() };
  }

  /**
   * Tags a screen `dark` or `light` from its own pixels when it has neither —
   * as the recorder does for the screens it captures, but a screenshot added
   * by hand arrives with no style at all, and the gallery's hover footer then
   * stays light over a black screen. Judged on the bottom part of the image,
   * where that footer sits. Rebuilds the library when it tags one; never
   * throws (a screen it can't read is simply left as it was).
   */
  async tagScreenTone(platform: string, appId: string, fileName: string, version: string, flow: string): Promise<'dark' | 'light' | null> {
    const { base } = this.assertFileName(fileName, IMAGE_EXT);
    const image = this.inStore(...this.screenPathParts(platform, appId, version, flow, fileName));
    const sidecarFile = this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}.json`));
    const toned = () => {
      const style = readJson<Record<string, unknown>>(sidecarFile, {}).style;
      return Array.isArray(style) && style.some((s) => s === 'dark' || s === 'light');
    };
    try {
      if (toned()) return null;
      const { width = 0, height = 0 } = await sharp(image).metadata();
      if (!width || !height) return null;
      const top = Math.round(height * 0.6);
      const pixels = await sharp(image)
        .extract({ left: 0, top, width, height: height - top })
        .resize(24, 24, { fit: 'fill' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer();
      let sum = 0;
      for (let i = 0; i + 2 < pixels.length; i += 3) sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      const brightness = sum / (pixels.length / 3) / 255;
      const tone = brightness < DARK_BELOW ? 'dark' : 'light';
      // Gone meanwhile (deleted), or tagged meanwhile (saved by hand): leave it.
      if (!existsSync(image) || toned()) return null;
      const existing = readJson<Record<string, unknown>>(sidecarFile, {});
      const style = Array.isArray(existing.style) ? existing.style.map(String) : [];
      this.writeJson(sidecarFile, { ...existing, style: [...style, tone] });
      this.rebuild();
      this.logger.log(`Tagged ${platform}/${appId}/${this.qualifiedFile(version, flow, fileName)} as ${tone} (brightness ${brightness.toFixed(2)})`);
      return tone;
    } catch (error) {
      this.logger.warn(`Could not tell whether ${fileName} is dark or light: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * The order a version's screens show in, set by hand in the admin: each
   * listed screen's sidecar gets its position as `order`, and the library is
   * rebuilt once (not once a screen). Every entry is checked before anything
   * is written, so a bad one changes nothing. Screens the list leaves out
   * keep their automatic place, after the ordered ones.
   */
  saveVersionOrder(appIdRaw: string, versionRaw: string, screens: unknown) {
    const appId = this.assertSlug(appIdRaw, 'app');
    const version = this.assertVersion(versionRaw);
    if (!version) throw new BadRequestException('A version is required');
    if (!Array.isArray(screens) || screens.length === 0) throw new BadRequestException('screens must be a non-empty list');
    const sidecars = screens.map((entry: any) => {
      const platform = this.assertPlatform(String(entry?.platform ?? ''));
      const { base, ext } = this.assertFileName(String(entry?.file ?? ''), IMAGE_EXT);
      const flow = this.assertFlow(entry?.flow);
      const image = this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}${ext}`));
      if (!existsSync(image)) throw new NotFoundException(`${base}${ext} is not in this version`);
      return this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}.json`));
    });
    sidecars.forEach((sidecarFile, order) => {
      this.writeJson(sidecarFile, { ...readJson<Record<string, unknown>>(sidecarFile, {}), order });
    });
    return { report: this.rebuild() };
  }

  /** Adds tags to the shared list the manifest keeps tags from (tags.json), when it exists. */
  private addToTagList(tags: string[]) {
    const file = join(this.root, 'tags.json');
    if (!existsSync(file) || !tags.length) return;
    const doc = readJson<{ version?: number; tags?: Array<string | { slug?: string }> }>(file, { version: 1, tags: [] });
    const have = new Set((doc.tags || []).map((tag) => (typeof tag === 'string' ? tag : tag?.slug ?? '')));
    const added = tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(tag) && !have.has(tag));
    if (!added.length) return;
    this.writeJson(file, { version: doc.version || 1, tags: [...(doc.tags || []), ...added] });
  }

  deleteScreen(platformRaw: string, appIdRaw: string, fileNameRaw: string, versionRaw?: string, flowRaw?: string) {
    const platform = this.assertPlatform(platformRaw);
    const appId = this.assertSlug(appIdRaw, 'app');
    const { base, ext } = this.assertFileName(fileNameRaw, IMAGE_EXT);
    const version = this.assertVersion(versionRaw);
    const flow = this.assertFlow(flowRaw);

    const image = this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}${ext}`));
    if (!existsSync(image)) throw new NotFoundException('That screen is not in the store');

    rmSync(image, { force: true });
    rmSync(this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}.json`)), { force: true });
    const file = this.qualifiedFile(version, flow, `${base}${ext}`);
    const screenId = screenIdFor(platform, appId, file);
    rmSync(this.inStore('analysis', `${screenId}.json`), { force: true });
    rmSync(this.inStore('words', `${screenId}.json`), { force: true });

    // The screen leaves every flow it was a step of: a flow pointing at a
    // screen that no longer exists would show a gap where it was.
    const flowsFile = join(this.root, 'flows.json');
    const flowsData = readJson<{ version?: number; flows?: any[] }>(flowsFile, { version: 1, flows: [] });
    let flowsChanged = 0;
    for (const entry of flowsData.flows || []) {
      if (entry.appId !== appId) continue;
      const before = (entry.screenIds ?? []).length + (entry.steps ?? []).length;
      if (Array.isArray(entry.screenIds)) entry.screenIds = entry.screenIds.filter((id: string) => id !== screenId);
      if (Array.isArray(entry.steps)) entry.steps = entry.steps.filter((step: { screenId?: string }) => step?.screenId !== screenId);
      if ((entry.screenIds ?? []).length + (entry.steps ?? []).length !== before) flowsChanged++;
    }
    if (flowsChanged) this.writeJson(flowsFile, { version: flowsData.version || 1, flows: flowsData.flows });

    this.logger.log(`Deleted screens/${platform}/${appId}/${file}${flowsChanged ? ` (taken out of ${flowsChanged} flow(s))` : ''}`);
    return { report: this.rebuild() };
  }

  // ─── Versions ─────────────────────────────────────────────────────────────

  /** The version a fresh write should land in when the caller does not name one. */
  private currentTargetVersion(appId: string): string {
    return this.listVersions(appId)[0]?.id || currentVersionId();
  }

  /**
   * An app's versions, newest first — mirroring the grouping
   * `manifest.builder.ts` computes at build time (see `versionsForApp`
   * there) from the same files and the same "earliest capturedAt in the
   * bucket" rule. `isLatest` is always the newest by date; renaming a
   * version's date (see `renameVersion`) is the only way to change which
   * one that is.
   */
  private computeVersions(appId: string, files: AdminScreenFile[]): AdminAppVersion[] {
    const datesByVersion = new Map<string, string[]>();
    for (const f of files) {
      if (f.appId !== appId) continue;
      if (!datesByVersion.has(f.version)) datesByVersion.set(f.version, []);
      const capturedAt = (f.sidecar as any)?.capturedAt;
      if (typeof capturedAt === 'string' && capturedAt) datesByVersion.get(f.version)!.push(capturedAt);
    }
    const entries = Array.from(datesByVersion.entries())
      .map(([id, dates]) => ({ id, capturedAt: dates.length ? dates.slice().sort()[0] : `${id}-01` }))
      .sort((a, b) => b.id.localeCompare(a.id));
    const newestId = entries[0]?.id ?? null;
    return entries.map((e) => ({
      id: e.id,
      label: dayLabel(e.id),
      capturedAt: e.capturedAt,
      isLatest: e.id === newestId,
    }));
  }

  listVersions(appIdRaw: string): AdminAppVersion[] {
    const appId = this.assertSlug(appIdRaw, 'app id');
    return (this.getState().apps as any[]).find((a) => a.id === appId)?.versions ?? [];
  }

  /**
   * Renames a dated version — its folder on every platform, its screens'
   * analysis records, and every id in flows.json built from it (a flow's own
   * id, its parentId, its screenIds, and its steps' screenIds all embed the
   * version the same way a screen id does). This is the only way to change
   * which version is "Latest" now that there is no manual pin: a version
   * becomes newest by carrying the newest date.
   */
  renameVersion(appIdRaw: string, oldVersionIdRaw: string, newVersionIdRaw: string) {
    const appId = this.assertSlug(appIdRaw, 'app id');
    const oldVersionId = this.assertVersion(oldVersionIdRaw);
    const newVersionId = this.assertVersion(newVersionIdRaw);
    if (!oldVersionId || !newVersionId) throw new BadRequestException('both dates are required');
    if (oldVersionId === newVersionId) throw new BadRequestException("that is already this version's date");

    const available = this.listVersions(appId);
    if (!available.some((v) => v.id === oldVersionId)) {
      throw new BadRequestException(`"${oldVersionId}" is not a known version of ${appId}`);
    }
    if (available.some((v) => v.id === newVersionId)) {
      throw new BadRequestException(`${appId} already has a version dated ${newVersionId}`);
    }
    const hasVersionFolder = PLATFORMS.some((platform) =>
      existsSync(this.inStore('screens', platform, appId, VERSIONS_DIR_NAME, oldVersionId)),
    );
    if (!hasVersionFolder) {
      throw new BadRequestException(
        `${dayLabel(oldVersionId)} is ${appId}'s undated capture, grouped by date rather than stored in a dated folder — it can't be renamed directly.`,
      );
    }

    for (const platform of PLATFORMS) {
      const oldDir = this.inStore('screens', platform, appId, VERSIONS_DIR_NAME, oldVersionId);
      if (!existsSync(oldDir)) continue;
      const newDir = this.inStore('screens', platform, appId, VERSIONS_DIR_NAME, newVersionId);
      renameSync(oldDir, newDir);

      for (const file of this.listImagesOneLevel(newDir)) {
        const oldId = screenIdFor(platform, appId, `${VERSIONS_DIR_NAME}/${oldVersionId}/${file}`);
        const newId = screenIdFor(platform, appId, `${VERSIONS_DIR_NAME}/${newVersionId}/${file}`);
        const oldAnalysis = this.inStore('analysis', `${oldId}.json`);
        if (existsSync(oldAnalysis)) {
          renameSync(oldAnalysis, this.inStore('analysis', `${newId}.json`));
        }
      }
    }

    // A screen or flow id is `<appId>-<platform>-versions-<versionId>-...`;
    // remapping that one shared prefix per platform catches flow ids, their
    // parentId, their screenIds, and their steps' screenIds all at once.
    const flowsFile = join(this.root, 'flows.json');
    const flowsData = readJson<{ version?: number; flows?: any[] }>(flowsFile, { version: 1, flows: [] });
    const flows = flowsData.flows || [];
    const remap = (id: string): string => {
      for (const platform of PLATFORMS) {
        const oldPrefix = `${appId}-${platform}-${VERSIONS_DIR_NAME}-${oldVersionId}-`;
        if (id.startsWith(oldPrefix)) {
          return `${appId}-${platform}-${VERSIONS_DIR_NAME}-${newVersionId}-${id.slice(oldPrefix.length)}`;
        }
      }
      return id;
    };
    let flowsChanged = false;
    for (const flow of flows) {
      if (flow.appId !== appId) continue;
      const remappedId = remap(flow.id);
      if (remappedId !== flow.id) {
        flow.id = remappedId;
        flowsChanged = true;
      }
      if (flow.parentId) {
        const remappedParent = remap(flow.parentId);
        if (remappedParent !== flow.parentId) {
          flow.parentId = remappedParent;
          flowsChanged = true;
        }
      }
      if (Array.isArray(flow.screenIds)) {
        const remapped = flow.screenIds.map(remap);
        if (remapped.some((id: string, i: number) => id !== flow.screenIds[i])) {
          flow.screenIds = remapped;
          flowsChanged = true;
        }
      }
      if (Array.isArray(flow.steps)) {
        for (const step of flow.steps) {
          if (step?.screenId) {
            const remapped = remap(step.screenId);
            if (remapped !== step.screenId) {
              step.screenId = remapped;
              flowsChanged = true;
            }
          }
        }
      }
    }
    if (flowsChanged) this.writeJson(flowsFile, { version: flowsData.version || 1, flows });

    this.logger.log(`Renamed ${appId}'s version ${oldVersionId} to ${newVersionId}`);
    return { versions: this.listVersions(appId), report: this.rebuild() };
  }

  /**
   * Every image directly in a folder, plus one level of flow subfolders —
   * the same loose-file-or-`<flow>/<n>.png` shape every version and the
   * legacy bucket share. Scoped to a single directory (unlike
   * `listAppScreenFiles`, which walks every version bucket at once) so
   * `deleteVersion` can remove exactly one version's images.
   */
  private listImagesOneLevel(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && IMAGE_EXT.includes(extname(entry.name).toLowerCase())) {
        out.push(entry.name);
      } else if (entry.isDirectory()) {
        for (const inner of readdirSync(join(dir, entry.name))) {
          if (IMAGE_EXT.includes(extname(inner).toLowerCase())) out.push(`${entry.name}/${inner}`);
        }
      }
    }
    return out;
  }

  /**
   * Removes an entire dated version: its screens and sidecars on every
   * platform, and their analysis records — the version-scoped counterpart to
   * `deleteApp`. Refuses an app's only version, since that would silently
   * empty it rather than deleting it; `deleteApp` is the deliberate action
   * for that.
   */
  deleteVersion(appIdRaw: string, versionIdRaw: string) {
    const appId = this.assertSlug(appIdRaw, 'app id');
    const versionId = this.assertVersion(versionIdRaw);
    if (!versionId) throw new BadRequestException('version is required');

    const available = this.listVersions(appId);
    if (!available.some((v) => v.id === versionId)) {
      throw new BadRequestException(`"${versionId}" is not a known version of ${appId}`);
    }
    if (available.length <= 1) {
      throw new BadRequestException(`${appId} has only one version — delete the app if you want it gone entirely.`);
    }

    let screensRemoved = 0;
    const analysisRemoved: string[] = [];
    for (const platform of PLATFORMS) {
      const dir = this.inStore('screens', platform, appId, VERSIONS_DIR_NAME, versionId);
      if (!existsSync(dir)) continue;
      for (const file of this.listImagesOneLevel(dir)) {
        screensRemoved++;
        // `file` is already relative to the version folder (possibly with its
        // own flow segment, e.g. "onboarding/1.png") — `qualifiedFile` is for
        // composing a single leaf name with version/flow segments known
        // separately, which isn't the shape here, so this is built directly.
        const screenId = screenIdFor(platform, appId, `${VERSIONS_DIR_NAME}/${versionId}/${file}`);
        const analysis = this.inStore('analysis', `${screenId}.json`);
        if (existsSync(analysis)) {
          rmSync(analysis, { force: true });
          analysisRemoved.push(screenId);
        }
        // The text read off the screen goes with it.
        const words = this.inStore('words', `${screenId}.json`);
        if (existsSync(words)) rmSync(words, { force: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }

    // The version's flows go too: a flow id is `<appId>-<platform>-versions-
    // <versionId>-…`, so every flow of this version shares that prefix. Left
    // behind, they would point at screens that no longer exist.
    const flowsFile = join(this.root, 'flows.json');
    const flowsData = readJson<{ version?: number; flows?: any[] }>(flowsFile, { version: 1, flows: [] });
    const prefixes = PLATFORMS.map((platform) => `${appId}-${platform}-${VERSIONS_DIR_NAME}-${versionId}-`);
    const ofVersion = (id: unknown) => typeof id === 'string' && prefixes.some((prefix) => id.startsWith(prefix));
    const keptFlows = (flowsData.flows || []).filter((flow) => !(flow.appId === appId && ofVersion(flow.id)));
    const flowsRemoved = (flowsData.flows || []).length - keptFlows.length;
    if (flowsRemoved) this.writeJson(flowsFile, { version: flowsData.version || 1, flows: keptFlows });

    this.logger.log(`Deleted version ${versionId} of ${appId}: ${screensRemoved} screenshot(s), ${flowsRemoved} flow(s)`);
    return { removed: { screens: screensRemoved, analysis: analysisRemoved.length, flows: flowsRemoved }, report: this.rebuild() };
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

    // The screens an admin picked for the app's card carousel, in order. Left
    // out of the request, any earlier pick stays; sent as an empty list, the
    // card goes back to choosing automatically (see coverScreen on the web).
    let cardFields: { cardScreens?: string[] } = {};
    if (input.cardScreens !== undefined && input.cardScreens !== null) {
      cardFields = { cardScreens: this.readCardScreens(id, input.cardScreens) };
    }

    // Where the app lives: iOS, Web Apps, Webs. Left out of the request, an earlier pick stays; sent as an
    // empty list it is cleared (the screens an app has still say where it is).
    let platformFields: { platforms?: string[] } = {};
    if (input.platforms !== undefined && input.platforms !== null) {
      const known = PLATFORMS as readonly string[];
      if (!Array.isArray(input.platforms) || input.platforms.some((v: unknown) => typeof v !== 'string' || !known.includes(v))) {
        throw new BadRequestException(`platforms must be a list of ${PLATFORMS.join(', ')}`);
      }
      platformFields = { platforms: PLATFORMS.filter((p) => (input.platforms as string[]).includes(p)) };
    }

    // Who set the category. A change made here is a person's call; an unchanged
    // one keeps whatever source it already had (the crawler records `store`/`ai`).
    const previous = apps.find((a) => a.id === id);
    const industrySource = previous && previous.industry === input.industry ? previous.industrySource : 'manual';

    const record = {
      id,
      name,
      industry: input.industry,
      ...(industrySource ? { industrySource } : {}),
      website: input.website ? String(input.website).trim() : '',
      tagline: input.tagline ? String(input.tagline).trim() : '',
      ...(input.logo ? { logo: String(input.logo) } : {}),
      ...ratingFields,
      ...cardFields,
      ...platformFields,
    };

    const index = apps.findIndex((a) => a.id === id);
    if (index === -1) apps.push(record);
    else apps[index] = { ...apps[index], ...record };

    this.writeJson(file, { version: data.version || 1, apps });
    this.ensurePublishable(id);
    return { app: record, report: this.rebuild() };
  }

  /**
   * Validates the ids picked for an app's card carousel: strings, no
   * repeats, at most MAX_CARD_SCREENS per platform (Claude has four on iOS and
   * four on the web, each section's card its own), and every one a screen actually stored
   * for this app — a card pointing at another app's screen, or at one that
   * was deleted, would be a silent blank in the gallery.
   */
  private readCardScreens(appId: string, raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
      throw new BadRequestException('cardScreens must be a list of screen ids');
    }
    const ids = Array.from(new Set((raw as string[]).map((v) => v.trim()).filter(Boolean)));
    for (const platform of PLATFORMS) {
      if (ids.filter((sid) => sid.startsWith(`${appId}-${platform}-`)).length > MAX_CARD_SCREENS) {
        throw new BadRequestException(`cardScreens may hold at most ${MAX_CARD_SCREENS} screens per platform`);
      }
    }
    const stored = this.storedScreenIds(appId);
    const unknown = ids.filter((sid) => !stored.has(sid));
    if (unknown.length) {
      throw new BadRequestException(`cardScreens: not stored for "${appId}": ${unknown.join(', ')}`);
    }
    return ids;
  }

  /** Every screen id currently on disk for an app, across platforms and versions. */
  private storedScreenIds(appId: string): Set<string> {
    const ids = new Set<string>();
    for (const platform of PLATFORMS) {
      const dir = join(this.root, 'screens', platform, appId);
      if (!existsSync(dir)) continue;
      for (const entry of listAppScreenFiles(dir)) ids.add(screenIdFor(platform, appId, entry.file));
    }
    return ids;
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
      capturedAt: localDateString(),
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
  deleteApp(appIdRaw: string, platformRaw?: string) {
    const id = this.assertSlug(appIdRaw, 'app id');
    if (platformRaw && !(PLATFORMS as readonly string[]).includes(platformRaw)) {
      throw new BadRequestException(`platform must be one of ${PLATFORMS.join(', ')}`);
    }
    // One platform of an app on several (Claude's web part): only that part goes; the app, its logo and
    // licence stay for the platform that is left. Its last platform deletes the whole app.
    const others = PLATFORMS.filter((p) => p !== platformRaw && existsSync(this.inStore('screens', p, id)));
    if (platformRaw && others.length > 0) return this.deleteAppPlatform(id, platformRaw as (typeof PLATFORMS)[number]);

    let screensRemoved = 0;
    const analysisRemoved: string[] = [];

    for (const platform of PLATFORMS) {
      const dir = this.inStore('screens', platform, id);
      if (!existsSync(dir)) continue;

      for (const entry of listAppScreenFiles(dir)) {
        screensRemoved++;
        const screenId = screenIdFor(platform, id, entry.file);
        const analysis = this.inStore('analysis', `${screenId}.json`);
        if (existsSync(analysis)) {
          rmSync(analysis, { force: true });
          analysisRemoved.push(screenId);
        }
        // The text read off the screen goes with it.
        rmSync(this.inStore('words', `${screenId}.json`), { force: true });
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

    // Its "Reviewed by Claude" marks, and any review still in progress for it.
    const marksFile = join(this.root, 'reviewed.json');
    if (existsSync(marksFile)) {
      const marks = readJson<Record<string, unknown>>(marksFile, {});
      for (const key of Object.keys(marks)) if (key.startsWith(`${id}-`) && PLATFORMS.some((platform) => key.startsWith(`${id}-${platform}-`))) delete marks[key];
      this.writeJson(marksFile, marks);
    }
    const reviewsDir = join(this.root, '..', 'reviews');
    if (existsSync(reviewsDir)) {
      for (const entry of readdirSync(reviewsDir)) {
        if (PLATFORMS.some((platform) => entry.startsWith(`${id}-${platform}-`))) rmSync(join(reviewsDir, entry), { recursive: true, force: true });
      }
    }

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

  /** `deleteApp` for one platform of an app that is on others too. */
  private deleteAppPlatform(id: string, platform: (typeof PLATFORMS)[number]) {
    const prefix = `${id}-${platform}-`;
    let screensRemoved = 0;
    let analysisRemoved = 0;
    const dir = this.inStore('screens', platform, id);
    if (existsSync(dir)) {
      for (const entry of listAppScreenFiles(dir)) {
        screensRemoved++;
        const screenId = screenIdFor(platform, id, entry.file);
        const analysis = this.inStore('analysis', `${screenId}.json`);
        if (existsSync(analysis)) {
          rmSync(analysis, { force: true });
          analysisRemoved++;
        }
        rmSync(this.inStore('words', `${screenId}.json`), { force: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }

    // The record stays, without this platform and without its card pictures.
    const appsFile = join(this.root, 'apps.json');
    const appsData = readJson<{ version?: number; apps?: any[] }>(appsFile, { version: 1, apps: [] });
    const record = (appsData.apps || []).find((a) => a.id === id);
    if (record) {
      if (Array.isArray(record.platforms)) record.platforms = record.platforms.filter((p: string) => p !== platform);
      if (Array.isArray(record.cardScreens)) record.cardScreens = record.cardScreens.filter((sid: string) => !sid.startsWith(prefix));
      this.writeJson(appsFile, { version: appsData.version || 1, apps: appsData.apps });
    }

    const flowsFile = join(this.root, 'flows.json');
    const flowsData = readJson<{ version?: number; flows?: any[] }>(flowsFile, { version: 1, flows: [] });
    const keptFlows = (flowsData.flows || []).filter((f) => !(f.appId === id && f.platform === platform));
    const flowsRemoved = (flowsData.flows || []).length - keptFlows.length;
    this.writeJson(flowsFile, { version: flowsData.version || 1, flows: keptFlows });

    const marksFile = join(this.root, 'reviewed.json');
    if (existsSync(marksFile)) {
      const marks = readJson<Record<string, unknown>>(marksFile, {});
      for (const key of Object.keys(marks)) if (key.startsWith(prefix)) delete marks[key];
      this.writeJson(marksFile, marks);
    }
    const reviewsDir = join(this.root, '..', 'reviews');
    if (existsSync(reviewsDir)) {
      for (const entry of readdirSync(reviewsDir)) if (entry.startsWith(prefix)) rmSync(join(reviewsDir, entry), { recursive: true, force: true });
    }

    this.logger.log(`Deleted ${platform} of app ${id}: ${screensRemoved} screenshot(s), ${flowsRemoved} flow(s)`);
    return {
      removed: { app: false, screens: screensRemoved, analysis: analysisRemoved, flows: flowsRemoved, logo: null, source: false },
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
    // The status alone publishes: a permission basis, licence, licence URL and
    // attribution are all optional — recorded when known and shown on the
    // screen page when present.

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
    if (screenIds.length < 1) throw new BadRequestException('a flow needs at least one screen');

    const file = join(this.root, 'flows.json');
    const data = readJson<{ version?: number; flows?: any[] }>(file, { version: 1, flows: [] });
    const flows = data.flows || [];
    // The flow this one nests under, if any. Validated as a slug here; the
    // builder checks it names a published flow of the same app.
    const parentId =
      typeof input?.parentId === 'string' && input.parentId.trim() && input.parentId !== id
        ? this.assertSlug(input.parentId, 'parent flow id')
        : null;
    const record = { id, appId, name, category, platform, screenIds, parentId };

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
