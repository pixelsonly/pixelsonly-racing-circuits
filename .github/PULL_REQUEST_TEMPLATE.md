<!--
  Thanks for contributing. The bar here is higher than typical open source:
  errors in this data become errors on aluminum prints and public pages, so
  every factual change needs a source. PRs without sources will be asked for
  them before review.
-->

## What does this change?

<!-- New track? Corrected fact? New layout? Asset update? Briefly describe it. -->

## Affected track(s)

<!-- e.g. laguna-seca, spa -->

## Source citations (required for any data change)

<!--
  List the authoritative source(s) for each fact you added or changed.
  These must also be present in the record's `sources` (or a corner/lap_records
  `sources` block). Prefer official circuit sites, sanctioning bodies, and
  well-referenced encyclopedic entries over forums or wikis without citations.
-->

- Fact: …  →  Source: …

## Checklist

- [ ] `npm run validate` passes locally
- [ ] Both units are present for every length (km + mi) and elevation (m + ft)
- [ ] Turns / length / elevation match the **selected layout** (not a different config)
- [ ] Any new SVG runs clean through SVGO (`npx svgo --config svgo.config.mjs -rf tracks`)
- [ ] Sources added to the record for every new/changed fact
- [ ] Flag SVG license recorded in `LICENSE-ASSETS.md` (if a flag was added)
