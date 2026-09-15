/**
 * Builds data/inspirations/manifest.json from what is actually stored on disk.
 *
 * One implementation, two callers: the CLI (`npm run build:inspirations`) and
 * the admin API, which rebuilds after every write. Keeping it here rather than
 * in scripts/ means it ships in dist/ and works inside the Docker image.
 *
 * The licensing gate is enforced here: a screen is published only when its app
 * has an entry in sources.json with "status": "approved". Anything else is
 * counted, reported, and left out of the manifest.
 */

import {
  existsSync,
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, extname, join } from 'path';

export const PLATFORMS = ['web', 'ios', 'android'] as const;
export const IMAGE_EXT = ['.webp', '.png', '.jpg', '.jpeg', '.avif', '.gif'];
export const LOGO_EXT = [...IMAGE_EXT, '.svg'];

export const SCREEN_TYPES = [
  'landing', 'login', 'signup', 'dashboard', 'search', 'pricing', 'checkout',
  'settings', 'profile', 'onboarding', 'feed', 'product', 'other',
] as const;

export const INDUSTRIES = [
  'saas', 'fintech', 'healthcare', 'ecommerce', 'education', 'travel',
  'productivity', 'ai', 'social', 'finance',
] as const;

export const STYLES = [
  'minimal', 'editorial', 'bold', 'dark', 'light', 'playful', 'corporate',
  'experimental',
] as const;

export const FLOW_CATEGORIES = [
  'onboarding', 'checkout', 'authentication', 'search', 'settings', 'creation',
  'discovery',
] as const;

export const PERMISSIONS = [
  'owner-granted', 'open-source', 'public-domain', 'own-work', 'fair-use-reference',
] as const;

export const REVIEW_STATUSES = ['pending', 'review', 'approved', 'rejected'] as const;

const APPROVED_STATUS = 'approved';

export type BuildReport = {
  counts: Record<string, number>;
  skipped: { appId: string; platform: string; count: number; reason: string }[];
  warnings: string[];
  problems: string[];
  manifestPath: string;
};

// ─── Image dimensions ───────────────────────────────────────────────────────
// Read from the file header rather than decoding, so no image dependency is
// needed. Returns null for anything unrecognised; the caller reports it.

export function readDimensions(file: string): { width: number; height: number } | null {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(64 * 1024);
    const read = readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, read);

    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      // PNG: IHDR width/height are the first two fields of the first chunk.
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      // GIF: logical screen descriptor, little-endian.
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return readWebpDimensions(buf);
    }

    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      return readJpegDimensions(fd, buf);
    }

    if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
      return readAvifDimensions(buf);
    }

    return null;
  } finally {
    closeSync(fd);
  }
}

