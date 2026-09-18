# Inspirations storage

Screenshot storage for the Inspirations platform (`/inspirations` in motvin-web).

Everything the gallery shows comes from this folder. There is no generated or
placeholder content anywhere in the stack: if a screen is not stored here, it
does not appear on the site.

## Layout

```
data/inspirations/
  apps.json              app records — one entry per product
  flows.json             ordered screen sequences
  patterns.json          named UI patterns and the screens that show them
  sources.json           LICENSING GATE — per-app permission + license
  manifest.json          GENERATED — do not edit by hand
  logos/                 app marks:  <app-slug>.svg | .png | .webp
  screens/
    web/<app-slug>/      desktop + responsive web captures
    ios/<app-slug>/      iPhone captures
    android/<app-slug>/  Android captures
  analysis/              <screen-id>.json — real UI analysis output, when it exists
```

Platform folders match the platform filter in the UI (Web / iOS / Android).
"Mobile" is deliberately split in two: the gallery filters and the aspect
ratios differ between the two platforms.

## Screen file naming

Two layouts, both valid, read side by side.

**Grouped by flow** — what automatic capture writes. The folder is the journey's
name and the numbers are the order it was walked:

```
screens/<platform>/<app-slug>/<flow-name>/<position>.<ext>
screens/ios/luma/onboarding/1.png
screens/ios/luma/completing-a-profile/1.png … /6.png
```

The screen id becomes `<app-slug>-<platform>-<flow-name>-<position>`, so each
flow's `1.png` stays distinct. Ordering is numeric, so `10.png` follows `9.png`
rather than `1.png`. A screen filed this way carries no type in its name — its
sidecar is the source of truth, which automatic capture always writes.

Exactly one level of nesting is read. A deeper folder is ignored, not flattened.

**Loose** — what a manual upload writes. The name leads with the screen type:

```
screens/<platform>/<app-slug>/<screen-type>[-<variant>].<ext>
```

- `<app-slug>` must match an `id` in `apps.json`.
- `<screen-type>` must be one of the screen types in `manifest.json`'s
  `screenTypes` (landing, login, signup, dashboard, search, pricing, checkout,
  settings, profile, onboarding, feed, product, other).
- `<variant>` is free text for multiple captures of the same type
  (`dashboard-empty`, `dashboard-expanded`).
- `<ext>` is `.webp` (preferred), `.png`, or `.jpg`.

The screen id is derived from the path: `<app-slug>-<platform>-<basename>`.
Example: `screens/ios/acme/dashboard-empty.webp` → `acme-ios-dashboard-empty`.

## Record shapes

`apps.json` — one entry per product. `id` is the slug used in folder names
and URLs.

```json
{
  "id": "acme",
  "name": "Acme",
  "industry": "saas",
  "platforms": ["web", "ios"],
  "website": "https://acme.example",
  "tagline": "One line about the product.",
  "logo": "acme.svg"
}
```

Per-screen extras are optional, in a JSON sidecar next to the image
(`dashboard.webp` → `dashboard.json`). Anything omitted is left unset rather
than guessed:

```json
{
  "name": "Spending dashboard",
  "screenType": "dashboard",
  "tags": ["kpi", "analytics"],
  "elements": ["navigation", "chart", "table", "kpi-card"],
  "style": ["minimal", "light"],
  "capturedAt": "2026-02-14"
}
```

`flows.json` — ordered screen ids, which must exist under `screens/`.

```json
{
  "id": "acme-ios-onboarding",
  "appId": "acme",
  "name": "Onboarding",
  "category": "onboarding",
  "platform": "ios",
  "screenIds": ["acme-ios-onboarding", "acme-ios-signup", "acme-ios-dashboard"]
}
```

`patterns.json` — the pattern catalogue. Each pattern's examples are resolved
at build time from its `match` block against stored screens, so patterns fill
in automatically as screens arrive.

## Provenance

`sources.json` holds one entry per app, recording where its screens came from.
It used to gate publication; it no longer does. An entry is created with
`"status": "approved"` as soon as an app has a record or a screen, so captures
reach the gallery without a separate approval step.

The rest of the entry still matters: permission, licence, attribution and
redistribution all flow into `manifest.json` and onto the screen page. What is
left blank simply reads as unrecorded.

Each entry records how the capture was obtained and what may be done with it:

```json
"acme": {
  "sourceUrl": "https://acme.example",
  "capturedAt": "2026-02-14",
  "capturedBy": "motvin",
  "permission": "owner-granted",
  "license": "CC BY 4.0",
  "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
  "attribution": "Acme Inc.",
  "redistribution": "allowed",
  "status": "approved"
}
```

- `permission` — `owner-granted`, `open-source`, `public-domain`,
  `own-work`, or `fair-use-reference`. Records why the material may be shown at
  all. Nothing enforces it now, so it is only as accurate as whoever set it.
- `license`, `licenseUrl`, `attribution` — optional. Recorded when known and
  shown on the screen page; an entry with no licence reads "Not recorded", and
  a missing attribution falls back to the app's name.
- `redistribution` — `allowed` lets visitors download the file.
  `view-only` displays it in the gallery but disables download.
- `status` — `pending`, `review`, `approved`, `rejected`. Set to `approved`
  automatically. The builder still reads it, so setting one back by hand is how
  an app is pulled from the site without deleting its files.

Do not add screenshots scraped from another design library. Those files are
that library's compilation, collected under its own terms, and are not ours to
republish. Sources that are safe to build on:

- apps the owner has given written permission to feature,
- open-source apps whose UI ships under a permissive or copyleft licence,
- Motvin's own products and captures,
- public-domain and government design systems.

## Two ways to fill this folder

**The admin page**, at `/inspirations/admin` in the web app, is the normal
route: upload screenshots, record each app's licence, approve it, and the
manifest is rebuilt for you on every change. Access is limited to the accounts
in `INSPIRATIONS_ADMIN_EMAILS`, checked server-side against the caller's
Firebase ID token, so the page cannot be used by anyone else.

Deleting an app on that page deletes everything stored for it: its screenshots
on every platform, their sidecars and analysis files, its logo, its licence
entry and its flows. There is no trash folder, so the confirmation names the
file count before anything goes.

**By hand**, by dropping files into the folders above and editing the JSON, then
rebuilding:

```bash
npm run build:inspirations
```

Either way the same builder runs: it scans the folders, reads image dimensions,
reads each app's source entry, and writes `manifest.json`. The API serves that
manifest and streams files straight from `screens/` and `logos/`.
