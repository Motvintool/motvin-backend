#!/usr/bin/env node

/**
 * Verify every icon in data/icons and move it into the style it actually is.
 *
 * The `style` on an icon came from the Iconify source file name, so it named the
 * upstream file, not the artwork. That left four problems:
 *   - "outline" held 83k fill-only icons whose stroke cannot be adjusted
 *   - colored artwork ("color" / "multi-color") had no style chip at all
 *   - 27k icons carried no style and silently defaulted to "outline" in the UI
 *   - collections that pack several upstream variants into one file (Google
 *     Material Icons ships baseline/outline/round/sharp/twotone) reported a
 *     single style for all of them
 *
 * Styles after this pass: outline, solid, duotone, thin, 3d.
 *   3d      - colored artwork; the only bucket rendered with its native colors
 *   outline - any stroked artwork. The renderer applies its own stroke-width to
 *             every non-none stroke, so all of it is width-adjustable, and the
 *             Stroke Width control belongs to this style alone.
 *   solid   - everything painted with a fill, whether it reads as a solid
 *             shape or as a hollow outline drawn with fills
 *   duotone / thin - the two upstream variants still honoured by name, because
 *             the artwork alone cannot reveal them
 *
 * There is no "rounded" style: every icon that carried it was fill artwork and
 * now sorts into Solid, and there is no "bold" style either - fill artwork all
 * lands in Solid regardless of how heavy or hollow it looks.
 *
 * The original value is kept on each icon as `sourceStyle` so this pass stays
 * auditable and the upstream variant name is never lost.
 *
 * Usage: node scripts/reclassify-icon-styles.js [--dry-run] [--only=id,id]
 */

const fs = require("fs");
const path = require("path");

const dataRoot = path.join(__dirname, "../data/icons");
const DRY_RUN = process.argv.includes("--dry-run");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.split("=")[1].split(",")) : null;

// The style chips the UI ships, in display order. No "rounded" and no "bold":
// both were fill artwork, which all belongs in Solid.
const STYLES = ["outline", "solid", "duotone", "thin", "3d"];

// Upstream variant names we trust over the artwork analysis, because they name a
// treatment the artwork cannot reveal: a "thin" Phosphor icon is fill-only, but
// it is genuinely thin, not solid.
//
// "bold" is deliberately NOT here - there is no Bold style. Upstream
// bold-weight icons are sorted by what they are: stroked ones become Outline,
// filled ones Solid.
const VARIANT_STYLES = new Set(["duotone", "thin"]);

// Name/style tokens -> style. `null` means "this token tells us nothing the
// artwork analysis cannot decide better": whether an icon is Outline or Solid
// depends on if the artwork is actually stroked, not on what it is called.
const TOKEN_STYLE = {
  baseline: "solid",
  sharp: "solid",
  filled: "solid",
  fill: "solid",
  solid: "solid",
  twotone: "duotone",
  "two-tone": "duotone",
  duotone: "duotone",
  duo: "duotone",
  thin: "thin",
  light: "thin",
  // Sorted by artwork, not by name: "rounded" is a shape and "bold" is a weight,
  // and neither tells us whether the path is a fill or an editable stroke.
  round: null,
  rounded: null,
  bold: null,
  heavy: null,
  outline: null,
  outlined: null,
  line: null,
  linear: null,
  regular: null,
  stroke: null,
};

// Tokens safe to read off the end of any icon name. `round`, `two`, `sharp` and
// friends are excluded: "arrow-round" and "two-hearts" are subjects, not
// variants. Those only count via the prefix-partition path below.
const SAFE_SUFFIX_TOKENS = new Set([
  "duotone",
  "twotone",
  "two-tone",
  "duo",
  "thin",
  "light",
  "bold",
  "heavy",
  "rounded",
  "filled",
  "fill",
  "solid",
]);

// Colors that carry no hue: artwork using only these is monochrome and
// recolorable, not colored artwork.
const MONOCHROME = new Set([
  "none",
  "currentcolor",
  "inherit",
  "transparent",
  "#000",
  "#000000",
  "#000f",
  "#000000ff",
  "black",
  "#fff",
  "#ffffff",
  "#ffff",
  "#ffffffff",
  "white",
]);