function readWebpDimensions(buf: Buffer) {
  const format = buf.toString('ascii', 12, 16);
  if (format === 'VP8X') {
    // Canvas size is stored minus one, as two 24-bit little-endian values.
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  if (format === 'VP8 ') {
    // Lossy: 14-bit dimensions follow the 3-byte start code.
    const start = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (start === -1) return null;
    return {
      width: buf.readUInt16LE(start + 3) & 0x3fff,
      height: buf.readUInt16LE(start + 5) & 0x3fff,
    };
  }
  if (format === 'VP8L') {
    // Lossless: 14-bit width then 14-bit height, bit-packed after the marker.
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function readJpegDimensions(fd: number, firstChunk: Buffer) {
  // Walk the marker segments until a Start Of Frame carries the size. The
  // header may sit past the first read for images with large EXIF blocks.
  let buf = firstChunk;
  let offset = 2;
  let fileOffset = 0;

  const ensure = (need: number) => {
    if (offset + need <= buf.length) return true;
    const next = Buffer.alloc(64 * 1024);
    const from = fileOffset + offset;
    const read = readSync(fd, next, 0, next.length, from);
    if (read <= 0) return false;
    buf = next.subarray(0, read);
    fileOffset = from;
    offset = 0;
    return offset + need <= buf.length;
  };

  while (ensure(4)) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    const length = buf.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (!ensure(9)) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    offset += 2 + length;
  }
  return null;
}

function readAvifDimensions(buf: Buffer) {
  // ispe (image spatial extents) carries the display size.
  const ispe = buf.indexOf('ispe', 0, 'ascii');
  if (ispe === -1 || ispe + 16 > buf.length) return null;
  return { width: buf.readUInt32BE(ispe + 8), height: buf.readUInt32BE(ispe + 12) };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch (error) {
    throw new Error(`${basename(file)} is not valid JSON: ${(error as Error).message}`);
  }
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function listFiles(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && extensions.includes(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
}

export function titleCase(slug: string): string {
  return slug.split(/[-_]/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function uniq<T>(list: T[]): T[] {
  return Array.from(new Set(list.filter(Boolean)));
}

/** `screens/<platform>/<app>/<file>` → the id the rest of the system uses. */
export function screenIdFor(platform: string, appId: string, file: string): string {
  return `${appId}-${platform}-${basename(file, extname(file))}`;
}

// ─── Build ──────────────────────────────────────────────────────────────────

export function buildInspirationsManifest(root: string): BuildReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const skipped: BuildReport['skipped'] = [];

  const screensDir = join(root, 'screens');
  const logosDir = join(root, 'logos');
  const analysisDir = join(root, 'analysis');
  const outFile = join(root, 'manifest.json');

  const appsFile = readJson<{ apps?: any[] }>(join(root, 'apps.json'), { apps: [] });
  const flowsFile = readJson<{ flows?: any[] }>(join(root, 'flows.json'), { flows: [] });
  const patternsFile = readJson<{ patterns?: any[] }>(join(root, 'patterns.json'), { patterns: [] });
  const sourcesFile = readJson<{ sources?: Record<string, any> }>(join(root, 'sources.json'), { sources: {} });

  const sources = sourcesFile.sources || {};
  const appRecords = new Map<string, any>((appsFile.apps || []).map((a) => [a.id, a]));
  const logoFiles = new Map<string, string>(
    listFiles(logosDir, LOGO_EXT).map((f) => [basename(f, extname(f)), f]),
  );

  const screens: any[] = [];
  const appsSeen = new Set<string>();

  for (const platform of PLATFORMS) {
    const platformDir = join(screensDir, platform);
    for (const appId of listDirs(platformDir)) {
      const appDir = join(platformDir, appId);
      const images = listFiles(appDir, IMAGE_EXT);
      if (images.length === 0) continue;

      const source = sources[appId];
      if (!source || source.status !== APPROVED_STATUS) {
        skipped.push({
          appId,
          platform,
          count: images.length,
          reason: !source
            ? 'no entry in sources.json'
            : `status "${source.status || 'unset'}" is not "${APPROVED_STATUS}"`,
        });
        continue;
      }

      const app = appRecords.get(appId);
      if (!app) {
        problems.push(`screens/${platform}/${appId}/ has ${images.length} image(s) but no "${appId}" entry in apps.json`);
        continue;
      }

      appsSeen.add(appId);

      for (const file of images) {
        const base = basename(file, extname(file));
        const id = screenIdFor(platform, appId, file);
        const abs = join(appDir, file);

        let dimensions: { width: number; height: number } | null = null;
        try {
          dimensions = readDimensions(abs);
        } catch (error) {
          problems.push(`could not read ${platform}/${appId}/${file}: ${(error as Error).message}`);
          continue;
        }
        if (!dimensions || !dimensions.width || !dimensions.height) {
          problems.push(`could not read image dimensions from ${platform}/${appId}/${file}`);
          continue;
        }

        const sidecar = readJson<any>(join(appDir, `${base}.json`), {});
        const typeFromName = base.split('-')[0].toLowerCase();
        const screenType =
          sidecar.screenType || ((SCREEN_TYPES as readonly string[]).includes(typeFromName) ? typeFromName : 'other');

        if (sidecar.screenType && !(SCREEN_TYPES as readonly string[]).includes(sidecar.screenType)) {
          problems.push(`${platform}/${appId}/${base}.json has unknown screenType "${sidecar.screenType}"`);
          continue;
        }
        const badStyles = (sidecar.style || []).filter((s: string) => !(STYLES as readonly string[]).includes(s));
        if (badStyles.length) {
          warnings.push(`${platform}/${appId}/${base}.json has unknown style(s): ${badStyles.join(', ')}`);
        }
        if (!(SCREEN_TYPES as readonly string[]).includes(typeFromName) && !sidecar.screenType) {
          warnings.push(`${platform}/${appId}/${file} filename does not start with a known screen type — filed as "other"`);
        }

        screens.push({
          id,
          appId,
          name: sidecar.name || titleCase(base),
          file: `${platform}/${appId}/${file}`,
          url: `/api/inspirations/screens/${platform}/${appId}/${file}`,
          width: dimensions.width,
          height: dimensions.height,
          bytes: statSync(abs).size,
          platform,
          screenType,
          industry: app.industry,
          tags: uniq([...(sidecar.tags || []), app.industry, screenType, platform]),
          elements: uniq<string>(sidecar.elements || []),
          style: uniq<string>((sidecar.style || []).filter((s: string) => (STYLES as readonly string[]).includes(s))),
          capturedAt: sidecar.capturedAt || source.capturedAt || null,
          hasAnalysis: existsSync(join(analysisDir, `${id}.json`)),
          downloadable: source.redistribution === 'allowed',
          source: {
            url: source.sourceUrl || app.website || null,
            license: source.license || null,
            licenseUrl: source.licenseUrl || null,
            attribution: source.attribution || app.name,
            permission: source.permission || null,
          },
        });
      }
    }
  }

  const screensByApp = new Map<string, any[]>();
  for (const screen of screens) {
    if (!screensByApp.has(screen.appId)) screensByApp.set(screen.appId, []);
    screensByApp.get(screen.appId)!.push(screen);
  }

  const knownScreenIds = new Set(screens.map((s) => s.id));
  const publishedFlows = (flowsFile.flows || [])
    .map((flow) => {
      const missing = (flow.screenIds || []).filter((id: string) => !knownScreenIds.has(id));
      if (missing.length) {
        warnings.push(
          `flow "${flow.id}" drops ${missing.length} screen id(s) not stored or not approved: ${missing.join(', ')}`,
        );
      }
      return { ...flow, screenIds: (flow.screenIds || []).filter((id: string) => knownScreenIds.has(id)) };
    })
    .filter((flow) => flow.screenIds.length >= 2);

  const apps = Array.from(appsSeen)
    .map((appId) => {
      const app = appRecords.get(appId);
      const appScreens = screensByApp.get(appId) || [];
      const source = sources[appId] || {};
      const logo = app.logo || logoFiles.get(appId) || null;
      return {
        id: appId,
        name: app.name || titleCase(appId),
        slug: appId,
        industry: app.industry,
        platforms: uniq<string>(appScreens.map((s) => s.platform)),
        website: app.website || null,
        tagline: app.tagline || null,
        logo: logo ? `/api/inspirations/logos/${logo}` : null,
        screenCount: appScreens.length,
        flowCount: publishedFlows.filter((f) => f.appId === appId).length,
        license: source.license || null,
        attribution: source.attribution || app.name || titleCase(appId),
      };
    })
    .sort((a, b) => b.screenCount - a.screenCount || a.name.localeCompare(b.name));

  for (const app of appRecords.values()) {
    if (!app.industry || !(INDUSTRIES as readonly string[]).includes(app.industry)) {
      problems.push(`app "${app.id}" has an unknown industry "${app.industry}"`);
    }
  }

  // Patterns resolve their own examples from the stored screens.
  const patterns = (patternsFile.patterns || [])
    .map((pattern) => {
      const m = pattern.match || {};
      const matched = screens.filter((screen) => {
        if (m.platforms && !m.platforms.includes(screen.platform)) return false;
        if (m.screenTypes && !m.screenTypes.includes(screen.screenType)) return false;
        if (m.industries && !m.industries.includes(screen.industry)) return false;
        if (m.elements && !m.elements.some((e: string) => screen.elements.includes(e))) return false;
        if (m.tags && !m.tags.some((t: string) => screen.tags.includes(t))) return false;
        return true;
      });
      return {
        id: `pattern-${pattern.slug}`,
        slug: pattern.slug,
        name: pattern.name,
        category: pattern.category,
        description: pattern.description,
        tags: pattern.tags || [],
        screenIds: matched.map((s) => s.id),
      };
    })
    .filter((p) => p.screenIds.length > 0);

  const elementCounts: Record<string, number> = {};
  for (const screen of screens) {
    for (const element of screen.elements) {
      elementCounts[element] = (elementCounts[element] || 0) + 1;
    }
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: {
      apps: apps.length,
      screens: screens.length,
      flows: publishedFlows.length,
      patterns: patterns.length,
      'ui-elements': Object.values(elementCounts).reduce((n, c) => n + c, 0),
    },
    // What the store actually holds, so filters never offer a value with
    // nothing behind it. `vocabulary` keeps the full accepted sets for
    // validation and for the admin tooling.
    taxonomy: {
      platforms: PLATFORMS.filter((p) => screens.some((s) => s.platform === p)),
      screenTypes: SCREEN_TYPES.filter((t) => screens.some((s) => s.screenType === t)),
      industries: INDUSTRIES.filter((i) => screens.some((s) => s.industry === i)),
      styles: STYLES.filter((v) => screens.some((s) => s.style.includes(v))),
      elements: Object.keys(elementCounts).sort(),
    },
    vocabulary: {
      platforms: PLATFORMS,
      screenTypes: SCREEN_TYPES,
      industries: INDUSTRIES,
      styles: STYLES,
      flowCategories: FLOW_CATEGORIES,
      permissions: PERMISSIONS,
      reviewStatuses: REVIEW_STATUSES,
    },
    apps,
    screens,
    flows: publishedFlows,
    patterns,
    elementCounts,
  };

  writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');

  return { counts: manifest.counts, skipped, warnings, problems, manifestPath: outFile };
}
