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
const sharp = require("sharp");

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
  if (dark > 0 && dark >= light * 0.5) return true;
  // A colored set has no weights to speak of, so its `-light` is a theme even
  // without the matching darks: Material Theme ships 49 grey `cursor-light`
  // style logos beside the coloured originals, and they were landing in Thin.
  // Every genuine weight set (Fluent, Stash, Letsicons, Iconamoon) is 0% colour.
  const colored = icons.filter((icon) => isColoredArtwork(icon.svg || "")).length;
  return light > 0 && colored / icons.length >= 0.5;
}

/**
 * Material Symbols ships each icon twice per weight: `10k` (filled) beside
 * `10k-outline`, and likewise `10k-rounded` / `10k-outline-rounded`. Its thin
 * weight is declared "thin" as a whole, so without this the filled half - 6,397
 * solid shapes - filled the Thin chip next to the hairline icons. A bare name
 * counts as the filled twin only where its outline sibling exists; icons with
 * no fill variant (`123`, arrows) ship once and stay where they are.
 */
const TWIN_SHAPES = ["-rounded", "-sharp"];

function outlineTwinName(name) {
  const shape = TWIN_SHAPES.find((s) => name.endsWith(s)) || "";
  return `${name.slice(0, name.length - shape.length)}-outline${shape}`;
}

function detectFilledTwins(icons) {
  const names = new Set(icons.map((icon) => icon.name || icon.id));
  const filled = new Set();
  for (const name of names) {
    if (splitTokens(name).includes("outline")) continue;
    if (names.has(outlineTwinName(name))) filled.add(name);
  }
  // Covers a set, not a stray pair.
  return filled.size >= 25 && filled.size / names.size >= 0.1 ? filled : new Set();
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

  // A thin-weight icon drawn as a filled shape does not read as thin; the
  // artwork decides, as for every other fill.
  if (
    variant === "thin" &&
    (ctx.filledTwins.has(icon.name || icon.id) || ctx.filledThin.has(icon.id))
  ) {
    return byArtwork(info);
  }

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
  if (DRY_RUN) return;
  // Rewriting ~250 multi-megabyte files back to back, Windows intermittently
  // fails the open with EBUSY/EPERM/UNKNOWN because a virus scanner or the
  // search indexer still holds the handle. It surfaced twice here, on a
  // different collection each time, and took the whole pass down *before*
  // collections.json was written - so the icons were reclassified but the style
  // chips still showed the pre-pass values. Retry rather than lose the run.
  const payload = JSON.stringify(value);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, payload);
      return;
    } catch (err) {
      const transient = ["EBUSY", "EPERM", "UNKNOWN", "EMFILE", "ENFILE"].includes(err.code);
      if (!transient || attempt >= 6) throw err;
      // Synchronous backoff: this script is single-threaded top to bottom.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (attempt + 1));
    }
  }
};

// --------------------------------------------------------------------
// Filled area
//
// A thin weight is a promise about lines, but Material Symbols, Fluent and
// Atlas also draw filled badges, dots, hearts and half-filled shapes inside
// their thin and light weights (`business-chip-outline`, `star-rate-half`,
// `signal-cellular-4-bar`). The name cannot reveal them and the paths are all
// fills, so look at the picture: render it, erode away anything line-thick,
// and measure the solid area that survives.
// --------------------------------------------------------------------

const FILL_RENDER_SIZE = 128;
// An 11px window clears every thin/light line (Phosphor light is 6px at this
// size, Iconamoon light ~8px) while a notification dot or badge (15px+) stays.
const FILL_ERODE_RADIUS = 5;
// Checked by eye against every band: above 0.4% the filled part is plainly
// visible (badges, filled hearts, half stars); below it, at most a tiny dot
// such as the eyes of a face.
const FILLED_AREA_LIMIT = 0.004;

