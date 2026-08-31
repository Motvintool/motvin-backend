const fs = require('fs');
const path = require('path');
const https = require('https');

const outputDir = path.join(__dirname, '../data/illustrations');
const sourcesFile = path.join(outputDir, 'sources.json');

const collectionsMap = new Map();
const seenIds = new Set();

// Illustration sources — all served via GitHub raw SVG files
const sources = [
  {
    id: 'undraw',
    name: 'unDraw',
    license: 'MIT',
    author: 'Katerina Limpitsouni',
    category: 'Illustration',
    style: 'flat',
    tags: ['flat', 'people', 'business'],
  },
  {
    id: 'opendoodles',
    name: 'Open Doodles',
    license: 'CC0',
    author: 'Pablo Stanley',
    category: 'Illustration',
    style: 'sketch',
    tags: ['sketch', 'people', 'hand-drawn'],
  },
  {
    id: 'drawkit',
    name: 'DrawKit',
    license: 'MIT',
    author: 'DrawKit',
    category: 'Illustration',
    style: 'flat',
    tags: ['flat', 'minimal', 'business'],
  },
  {
    id: 'humaaans',
    name: 'Humaaans',
    license: 'MIT',
    author: 'Pablo Stanley',
    category: 'Illustration',
    style: 'flat',
    tags: ['flat', 'people', 'mix-and-match'],
  },
  {
    id: 'ouch',
    name: 'Ouch! (Icons8)',
    license: 'Free',
    author: 'Icons8',
    category: 'Illustration',
    style: 'flat',
    tags: ['flat', 'vector', 'scenes'],
  },
  {
    id: 'freepik',
    name: 'Storyset (Freepik)',
    license: 'CC BY 4.0',
    author: 'Freepik',
    category: 'Illustration',
    style: 'flat',
    tags: ['flat', 'animated', 'business', 'people'],
  },
];

function fetchText(url, options = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { ...options, headers: { 'User-Agent': 'motvin-illustration-builder', ...(options.headers || {}) } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location, options));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, options));
}

function extractSvgParts(svgContent) {
  const svgTag = svgContent.match(/<svg\b[^>]*>/i)?.[0] || '';
  const viewBox = svgTag.match(/viewBox=["']([^"']+)["']/i)?.[1] || '0 0 500 500';
  const body = svgContent.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/i)?.[1];
  if (!body) return null;
  return {
    viewBox,
    svg: body
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '')
      .replace(/\son\w+=["'][^"']*["']/gi, '')
      .trim(),
  };
}

// ── unDraw ──────────────────────────────────────────────────────────
async function processUnDraw() {
  console.log('Fetching unDraw illustration list...');
  try {
    const list = await fetchJson('https://undraw.co/api/illustrations');
    const items = Array.isArray(list) ? list : (list.illustrations || list.data || []);
    console.log(`  Found ${items.length} unDraw illustrations`);

    const icons = [];
    let count = 0;
    const chunkSize = 30;

    for (let i = 0; i < Math.min(items.length, 400); i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (item) => {
        try {
          const slug = item.slug || item.name?.toLowerCase().replace(/\s+/g, '-');
          if (!slug) return;
          const uid = `undraw_${slug}`;
          if (seenIds.has(uid)) return;

          const svgUrl = item.image || `https://undraw.co/illustrations/${slug}.svg`;
          const svgContent = await fetchText(svgUrl);
          const parts = extractSvgParts(svgContent);
          if (!parts) return;

          seenIds.add(uid);
          icons.push({
            id: uid,
            name: (item.title || slug).replace(/-/g, ' '),
            body: parts.svg,
            viewBox: parts.viewBox,
            tags: ['undraw', 'flat', 'people'],
            style: 'flat',
          });
          count++;
        } catch (e) { /* skip individual failures */ }
      }));
      process.stdout.write(`\r  unDraw: ${Math.min(i + chunkSize, Math.min(items.length, 400))}/${Math.min(items.length, 400)} (${count} added)`);
    }

    console.log(`\n  ✓ unDraw: ${count}`);
    return icons;
  } catch (e) {
    console.log(`\n  ✗ unDraw failed: ${e.message}`);
    return [];
  }
}

// ── Open Doodles ────────────────────────────────────────────────────
async function processOpenDoodles() {
  console.log('Fetching Open Doodles...');
  const baseUrl = 'https://api.opendoodles.com/';
  try {
    const data = await fetchJson(`${baseUrl}list`);
    const items = Array.isArray(data) ? data : (data.doodles || data.data || []);
    console.log(`  Found ${items.length} doodles`);

    const icons = [];
    for (const item of items.slice(0, 300)) {
      try {
        const name = typeof item === 'string' ? item : (item.name || item.slug || '');
        if (!name) continue;
        const uid = `opendoodles_${name.toLowerCase().replace(/\s+/g, '-')}`;
        if (seenIds.has(uid)) return;

        const svgContent = await fetchText(`${baseUrl}svg/${encodeURIComponent(name)}`);
        const parts = extractSvgParts(svgContent);
        if (!parts) continue;

        seenIds.add(uid);
        icons.push({
          id: uid,
          name: name.replace(/-/g, ' '),
          body: parts.svg,
          viewBox: parts.viewBox,
          tags: ['opendoodles', 'sketch', 'people', 'hand-drawn'],
          style: 'sketch',
        });
      } catch (e) { /* skip */ }
    }

    console.log(`  ✓ Open Doodles: ${icons.length}`);
    return icons;
  } catch (e) {
    console.log(`  ✗ Open Doodles failed: ${e.message}`);
    return [];
  }
}

