#!/usr/bin/env node
/**
 * Builds data/inspirations/manifest.json from what is actually stored on disk.
 *
 *   node scripts/build-inspirations-data.js
 *
 * Walks screens/<platform>/<app>/, reads each image's real pixel dimensions
 * from its header, merges the hand-maintained catalogue files, resolves every
 * pattern's examples from its match rules, and writes one manifest the API
 * serves.
 *
 * The licensing gate is enforced here: a screen is published only when its app
 * has an entry in sources.json with "status": "approved". Anything else is
 * counted, reported, and left out of the manifest.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'inspirations');
const SCREENS_DIR = path.join(DATA_DIR, 'screens');
const LOGOS_DIR = path.join(DATA_DIR, 'logos');
const ANALYSIS_DIR = path.join(DATA_DIR, 'analysis');
const OUT_FILE = path.join(DATA_DIR, 'manifest.json');

const PLATFORMS = ['web', 'ios', 'android'];
const IMAGE_EXT = ['.webp', '.png', '.jpg', '.jpeg', '.avif', '.gif'];

const SCREEN_TYPES = [
  'landing', 'login', 'signup', 'dashboard', 'search', 'pricing', 'checkout',
  'settings', 'profile', 'onboarding', 'feed', 'product', 'other',
];

const INDUSTRIES = [
  'saas', 'fintech', 'healthcare', 'ecommerce', 'education', 'travel',
  'productivity', 'ai', 'social', 'finance',
];

const STYLES = [
  'minimal', 'editorial', 'bold', 'dark', 'light', 'playful', 'corporate',
  'experimental',
];

const APPROVED_STATUS = 'approved';

// ─── Image dimensions ───────────────────────────────────────────────────────
// Read from the file header rather than decoding, so no image dependency is
// needed. Returns null for anything unrecognised; the caller reports it.

function readDimensions(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, head, 0, head.length, 0);
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
    fs.closeSync(fd);
  }
}

function readWebpDimensions(buf) {
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

function readJpegDimensions(fd, firstChunk) {
  // Walk the marker segments until a Start Of Frame carries the size. The
  // header may sit past the first read for images with large EXIF blocks.
  let buf = firstChunk;
  let offset = 2;
  let fileOffset = 0;

  const ensure = (need) => {
    if (offset + need <= buf.length) return true;
    const next = Buffer.alloc(64 * 1024);
    const from = fileOffset + offset;
    const read = fs.readSync(fd, next, 0, next.length, from);
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

function readAvifDimensions(buf) {
  // ispe (image spatial extents) carries the display size.
  const ispe = buf.indexOf('ispe', 0, 'ascii');
  if (ispe === -1 || ispe + 16 > buf.length) return null;
  return { width: buf.readUInt32BE(ispe + 8), height: buf.readUInt32BE(ispe + 12) };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`);
  }
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_EXT.includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
}

function titleCase(slug) {
  return slug.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function uniq(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

// ─── Build ──────────────────────────────────────────────────────────────────

function build() {
  const problems = [];
  const warnings = [];
  const skipped = [];

  const appsFile = readJson(path.join(DATA_DIR, 'apps.json'), { apps: [] });
  const flowsFile = readJson(path.join(DATA_DIR, 'flows.json'), { flows: [] });
  const patternsFile = readJson(path.join(DATA_DIR, 'patterns.json'), { patterns: [] });
  const sourcesFile = readJson(path.join(DATA_DIR, 'sources.json'), { sources: {} });

  const sources = sourcesFile.sources || {};
  const appRecords = new Map((appsFile.apps || []).map((a) => [a.id, a]));
  const logoFiles = new Map(
    listImages(LOGOS_DIR)
      .concat(fs.existsSync(LOGOS_DIR) ? fs.readdirSync(LOGOS_DIR).filter((f) => f.endsWith('.svg')) : [])
      .map((f) => [path.basename(f, path.extname(f)), f]),
  );

  const screens = [];
  const appsSeen = new Set();

  for (const platform of PLATFORMS) {
    const platformDir = path.join(SCREENS_DIR, platform);
    for (const appId of listDirs(platformDir)) {
      const appDir = path.join(platformDir, appId);
      const images = listImages(appDir);
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
        const base = path.basename(file, path.extname(file));
        const id = `${appId}-${platform}-${base}`;
        const abs = path.join(appDir, file);

        let dimensions = null;
        try {
          dimensions = readDimensions(abs);
        } catch (error) {
          problems.push(`could not read ${platform}/${appId}/${file}: ${error.message}`);
          continue;
        }
        if (!dimensions || !dimensions.width || !dimensions.height) {
          problems.push(`could not read image dimensions from ${platform}/${appId}/${file}`);
          continue;
        }

        const sidecar = readJson(path.join(appDir, `${base}.json`), {});
        const typeFromName = base.split('-')[0].toLowerCase();
        const screenType = sidecar.screenType
          || (SCREEN_TYPES.includes(typeFromName) ? typeFromName : 'other');

        if (sidecar.screenType && !SCREEN_TYPES.includes(sidecar.screenType)) {
          problems.push(`${platform}/${appId}/${base}.json has unknown screenType "${sidecar.screenType}"`);
          continue;
        }
        const badStyles = (sidecar.style || []).filter((s) => !STYLES.includes(s));
        if (badStyles.length) {
          warnings.push(`${platform}/${appId}/${base}.json has unknown style(s): ${badStyles.join(', ')}`);
        }
        if (!SCREEN_TYPES.includes(typeFromName) && !sidecar.screenType) {
          warnings.push(`${platform}/${appId}/${file} filename does not start with a known screen type — filed as "other"`);
        }

        const analysisFile = path.join(ANALYSIS_DIR, `${id}.json`);

        screens.push({
          id,
          appId,
          name: sidecar.name || titleCase(base),
          file: `${platform}/${appId}/${file}`,
          url: `/api/inspirations/screens/${platform}/${appId}/${file}`,
          width: dimensions.width,
          height: dimensions.height,
          bytes: fs.statSync(abs).size,
          platform,
          screenType,
          industry: app.industry,
          tags: uniq([...(sidecar.tags || []), app.industry, screenType, platform]),
          elements: uniq(sidecar.elements || []),
          style: uniq((sidecar.style || []).filter((s) => STYLES.includes(s))),
          capturedAt: sidecar.capturedAt || source.capturedAt || null,
          hasAnalysis: fs.existsSync(analysisFile),
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

  // Apps — only those with at least one published screen.
  const screensByApp = new Map();
  for (const screen of screens) {
    if (!screensByApp.has(screen.appId)) screensByApp.set(screen.appId, []);
    screensByApp.get(screen.appId).push(screen);
  }

  const publishedFlows = (flowsFile.flows || []).filter((flow) => {
    const known = new Set(screens.map((s) => s.id));
    const missing = (flow.screenIds || []).filter((id) => !known.has(id));
    if (missing.length) {
      warnings.push(`flow "${flow.id}" drops ${missing.length} screen id(s) not stored or not approved: ${missing.join(', ')}`);
    }
    flow.screenIds = (flow.screenIds || []).filter((id) => known.has(id));
    return flow.screenIds.length >= 2;
  });

  const apps = Array.from(appsSeen).map((appId) => {
    const app = appRecords.get(appId);
    const appScreens = screensByApp.get(appId) || [];
    const source = sources[appId] || {};
    const logo = app.logo || logoFiles.get(appId) || null;
    return {
      id: appId,
      name: app.name || titleCase(appId),
      slug: appId,
      industry: app.industry,
      platforms: uniq(appScreens.map((s) => s.platform)),
      website: app.website || null,
      tagline: app.tagline || null,
      logo: logo ? `/api/inspirations/logos/${logo}` : null,
      screenCount: appScreens.length,
      flowCount: publishedFlows.filter((f) => f.appId === appId).length,
      license: source.license || null,
      attribution: source.attribution || app.name || titleCase(appId),
    };
  }).sort((a, b) => b.screenCount - a.screenCount || a.name.localeCompare(b.name));

  for (const app of appRecords.values()) {
    if (!app.industry || !INDUSTRIES.includes(app.industry)) {
      problems.push(`app "${app.id}" has an unknown industry "${app.industry}"`);
    }
  }

  // Patterns resolve their own examples from the stored screens.
  const patterns = (patternsFile.patterns || []).map((pattern) => {
    const m = pattern.match || {};
    const matched = screens.filter((screen) => {
      if (m.platforms && !m.platforms.includes(screen.platform)) return false;
      if (m.screenTypes && !m.screenTypes.includes(screen.screenType)) return false;
      if (m.industries && !m.industries.includes(screen.industry)) return false;
      if (m.elements && !m.elements.some((e) => screen.elements.includes(e))) return false;
      if (m.tags && !m.tags.some((t) => screen.tags.includes(t))) return false;
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
  }).filter((p) => p.screenIds.length > 0);

  const elementCounts = {};
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
    // validation and for the ingest tooling.
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
    },
    apps,
    screens,
    flows: publishedFlows,
    patterns,
    elementCounts,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + '\n');

  // ── Report ──
  console.log('Inspirations manifest');
  console.log(`  apps          ${manifest.counts.apps}`);
  console.log(`  screens       ${manifest.counts.screens}`);
  console.log(`  flows         ${manifest.counts.flows}`);
  console.log(`  patterns      ${manifest.counts.patterns}`);
  console.log(`  ui elements   ${manifest.counts['ui-elements']}`);
  console.log(`  written to    ${path.relative(process.cwd(), OUT_FILE)}`);

  if (skipped.length) {
    console.log('\nHeld back by the licensing gate:');
    for (const s of skipped) {
      console.log(`  ${s.platform}/${s.appId} — ${s.count} image(s): ${s.reason}`);
    }
  }
  if (warnings.length) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  ${w}`);
  }
  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log(`  ${p}`);
  }
  if (manifest.counts.screens === 0) {
    console.log('\nNo screens published yet. Add images under data/inspirations/screens/<platform>/<app>/,');
    console.log('list the app in apps.json, approve it in sources.json, then run this again.');
  }

  return problems.length === 0 ? 0 : 1;
}

process.exit(build());
