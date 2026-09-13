# Adding New Icon Sources

How to add an open-source icon set to the Icons page, using the scripts already
in `scripts/`. Written from the sources added in practice — every warning below
is something that actually went wrong, not a hypothetical.

Current catalogue: **243 collections, 390,508 icons**.

---

## Table of Contents

- [The Pipeline](#the-pipeline)
- [Before You Start: Research](#before-you-start-research)
- [Step 1: Declare the Source](#step-1-declare-the-source)
- [Step 2: Import It](#step-2-import-it)
- [Step 3: Assign Styles](#step-3-assign-styles)
- [Step 4: Rebuild and Restart](#step-4-rebuild-and-restart)
- [Step 5: Verify](#step-5-verify)
- [Traps](#traps)
- [Checklist](#checklist)

---

## The Pipeline

Two scripts, run in this order. **Never skip the second.**

```
scripts/build-icons-data-full.js     fetch + write raw icons
        ↓
scripts/reclassify-icon-styles.js    assign the real style to every icon
        ↓
npm run build && restart             backend loads data at startup
```

What gets written per source:

```
data/icons/<sourceId>/icons.json      the icon records
data/icons/<sourceId>/metadata.json   name, total, styles, styleCounts
data/icons/collections.json           one entry per collection  (merged)
data/icons/sources.json               licence + licenceUrl        (manual)
```

An icon record looks like this. Match it exactly:

```json
{
  "id": "ikonate_outline_alarm",
  "name": "alarm",
  "category": "UI",
  "tags": ["alarm", "ikonate", "outline"],
  "style": "outline",
  "viewBox": "0 0 24 24",
  "svg": "<g fill=\"none\" stroke=\"currentColor\">…</g>"
}
```

`svg` holds the **inner markup only** — no wrapping `<svg>` element. `id` is
`sourceId_style_name` and only needs to be unique inside its own collection.

---

## Before You Start: Research

**Iconify is the aggregator.** It carries essentially every permissively
licensed set on GitHub, and this project already imports every one of its
collections. So "search GitHub for icon sets" and "don't duplicate what we
have" collapse into almost the same constraint.

Check Iconify first:

```bash
curl -s https://raw.githubusercontent.com/iconify/icon-sets/master/collections.json -o /tmp/iconify.json
```

Then diff against what the build script already imports:

```bash
node -e '
const src = require("fs").readFileSync("scripts/build-icons-data-full.js","utf8");
const have = new Set([...src.matchAll(/file: *.([^\x27"]+)/g)].map(m=>m[1]));
const all = require("/tmp/iconify.json");
Object.entries(all)
  .filter(([k]) => !have.has(k))
  .sort((a,b) => b[1].total - a[1].total)
  .forEach(([k,v]) => console.log(k.padEnd(20), String(v.total).padStart(7), (v.license||{}).title));
'
```

**This diff over-reports.** A prefix it lists is not necessarily missing — many
collections are assembled from prefixes that differ from their `sourceId`
(Boxicons from `bx`/`bxs`/`bxl`, Heroicons from `heroicons-outline` and
`heroicons-solid`). The run above named seven "missing" sets that were all
already imported. Confirm against the data directory before believing it:

```bash
for d in boxicons heroicons token meteocons; do
  [ -d "data/icons/$d" ] && echo "PRESENT $d" || echo "ABSENT  $d"
done
```

As of this writing **every Iconify collection is imported**, so a genuinely new
set has to come from a GitHub repo that Iconify does not carry.

### Count *new* icons, not raw icons

A set's headline count is not what you gain. Compare names against the whole
catalogue before promising a number:

```bash
node -e '
const fs=require("fs"), root="data/icons";
const mine=new Set();
for (const d of fs.readdirSync(root)) {
  const f = `${root}/${d}/icons.json`;
  if (!fs.existsSync(f)) continue;               // skips .DS_Store and loose .json
  for (const i of JSON.parse(fs.readFileSync(f))) mine.add(String(i.name).toLowerCase());
}
console.log("distinct names already held:", mine.size);
'
```

Measured examples: Evil Icons was **0 new of 70**. Metro was **68 new of 512**.
Zocial **15 of 104**. The importer keeps duplicates (ids are namespaced per
collection, so nothing collides), but they inflate search results — decide
deliberately whether you want them.

### Licence

Only add `MIT`, `Apache-2.0`, `CC0-1.0`, `ISC`, `BSD-*`, `CC-BY-4.0`, `OFL-1.1`.
Reject `NOASSERTION` and repos with no LICENSE file.

---

## Step 1: Declare the Source

Add an entry to the `sources` array in `scripts/build-icons-data-full.js`.
**Do not create a new script** — everything belongs in this one file.

### Iconify source (preferred)

One line. `file` is the Iconify prefix.

```js
{ file: 'iconmind', sourceId: 'iconmind', sourceName: 'IconMind', style: 'outline' },
```

### GitHub source (for sets not on Iconify)

```js
{
  kind: 'github',
  repo: 'mikolajdobrucki/ikonate',
  branch: 'master',
  dir: 'icons',              // only .svg under this path
  sourceId: 'ikonate',
  sourceName: 'Ikonate',
  style: 'outline',          // provisional; reclassify decides the real one
  wrap: 'fill="none" stroke="currentColor" stroke-width="2"',  // see below
},
```

### Does it need `wrap`?

Look at one raw file first:

```bash
curl -s https://raw.githubusercontent.com/<repo>/<branch>/<dir>/<some>.svg
```

If the geometry carries **no `fill` or `stroke` at all**, the set expects CSS to
paint it. Imported as-is, SVG defaults apply — `fill:black, stroke:none` — so
every icon renders as a solid blob and lands in Solid. Ikonate is exactly this.
`wrap` puts the paint the artwork expects around the body.

`style` here is usually only a placeholder — Step 3 overwrites it from the
artwork. The exception is `duotone` and `thin`, the two variants reclassify
trusts by name over the artwork (`VARIANT_STYLES`). Declaring either is how you
route a set the artwork alone cannot classify.

### Declaring `thin` for fill-based line art

Fine line art is often drawn as filled paths that *trace* a line rather than
filling a silhouette. Nothing in the markup distinguishes that from a solid
glyph, so reclassify sends it to Solid, where it looks out of place next to
actual filled icons. Carbon Pictograms and Linea are both this, and both declare
`style: 'thin'` to land in Thin instead.

This only works on artwork with no adjustable stroke. Outline outranks a
declared `thin` — a stroked icon filed under Thin would lose Stroke Width, the
one control it should have — so declaring `thin` on stroked artwork is silently
ignored.

**`sourceStyle` is sticky.** Reclassify records the declared style once
(`if (!("sourceStyle" in icon))`) and never rewrites it, so editing `style` in
the build script does nothing to icons already on disk. Re-import the source to
change it:

```bash
node scripts/build-icons-data-full.js --only=carbon-pictograms,linea
npm run reclassify:icon-styles
```

### SVG-font source (`kind: 'svgfont'`)

Some sets only ship as an icon font — one `.svg` per pack, every icon a
`<glyph>` inside it, and no per-icon file anywhere. Atlas Icons is 41 such packs
and is not on Iconify.

```js
{ kind: 'svgfont', repo: 'Vectopus/Atlas-icons-font', branch: 'main',
  pathMatch: /^packs\/[^/]+\/fonts\/[^/]+\.svg$/,
  sourceId: 'atlas-icons', sourceName: 'Atlas Icons', style: 'solid' },
```

Three things make font glyphs different from ordinary SVG:

- **The y-axis is upside down.** Glyph outlines run *up* from the baseline, so a
  path dropped straight into a viewBox renders inverted and off-canvas. The
  importer wraps each one in `translate(0, ascent) scale(1, -1)`, read from the
  font's own `<font-face>`, and sizes the viewBox
  `0 0 <glyph horiz-adv-x> <units-per-em>`. Check a directional icon after
  importing — `arrow-down` pointing up means the flip is wrong.
- **The weight is in the name.** Atlas ships `crown-winner`, `crown-winner-thin`
  and `crown-winner-bold`. The importer splits that suffix off the display name
  and uses it to pick the style (`thin`/`light` → Thin), because font outlines
  are always fills and the artwork could never reveal the weight. The id keeps
  the raw glyph name, or two of every three icons would collide.

- **They need `fill-rule="nonzero"`, explicitly.** Fonts are authored for the
  nonzero winding rule: overlapping contours union, and counters are cut by
  reversing direction. `renderSvg` stamps `fill-rule="evenodd"` on the wrapper
  of *every* icon (`motvin-icons.js`, the `innerSvg` line), and under evenodd
  those overlaps punch holes instead — bottom bars, podium bases and banner
  edges vanish, so the linework looks unclosed. **87% of Atlas glyphs rendered
  wrong** before the importer set nonzero on the transform group, which
  overrides the inherited value.

  Ordinary SVG icon sets are unaffected — a 12-collection sample showed 0 of 15
  icons each differing between the two rules — so this is a font-glyph problem,
  not a reason to change the renderer.

Glyphs with no `glyph-name` or an empty `d` (`.notdef`, the space) are skipped:
41 of Atlas's 8,021 `<glyph>` elements, leaving 7,980.

Verify by rasterising the app's own output against ground-truth nonzero rather
than eyeballing the grid — the damage is subtle at 24px and obvious at 72px:

```js
// differs > ~20 px out of 96x96 means the fill rule is wrong
renderSvg(body, { iconStyle, sourceId, viewBox, size: 96 })   // vs
`<svg viewBox="${viewBox}" fill-rule="nonzero">${body}</svg>`
```

### Files named by codepoint (`nameMap`)

OpenMoji names every file after its Unicode codepoint — `1F600.svg` — which is
unsearchable. `nameMap` points at a JSON in the same repo that carries the human
name, and its synonyms become tags:

```js
{ kind: 'github', repo: 'hfg-gmuend/openmoji', branch: 'master', dir: 'black/svg',
  nameMap: { file: 'data/openmoji.json', key: 'hexcode', label: 'annotation', tags: 'tags' },
  sourceId: 'openmoji-black', sourceName: 'OpenMoji Black', style: 'outline' },
```

`1F600.svg` becomes `grinning-face`, tagged `cheerful, cheery, grin, happy, …`.
The id still keeps the raw file name, so a codepoint the map misses (2 of 4,565
here) degrades to its old name rather than colliding or vanishing. Check after
importing:

```bash
node -e 'const a=require("./data/icons/<sourceId>/icons.json");
console.log(a.filter(i=>/^[0-9a-f-]+$/i.test(i.name)).length, "of", a.length, "still codepoint-named")'
```

### Scattered trees and prefixed file names

`dir` is a single path prefix, which only works when a repo keeps its icons in
one folder and nothing else. Two optional fields cover the rest:

```js
{
  kind: 'github',
  repo: 'linea-io/Linea-Iconset',
  branch: 'master',
  pathMatch: /\/_SVG expanded\//,    // filter the whole path, not a prefix
  stripName: /^(basic_elaboration|arrows|basic|ecommerce|music|software|weather)_/,
  sourceId: 'linea',
  sourceName: 'Linea',
  style: 'outline',
},
```

- **`pathMatch`** tests the full path. Linea spreads its artwork across seven
  category folders as `<category>/_SVG expanded/…` *and* keeps 722 iconfont
  `.svg` files in the same tree. No `dir` prefix can express that; a bare import
  would pull in the font artefacts.
- **`stripName`** drops a category prefix baked into the file name. Linea ships
  `basic_alarm.svg`, so without it users have to search for `basic_alarm` rather
  than `alarm`. Order the alternation longest-first — `basic_elaboration` must
  match before `basic`.

`stripName` changes the **name only**. The id keeps the raw file name, because
nine Linea icons collide once stripped (`basic_alarm` and `software_alarm` are
different artwork) and `addIcon` silently drops the second of each as a
duplicate id. Both spellings go into `tags`, so either one finds the icon.

### Also update `sources.json` (manual)

**Easy to forget, and it fails quietly.** The build script does not write
licences, and `calculateStats` only counts licences it finds in this file — so a
source missing here is *absent from the License filter entirely*, not merely
labelled "Unknown". Eight sources were added this way and 2,509 icons were
unreachable by licence until it was spotted.

Verify after importing:

```bash
curl -s http://localhost:3000/api/icons/stats | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).data;
const sum=Object.values(d.byLicense).reduce((a,b)=>a+b,0);
console.log("byLicense sum",sum,"total",d.total,"gap",d.total-sum);})'
```

The gap must be **0**.

```json
"iconmind": {
  "license": "MIT",
  "licenseUrl": "https://icon-sets.iconify.design/icon-sets/iconmind/"
}
```

**Write the licence the way the file already spells it.** `license` is the
filter bucket verbatim, so `Apache-2.0` does not join `Apache 2.0` — it opens a
second, near-identical entry in the License list. The file uses display spelling
(`Apache 2.0`, `CC0 1.0`, `CC BY 4.0`), not SPDX. Check before adding:

```bash
node -e 'const s=require("./data/icons/sources.json");const c={};
Object.values(s).forEach(v=>c[v.license]=(c[v.license]||0)+1);
console.log(Object.entries(c).sort((a,b)=>b[1]-a[1]))'
```

A bucket with a count of 1 that looks like a near-duplicate is usually a typo.

---

## Step 2: Import It

**Always use `--only=`.** A bare run refetches all 243 collections *and rewrites
every style from the upstream file name*, undoing Step 3 across the entire
catalogue.

```bash
node scripts/build-icons-data-full.js --only=iconmind
node scripts/build-icons-data-full.js --only=windows-metro,metro,cryptocoins
```

`--only=` takes `sourceId` values (not Iconify `file` names) and merges results
into the existing `collections.json`, preserving every collection it did not
refetch — including their order and `styleCounts`.

Smoke-test with the smallest source first. GitHub sources fetch one file each
(12 in parallel); expect roughly a minute per 2,500 files.

Nothing is written until every fetch completes, so an interrupted run leaves the
data untouched — verify that rather than assuming:

```bash
node -e 'const c=require("./data/icons/collections.json");
console.log(c.totalCollections, c.totalIcons, c.collections.slice(0,3).map(x=>x.id))'
```

---

## Step 3: Assign Styles

```bash
npm run reclassify:icon-styles
```

This inspects every icon's artwork and assigns one of five styles. The
upstream/provisional value is preserved as `sourceStyle`, so the pass is
re-runnable and idempotent.

| Style | Means |
|---|---|
| `3d` | coloured artwork — the only style rendered with its native palette |
| `duotone` | named duotone, whether stroked or filled — this outranks the artwork |
| `outline` | a stroke the renderer can actually restyle |
| `thin` | upstream thin/light weight, fill-based |
| `solid` | everything else painted with a fill |

Two rules are subtler than they look:

- **`outline` means *adjustable*.** Stroke Width is the only style-specific
  control, and it lives on Outline alone. An icon whose stroke the renderer
  refuses to touch must not be Outline — see the `<mask>`/`<defs>` trap below.
- **Colour means *hue*, not "not black".** Greys (`#212121`, `#333`, `gray`) and
  near-blacks (`#070400`) are monochrome. The parser compares RGB channels with
  an 8/255 tolerance.

Check the report for your source:

```bash
npm run reclassify:icon-styles 2>&1 | grep '^<sourceId> '
```

---

## Step 4: Rebuild and Restart

The backend reads `data/icons` **once at startup** and caches stats for an hour.
Editing files under a running server changes nothing.

```bash
npm run build
# kill the old process, then:
npm run start:prod
```

Allow ~5s for the search index to build. During that window filtered searches
return empty rather than erroring, and the frontend only retries when no filter
is active.

Frontend note: `icons.html` pins script versions (`motvin-icons.js?v=17`). Only
bump those if you changed the JS — adding a source needs no frontend change.

---

## Step 5: Verify

### Counts line up

```bash
curl -s http://localhost:3000/api/icons/stats | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const d=JSON.parse(s).data;
  console.log("total", d.total, "collections", d.totalCollections);
  console.log("byStyle", d.byStyle);
  console.log("sums:", Object.values(d.byStyle).reduce((a,b)=>a+b,0) === d.total);
})'
```

### Every icon satisfies its style

The check that matters. Run it over the whole catalogue, not a sample:

```bash
node -e '
const fs=require("fs");
const TOL=8, WHITES=new Set(["#fff","#ffffff","#ffff","#ffffffff","white"]);
const HUE=v=>{v=String(v).trim().toLowerCase();
 if(["","none","currentcolor","inherit","transparent"].includes(v)||/^(url|var)\(/.test(v))return false;
 const m=/^#([0-9a-f]{3,8})$/.exec(v);
 if(m){let h=m[1];h=h.length<6?h.slice(0,3).split("").map(c=>c+c).join(""):h.slice(0,6);
  if(h.length<6)return false;const[r,g,b]=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16));
  return Math.max(r,g,b)-Math.min(r,g,b)>TOL;}
 // rgb()/rgba()/hsl() too - the classifier parses these, so a sweep that only
 // knows hex calls rgb(100%,100%,100%) and rgba(229,229,229,.2) "coloured" and
 // invents violations that are not there.
 const rgb=/^rgba?\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)/.exec(v);
 if(rgb){const[r,g,b]=rgb.slice(1,4).map(n=>parseFloat(n));return Math.max(r,g,b)-Math.min(r,g,b)>TOL;}
 const hsl=/^hsla?\(\s*[\d.]+(?:deg|rad|turn)?[,\s]+([\d.]+)%/.exec(v);
 if(hsl)return parseFloat(hsl[1])!==0;
 return !["black","white","gray","grey","silver","gainsboro","whitesmoke","dimgray","darkgray","lightgray","snow","ivory"].includes(v);};
let bad=0, tot={};
for (const d of fs.readdirSync("data/icons")) {
  const f = `data/icons/${d}/icons.json`;
  if (!fs.existsSync(f)) continue;
  for (const i of JSON.parse(fs.readFileSync(f))) {
    const sv=i.svg||""; tot[i.style]=(tot[i.style]||0)+1;

    // colour: attributes, <style> class rules AND inline style="fill:..."
    let paints=[...sv.matchAll(/(?:fill|stroke|stop-color)\s*=\s*"([^"]*)"/gi)].map(m=>m[1]);
    for (const b of sv.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
      paints=paints.concat([...b[1].matchAll(/(?:fill|stroke|stop-color)\s*:\s*([^;}"\s!]+)/gi)].map(m=>m[1]));
    for (const b of sv.matchAll(/style\s*=\s*"([^"]*)"/gi))
      paints=paints.concat([...b[1].matchAll(/(?:fill|stroke|stop-color)\s*:\s*([^;}"\s!]+)/gi)].map(m=>m[1]));
    const coloured = paints.some(HUE) || /<image\b/i.test(sv);

    // adjustable stroke: must survive the renderer, and not be a white hairline
    const canRestyle = !/<mask|<defs/i.test(sv);
    const stroked = [...sv.matchAll(/stroke\s*=\s*"([^"]*)"/gi)].some(m=>m[1].trim().toLowerCase()!=="none");
    const outside = sv.replace(/<(defs|mask)\b[^>]*>[\s\S]*?<\/\1>/gi,"");
    const so = [...outside.matchAll(/stroke\s*=\s*"([^"]*)"/gi)].map(m=>m[1].trim().toLowerCase()).filter(v=>v!=="none");
    const hairline = so.length>0 && so.every(v=>WHITES.has(v)) && !/fill\s*=\s*"none"/i.test(sv);
    const adj = stroked && canRestyle && !hairline;

    if (i.style==="3d"      && !coloured) bad++;
    if (i.style==="outline" && (!adj || coloured)) bad++;
    if (i.style==="solid"   && (adj  || coloured)) bad++;
    if (i.style==="thin"    && (adj  || coloured)) bad++;
    if (i.style==="duotone" && coloured) bad++;
  }
}
console.log(tot); console.log("violations:", bad);
'
```

Expect **0 violations**.

### In the browser

Filter to the new source and confirm: the right style chips appear, Stroke Width
shows **only** for Outline, and the icons actually render (a blank grid usually
means missing paint — revisit `wrap`).

---

## Traps

Each of these cost real debugging time.

### `HTTP 403` on every GitHub source

Looks like a rate limit. It usually isn't — check with
`curl -s https://api.github.com/rate_limit`. The GitHub API rejects requests
with **no `User-Agent`** using a 403. `fetchJson` now sends one; keep it that way.

### The import hangs with no output

If the node process shows **zero open TCP connections**
(`lsof -nP -p <pid> | grep -c TCP`), it is stuck, not working. `fetchText` has a
15s timeout and 2 retries for this reason. Never add a fetch without a timeout —
one stalled socket blocks thousands of files silently.

### Icons import but render as black blobs

The set ships no paint attributes. Use `wrap`. See Step 1.

### Stray tooltips on hover

Standalone `.svg` files often contain `<title>` for accessibility. `unwrapSvg`
strips `<title>` and `<desc>` in **both** forms — paired *and* self-closing
(`<title id="x"/>`). The self-closing form was missed at first and slipped
through on 4 icons.

### Pasted layers named `accessibility_00000157309047752657…_`

Illustrator labels every shape it exports. That id survives Copy SVG, and a
design tool uses it to name the pasted layer — and since the ids repeat across
icons, pasting several into one document collides them. All 1,575 Carbon
Pictograms shipped this way.

`unwrapSvg` now drops ids, but only those nothing in the same icon references:
`url(#id)`, `href="#id"` and `clip-path` still need theirs, so gradients, masks
and clip paths are left intact. Worth re-checking after adding any
editor-exported set:

```bash
node -e 'const a=require("./data/icons/<sourceId>/icons.json");
console.log(a.filter(i=>/ id="/.test(i.svg||"")).length, "of", a.length, "still carry an id")'
```

A few survivors are normal — they are the referenced ones.

### A filled rectangle covers the icon once pasted into a design tool

Invisible in the browser, obvious the moment it leaves. Illustrator exports an
artboard-sized "Transparent Rectangle" behind the artwork:

```html
<rect style="fill:none;" width="32" height="32"/>
```

Nothing shows on the web — the inline `style` beats the `fill` attribute
`renderSvg` writes onto it. A design tool reads the attribute instead and pastes
a filled square on top of the icon. 1,511 of 1,575 Carbon pictograms had one.

`unwrapSvg` drops these, but only rects that cover the whole artboard *and*
demonstrably paint nothing — via inline `fill:none`, a class the icon's own
`<style>` block defines as `fill:none` (`.cls-1`, `.st0`), `fill="none"`, or
opacity ≤ 0.05. Full-bleed coloured rects and small ones stay: Carbon draws
chart bars as `<rect>`, and deleting those would gut the icon.

Removing the rect can orphan the `<style>` block that existed only to hide it,
so an unreferenced one is dropped too — not cosmetic, because `renderSvg` skips
recolouring any icon containing `<defs>`, and the dead block would have cost
44 icons their colour controls.

Check what a copy actually hands over rather than trusting the grid:

```js
window.BulkExport.flattenSvg(await exportSvgFor(ICONS[0]))
// want only <svg> and the drawing elements - no <rect> spanning the viewBox,
// no <defs>/<style>, no id
```

### Phosphor no longer first in the default view

`collections.json` is in **curated order, not size order** — Phosphor first,
Heroicons second. The grid renders collections in this order when no filter is
active, so sorting by `total` changes what users first see. Do not re-add a sort
to the write step; `--only=` preserves the existing order and appends new sources
at the end.

### Every line renders doubled after moving a set out of Solid

Only for fill-based artwork with **no `fill` and no `stroke` attribute at all** —
bare `<path d="…">`, which is how Carbon Pictograms, Linea and every extracted
font glyph (Atlas Icons) ship.

`renderSvg` detects fill-based artwork correctly, then throws the answer away
for any style other than `solid`/`brands` unless the source is on a hard-coded
allowlist:

```js
let isFillBased = !/stroke\s*=\s*"(?!\s*none)/i.test(paths);
if (opts.iconStyle !== "solid" && …) {
  if (!fillBasedSources.includes(opts.sourceId)) isFillBased = false;
}
```

With `isFillBased` false and no paint attributes to read, each path comes out
`fill="none" stroke="currentColor"` — so a fill that *traces* a line gets
outlined, and every line in the icon renders as two. In Solid the same artwork
is fine, because the guard never fires; the breakage appears only when the set
is reclassified into Thin or Duotone.

Add such a source to `fillBasedSources` in `JS/motvin-icons.js` at the same time
you declare `style: 'thin'`, and bump the pinned `motvin-icons.js?v=` in
`icons.html` — the two changes belong in one commit. Verify against a bare path
rather than one already on the page (the DOM copy has been rewritten and will
pass either way):

```js
renderSvg('<path d="M1,1z"/>', { iconStyle:'thin', sourceId:'<sourceId>', viewBox:'0 0 32 32', size:24 })
// want: fill="currentColor" stroke="none"   (not fill="none" stroke="currentColor")
```

**The allowlist is keyed on `opts.sourceId`, so anything that forgets to pass it
fails the check too.** `editorRenderOpts()` did, which left the detail view and
everything it feeds — Copy SVG, Download SVG, the code preview, all export
formats — stroking these sets long after the grid was fixed. Grid and editor are
separate render paths; test both:

```js
// grid path
renderSvg(body, { iconStyle: rec.style, sourceId: coll, viewBox: rec.viewBox, size: 24 })
// editor path - what Copy SVG and Download SVG actually hand out
state.editorIcon = { ...rec, source: coll, svg: body }; currentSvgString()
```

### Icons in Outline whose Stroke Width does nothing

`renderSvg` bails out entirely on `<mask>` or `<defs>` — naive regex rewriting
would destroy those shapes — so the stroke it would inject never lands. Such
artwork is **not** adjustable and must not be Outline. This was wrong for 3,117
icons (Iptwotone 1,942, IconPark 941) before being caught.

Related: a white hairline (`stroke="#FFF" stroke-width=".2"`) on artwork with
nothing hollow is a separator, not linework. Windows Metro draws filled glyphs
that way.

### A black logo lands in 3D Icons

`#070400` is r7 g4 b0 — a 7/255 spread nobody can see. Exact channel equality is
too strict; `ACHROMATIC_TOLERANCE = 8` handles it. This affected 702 icons.

### Duplicate ids across collections

`tdesign` and `keyline-icons` both have `activity`; `el`/`lsicon`/`mi` share
names. **225 such collisions exist and are expected** — ids are unique per
collection, not globally. Do not key anything on `id` alone.

### The reclassify pass dies partway and leaves the chips stale

It rewrites ~250 multi-megabyte files back to back, and on Windows an open
intermittently fails with `UNKNOWN`/`EBUSY` because a virus scanner or the
search indexer still holds the handle. It happened twice here, on a *different*
collection each run — which is the tell that the file is fine and the write is
not.

The damage is quiet: the crash lands inside the per-collection loop, **before**
the single `writeJson(collectionsFile, …)` at the very end. So `icons.json` and
`metadata.json` are updated, `collections.json` is not — and since that entry is
what feeds the style chips, the UI keeps showing the pre-pass styles while the
data underneath has moved. `styleCounts` missing from a collections entry is the
symptom.

`writeJson` now retries transient codes, but always check the exit status rather
than the output — a `grep` over the log hides the stack trace completely:

```bash
npm run reclassify:icon-styles > /tmp/reclass.log 2>&1; echo "EXIT: $?"
node -e 'const c=require("./data/icons/collections.json").collections;
console.log(c.filter(x=>!x.styleCounts).length, "entries missing styleCounts")'
```

Both must read 0. Re-running is safe — the pass is idempotent.

### Your verifier agreeing with your bug

Twice a check passed while the data was wrong, because the check reused the same
flawed logic as the classifier. When something looks suspicious, open the actual
SVG markup instead of re-running the same test. VectorLogoZone hid 294 coloured
logos this way (colour set via a `<style>` class rule, which the attribute-only
check never read).

It also fails the other way — a sweep **weaker** than the classifier invents
violations that are not there. The sweep above reported 5 until it learned what
`reclassify` already knew: `fill:rgb(100%,100%,100%)` is white and
`rgba(229,229,229,.2)` is grey, but a hex-only check calls both colour. Before
"fixing" data a sweep complains about, diff your check against `valueHasHue` and
`paintValues` in `reclassify-icon-styles.js` — those two are the definition.
Both gaps (`rgb()`/`hsl()`, and inline `style="fill:…"`) are patched into the
snippet above.

---

## Checklist

```
[ ] Source is not already in data/icons or Iconify (check data/, not just the diff)
[ ] Licence is permissive; LICENSE file exists
[ ] Counted NEW names, not the headline total
[ ] Entry added to `sources` in build-icons-data-full.js
[ ] Checked a raw .svg — does it need `wrap`?
[ ] Tree scattered or file names prefixed? -> `pathMatch` / `stripName`
[ ] Licence added to data/icons/sources.json  <- silent failure if skipped
[ ] Licence string matches an existing bucket's spelling exactly
[ ] byLicense sum == total (gap 0)
[ ] Imported with --only=<sourceId>
[ ] npm run reclassify:icon-styles  <- check EXIT CODE, not just output
[ ] npm run build && restart backend
[ ] every collections.json entry has styleCounts
[ ] stats byStyle sums to total
[ ] full-catalogue sweep shows 0 violations
[ ] declared `thin`/`duotone` on bare-path artwork? -> add to `fillBasedSources`
    in JS/motvin-icons.js and bump `motvin-icons.js?v=` in icons.html
[ ] browser: chips correct, Stroke Width only on Outline, icons visible
[ ] browser: lines render single, not doubled (grid AND editor Copy SVG)
[ ] copy output is clean: no artboard <rect>, no <defs>/<style>, no editor ids
[ ] font-glyph source? -> fill-rule="nonzero" baked in; shapes close properly
[ ] default view still opens on Phosphor
```

---

## Other Pages

Logos and Illustrations have the same shape:

| Page | Build script | Reclassify | Styles |
|---|---|---|---|
| Icons | `build-icons-data-full.js` | `reclassify-icon-styles.js` | outline, solid, duotone, thin, 3d |
| Logos | `build-logos-data-full.js` | `reclassify-logo-styles.js` | color *(shown as "Default")*, solid |
| Illustrations | `build-illustrations-data-full.js` | `reclassify-illustration-styles.js` | color, solid |

Two differences worth knowing:

- Logos and Illustrations store markup under **`body`**, not `svg`. The services
  accept either; new code should too.
- Three illustration collections ship only an `imageUrl` with no inline SVG (395
  items). They render as `<img>` and cannot be inspected or recoloured, so the
  reclassify pass leaves their declared style alone.

The colour-analysis helpers (`valueHasHue`, `isColoredArtwork`) are **duplicated
in all three reclassify scripts** by choice. A change to one needs the same
change in the others, or the pages will disagree about what "coloured" means.