const COLOR_ATTR_RE =
  /(?:fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*"([^"]*)"/gi;
const STROKE_ATTR_RE = /stroke\s*=\s*"([^"]*)"/gi;
const STOP_COLOR_RE = /stop-color\s*=\s*"([^"]*)"/gi;
const GRADIENT_RE = /<(?:linearGradient|radialGradient|pattern|image)\b/i;

const splitTokens = (value) =>
  String(value || "")
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter(Boolean);

/**
 * Inspect the raw SVG body and report what the artwork actually is.
 */
function analyzeSvg(svg) {
  let match;

  const hues = new Set();
  COLOR_ATTR_RE.lastIndex = 0;
  while ((match = COLOR_ATTR_RE.exec(svg)) !== null) {
    const value = match[1].trim().toLowerCase();
    if (!value || MONOCHROME.has(value)) continue;
    if (value.startsWith("url(")) continue; // gradient reference, handled below
    hues.add(value);
  }

  let colored = hues.size > 0;
  if (!colored && GRADIENT_RE.test(svg)) {
    // A gradient/pattern/raster is colored unless every stop we can read is
    // monochrome. No readable stops means we cannot prove it is mono.
    const stops = [];
    STOP_COLOR_RE.lastIndex = 0;
    while ((match = STOP_COLOR_RE.exec(svg)) !== null) {
      stops.push(match[1].trim().toLowerCase());
    }
    colored = stops.length === 0 || stops.some((s) => !MONOCHROME.has(s));
  }

  // Is any geometry drawn with a stroke at all?
  let stroked = false;
  STROKE_ATTR_RE.lastIndex = 0;
  while ((match = STROKE_ATTR_RE.exec(svg)) !== null) {
    if (match[1].trim().toLowerCase() !== "none") {
      stroked = true;
      break;
    }
  }

  // Any stroked path is width-adjustable. renderSvg strips whatever
  // stroke-width the artwork declared and applies its own to every path with a
  // non-none stroke, so declaring one up front makes no difference.
  const adjustableStroke = stroked;

  return { colored, stroked, adjustableStroke };
}

/**
 * Some collections pack every upstream variant into one file and encode the
 * variant as the first name token (Google Material Icons: baseline-home,
 * outline-home, round-home, sharp-home, twotone-home). Detect that only when
 * the prefixes partition the whole collection, so an icon that merely starts
 * with "round" in an unrelated collection is never mistaken for a variant.
 */
function detectPrefixPartition(icons) {
  let known = 0;
  const prefixes = new Set();

  for (const icon of icons) {
    const first = splitTokens(icon.name || icon.id)[0];
    if (first !== undefined && first in TOKEN_STYLE) {
      known++;
      prefixes.add(first);
    }
  }

  const covers = icons.length > 0 && known / icons.length >= 0.95;
  return covers && prefixes.size >= 2;
}

/**
 * "light" is a weight in Stash/Iconamoon/Fluent, but a theme in Selfhst and
 * Skillicons, which ship `foo-light` next to `foo-dark`. Genuine theme sets pair
 * up almost one-to-one (Selfhst 2353 light / 2312 dark, Skillicons 162 / 162),
 * so compare the counts rather than merely spotting a dark icon - Iconamoon has
 * a single stray `-dark`, and treating that as a theme hid all 304 of its real
 * `-light` weight variants.
 */
function detectThemeVariants(icons) {
  let light = 0;
  let dark = 0;
  for (const icon of icons) {
    const last = splitTokens(icon.name || icon.id).pop();
    if (last === "light") light++;
    else if (last === "dark") dark++;
  }
  return dark > 0 && dark >= light * 0.5;
}

/**
 * A trailing "rounded"/"bold"/"light" only names a variant when the collection
 * actually ships that variant as a set. Solar has 1356 `*-line-duotone` icons —
 * a real variant. Tabler has 12 `*-rounded` icons, and they are square-rounded
 * shapes, not a weight; Hugeicons has exactly one `text-bold`. Requiring the
 * token to cover a set rather than a stray icon separates the two.
 */
