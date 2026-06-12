---
name: add-track
description: Add a new circuit to the dataset from a "[track]" GitHub issue — the full intake assembly line (research, adversarial fact-check, assets, map.svg derivation, corner positions, validate, PR). Use when asked to add a track, handle a new-track issue, or batch several track issues.
---

# Add a track from a [track] issue

One issue → one branch → one PR (`feat:` = minor release). Proven on Road America
([#39](https://github.com/pixelsonly/pixelsonly-racing-circuits/pull/39), centerline-path source)
and Daytona ([#54](https://github.com/pixelsonly/pixelsonly-racing-circuits/pull/54), filled-band source).
Read `docs/intake-checklist.md`, `AGENTS.md`, and the exemplar
`tracks/road-america/road-america.yaml` + `.md` before starting. Work in your
worktree with **relative paths only**.

## Phase 0 — intake

`gh issue view <N>` → extract: circuit name, **slug (permanent, binding)**,
country, canonical layout, Commons map SVG, Wikipedia URL, official site.

- Layout field blank → adopt the configuration the linked SVG depicts if it
  matches the repo preference (GP/IMSA layout); record the decision for the PR.
- Linked map is a raster (PNG) → `fetch-map` will reject it; find the proper
  Commons SVG of the *same selected layout* and note the substitution in the PR.

## Phase 1 — research + adversarial fact-check (two agents)

1. Launch a research agent with [research-prompt.md](research-prompt.md)
   (fill the `{{...}}` placeholders). Output: complete YAML record (no corner
   positions, no `map_source`/`map_attribution`), narrative `.md`, and notes.
2. Launch a verify agent with [verify-prompt.md](verify-prompt.md) on the
   result — it can run in the background while Phase 2/3 proceeds, but its
   corrections MUST be applied before commit. **Never skip it**: on Daytona it
   caught a wrong renaming claim and a handedness error in a record already
   marked `verified`.

When batching several tracks, run all research agents in parallel first —
research is the wall-clock long pole and the agents are independent.

## Phase 2 — scaffold + scripted assets

```
git fetch origin main && git checkout -B feat/add-<slug> origin/main
npm ci                                   # once per worktree
# write tracks/<slug>/<slug>.yaml and <slug>.md from Phase 1
npm run fetch-flag -- <slug>
npm run fetch-map  -- <slug> --from "<commons-file-or-url>"
git diff tracks/<slug>/<slug>.yaml       # fetch-map rewrites the YAML; confirm no mangling
```

## Phase 3 — map.svg (decision tree)

**Always render the source first** (macOS): `qlmanage -t -s 3000 -o /tmp
tracks/<slug>/map-source.svg`, then look at the PNG. One look resolves layout,
marker numbering, pit roads, and which extraction path applies — do not try to
reason it out from path data.

- **Stroked centerline path** (most Pittenger-era maps): Phase B path-extract
  per `docs/intake-checklist.md` step 5, then `npm run positions -- <slug>`
  for marker-derived corner positions.
- **Filled band** (2024-era "Road Course" style — one black filled path with
  hole subpaths, no centerline): `npm run map-band -- <slug> --start "x,y"
  [--heading "dx,dy"] [--avoid "x,y;..."] [--sf "x,y"] [--reverse]`.
  Pick `--start` on an unambiguous stretch of racing line, `--avoid` on pit
  road / access roads, `--sf` near the start/finish graphic. The script writes
  `map.svg` and prints marker-projected positions + signed-turn handedness.
  **Gate: the reported marker lap order must come out exactly 1..N** (use
  `--reverse` if it's backwards); verify the numerals against the render.
- Either way, finish with `npx svgo --config svgo.config.mjs -f tracks/<slug>`,
  render the produced `map.svg`, and compare it with the source by eye.

## Phase 4 — reconcile the record

- Insert `position: { x: N, y: N }` after each corner's `direction`, plus a
  provenance comment above `corners:` (how positions/handedness were derived —
  mirror road-america's or daytona's comment).
- **Handedness: geometry wins over guide prose.** Negative signed turn = LEFT
  (y-down SVG coordinates, trace in race direction). If geometry contradicts a
  source, change the record and flag it in the PR (Daytona T2 precedent).
- Corner scope is Tier 1 + sourced Tier 2 only (no `coaching`, no `landmark`);
  unnamed corners are `"Turn N"`; signature corner(s) get `signature: true` +
  `story`. Layouts over ~20 turns: cover the lap with named/compound corners
  (Spa precedent). `lap_records` only with exact sourced `m:ss.mmm` times.
- Units always paired (km+mi, m+ft) or both absent — layout AND corner level.

## Phase 5 — gates (all must pass before the PR)

```
npx svgo --config svgo.config.mjs -rf tracks --quiet
npm run capture-frame -- <slug> --preview --plan-file   # writes <slug>.capture.json
git status   # ONLY tracks/<slug>/** and LICENSE-ASSETS.md may be dirty
npm run validate          # zero errors
node scripts/build.mjs    # must succeed; never commit build/
```

After `capture-frame`, **eyeball the preview** (`qlmanage -t -s 1400
previews/capture/<slug>.svg`): the track must sit centered in the red web frame
with margin. If the banner says the OSM center fell back, or it looks off-centre,
add a `center` override in `scripts/capture-frame.overrides.json` and re-run.
Commit `tracks/<slug>/<slug>.capture.json` — the dispatcher reads it on merge.

## Phase 6 — commit + PR

- Commit subject: `feat: add <Name> (<Layout>)`; body: 2–4 bullets +
  `Refs #<N>` + the Co-Authored-By footer.
- `git push -u origin feat/add-<slug>`, then `gh pr create` with the same
  title (squash-merge makes it the release-please commit subject — `feat:` ⇒
  minor bump). Body: one-liner + `Closes #<N>`, "What's included",
  **"Decisions & deviations"** (layout calls, source substitutions,
  geometry-settled handedness, anything to double-check), "Verification",
  and the Claude Code footer.

## Gotchas

- XML comments cannot contain `--`; sanitize source filenames before putting
  them in `map.svg`'s comment (e.g. Suzuka's `Suzuka_circuit_map--2005.svg`).
- Official circuit sites often 403 non-browser fetchers; cite them per the
  issue but verify facts via Wikipedia/RacingCircuits.info/series sources.
- `fetch-flag`/`fetch-map` insert LICENSE-ASSETS.md rows at the same table
  position — concurrent track PRs conflict there on merge; trivial rebase.
- Never push `main`; never touch CHANGELOG.md, the version, or
  `.release-please-manifest.json`. Tooling PRs use `chore:` (no release).
