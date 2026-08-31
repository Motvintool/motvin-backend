/**
 * Converts real_illustrations_data.js (motvin-ui) into the backend data format.
 * Run once: node scripts/populate-illustrations-from-static.js
 */

const fs   = require('fs');
const path = require('path');

const UI_DATA  = path.join(__dirname, '../../motvin-ui/real_illustrations_data.js');
const DATA_DIR = path.join(__dirname, '../data/illustrations');

// Source metadata for the collections found in the static data file
const SOURCE_META = {
  bioicons:    { name: 'Bioicons',            license: 'CC BY 4.0', licenseUrl: 'https://bioicons.com', author: 'Simon Duerr', styles: ['color'] },
  fluentemoji: { name: 'Fluent Emoji',        license: 'MIT',       licenseUrl: 'https://github.com/microsoft/fluentui-emoji', author: 'Microsoft', styles: ['color'] },
  flowbite:    { name: 'Flowbite Illustrations', license: 'MIT',    licenseUrl: 'https://flowbite.com/icons/', author: 'Themesberg', styles: ['color'] },
  ira:         { name: 'IRA Design',          license: 'MIT',       licenseUrl: 'https://iradesign.io', author: 'Creative Tim', styles: ['color'] },
  opendoodles: { name: 'Open Doodles',        license: 'CC0',       licenseUrl: 'https://www.opendoodles.com', author: 'Pablo Stanley', styles: ['solid'] },
};

// Normalize JSX-style camelCase SVG attributes to valid XML SVG kebab-case
const JSX_TO_SVG = {
  fillRule: 'fill-rule', clipRule: 'clip-rule', clipPath: 'clip-path',
  strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin', strokeDasharray: 'stroke-dasharray',
  strokeDashoffset: 'stroke-dashoffset', strokeOpacity: 'stroke-opacity',
  strokeMiterlimit: 'stroke-miterlimit', fillOpacity: 'fill-opacity',
  stopColor: 'stop-color', stopOpacity: 'stop-opacity',
  dominantBaseline: 'dominant-baseline', alignmentBaseline: 'alignment-baseline',
  colorInterpolation: 'color-interpolation', colorRendering: 'color-rendering',
  fontFamily: 'font-family', fontSize: 'font-size', fontWeight: 'font-weight',
  letterSpacing: 'letter-spacing', textAnchor: 'text-anchor',
};
const CAMEL_RE = new RegExp(`\\b(${Object.keys(JSX_TO_SVG).join('|')})=`, 'g');
function normalizeSvg(svg) {
  if (!svg) return svg;
  return svg.replace(CAMEL_RE, (_, attr) => `${JSX_TO_SVG[attr]}=`);
}

// ── Load static data ────────────────────────────────────────────────────────
const raw = fs.readFileSync(UI_DATA, 'utf8');
const data = JSON.parse(raw.replace(/^var REAL_ILLUSTRATIONS\s*=\s*/, '').replace(/;?\s*$/, ''));
console.log(`Loaded ${data.length} illustrations`);

// ── Group by source ─────────────────────────────────────────────────────────
const bySource = {};
for (const item of data) {
  if (!bySource[item.source]) bySource[item.source] = [];
  bySource[item.source].push(item);
}

// ── Write collection files ──────────────────────────────────────────────────
const collectionsList = [];
const newSources = {};

for (const [sourceId, items] of Object.entries(bySource)) {
  const meta = SOURCE_META[sourceId] || { name: sourceId, license: 'Unknown', licenseUrl: '', author: '', styles: [] };
  const collDir = path.join(DATA_DIR, sourceId);

  fs.mkdirSync(collDir, { recursive: true });

  // Strip svg for items that have a CDN imageUrl; keep it for items that need the SVG endpoint
  const icons = items.map(({ id, name, source, sourceName, category, tags, style, viewBox, imageUrl, svg, license, licenseUrl, author }) => ({
    id, name, source, sourceName, category, tags: tags || [],
    style: style || meta.styles[0] || 'color', viewBox: viewBox || '0 0 500 500',
    imageUrl: imageUrl || null,
    svg: (!imageUrl && svg) ? normalizeSvg(svg) : undefined, // only keep svg body when there is no CDN URL
    license: license || meta.license,
    licenseUrl: licenseUrl || meta.licenseUrl,
    author: author || meta.author,
  }));

  fs.writeFileSync(path.join(collDir, 'icons.json'), JSON.stringify(icons, null, 2));

  const metadata = {
    id:         sourceId,
    name:       meta.name,
    total:      items.length,
    styles:     meta.styles,
    license:    meta.license,
    licenseUrl: meta.licenseUrl,
    author:     meta.author,
    category:   'Illustration',
  };
  fs.writeFileSync(path.join(collDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  collectionsList.push({ id: sourceId, name: meta.name, total: items.length, styles: meta.styles, license: meta.license, category: 'Illustration', author: meta.author });
  newSources[sourceId] = { license: meta.license };

  console.log(`  ✓ ${sourceId}: ${items.length} illustrations`);
}

// ── Update collections.json ──────────────────────────────────────────────────
const collections = {
  totalCollections: collectionsList.length,
  totalIcons:       data.length,
  collections:      collectionsList,
};
fs.writeFileSync(path.join(DATA_DIR, 'collections.json'), JSON.stringify(collections, null, 2));

// ── Update sources.json ──────────────────────────────────────────────────────
fs.writeFileSync(path.join(DATA_DIR, 'sources.json'), JSON.stringify(newSources, null, 2));

console.log(`\nDone — ${data.length} illustrations across ${collectionsList.length} collections`);
console.log('Restart the backend to pick up the new data.');
