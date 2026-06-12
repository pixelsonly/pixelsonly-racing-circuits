# Per-track intake checklist

Run once per track. Each step writes into the track's folder. The aim is a
repeatable assembly line, not a from-scratch design job.

## 1. Identity & layout
- [ ] Lock `slug` (kebab-case, permanent), `name`, `display_name`, `subtitle`,
      `country_code`, `country_name`, `locality`.
- [ ] **Determine the layout.** If the circuit has multiple configurations, select
      the Grand Prix or IMSA layout. **If it's ambiguous, stop and decide before
      proceeding** — the choice drives turns, length, elevation, and the map.
- [ ] For multi-layout circuits, add one `layouts[]` entry per configuration and
      set `primary_layout`.

## 2. Coordinates
- [ ] Record `latitude` / `longitude` (circuit center), verified against an
      authoritative source — not a single dropped map pin.

## 3. Satellite imagery (separate private tooling)
- [ ] Run `npm run capture-frame -- <slug> --preview --plan-file` (needs
      `map.svg` + `length_km`, i.e. do this after step 5/6). It derives the
      capture frame — center (OSM-refined, else the declared coords) + master/web
      spans + master px size — writes the committed `tracks/<slug>/<slug>.capture.json`,
      and renders `previews/capture/<slug>.svg`.
- [ ] **Review the preview** (`qlmanage -t -s 1400 previews/capture/<slug>.svg`):
      the track must sit centered in the red web frame with margin, on the blue
      OSM geometry. If OSM fell back (banner says so) or the center looks off,
      add a `center`/span override in `scripts/capture-frame.overrides.json` and
      re-run. Commit the `.capture.json` — the dispatcher reads it on merge and
      fails loud if it's missing.
- [ ] On merge, [`dispatch-capture.yml`](../.github/workflows/dispatch-capture.yml)
      fires the private capture repo, which writes the Sentinel-2 master + the
      web JPG derivative + sidecars to private R2.
- [ ] Produce the **stylized derivative** and place it in the track folder as
      `satellite.*`; set `assets.satellite.attribution` to
      "Contains modified Copernicus Sentinel data <year>".