// ── DrawKit (GitHub) ─────────────────────────────────────────────────
async function processDrawKit() {
  console.log('Fetching DrawKit...');
  try {
    const treeData = await fetchJson(
      'https://api.github.com/repos/drawkit/drawkit-illustrations/git/trees/main?recursive=1',
      { headers: { 'User-Agent': 'motvin-illustration-builder' } }
    );
    const svgFiles = (treeData.tree || []).filter(n => n.path.endsWith('.svg') && !n.path.includes('preview'));
    console.log(`  Found ${svgFiles.length} DrawKit SVG files`);

    const icons = [];
    const chunkSize = 20;
    for (let i = 0; i < Math.min(svgFiles.length, 300); i += chunkSize) {
      const chunk = svgFiles.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (node) => {
        try {
          const rawUrl = `https://raw.githubusercontent.com/drawkit/drawkit-illustrations/main/${node.path}`;
          const svgContent = await fetchText(rawUrl);
          const slug = node.path.split('/').pop().replace('.svg', '');
          const uid = `drawkit_${slug}`;
          if (seenIds.has(uid)) return;

          const parts = extractSvgParts(svgContent);
          if (!parts) return;

          seenIds.add(uid);
          icons.push({
            id: uid,
            name: slug.replace(/[-_]/g, ' '),
            body: parts.svg,
            viewBox: parts.viewBox,
            tags: ['drawkit', 'flat', 'minimal'],
            style: 'flat',
          });
        } catch (e) { /* skip */ }
      }));
      process.stdout.write(`\r  DrawKit: ${Math.min(i + chunkSize, Math.min(svgFiles.length, 300))}/${Math.min(svgFiles.length, 300)} (${icons.length} added)`);
    }

    console.log(`\n  ✓ DrawKit: ${icons.length}`);
    return icons;
  } catch (e) {
    console.log(`\n  ✗ DrawKit failed: ${e.message}`);
    return [];
  }
}

// ── Humaaans (GitHub) ────────────────────────────────────────────────
async function processHumaaans() {
  console.log('Fetching Humaaans...');
  try {
    const treeData = await fetchJson(
      'https://api.github.com/repos/marshallofsound/humaaans/git/trees/master?recursive=1',
      { headers: { 'User-Agent': 'motvin-illustration-builder' } }
    );
    const svgFiles = (treeData.tree || []).filter(n => n.path.endsWith('.svg'));
    console.log(`  Found ${svgFiles.length} Humaaans SVG files`);

    const icons = [];
    const chunkSize = 20;
    for (let i = 0; i < Math.min(svgFiles.length, 200); i += chunkSize) {
      const chunk = svgFiles.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (node) => {
        try {
          const rawUrl = `https://raw.githubusercontent.com/marshallofsound/humaaans/master/${node.path}`;
          const svgContent = await fetchText(rawUrl);
          const slug = node.path.split('/').pop().replace('.svg', '');
          const uid = `humaaans_${slug}`;
          if (seenIds.has(uid)) return;

          const parts = extractSvgParts(svgContent);
          if (!parts) return;

          seenIds.add(uid);
          icons.push({
            id: uid,
            name: slug.replace(/[-_]/g, ' '),
            body: parts.svg,
            viewBox: parts.viewBox,
            tags: ['humaaans', 'flat', 'people', 'mix-and-match'],
            style: 'flat',
          });
        } catch (e) { /* skip */ }
      }));
    }

    console.log(`  ✓ Humaaans: ${icons.length}`);
    return icons;
  } catch (e) {
    console.log(`  ✗ Humaaans failed: ${e.message}`);
    return [];
  }
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  const processors = [
    { src: sources[0], fn: processUnDraw },
    { src: sources[1], fn: processOpenDoodles },
    { src: sources[2], fn: processDrawKit },
    { src: sources[3], fn: processHumaaans },
  ];

  const collectionsList = [];
  const sourcesOutput = {};
  let totalItems = 0;

  for (const { src, fn } of processors) {
    const icons = await fn();
    if (!icons.length) continue;

    const collectionDir = path.join(outputDir, src.id);
    fs.mkdirSync(collectionDir, { recursive: true });

    const metadata = {
      id: src.id,
      name: src.name,
      total: icons.length,
      styles: [src.style],
      license: src.license,
      category: src.category,
      author: src.author,
    };

    fs.writeFileSync(path.join(collectionDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    fs.writeFileSync(path.join(collectionDir, 'icons.json'), JSON.stringify(icons, null, 2));

    collectionsList.push(metadata);
    sourcesOutput[src.id] = { license: src.license };
    totalItems += icons.length;
  }

  collectionsList.sort((a, b) => b.total - a.total);

  fs.writeFileSync(sourcesFile, JSON.stringify(sourcesOutput, null, 2));
  fs.writeFileSync(
    path.join(outputDir, 'collections.json'),
    JSON.stringify({ totalCollections: collectionsList.length, totalIcons: totalItems, collections: collectionsList }, null, 2)
  );

  console.log(`\nDone — ${totalItems} illustrations across ${collectionsList.length} collections.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
