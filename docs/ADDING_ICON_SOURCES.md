# Adding New Icon Sources

How to add an open-source icon set to the Icons page, using the scripts already
in `scripts/`. Written from the sources added in practice — every warning below
is something that actually went wrong, not a hypothetical.

Current catalogue: **238 collections, 379,763 icons**.

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
licensed set on GitHub, and this project already imports 231 of its 238
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

`style` here is only a placeholder. Step 3 overwrites it from the artwork.

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

---

## Step 2: Import It

**Always use `--only=`.** A bare run refetches all 231 collections *and rewrites
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
 return !["black","white","gray","grey","silver","gainsboro","whitesmoke","dimgray","darkgray","lightgray","snow","ivory"].includes(v);};
let bad=0, tot={};
for (const d of fs.readdirSync("data/icons")) {
  const f = `data/icons/${d}/icons.json`;
  if (!fs.existsSync(f)) continue;
  for (const i of JSON.parse(fs.readFileSync(f))) {
    const sv=i.svg||""; tot[i.style]=(tot[i.style]||0)+1;

    // colour: attributes AND <style> class rules
    let paints=[...sv.matchAll(/(?:fill|stroke|stop-color)\s*=\s*"([^"]*)"/gi)].map(m=>m[1]);
    for (const b of sv.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
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

### Phosphor no longer first in the default view

`collections.json` is in **curated order, not size order** — Phosphor first,
Heroicons second. The grid renders collections in this order when no filter is
active, so sorting by `total` changes what users first see. Do not re-add a sort
to the write step; `--only=` preserves the existing order and appends new sources
at the end.

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

### Your verifier agreeing with your bug

Twice a check passed while the data was wrong, because the check reused the same
flawed logic as the classifier. When something looks suspicious, open the actual
SVG markup instead of re-running the same test. VectorLogoZone hid 294 coloured
logos this way (colour set via a `<style>` class rule, which the attribute-only
check never read).

---

## Checklist

```
[ ] Source is not already in data/icons or Iconify
[ ] Licence is permissive; LICENSE file exists
[ ] Counted NEW names, not the headline total
[ ] Entry added to `sources` in build-icons-data-full.js
[ ] Checked a raw .svg — does it need `wrap`?
[ ] Licence added to data/icons/sources.json  <- silent failure if skipped
[ ] byLicense sum == total (gap 0)
[ ] Imported with --only=<sourceId>
[ ] npm run reclassify:icon-styles
[ ] npm run build && restart backend
[ ] stats byStyle sums to total
[ ] full-catalogue sweep shows 0 violations
[ ] browser: chips correct, Stroke Width only on Outline, icons visible
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