## 4. Country flag (SVG)
- [ ] Run `npm run fetch-flag -- <slug>`. The script resolves the flag from
      Wikimedia Commons via Wikidata (using the record's `country_code`), writes
      `flag.svg`, runs SVGO, and updates the `LICENSE-ASSETS.md` register row.
- [ ] If the output warns that the license is not public domain, review the
      register row and confirm the poster + web rendering carry correct
      attribution (some CC-BY-SA flags also require share-alike).

## 5. Track map (SVG)

Two-phase: a scripted Phase A grabs a Commons reference, commits it, and
records its license; a manual Phase B produces the simplified production map
from it. Both the original source (`map-source.svg`, SVGO-optimized but
visually unchanged) and the production map (`map.svg`) are committed — the
website may render either.

### Phase A — fetch the source
- [ ] Identify a Wikimedia Commons SVG of the **selected layout** (named in the
      new-track issue). Public-domain sources are preferred; CC-BY-SA is fine
      but obligates share-alike downstream.
- [ ] Run `npm run fetch-map -- <slug> --from "<commons-title-or-url>"`.
      The script:
      - downloads the original to `tracks/<slug>/map-source.svg` (committed);
      - writes `assets.map_source` + `assets.map_attribution`
        (source URL, license, artist, ready-to-render credit, accessed date)
        into the track YAML — a comment-preserving surgical edit;
      - upserts the **Track maps** row in `LICENSE-ASSETS.md`.
      No need to hand-copy any of the license/credit fields.

### Phase B — produce map.svg

Two sub-paths depending on what the Commons SVG looks like. Inspect the source
first (open in a text editor — Inkscape Wikimedia files are human-readable).

**Path-extract** (preferred when the source already has a single closed-path
track outline; this was the case for Laguna Seca's `path2538`):
- [ ] Identify the path element that draws the track centerline (typically the
      thickest black stroke). Note its `id`.
- [ ] Wrap that path's `d` in a fresh SVG with `viewBox="0 0 1000 1000"`, a
      single `<g>` whose `transform` is an affine fit (`matrix(s 0 0 s tx ty)`)
      from the source's path-coord space to the 1000×1000 box with a ~50px
      margin. Set stroke-width to `10/s` so the post-flatten stroke renders at
      10 user units.
- [ ] Apply the repo's stroke conventions on the `<path>`: `fill="none"`,
      `stroke="#1f1f21"`, `stroke-linecap="round"`, `stroke-linejoin="round"`,
      plus `aria-label` and `role="img"` on the `<svg>` element.
- [ ] Run SVGO (step C) — it flattens the transform into the path coordinates
      and adjusts stroke-width accordingly.

**Affinity-trace fallback** (when the source is too messy to extract —
multi-segment paths, missing centerline, weird grouping, raster-only):
- [ ] Open `map-source.svg` in Affinity Designer.
- [ ] Set the document canvas to **1000×1000**.
- [ ] Pen-trace a single closed centerline of the selected layout. Discard pit
      lane, runoff fills, color shading, labels, start/finish markings —
      everything except the track outline.
- [ ] Fit the path to the canvas with a small visual margin so corners at the
      edges don't clip when rendered.
- [ ] Export as SVG with the same conventions as path-extract above.

In either case, save as `tracks/<slug>/map.svg` with a leading XML comment
block carrying the derivation note (source file + license + retrace date).
SVGO is configured to preserve comments. **Do not put `--` inside the comment**
— XML rejects it and SVGO will refuse to parse.

### Phase C — optimize
- [ ] Run SVGO: `npx svgo --config svgo.config.mjs -rf tracks`.
- [ ] With the final viewBox locked in, fill `position: { x, y }` (0–1) on
      every corner that has an entry in the YAML.

## 6. Track facts (per selected layout)
- [ ] `year_opened`, `turns`, `length_km` + `length_mi`, `elevation_change_m` +
      `elevation_change_ft` — each cross-checked against an authoritative source.
- [ ] Per-corner records: at minimum the signature corner(s) with `name`,
      `description`, and a `sources` block. Add `position` once the map viewBox is
      final.
- [ ] Optional per-corner geometry + coaching (all additive, populate what
      genuinely applies — omit fields that don't fit a compound corner):
      - `direction` (`left`/`right`/`left-right`/`right-left`/`chicane`),
        `apex_type` (`early`/`geometric`/`late`/`double`).
      - `elevation_change_m` + `elevation_change_ft` — **signed** (negative =
        drops), paired like the layout figure; cross-check against a source.
      - `radius_m` (approx; metric-only), `landmark` (visual brake/turn-in
        reference), `coaching` (free-form technique notes — craft knowledge, no
        source required). Keep car/class-specific numbers OUT.
- [ ] Lap records by class (optional) — each REQUIRES a `sources` block.

## 7. Editorial + commerce
- [ ] `editorial.tagline`, `editorial.narrative_md` (write `<slug>.md`),
      `editorial.available_in`. Any author note at the top of `<slug>.md` (the
      licensing/sourcing reminder) must be an **HTML comment** (`<!-- ... -->`),
      not a Markdown blockquote — the package inlines the narrative and the apex
      site renders it with `<Content />`, so a blockquote would surface as a
      pull-quote on the published page. Match the comment convention already used
      by the "Expand with…" note at the bottom of each existing `<slug>.md`.
- [ ] `commerce.shopify_product_url` (at launch), `commerce.card_url` (companion
      card short link).

## 8. Sources & status
- [ ] At least one record-level `sources` entry; ≥2 to mark `verified`.
- [ ] Set `status`: `draft` → `verified` (cross-checked) → `canonical` (signed off
      for print + production).

## 9. Validate
- [ ] `npm run validate` passes (required fields, paired units, asset existence,
      no duplicate slug, sources present).
