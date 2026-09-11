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

const STROKE_ATTR_RE = /stroke\s*=\s*"([^"]*)"/gi;

// --------------------------------------------------------------------
// Colour analysis
//
// "Does this artwork carry a hue, or is it a monochrome mark?" Answering it by
// matching literal strings against a list of #000/#fff/black/white was wrong:
// it called #212121, #333, #999 and gray "colour". Parse the value and compare
// channels instead.
// --------------------------------------------------------------------

// Channel spread below this reads as grey/black to the eye, not as colour.
const ACHROMATIC_TOLERANCE = 8;

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
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const bl = parseInt(h.slice(4, 6), 16);
    // Exact equality is too strict: #070400 is r7 g4 b0, a 7/255 spread nobody
    // can see, yet it pushed a black logo into 3D Icons. Allow a small delta.
    return Math.max(r, g, bl) - Math.min(r, g, bl) > ACHROMATIC_TOLERANCE;
  }

  const rgb = /^rgba?\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)/.exec(v);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map((n) => parseFloat(n));
    return Math.max(r, g, b) - Math.min(r, g, b) > ACHROMATIC_TOLERANCE;
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

  // Shared with the logo and illustration passes so all three agree on what
  // "carries a hue" means. Matching literal #000/#fff strings used to call
  // greys like #555 and #212121 colour, which pushed 4,856 greyscale icons
  // (IconPark and IPTwotone duotone sets) into 3D Icons.
  const colored = isColoredArtwork(svg);

  // Is any geometry drawn with a stroke at all?
  let stroked = false;
  STROKE_ATTR_RE.lastIndex = 0;
  while ((match = STROKE_ATTR_RE.exec(svg)) !== null) {
    if (match[1].trim().toLowerCase() !== "none") {
      stroked = true;
      break;
    }
  }

  // renderSvg bails out entirely on <mask>/<defs> - naive regex rewriting would
  // destroy those shapes - so the stroke it would otherwise inject never lands.
  // Such artwork is not width-adjustable and does not belong in Outline.
  const rendererCanRestyle = !/<mask|<defs/i.test(svg);

  // A white-only stroke on artwork with nothing hollow is a hairline separator,
  // not the icon's linework (Windows Metro draws filled glyphs this way).
  const strokesOutsideDefs = [];
  let sm;
  const outside = svg.replace(/<(defs|mask)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const re2 = /stroke\s*=\s*"([^"]*)"/gi;
  while ((sm = re2.exec(outside)) !== null) {
    const v = sm[1].trim().toLowerCase();
    if (v !== "none") strokesOutsideDefs.push(v);
  }
  const WHITES = new Set(["#fff", "#ffffff", "#ffff", "#ffffffff", "white"]);
  const hairlineOnly =
    strokesOutsideDefs.length > 0 &&
    strokesOutsideDefs.every((v) => WHITES.has(v)) &&
    !/fill\s*=\s*"none"/i.test(svg);

  const adjustableStroke = stroked && rendererCanRestyle && !hairlineOnly;

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
const DUOTONE_TOKENS = new Set(["duotone", "twotone", "two-tone", "duo"]);

/**
 * Some sets name the duotone variant in the middle of a compound suffix rather
 * than at the end - IconMind ships `a-record-duotone-bold`, so the last token
 * is the weight and "duotone" sits before it. Trust a mid-name duotone only
 * where it covers a real share of the collection: it is half of IconMind and
 * 12% of Letsicons, but a stray 0.1% in Glyphs is a subject word.
 */
function detectDuotoneAnywhere(icons) {
  let hits = 0;
  for (const icon of icons) {
    const tokens = splitTokens(icon.name || icon.id);
    if (tokens.some((t) => DUOTONE_TOKENS.has(t))) hits++;
  }
  return icons.length > 0 && hits / icons.length >= 0.05;
}

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
  return info.adjustableStroke ? "outline" : "solid";
}

/**
 * Pick the style an icon belongs in. Colored artwork wins outright, then the
 * two upstream variants we still honour by name (duotone, thin), then the
 * artwork itself decides between outline and solid.
 */
/**
 * Which upstream variant does this icon's name or declared style claim?
 * Returns "duotone", "thin", or null. The name is only trusted through the same
 * gates the rest of the pass uses, so a subject word never counts as a variant.
 */
function declaredVariant(icon, ctx) {
  const declared = String(icon.sourceStyle || "").toLowerCase().trim();
  if (VARIANT_STYLES.has(declared)) return declared;
  if (declared in TOKEN_STYLE) {
    const mapped = TOKEN_STYLE[declared];
    if (mapped && VARIANT_STYLES.has(mapped)) return mapped;
  }

  const tokens = splitTokens(icon.name || icon.id);
  const first = tokens[0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : undefined;

  // Checked before the prefix/suffix rules because a compound suffix ends in
  // the weight, not the variant: IconMind's `-duotone-thin` would otherwise
  // read as Thin and lose the duotone it plainly declares.
  if (ctx.duotoneAnywhere && tokens.some((t) => DUOTONE_TOKENS.has(t))) {
    return "duotone";
  }

  if (ctx.prefixPartition && first !== undefined && first in TOKEN_STYLE) {
    const mapped = TOKEN_STYLE[first];
    return mapped && VARIANT_STYLES.has(mapped) ? mapped : null;
  }

  if (last && ctx.suffixVariants.has(last)) {
    if (!(last === "light" && ctx.themeVariants)) {
      const mapped = TOKEN_STYLE[last];
      if (mapped && VARIANT_STYLES.has(mapped)) return mapped;
    }
  }

  return null;
}

function classify(icon, info, ctx) {
  if (info.colored) return "3d";

  const variant = declaredVariant(icon, ctx);

  // Duotone outranks the artwork: a two-tone icon is duotone whether it is
  // drawn with strokes or fills, so IconPark, Solar and IconMind's duotone sets
  // stay together instead of scattering into Outline.
  if (variant === "duotone") return "duotone";

  // Everything else stroked is Outline - only Outline exposes Stroke Width, so
  // a stroked icon filed elsewhere would be adjustable artwork nobody can
  // adjust. That is why Thin does not get the same override as Duotone.
  if (info.adjustableStroke) return "outline";

  if (variant) return variant;

  if (ctx.prefixPartition) return byArtwork(info);
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
      duotoneAnywhere: detectDuotoneAnywhere(icons),
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
