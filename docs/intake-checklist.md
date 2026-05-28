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
- [ ] Run the capture tool (private repo) with the coordinates + span (default
      4 km). It writes the Sentinel-2 master + sidecar to private R2.
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
- [ ] Produce a simplified single-line outline of the **selected layout**, with a
      normalized `viewBox` (keep `0 0 1000 1000` so corner positions are 0-1).
- [ ] Consistent stroke conventions, no fill, single path where possible.
- [ ] Run SVGO: `npx svgo --config svgo.config.mjs -rf tracks`.

## 6. Track facts (per selected layout)
- [ ] `year_opened`, `turns`, `length_km` + `length_mi`, `elevation_change_m` +
      `elevation_change_ft` — each cross-checked against an authoritative source.
- [ ] Per-corner records: at minimum the signature corner(s) with `name`,
      `description`, and a `sources` block. Add `position` once the map viewBox is
      final.
- [ ] Lap records by class (optional) — each REQUIRES a `sources` block.

## 7. Editorial + commerce
- [ ] `editorial.tagline`, `editorial.narrative_md` (write `<slug>.md`),
      `editorial.available_in`.
- [ ] `commerce.shopify_product_url` (at launch), `commerce.card_url` (companion
      card short link).

## 8. Sources & status
- [ ] At least one record-level `sources` entry; ≥2 to mark `verified`.
- [ ] Set `status`: `draft` → `verified` (cross-checked) → `canonical` (signed off
      for print + production).

## 9. Validate
- [ ] `npm run validate` passes (required fields, paired units, asset existence,
      no duplicate slug, sources present).
