# AGENTS.md — pixelsonly-racing-circuits
Canonical motorsport circuit data, narrative, and visual assets behind pixelsonly.racing.
Published as `@pixelsonly/pixelsonly-racing-circuits` to GitHub Packages.

## Stack & commands
- Node >= 20, ESM ("type": "module"). No framework — plain .mjs scripts.
- `npm run validate` — schema + integrity checks. Required gate; runs in CI (validate.yml) on PRs
  touching tracks/, schema/, scripts/, or package.json. Run it before opening a PR.
- `npm run build` — derives build/circuits.json from per-track YAML (runs in prepack + publish).
- `npm run audit:handedness` — cross-checks each corner's `direction` against the map.svg
  centerline geometry and NOMINATES likely-wrong corners (needs `npm run build` first). It only
  flags candidates — always confirm a HIGH flag against a written source before editing data;
  it over-flags on tight clusters / compound-corner tracks (see the WEAK CALIBRATION note).
- Track data: tracks/<slug>/<slug>.yaml — the filename must match the folder name.

## Release model (do not bypass)
- Releases are managed by release-please v4 (manifest mode). Do NOT hand-edit the version,
  CHANGELOG.md, or .release-please-manifest.json.
- Version is driven by Conventional Commit *types*. PRs are squash-merged, so the PR title becomes
  the commit subject release-please parses. An unrecognized type silently produces no bump and no
  changelog entry — the pr-title check guards against this; honor it.
- Types in use (keep in sync with release-please-config.json and the pr-title check):
  - `feat:` -> minor (new track / additive optional field)
  - `fix:` / `data:` -> patch (value correction, typo)
  - `schema:` -> schema change
  - `assets:` -> asset change
  - `docs:` -> docs
  - `chore:` -> maintenance (hidden)
  - `feat!:` or a `BREAKING CHANGE:` footer -> major

## Cross-repo side effects (non-obvious)
- Adding a NEW canonical track YAML on main auto-triggers a satellite capture in the private repo
  pixelsonly-racing-track-captures: dispatch-capture.yml runs `gh workflow run capture.yml` there
  (span_km=80), authed by CAPTURES_DISPATCH_TOKEN. Fires on the track ADD only — NOT on edits to an
  existing track, NOT on release. Re-run capture.yml manually if a coordinate fix needs a fresh master.

## Editorial style
- No em-dashes in editorial content. Brand voice forbids the em-dash (`—`, U+2014). Use a
  colon, comma, parentheses, or a new sentence instead (matching the existing track copy).
- Scope = reader-facing prose: the narrative `<slug>.md` body, and the YAML prose fields
  `subtitle`, `editorial.tagline`, and per-corner `description` / `story` / `landmark` / `coaching`.
- Exempt (not editorial content): `<!-- ... -->` HTML comments and author notes in the `.md`,
  YAML `#` comments, source `title`/`url` fields, and corner `name`/`number` labels.
- `npm run validate` enforces this (the em-dash integrity check) — a stray em-dash fails CI.
  Out of scope by design: en-dashes and hyphens are allowed (e.g. range labels like `Turns 3-5`).

## Conventions
- Public-PR model: nothing reaches main without passing validate.
- Do not touch the stylization / satellite.webp return path — intentionally manual.