function detectSuffixVariants(icons) {
  const terminal = new Map();
  const midName = new Map();

  for (const icon of icons) {
    const tokens = splitTokens(icon.name || icon.id);
    if (tokens.length < 2) continue;
    const last = tokens[tokens.length - 1];
    if (SAFE_SUFFIX_TOKENS.has(last)) {
      terminal.set(last, (terminal.get(last) || 0) + 1);
    }
    for (const token of tokens.slice(0, -1)) {
      if (SAFE_SUFFIX_TOKENS.has(token)) {
        midName.set(token, (midName.get(token) || 0) + 1);
      }
    }
  }

  const trusted = new Set();
  for (const [token, count] of terminal) {
    // Covers a set, not a stray icon.
    if (count < 25 && count / icons.length < 0.1) continue;
    // A token that also shows up mid-name at a comparable rate belongs to the
    // icon names themselves. Solar has 84 `*-rounded` icons and 72 more with
    // "rounded" mid-name (`call-cancel-rounded-broken`) — it names a shape.
    // Real markers are decisive: Solar's own `duotone` never appears mid-name.
    if ((midName.get(token) || 0) >= count * 0.25) continue;
    trusted.add(token);
  }
  return trusted;
}

/**
 * Sort by what the artwork is:
 *   any stroke -> outline  (the width is adjustable, so it belongs there)
 *   otherwise  -> solid    (fill artwork, solid or hollow alike)
 * Artwork with neither attribute inherits a fill when rendered, so it is solid.
 */
function byArtwork(info) {
  return info.stroked ? "outline" : "solid";
}

/**
 * Pick the style an icon belongs in. Colored artwork wins outright, then the
 * two upstream variants we still honour by name (duotone, thin), then the
 * artwork itself decides between outline and solid.
 */
