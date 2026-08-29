#!/usr/bin/env node

/**
 * Fetch ALL icons from Iconify and build nested folder structure
 * Includes 200+ collections with all styles
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const baseUrl = 'https://raw.githubusercontent.com/iconify/icon-sets/master/json/';
const outputDir = path.join(__dirname, '../data/icons');

const collectionsMap = new Map();
let totalIconsProcessed = 0;
let processedCount = 0;
let totalSources = 0;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300) {
        return reject(new Error(`Status Code: ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function getDimensions(iconData, data) {
  const info = data.info || {};
  const dH = info.displayHeight;
  const dW = info.displayWidth ?? dH;
  const defaultHeight = dH ?? info.height ?? info.width ?? 16;
  const defaultWidth = dW ?? info.width ?? info.height ?? 16;
  const vLeft = iconData.left ?? data.left ?? 0;
  const vTop = iconData.top ?? data.top ?? 0;
  const vWidth = iconData.width ?? data.width ?? defaultWidth;
  const vHeight = iconData.height ?? data.height ?? defaultHeight;
  return vLeft + ' ' + vTop + ' ' + vWidth + ' ' + vHeight;
}

function addToCollection(collectionId, collectionName, icon) {
  if (!collectionsMap.has(collectionId)) {
    collectionsMap.set(collectionId, {
      metadata: {
        id: collectionId,
        name: collectionName,
        total: 0,
        styles: new Set(),
        categories: new Set(),
      },
      icons: []
    });
  }

  const collection = collectionsMap.get(collectionId);
  collection.icons.push(icon);
  collection.metadata.total++;
  collection.metadata.styles.add(icon.style);
  collection.metadata.categories.add(icon.category);
  totalIconsProcessed++;
}

// ALL source configurations from fetch_real_icons.js
const sources = [
  // --- NEW PACKS ---
  { file: 'tabler', sourceId: 'tabler', sourceName: 'Tabler Icons', style: 'outline' },
  { file: 'ph', sourceId: 'phosphor', sourceName: 'Phosphor', style: 'outline' },
  { file: 'solar', sourceId: 'solar', sourceName: 'Solar', style: 'outline' },
  { file: 'mingcute', sourceId: 'mingcute', sourceName: 'MingCute', style: 'outline' },
  { file: 'circum', sourceId: 'circum', sourceName: 'Circum Icons', style: 'outline' },
  { file: 'typcn', sourceId: 'typicons', sourceName: 'Typicons', style: 'solid' },

  // --- OUTLINE ---
  { file: 'lucide', sourceId: 'lucide', sourceName: 'Lucide', style: 'outline' },
  { file: 'feather', sourceId: 'feather', sourceName: 'Feather', style: 'outline' },
  { file: 'heroicons-outline', sourceId: 'heroicons', sourceName: 'Heroicons', style: 'outline' },
  { file: 'radix-icons', sourceId: 'radix', sourceName: 'Radix Icons', style: 'outline' },
  { file: 'ant-design', sourceId: 'antd', sourceName: 'Ant Design', style: 'outline' },
  { file: 'carbon', sourceId: 'carbon', sourceName: 'Carbon', style: 'outline' },
  { file: 'hugeicons', sourceId: 'hugeicons', sourceName: 'Huge Icons', style: 'outline' },
  { file: 'bx', sourceId: 'boxicons', sourceName: 'Boxicons', style: 'outline' },
  { file: 'iconoir', sourceId: 'iconoir', sourceName: 'Iconoir', style: 'outline' },
  { file: 'arcticons', sourceId: 'arcticons', sourceName: 'Arcticons', style: 'outline' },
  { file: 'thesvg', sourceId: 'thesvg', sourceName: 'theSVG', style: 'outline' },
  { file: 'griddy-icons', sourceId: 'griddy', sourceName: 'Griddy Icons', style: 'outline' },
  { file: 'streamline', sourceId: 'streamline', sourceName: 'Streamline', style: 'outline' },
  { file: 'iconamoon', sourceId: 'iconamoon', sourceName: 'IconaMoon', style: 'outline' },
  { file: 'la', sourceId: 'la', sourceName: 'Line Awesome', style: 'outline' },
  { file: 'lets-icons', sourceId: 'letsicons', sourceName: 'Lets Icons', style: 'outline' },
  { file: 'f7', sourceId: 'f7', sourceName: 'Framework7', style: 'outline' },
  { file: 'uil', sourceId: 'uil', sourceName: 'Unicons', style: 'outline' },
  { file: 'clarity', sourceId: 'clarity', sourceName: 'Clarity', style: 'outline' },
  { file: 'mage', sourceId: 'mage', sourceName: 'Mage Icons', style: 'outline' },
  { file: 'octicon', sourceId: 'octicon', sourceName: 'Octicons', style: 'outline' },
  { file: 'flowbite', sourceId: 'flowbite', sourceName: 'Flowbite', style: 'outline' },
  { file: 'gravity-ui', sourceId: 'gravityui', sourceName: 'Gravity UI', style: 'outline' },
  { file: 'vaadin', sourceId: 'vaadin', sourceName: 'Vaadin', style: 'outline' },
  { file: 'teenyicons', sourceId: 'teenyicons', sourceName: 'Teenyicons', style: 'outline' },
  { file: 'stash', sourceId: 'stash', sourceName: 'Stash Icons', style: 'outline' },
  { file: 'jam', sourceId: 'jam', sourceName: 'Jam Icons', style: 'outline' },
  { file: 'qlementine-icons', sourceId: 'qlementine', sourceName: 'Qlementine', style: 'outline' },
  { file: 'majesticons', sourceId: 'majesticons', sourceName: 'Majesticons', style: 'outline' },
  { file: 'gg', sourceId: 'gg', sourceName: 'css.gg', style: 'outline' },
  { file: 'lineicons', sourceId: 'lineicons', sourceName: 'Lineicons', style: 'outline' },
  { file: 'icomoon-free', sourceId: 'icomoon', sourceName: 'IcoMoon Free', style: 'outline' },
  { file: 'eva', sourceId: 'eva', sourceName: 'Eva Icons', style: 'outline' },
  { file: 'cil', sourceId: 'coreui', sourceName: 'CoreUI Free', style: 'outline' },
  { file: 'system-uicons', sourceId: 'systemui', sourceName: 'System UIcons', style: 'outline' },
  { file: 'fontisto', sourceId: 'fontisto', sourceName: 'Fontisto', style: 'outline' },
  { file: 'proicons', sourceId: 'proicons', sourceName: 'ProIcons', style: 'outline' },
  { file: 'basil', sourceId: 'basil', sourceName: 'Basil', style: 'outline' },
  { file: 'akar-icons', sourceId: 'akar', sourceName: 'Akar Icons', style: 'outline' },
  { file: 'ci', sourceId: 'coolicons', sourceName: 'coolicons', style: 'outline' },
  { file: 'pixel', sourceId: 'pixelicon', sourceName: 'Pixel Icon', style: 'outline' },
  { file: 'marketeq', sourceId: 'marketeq', sourceName: 'Marketeq', style: 'outline' },
  { file: 'meteor-icons', sourceId: 'meteor', sourceName: 'Meteor Icons', style: 'outline' },
  { file: 'oi', sourceId: 'oi', sourceName: 'Open Iconic', style: 'outline' },
  { file: 'gridicons', sourceId: 'gridicons', sourceName: 'Gridicons', style: 'outline' },
  { file: 'simple-line-icons', sourceId: 'simpleline', sourceName: 'Simple Line', style: 'outline' },
  { file: 'rivet-icons', sourceId: 'rivet', sourceName: 'Rivet Icons', style: 'outline' },
  { file: 'eos-icons', sourceId: 'eos', sourceName: 'EOS Icons', style: 'outline' },
  { file: 'uiw', sourceId: 'uiw', sourceName: 'UIW Icons', style: 'outline' },
  { file: 'uit', sourceId: 'uit', sourceName: 'Unicons Thin', style: 'outline' },
  { file: 'mono-icons', sourceId: 'mono', sourceName: 'Mono Icons', style: 'outline' },
  { file: 'formkit', sourceId: 'formkit', sourceName: 'FormKit', style: 'outline' },
  { file: 'weui', sourceId: 'weui', sourceName: 'WeUI', style: 'outline' },
  { file: 'ion', sourceId: 'ionicons', sourceName: 'Ionicons', style: 'outline' },
  { file: 'fa6-regular', sourceId: 'fontawesome', sourceName: 'Font Awesome', style: 'outline' },
  { file: 'icon-park-outline', sourceId: 'iconpark', sourceName: 'IconPark', style: 'outline' },
  { file: 'ri', sourceId: 'remix', sourceName: 'Remix Icon', style: 'outline' },
  { file: 'mynaui', sourceId: 'mynaui', sourceName: 'Mynaui', style: 'outline' },
  { file: 'mdi-light', sourceId: 'material', sourceName: 'Material', style: 'outline' },
  { file: 'ep', sourceId: 'ep', sourceName: 'Element Plus', style: 'outline' },
  { file: 'pepicons-print', sourceId: 'pepicons', sourceName: 'Pepicons', style: 'outline' },
  { file: 'charm', sourceId: 'charm', sourceName: 'Charm Icons', style: 'outline' },
  { file: 'nimbus', sourceId: 'nimbus', sourceName: 'Nimbus Icons', style: 'outline' },
  { file: 'quill', sourceId: 'quill', sourceName: 'Quill Icons', style: 'outline' },
  { file: 'bytesize', sourceId: 'bytesize', sourceName: 'Bytesize', style: 'outline' },
  { file: 'nonicons', sourceId: 'nonicons', sourceName: 'Nonicons', style: 'outline' },
  { file: 'oui', sourceId: 'oui', sourceName: 'OpenSearch UI', style: 'outline' },
  { file: 'wpf', sourceId: 'wpf', sourceName: 'WPF UI Icons', style: 'outline' },
  { file: 'ps', sourceId: 'primeicons', sourceName: 'PrimeIcons', style: 'outline' },
  { file: 'topcoat', sourceId: 'topcoat', sourceName: 'Topcoat', style: 'outline' },
  { file: 'gis', sourceId: 'gis', sourceName: 'GIS Map Icons', style: 'outline' },

  // --- SOLID ---
  { file: 'heroicons-solid', sourceId: 'heroicons', sourceName: 'Heroicons', style: 'solid' },
  { file: 'fa6-solid', sourceId: 'fontawesome', sourceName: 'Font Awesome', style: 'solid' },
  { file: 'icon-park-solid', sourceId: 'iconpark', sourceName: 'IconPark', style: 'solid' },
  { file: 'bxs', sourceId: 'boxicons', sourceName: 'Boxicons Solid', style: 'solid' },
  { file: 'simple-icons', sourceId: 'simpleicons', sourceName: 'Simple Icons', style: 'solid' },
  { file: 'ic', sourceId: 'ic', sourceName: 'Google Material Icons', style: 'outline' },
  { file: 'line-md', sourceId: 'linemd', sourceName: 'Material Line Icons', style: 'outline' },
  { file: 'lucide-lab', sourceId: 'lucidelab', sourceName: 'Lucide Lab', style: 'outline' },
  { file: 'prime', sourceId: 'prime', sourceName: 'Prime Icons', style: 'outline' },
  { file: 'bitcoin-icons', sourceId: 'bitcoin', sourceName: 'Bitcoin Icons', style: 'outline' },
  { file: 'humbleicons', sourceId: 'humble', sourceName: 'Humbleicons', style: 'outline' },
  { file: 'wordpress', sourceId: 'wordpress', sourceName: 'WordPress Icons', style: 'solid' },
  { file: 'icon-park-twotone', sourceId: 'iptwotone', sourceName: 'IconPark TwoTone', style: 'multi-color' },
  { file: 'guidance', sourceId: 'guidance', sourceName: 'Guidance', style: 'solid' },
  { file: 'cuida', sourceId: 'cuida', sourceName: 'Cuida Icons', style: 'outline' },
  { file: 'duo-icons', sourceId: 'duoicons', sourceName: 'Duoicons', style: 'duotone' },
  { file: 'uim', sourceId: 'uim', sourceName: 'Unicons Monochrome', style: 'outline' },

  // More collections...
  { file: 'mdi', sourceId: 'mdi', sourceName: 'Material Design Icons', style: 'solid' },
  { file: 'pepicons-pop', sourceId: 'pepicons-pop', sourceName: 'Pepicons Pop', style: 'solid' },
  { file: 'zondicons', sourceId: 'zondicons', sourceName: 'Zondicons', style: 'solid' },
  { file: 'dashicons', sourceId: 'dashicons', sourceName: 'Dashicons', style: 'solid' },
  { file: 'entypo', sourceId: 'entypo', sourceName: 'Entypo', style: 'solid' },
  { file: 'entypo-social', sourceId: 'entyposoc', sourceName: 'Entypo Social', style: 'solid' },
  { file: 'foundation', sourceId: 'foundation', sourceName: 'Foundation', style: 'solid' },
  { file: 'fa6-brands', sourceId: 'fabrand', sourceName: 'FA6 Brands', style: 'solid' },
  { file: 'cib', sourceId: 'cib', sourceName: 'CoreUI Brands', style: 'solid' },
  { file: 'bxl', sourceId: 'bxlogos', sourceName: 'Boxicons Logos', style: 'solid' },

  // Color/Emoji packs
  { file: 'noto', sourceId: 'noto', sourceName: 'Noto Emoji', style: 'color' },
  { file: 'twemoji', sourceId: 'twemoji', sourceName: 'Twemoji', style: 'color' },
  { file: 'openmoji', sourceId: 'openmoji', sourceName: 'OpenMoji', style: 'color' },
  { file: 'logos', sourceId: 'logos', sourceName: 'SVG Logos', style: 'color' },
  { file: 'vscode-icons', sourceId: 'vscode', sourceName: 'VSCode Icons', style: 'color' },
  { file: 'devicon', sourceId: 'devicon', sourceName: 'Devicon', style: 'color' },
  { file: 'skill-icons', sourceId: 'skillicons', sourceName: 'Skill Icons', style: 'color' },
  { file: 'circle-flags', sourceId: 'circleflags', sourceName: 'Circle Flags', style: 'color' },
  { file: 'flag', sourceId: 'flagicons', sourceName: 'Flag Icons', style: 'color' },
  { file: 'flagpack', sourceId: 'flagpack', sourceName: 'Flagpack', style: 'color' },
];

async function processSource(src) {
  try {
    processedCount++;
    process.stdout.write(`\r  [${processedCount}/${totalSources}] ${src.sourceName.padEnd(30)} `);

    const data = await fetchJson(`${baseUrl}${src.file}.json`);
    const iconsObj = data.icons || {};
    let count = 0;

    Object.entries(iconsObj).forEach(([iconName, iconData]) => {
      if (iconData.hidden) return;
      const svgBody = iconData.body;
      if (!svgBody) return;

      const viewBox = getDimensions(iconData, data);
      addToCollection(src.sourceId, src.sourceName, {
        id: `${src.sourceId}_${src.style}_${iconName}`,
        name: iconName,
        category: 'UI',
        tags: [iconName, src.sourceId, src.style],
        style: src.style,
        viewBox: viewBox,
        svg: svgBody
      });
      count++;
    });

    process.stdout.write(`✅ ${count}\n`);
  } catch (e) {
    process.stdout.write(`❌ ${e.message}\n`);
  }
}

// Special handlers
async function processTabler() {
  processedCount++;
  process.stdout.write(`\r  [${processedCount}/${totalSources}] Tabler (multi-style)`.padEnd(40));

  try {
    const data = await fetchJson(`${baseUrl}tabler.json`);
    const iconsObj = data.icons || {};
    const counts = { outline: 0, solid: 0 };

    Object.entries(iconsObj).forEach(([iconName, iconData]) => {
      if (iconData.hidden) return;
      const svgBody = iconData.body;
      if (!svgBody) return;

      let style, baseName;
      if (iconName.endsWith('-filled')) {
        style = 'solid';
        baseName = iconName.replace(/-filled$/, '');
      } else {
        style = 'outline';
        baseName = iconName;
      }

      const viewBox = getDimensions(iconData, data);
      addToCollection('tabler', 'Tabler Icons', {
        id: `tabler_${style}_${baseName}`,
        name: baseName,
        category: 'UI',
        tags: [baseName, 'tabler', style],
        style: style,
        viewBox: viewBox,
        svg: svgBody
      });
      counts[style]++;
    });

    process.stdout.write(`✅ ${counts.outline + counts.solid}\n`);
  } catch (e) {
    process.stdout.write(`❌ ${e.message}\n`);
  }
}

async function processBootstrap() {
  processedCount++;
  process.stdout.write(`\r  [${processedCount}/${totalSources}] Bootstrap (multi-style)`.padEnd(40));

  try {
    const data = await fetchJson(`${baseUrl}bi.json`);
    const iconsObj = data.icons || {};
    const counts = { outline: 0, solid: 0 };

    Object.entries(iconsObj).forEach(([iconName, iconData]) => {
      if (iconData.hidden) return;
      const svgBody = iconData.body;
      if (!svgBody) return;

      let style, baseName;
      if (iconName.endsWith('-fill')) {
        style = 'solid';
        baseName = iconName.replace(/-fill$/, '');
      } else {
        style = 'outline';
        baseName = iconName;
      }

      const viewBox = getDimensions(iconData, data);
      addToCollection('bootstrap', 'Bootstrap Icons', {
        id: `bootstrap_${style}_${baseName}`,
        name: baseName,
        category: 'UI',
        tags: [baseName, 'bootstrap', style],
        style: style,
        viewBox: viewBox,
        svg: svgBody
      });
      counts[style]++;
    });

    process.stdout.write(`✅ ${counts.outline + counts.solid}\n`);
  } catch (e) {
    process.stdout.write(`❌ ${e.message}\n`);
  }
}

async function processPhosphor() {
  processedCount++;
  process.stdout.write(`\r  [${processedCount}/${totalSources}] Phosphor (multi-style)`.padEnd(40));

  try {
    const data = await fetchJson(`${baseUrl}ph.json`);
    const iconsObj = data.icons || {};
    const counts = { outline: 0, solid: 0, bold: 0, thin: 0, duotone: 0 };

    Object.entries(iconsObj).forEach(([iconName, iconData]) => {
      if (iconData.hidden) return;
      const svgBody = iconData.body;
      if (!svgBody) return;

      let style, baseName;
      if (iconName.endsWith('-fill')) {
        style = 'solid';
        baseName = iconName.replace(/-fill$/, '');
      } else if (iconName.endsWith('-bold')) {
        style = 'bold';
        baseName = iconName.replace(/-bold$/, '');
      } else if (iconName.endsWith('-thin')) {
        style = 'thin';
        baseName = iconName.replace(/-thin$/, '');
      } else if (iconName.endsWith('-duotone')) {
        style = 'duotone';
        baseName = iconName.replace(/-duotone$/, '');
      } else if (iconName.endsWith('-light')) {
        return;
      } else {
        style = 'outline';
        baseName = iconName;
      }

      const viewBox = getDimensions(iconData, data);
      addToCollection('phosphor', 'Phosphor', {
        id: `phosphor_${style}_${baseName}`,
        name: baseName,
        category: 'UI',
        tags: [baseName, 'phosphor', style],
        style: style,
        viewBox: viewBox,
        svg: svgBody
      });
      counts[style]++;
    });

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    process.stdout.write(`✅ ${total}\n`);
  } catch (e) {
    process.stdout.write(`❌ ${e.message}\n`);
  }
}

async function main() {
  console.log('🚀 Fetching ALL icons from Iconify...\n');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  totalSources = sources.length + 3; // +3 for special handlers

  await processTabler();
  await processBootstrap();
  await processPhosphor();

  for (const src of sources) {
    await processSource(src);
  }

  console.log(`\n✅ Fetched ${totalIconsProcessed.toLocaleString()} icons from ${collectionsMap.size} collections\n`);

  // Write to disk
  console.log('💾 Writing to disk...\n');
  const collectionsList = [];

  for (const [collectionId, data] of collectionsMap) {
    const collectionPath = path.join(outputDir, collectionId);
    fs.mkdirSync(collectionPath, { recursive: true });

    const metadata = {
      id: data.metadata.id,
      name: data.metadata.name,
      displayName: data.metadata.name,
      total: data.metadata.total,
      styles: Array.from(data.metadata.styles),
      categories: Array.from(data.metadata.categories),
      defaultViewBox: '0 0 24 24',
      updated: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(collectionPath, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    fs.writeFileSync(
      path.join(collectionPath, 'icons.json'),
      JSON.stringify(data.icons, null, 2)
    );

    collectionsList.push({
      id: metadata.id,
      name: metadata.name,
      total: metadata.total,
      styles: metadata.styles,
    });

    const sizeKB = Math.round(JSON.stringify(data.icons).length / 1024);
    console.log(`  ✅ ${collectionId.padEnd(20)} ${metadata.total.toString().padStart(6)} icons (${sizeKB.toLocaleString()} KB)`);
  }

  const collectionsFile = {
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
    totalCollections: collectionsList.length,
    totalIcons: totalIconsProcessed,
    collections: collectionsList.sort((a, b) => b.total - a.total),
  };

  fs.writeFileSync(
    path.join(outputDir, 'collections.json'),
    JSON.stringify(collectionsFile, null, 2)
  );

  console.log('\n' + '='.repeat(60));
  console.log('✨ Build Complete!');
  console.log('='.repeat(60));
  console.log(`📊 Collections: ${collectionsList.length}`);
  console.log(`🎨 Total Icons: ${totalIconsProcessed.toLocaleString()}`);
  console.log(`📁 Location:    ${outputDir}`);
  console.log('='.repeat(60));

  console.log('\n🏆 Top 15 Collections:');
  collectionsList.slice(0, 15).forEach((col, i) => {
    console.log(`   ${(i + 1).toString().padStart(2)}. ${col.name.padEnd(25)} ${col.total.toString().padStart(7)} icons`);
  });

  console.log('\n✅ Ready! Start the backend:');
  console.log('   npm run start:dev\n');
}

main().catch(console.error);
