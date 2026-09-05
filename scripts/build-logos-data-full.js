const fs = require("fs");
const path = require("path");
const https = require("https");

const outputDir = path.join(__dirname, "../data/logos");
const sourcesFile = path.join(outputDir, "sources.json");

const allLogos = [];
const seenIds = new Set();
const collectionsMap = new Map();

const baseUrl =
  "https://raw.githubusercontent.com/iconify/icon-sets/master/json/";

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
  return vLeft + " " + vTop + " " + vWidth + " " + vHeight;
}

async function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, options, (res) => {
        if (res.statusCode >= 300) {
          return reject(new Error(`Status Code: ${res.statusCode}`));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300) {
          return reject(new Error(`Status Code: ${res.statusCode}`));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

const sources = [
  { file: "logos", sourceId: "logos", sourceName: "SVG Logos", style: "color" },
  {
    file: "simple-icons",
    sourceId: "simpleicons",
    sourceName: "Simple Icons",
    style: "solid",
  },
  {
    file: "skill-icons",
    sourceId: "skillicons",
    sourceName: "Skill Icons",
    style: "color",
  },
  {
    file: "devicon",
    sourceId: "devicon",
    sourceName: "Devicon",
    style: "color",
  },
];

async function processSource(src) {
  console.log(`Fetching ${src.sourceName} (${src.file}.json)...`);
  try {
    const data = await fetchJson(`${baseUrl}${src.file}.json`);
    const iconsObj = data.icons || {};

    const collectionIcons = [];

    Object.entries(iconsObj).forEach(([iconName, iconData]) => {
      if (iconData.hidden) return;
      const svgBody = iconData.body;
      if (!svgBody) return;

      const uid = `${src.sourceId}_${src.style}_${iconName}`;
      if (seenIds.has(uid)) return;
      seenIds.add(uid);
      const viewBox = getDimensions(iconData, data);

      collectionIcons.push({
        id: iconName,
        name: iconName.replace(/-/g, " "),
        body: svgBody,
        width: parseFloat(viewBox.split(" ")[2]) || 24,
        height: parseFloat(viewBox.split(" ")[3]) || 24,
        viewBox: viewBox,
      });
    });

    const metadata = {
      id: src.sourceId,
      name: src.sourceName,
      total: collectionIcons.length,
      styles: [src.style],
      license: data.info?.license?.title || "Unknown",
      licenseUrl: data.info?.license?.url || "",
      category: data.info?.category || "Logo",
      author: data.info?.author?.name || "Unknown",
    };

    collectionsMap.set(src.sourceId, { metadata, icons: collectionIcons });
    console.log(
      `  ✓ Added ${collectionIcons.length} logos from ${src.sourceName}`,
    );
  } catch (e) {
    console.log(`  ✗ Error downloading ${src.file}.json: ${e.message}`);
  }
}

async function processVectorLogoZone() {
  console.log(`Fetching VectorLogoZone (via GitHub Tree)...`);
  try {
    const treeData = await fetchJson(
      "https://api.github.com/repos/VectorLogoZone/vectorlogozone/git/trees/main?recursive=1",
      {
        headers: { "User-Agent": "Node.js Fetcher" },
      },
    );

    const svgFiles = treeData.tree.filter(
      (node) =>
        node.path.startsWith("src/content/logos/") &&
        node.path.endsWith(".svg"),
    );

    console.log(
      `  Found ${svgFiles.length} logos in VectorLogoZone. Downloading SVGs...`,
    );

    const collectionIcons = [];
    let count = 0;
    const chunkSize = 50;

    for (let i = 0; i < svgFiles.length; i += chunkSize) {
      const chunk = svgFiles.slice(i, i + chunkSize);

      await Promise.all(
        chunk.map(async (fileNode) => {
          try {
            const rawUrl = `https://raw.githubusercontent.com/VectorLogoZone/vectorlogozone/main/${fileNode.path}`;
            const svgContent = await fetchText(rawUrl);

            const iconName = fileNode.path.split("/").pop().replace(".svg", "");
            const uid = `vectorlogozone_color_${iconName}`;
            if (seenIds.has(uid)) return;

            let viewBox = "0 0 24 24"; // default
            const vbMatch = svgContent.match(/viewBox=["'](.*?)["']/i);
            if (vbMatch) {
              viewBox = vbMatch[1];
            } else {
              const wMatch = svgContent.match(
                /<svg[^>]*\swidth=["']([^"']+)["']/i,
              );
              const hMatch = svgContent.match(
                /<svg[^>]*\sheight=["']([^"']+)["']/i,
              );
              if (wMatch && hMatch) {
                const w = parseFloat(wMatch[1].replace(/[^\d.]/g, ""));
                const h = parseFloat(hMatch[1].replace(/[^\d.]/g, ""));
                if (!isNaN(w) && !isNaN(h)) {
                  viewBox = `0 0 ${w} ${h}`;
                }
              }
            }

            const bodyMatch = svgContent.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
            let svgBody = "";
            if (bodyMatch) {
              svgBody = bodyMatch[1].trim();
            } else {
              return;
            }

            seenIds.add(uid);
            collectionIcons.push({
              id: iconName,
              name: iconName.replace(/-/g, " "),
              body: svgBody,
              width: parseFloat(viewBox.split(" ")[2]) || 24,
              height: parseFloat(viewBox.split(" ")[3]) || 24,
              viewBox: viewBox,
            });
            count++;
          } catch (e) {
            // ignore individual fetch errors
          }
        }),
      );

      process.stdout.write(
        `\r  Progress: ${Math.min(i + chunkSize, svgFiles.length)} / ${svgFiles.length} (${count} added)`,
      );
    }

    const metadata = {
      id: "vectorlogozone",
      name: "VectorLogoZone",
      total: collectionIcons.length,
      styles: ["color"],
      license: "Unknown",
      category: "Logo",
      author: "VectorLogoZone",
    };

    collectionsMap.set("vectorlogozone", { metadata, icons: collectionIcons });
    console.log(`\n  ✓ Added ${count} logos from VectorLogoZone`);
  } catch (e) {
    console.log(`\n  ✗ Error downloading VectorLogoZone: ${e.message}`);
  }
}

async function main() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const src of sources) {
    await processSource(src);
  }

  await processVectorLogoZone();

  let totalIcons = 0;
  const collectionsList = [];
  const sourcesOutput = {};

  for (const [id, data] of collectionsMap) {
    const collectionPath = path.join(outputDir, id);
    fs.mkdirSync(collectionPath, { recursive: true });

    fs.writeFileSync(
      path.join(collectionPath, "metadata.json"),
      JSON.stringify(data.metadata, null, 2),
    );
    fs.writeFileSync(
      path.join(collectionPath, "icons.json"),
      JSON.stringify(data.icons, null, 2),
    );

    collectionsList.push(data.metadata);
    totalIcons += data.metadata.total;

    sourcesOutput[id] = {
      license: data.metadata.license,
      licenseUrl: data.metadata.licenseUrl,
    };
  }

  collectionsList.sort((a, b) => b.total - a.total);

  fs.writeFileSync(sourcesFile, JSON.stringify(sourcesOutput, null, 2));

  fs.writeFileSync(
    path.join(outputDir, "collections.json"),
    JSON.stringify(
      {
        totalCollections: collectionsList.length,
        totalIcons: totalIcons,
        collections: collectionsList,
      },
      null,
      2,
    ),
  );

  console.log(
    `\nSaved ${totalIcons} logos across ${collectionsList.length} collections!`,
  );
}

main();
