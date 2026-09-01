#!/usr/bin/env node

const fs = require("fs");
const https = require("https");
const path = require("path");

const dataDirectory = path.join(__dirname, "../data/icons");
const collectionsPath = path.join(dataDirectory, "collections.json");
const sourcesPath = path.join(dataDirectory, "sources.json");
const iconifyCollectionsUrl = "https://api.iconify.design/collections";
const concurrency = 8;
const sourceAliases = {
  "iconpark-base": "icon-park",
  fa5: "fa6-solid",
  fa7: "fa7-solid",
  fabrand: "fa7-brands",
  iptwotone: "icon-park-twotone",
  "fluent-emoji-hc": "fluent-emoji-high-contrast",
  "emojione-mono": "emojione-monotone",
  linemd: "line-md",
  qlementine: "qlementine-icons",
  gravityui: "gravity-ui",
  crypto: "cryptocurrency",
  "crypto-color": "cryptocurrency-color",
  "streamline-kameleon": "streamline-kameleon-color",
  "flat-color": "flat-color-icons",
  bxlogos: "bxl",
  material: "ic",
  sidekick: "sidekickicons",
  "streamline-stickies": "streamline-stickies-color",
  simpleline: "simple-line-icons",
  mono: "mono-icons",
};
const verifiedLicenseUrls = {
  zmdi: "https://github.com/zavoloklom/material-design-iconic-font/blob/master/LICENSE",
  "flat-color":
    "https://github.com/icons8/flat-color-icons/blob/master/LICENSE",
  icons8: "https://github.com/icons8/windows-10-icons/blob/master/LICENSE",
  weui: "https://github.com/weui/weui-icon/blob/master/LICENSE",
  il: "https://github.com/icalia-labs/icalicons/blob/master/LICENSE",
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Invalid JSON response"));
          }
        });
      })
      .on("error", reject);
  });
}

async function mapWithConcurrency(items, worker) {
  const results = [];
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      results.push(await worker(item));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker),
  );
  return results;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function main() {
  const collections = JSON.parse(fs.readFileSync(collectionsPath, "utf8"));
  const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  const index = await fetchJson(iconifyCollectionsUrl);
  const indexEntries = Object.entries(index);
  const updates = [];
  const unresolved = [];

  await mapWithConcurrency(collections.collections, async (collection) => {
    const current = sources[collection.id] || {};
    const needsLicense = !current.license || current.license === "Unknown";
    const needsUrl = !current.licenseUrl;
    if (!needsLicense && !needsUrl) return;

    try {
      const alias = sourceAliases[collection.id];
      const directMatch = index[alias || collection.id];
      const nameMatches = indexEntries.filter(
        ([, info]) =>
          normalizeName(info.name) === normalizeName(collection.name),
      );
      const upstream =
        directMatch || (nameMatches.length === 1 ? nameMatches[0][1] : null);
      const license = upstream?.license;
      const title = license?.title || license?.spdx;
      const licenseUrl = license?.url || verifiedLicenseUrls[collection.id];

      if (!title) {
        unresolved.push(
          `${collection.id}: ${upstream ? "incomplete" : "no matching"} upstream license data`,
        );
        return;
      }

      sources[collection.id] = {
        license: needsLicense ? title : current.license,
        licenseUrl: needsUrl ? licenseUrl : current.licenseUrl,
      };
      updates.push(collection.id);
      if (!licenseUrl) {
        unresolved.push(`${collection.id}: no official license URL published`);
      }
    } catch (error) {
      unresolved.push(`${collection.id}: ${error.message}`);
    }
  });

  fs.writeFileSync(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
  console.log(`Updated ${updates.length} icon source records.`);
  if (unresolved.length > 0) {
    console.warn(`Unresolved ${unresolved.length} collections:`);
    unresolved.forEach((entry) => console.warn(`- ${entry}`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