function classify(icon, info, ctx) {
  if (info.colored) return "3d";

  // Stroked artwork is Outline, full stop - it outranks the upstream variant
  // names. Only Outline exposes the Stroke Width control, so a stroked icon
  // filed under Thin or Duotone would be adjustable artwork the user cannot
  // adjust. (Solar, Glyphs and Keyline ship stroked duotone/thin sets.)
  if (info.stroked) return "outline";

  const declared = String(icon.sourceStyle || "").toLowerCase().trim();
  if (VARIANT_STYLES.has(declared)) return declared;
  if (declared in TOKEN_STYLE) {
    const mapped = TOKEN_STYLE[declared];
    if (mapped && VARIANT_STYLES.has(mapped)) return mapped;
  }

  const tokens = splitTokens(icon.name || icon.id);
  const first = tokens[0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : undefined;

  if (ctx.prefixPartition && first !== undefined && first in TOKEN_STYLE) {
    const mapped = TOKEN_STYLE[first];
    if (mapped && VARIANT_STYLES.has(mapped)) return mapped;
    return byArtwork(info);
  }

  if (last && ctx.suffixVariants.has(last)) {
    if (!(last === "light" && ctx.themeVariants)) {
      const mapped = TOKEN_STYLE[last];
      if (mapped && VARIANT_STYLES.has(mapped)) return mapped;
    }
  }

  return byArtwork(info);
}

/**
 * Iconify-shaped entries (`body` + `width`/`height`, no style/tags/viewBox)
 * reach the UI with an undefined style and a wrong 24x24 viewBox. Normalize them
 * to the shape every other collection already uses.
 */
function normalize(icon, collectionId) {
  if (!icon.svg && icon.body) {
    icon.svg = icon.body;
    delete icon.body;
  }

  if (!icon.viewBox) {
    const w = icon.width ?? 24;
    const h = icon.height ?? w;
    icon.viewBox = `0 0 ${w} ${h}`;
  }
  delete icon.width;
  delete icon.height;

  if (!icon.name) icon.name = String(icon.id || "").replace(/[_-]+/g, " ");
  if (!Array.isArray(icon.tags) || icon.tags.length === 0) {
    icon.tags = [String(icon.name).replace(/\s+/g, "-"), collectionId];
  }
  if (!icon.category) icon.category = "UI";

  return icon.svg || "";
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const writeJson = (file, value) => {
  if (!DRY_RUN) fs.writeFileSync(file, JSON.stringify(value));
};

function main() {
  const collectionsFile = path.join(dataRoot, "collections.json");
  const collectionsData = readJson(collectionsFile);
  const byId = new Map(collectionsData.collections.map((c) => [c.id, c]));

  const dirs = fs
    .readdirSync(dataRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!ONLY || ONLY.has(d.name)))
    .map((d) => d.name)
    .sort();

  const globalCounts = {};
  const moves = {};
  let totalIcons = 0;
  let totalMoved = 0;

  for (const collectionId of dirs) {
    const iconsFile = path.join(dataRoot, collectionId, "icons.json");
    if (!fs.existsSync(iconsFile)) continue;

    const icons = readJson(iconsFile);
    for (const icon of icons) normalize(icon, collectionId);

    const ctx = {
      prefixPartition: detectPrefixPartition(icons),
      themeVariants: detectThemeVariants(icons),
      suffixVariants: detectSuffixVariants(icons),
    };

    const counts = {};
    let moved = 0;

    for (const icon of icons) {
      // Keep the first run's value: re-running must not read back its own output.
      if (!("sourceStyle" in icon)) icon.sourceStyle = icon.style ?? null;

      const info = analyzeSvg(icon.svg || "");
      const style = classify(icon, info, ctx);

      if (String(icon.style) !== style) {
        moved++;
        const key = `${icon.sourceStyle ?? "(none)"} -> ${style}`;
        moves[key] = (moves[key] || 0) + 1;
      }

      icon.style = style;
      // Persisted so the API does not re-derive it per request, and so the
      // Outline filter can reject fill-only artwork.
      icon.isEditableStroke = info.adjustableStroke;

      // Tags feed the search index; keep the style searchable and drop the stale
      // one. Only style names are stripped — "light" and "fill" stay, because a
      // lightbulb icon legitimately carries them as subject tags.
      const stale = new Set([
        ...STYLES,
        String(icon.sourceStyle || "").toLowerCase(),
        "color",
        "multi-color",
      ]);
      icon.tags = icon.tags.filter((t) => !stale.has(String(t).toLowerCase()));
      icon.tags.push(style);

      counts[style] = (counts[style] || 0) + 1;
      globalCounts[style] = (globalCounts[style] || 0) + 1;
    }

    totalIcons += icons.length;
    totalMoved += moved;
    writeJson(iconsFile, icons);

    // metadata.json and the collections.json entry both feed the style chips.
    // Every other field they carry stays untouched.
    const styles = STYLES.filter((s) => counts[s]);
    const metaFile = path.join(dataRoot, collectionId, "metadata.json");
    if (fs.existsSync(metaFile)) {
      const meta = readJson(metaFile);
      meta.total = icons.length;
      meta.styles = styles;
      meta.styleCounts = counts;
      writeJson(metaFile, meta);
    }

    const entry = byId.get(collectionId);
    if (entry) {
      entry.total = icons.length;
      entry.styles = styles;
      entry.styleCounts = counts;
    }

    process.stdout.write(
      `${collectionId.padEnd(28)} ${String(icons.length).padStart(6)} icons  ` +
        `${String(moved).padStart(6)} moved  ${styles.join(",")}\n`,
    );
  }

  if (!ONLY) {
    collectionsData.totalIcons = totalIcons;
    collectionsData.totalCollections = collectionsData.collections.length;
  }
  writeJson(collectionsFile, collectionsData);

  console.log("\n--- style totals ---");
  for (const style of STYLES) {
    console.log(
      `${style.padEnd(10)} ${(globalCounts[style] || 0).toLocaleString()}`,
    );
  }
  console.log("\n--- moves ---");
  Object.entries(moves)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`${String(v).padStart(7)}  ${k}`));
  console.log(
    `\n${totalMoved.toLocaleString()} of ${totalIcons.toLocaleString()} icons moved` +
      `${DRY_RUN ? " (dry run, nothing written)" : ""}`,
  );
}

main();
