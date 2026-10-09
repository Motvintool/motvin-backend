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
  titleCase,
  VERSION_DIR_RE,
  VERSIONS_DIR_NAME,
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
      generatedAt: manifest.generatedAt || null,
      vocabulary: {
        platforms: PLATFORMS,
        screenTypes: SCREEN_TYPES,
        states: SCREEN_STATES,
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
    versionRaw?: string,
    flowRaw?: string,
  ) {
    const platform = this.assertPlatform(platformRaw);
    const appId = this.assertSlug(appIdRaw, 'app');
    const { base, ext } = this.assertFileName(fileNameRaw, IMAGE_EXT);
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

    const report = this.rebuild();
    const file = this.qualifiedFile(version, flow, `${base}${ext}`);
    this.logger.log(`Uploaded screens/${platform}/${appId}/${file} (${dims.width}x${dims.height})`);
    return {
      id: screenIdFor(platform, appId, file),
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

    if (meta.screenType && !(SCREEN_TYPES as readonly string[]).includes(meta.screenType)) {
      throw new BadRequestException(`screenType must be one of ${SCREEN_TYPES.join(', ')}`);
    }
    const styles: string[] = Array.isArray(meta.style) ? meta.style : [];
    const badStyle = styles.find((s) => !(STYLES as readonly string[]).includes(s));
    if (badStyle) throw new BadRequestException(`unknown style "${badStyle}"`);

    const states: string[] = Array.isArray(meta.states) ? meta.states.map(String) : [];
    const badState = states.find((v) => !(SCREEN_STATES as readonly string[]).includes(v));
    if (badState) throw new BadRequestException(`unknown state "${badState}"`);

    // Fields automatic capture wrote and the form does not edit are carried
    // over, so saving a name never wipes a description or the capture facts.
    const sidecarFile = this.inStore(...this.screenPathParts(platform, appId, version, flow, `${base}.json`));
    const existing = readJson<Record<string, unknown>>(sidecarFile, {});
    const sidecar = {
      ...existing,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : titleCase(base),
      screenType: meta.screenType || undefined,
      states,
      description:
        typeof meta.description === 'string' ? meta.description.trim().slice(0, 600) : (existing.description as string | undefined) ?? '',
      tags: Array.isArray(meta.tags) ? meta.tags.map(String).filter(Boolean) : [],
      elements: Array.isArray(meta.elements) ? meta.elements.map(String).filter(Boolean) : [],
      style: styles,
      capturedAt: typeof meta.capturedAt === 'string' && meta.capturedAt ? meta.capturedAt : (existing.capturedAt as string | undefined),
    };

    this.writeJson(sidecarFile, sidecar);
    const file = this.qualifiedFile(version, flow, `${base}${ext}`);
    return { id: screenIdFor(platform, appId, file), sidecar, report: this.rebuild() };
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
    rmSync(this.inStore('analysis', `${screenIdFor(platform, appId, file)}.json`), { force: true });

    this.logger.log(`Deleted screens/${platform}/${appId}/${file}`);
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
      }
      rmSync(dir, { recursive: true, force: true });
    }

    this.logger.log(`Deleted version ${versionId} of ${appId}: ${screensRemoved} screenshot(s)`);
    return { removed: { screens: screensRemoved, analysis: analysisRemoved.length }, report: this.rebuild() };
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
   * repeats, at most MAX_CARD_SCREENS, and every one a screen actually stored
   * for this app — a card pointing at another app's screen, or at one that
   * was deleted, would be a silent blank in the gallery.
   */
  private readCardScreens(appId: string, raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
      throw new BadRequestException('cardScreens must be a list of screen ids');
    }
    const ids = Array.from(new Set((raw as string[]).map((v) => v.trim()).filter(Boolean)));
    if (ids.length > MAX_CARD_SCREENS) {
      throw new BadRequestException(`cardScreens may hold at most ${MAX_CARD_SCREENS} screens`);
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
  deleteApp(appIdRaw: string) {
    const id = this.assertSlug(appIdRaw, 'app id');

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
