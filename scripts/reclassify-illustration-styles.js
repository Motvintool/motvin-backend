#!/usr/bin/env node

/**
 * Sort every illustration into one of the two styles the page ships:
 *
 *   color - full-colour artwork, rendered with its own palette
 *   solid - a single-colour drawing, recolourable like an icon
 *
 * Illustrations already carried a per-item style, but it was copied from the
 * collection, so a monochrome piece inside a colour set kept the wrong label
 * (Fluent Emoji's high-contrast variants are monochrome but filed as colour).
 *
 * Three of the five collections ship only an imageUrl with no inline SVG, so
 * there is no artwork to inspect. Those keep their declared style rather than
 * being guessed at, and the report says so.
 *
 * Usage: node scripts/reclassify-illustration-styles.js [--dry-run]
 */

const fs = require("fs");
const path = require("path");

const dataRoot = path.join(__dirname, "../data/illustrations");
const DRY_RUN = process.argv.includes("--dry-run");

const STYLES = ["color", "solid"];


// --------------------------------------------------------------------
// Colour analysis
//
// "Does this artwork carry a hue, or is it a monochrome mark?" Answering it by
// matching literal strings against a list of #000/#fff/black/white was wrong:
// it called #212121, #333, #999 and gray "colour". Parse the value and compare
// channels instead.
// --------------------------------------------------------------------

// Achromatic CSS named colours. Any other name is assumed to carry a hue.
const NEUTRAL_NAMES = new Set([
  "black", "white", "gray", "grey", "silver", "gainsboro", "whitesmoke",
  "dimgray", "dimgrey", "darkgray", "darkgrey", "lightgray", "lightgrey",
  "snow", "ivory",
]);

// Values that paint nothing, or defer the decision elsewhere.
const NON_PAINT = new Set(["", "none", "currentcolor", "inherit", "transparent"]);

/** Does a single CSS colour value carry a hue? */
function valueHasHue(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (NON_PAINT.has(v)) return false;
  if (v.startsWith("url(")) return false; // a reference; judged separately
  if (v.startsWith("var(")) return false; // theme token, not artwork colour

  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h.slice(0, 3).split("").map((c) => c + c).join("");
    } else {
      h = h.slice(0, 6);
    }
    if (h.length < 6) return false; // malformed, e.g. #00000 - browsers ignore it
    return !(h.slice(0, 2) === h.slice(2, 4) && h.slice(2, 4) === h.slice(4, 6));
  }

  const rgb = /^rgba?\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)/.exec(v);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map((n) => parseFloat(n));
    return !(r === g && g === b);
  }

  const hsl = /^hsla?\(\s*[\d.]+(?:deg|rad|turn)?[,\s]+([\d.]+)%/.exec(v);
  if (hsl) return parseFloat(hsl[1]) !== 0;

  if (NEUTRAL_NAMES.has(v)) return false;
  return true; // an unrecognised name (tomato, navy, ...) carries a hue
}

const PAINT_ATTR_RE =
  /(?:fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*"([^"]*)"/gi;
const STYLE_ATTR_RE = /style\s*=\s*"([^"]*)"/gi;
const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const CSS_PAINT_RE = /(?:fill|stroke|stop-color)\s*:\s*([^;}"\s!]+)/gi;
const RASTER_RE = /<image\b/i;

/** Every paint value declared, via attributes, inline style, or <style> rules. */
function paintValues(svg) {
  const values = [];
  let m;

  PAINT_ATTR_RE.lastIndex = 0;
  while ((m = PAINT_ATTR_RE.exec(svg)) !== null) values.push(m[1]);

  STYLE_ATTR_RE.lastIndex = 0;
  while ((m = STYLE_ATTR_RE.exec(svg)) !== null) {
    let d;
    CSS_PAINT_RE.lastIndex = 0;
    while ((d = CSS_PAINT_RE.exec(m[1])) !== null) values.push(d[1]);
  }

  STYLE_BLOCK_RE.lastIndex = 0;
  while ((m = STYLE_BLOCK_RE.exec(svg)) !== null) {
    let d;
    CSS_PAINT_RE.lastIndex = 0;
    while ((d = CSS_PAINT_RE.exec(m[1])) !== null) values.push(d[1]);
  }

  return values;
}

/** Coloured when any declared paint carries a hue, or a raster is embedded. */
function isColoredArtwork(svg) {
  if (!svg) return false;
  if (paintValues(svg).some(valueHasHue)) return true;
  return RASTER_RE.test(svg);
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf-8"));
const writeJson = (f, v) => {
  if (!DRY_RUN) fs.writeFileSync(f, JSON.stringify(v));
};

function main() {
  const collectionsFile = path.join(dataRoot, "collections.json");
  const collectionsData = readJson(collectionsFile);
  const byId = new Map(collectionsData.collections.map((c) => [c.id, c]));

  const totals = {};
  let grandTotal = 0;
  let moved = 0;
  let uninspectable = 0;

  const dirs = fs
    .readdirSync(dataRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const collectionId of dirs) {
    const file = path.join(dataRoot, collectionId, "icons.json");
    if (!fs.existsSync(file)) continue;

    const items = readJson(file);
    const entry = byId.get(collectionId);
    const declared =
      entry && entry.styles && entry.styles.length ? entry.styles[0] : "color";

    const counts = {};
    let skipped = 0;

    for (const item of items) {
      if (!("sourceStyle" in item)) item.sourceStyle = item.style ?? declared;

      const svg = item.svg || item.body || "";
      let style;
      if (svg) {
        style = isColoredArtwork(svg) ? "color" : "solid";
      } else {
        // imageUrl-only: no artwork to read, so trust what it already says.
        style = STYLES.includes(item.style) ? item.style : declared;
        skipped++;
      }

      if (item.style !== style) moved++;
      item.style = style;
      counts[style] = (counts[style] || 0) + 1;
      totals[style] = (totals[style] || 0) + 1;
    }

    grandTotal += items.length;
    uninspectable += skipped;
    writeJson(file, items);

    const styles = STYLES.filter((s) => counts[s]);
    const metaFile = path.join(dataRoot, collectionId, "metadata.json");
    if (fs.existsSync(metaFile)) {
      const meta = readJson(metaFile);
      meta.total = items.length;
      meta.styles = styles;
      meta.styleCounts = counts;
      writeJson(metaFile, meta);
    }
    if (entry) {
      entry.total = items.length;
      entry.styles = styles;
      entry.styleCounts = counts;
    }

    const note = skipped ? `  (${skipped} imageUrl-only, style kept)` : "";
    process.stdout.write(
      `${collectionId.padEnd(14)} ${String(items.length).padStart(4)}  ` +
        `${styles.map((s) => `${s}=${counts[s]}`).join(" ")}${note}\n`,
    );
  }

  collectionsData.totalIcons = grandTotal;
  collectionsData.totalCollections = collectionsData.collections.length;
  writeJson(collectionsFile, collectionsData);

  console.log("\n--- totals ---");
  for (const s of STYLES) {
    console.log(`  ${s.padEnd(8)} ${(totals[s] || 0).toLocaleString()}`);
  }
  console.log(
    `\n${moved} of ${grandTotal} illustrations restyled` +
      ` (${uninspectable} had no inline SVG to inspect)` +
      `${DRY_RUN ? " (dry run, nothing written)" : ""}`,
  );
}

main();