/** Share of the canvas that stays inked after eroding by FILL_ERODE_RADIUS. */
/** The icon's coverage mask (alpha channel) rendered at S x S, or null. */
async function renderAlpha(icon, S) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${icon.viewBox || "0 0 24 24"}" ` +
    `width="${S}" height="${S}" color="#000" fill="currentColor">${icon.svg || ""}</svg>`;
  try {
    return await sharp(Buffer.from(svg))
      .resize(S, S)
      .ensureAlpha()
      .extractChannel(3)
      .raw()
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Inked pixels that survive an erosion of radius R. Separable: a pixel
 * survives when its whole row window is inked (pass 1) and every row in its
 * column window survived (pass 2).
 */
function erodedCount(alpha, S, R) {
  const rows = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    let run = 0;
    for (let x = 0; x < S; x++) {
      run = alpha[y * S + x] > 128 ? run + 1 : 0;
      if (run >= 2 * R + 1) rows[y * S + x - R] = 1;
    }
  }
  let count = 0;
  for (let x = 0; x < S; x++) {
    let run = 0;
    for (let y = 0; y < S; y++) {
      run = rows[y * S + x] ? run + 1 : 0;
      if (run >= 2 * R + 1) count++;
    }
  }
  return count;
}

/** Share of the canvas that stays inked after eroding by FILL_ERODE_RADIUS. */
async function solidAreaShare(icon) {
  const S = FILL_RENDER_SIZE;
  const alpha = await renderAlpha(icon, S);
  if (!alpha) return 0; // unrenderable artwork is left to the other rules
  return erodedCount(alpha, S, FILL_ERODE_RADIUS) / (S * S);
}

// --------------------------------------------------------------------
// Line weight
//
// Thin mixes true hairlines (Carbon Pictograms, Phosphor thin, Linea) with
// sets whose "thin" is really a light weight (Material Symbols, Atlas,
// Phosphor light), and Phosphor ships both under the same names. The API
// lists hairlines first, so it needs a weight per icon: render at 96px and
// take the share of ink that survives a 3x3 erosion. A ~1px line leaves
// nothing behind; heavier lines keep their core. Typical values: hairline
// sets 0.01-0.24, light weights 0.45+.
// --------------------------------------------------------------------

const WEIGHT_RENDER_SIZE = 96;

async function lineWeight(icon) {
  const S = WEIGHT_RENDER_SIZE;
  const alpha = await renderAlpha(icon, S);
  if (!alpha) return null;
  let ink = 0;
  for (let p = 0; p < S * S; p++) if (alpha[p] > 128) ink++;
  if (!ink) return null;
  return Math.round((erodedCount(alpha, S, 1) / ink) * 1000) / 1000;
}

/** Thin-weight icons whose artwork carries a visible filled area. */
async function detectFilledThin(icons, ctx) {
  const filled = new Set();
  for (const icon of icons) {
    if (declaredVariant(icon, ctx) !== "thin") continue;
    if ((await solidAreaShare(icon)) > FILLED_AREA_LIMIT) filled.add(icon.id);
  }
  return filled;
}

async function main() {
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
    for (const icon of icons) {
      normalize(icon, collectionId);
      // Keep the first run's value: re-running must not read back its own output.
      if (!("sourceStyle" in icon)) icon.sourceStyle = icon.style ?? null;
    }

    const ctx = {
      prefixPartition: detectPrefixPartition(icons),
      themeVariants: detectThemeVariants(icons),
      suffixVariants: detectSuffixVariants(icons),
      duotoneAnywhere: detectDuotoneAnywhere(icons),
      filledTwins: detectFilledTwins(icons),
    };
    // Needs the rest of ctx: only icons that declare the thin variant are drawn.
    ctx.filledThin = await detectFilledThin(icons, ctx);

    const counts = {};
    let moved = 0;

    for (const icon of icons) {
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
    // Only Thin is ordered by weight; anything that left Thin drops a stale one.
    for (const icon of icons) {
      if (icon.style === "thin") icon.lineWeight = await lineWeight(icon);
      else delete icon.lineWeight;
    }

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
