# Pixelsonly Racing Circuits

The circuit data behind [pixelsonly.racing](https://pixelsonly.racing/circuits) —
structured motorsport reference data, narrative, and visual assets for one circuit
per folder.

This repo is the single source for three consumers: the apex website's circuit
pages, the track-poster design workflow, and future content. Gather a track once,
correctly, and all three stay consistent.

It's public because the data is rendered publicly anyway, and an open, indexable,
citable dataset is worth more than a private one. It is maintained by a small team
— see [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to propose changes and the
quality bar we hold (every fact needs a source).

## Layout

One folder per circuit under `tracks/`:

```
tracks/laguna-seca/
├── laguna-seca.yaml   # structured record — the contract
├── laguna-seca.md     # long-form narrative
├── map.svg            # simplified single-line outline of the selected layout
├── flag.svg           # country flag
└── satellite.webp     # (optional) stylized imagery derivative

schema/circuit.schema.json   # JSON Schema the records validate against
scripts/validate.mjs         # the validator CI runs on every PR
docs/intake-checklist.md     # the run-once-per-track gathering sequence
```

### Why YAML records + a JSON Schema

Records are authored in YAML (readable, supports comments for inline source notes)
and validated against a JSON Schema in CI. The schema is the framework-agnostic
contract; YAML is just the friendlier way to write against it. Per-corner data and
layout variants are **first-class** in the schema, because the apex circuit pages
(the most demanding consumer) need them — and designing for that consumer serves
the simpler poster workflow automatically.

## Validation

```
npm install
npm run validate
```

CI runs the same check on every PR ([`.github/workflows/validate.yml`](.github/workflows/validate.yml)).
A record cannot reach `main` with a missing field, an unpaired unit, a broken
asset reference, a duplicate slug, or no source citation.

### Authoring helpers

- `npm run fetch-flag -- <slug>` — resolves the track's country flag from
  Wikimedia Commons (via Wikidata's P41 property on the country's ISO code),
  writes `tracks/<slug>/flag.svg`, optimizes it, and updates the
  [`LICENSE-ASSETS.md`](LICENSE-ASSETS.md) register row with the flag's actual
  license and attribution. The full per-track sequence is in
  [`docs/intake-checklist.md`](docs/intake-checklist.md).
- `npm run capture-frame -- <slug> --preview --plan-file` — derives the
  **satellite capture frame** for a track: a square centered on the circuit,
  sized so the track sits prominently with a safe no-clip margin. Size comes
  from the layout's `map.svg` outline + `length_km` (the track's true ground
  diameter); the center is refined from OpenStreetMap and sanity-checked against
  that diameter (falling back to the record's declared center when OSM can't
  place the circuit). `--preview` writes a georeferenced SVG to
  `previews/capture/<slug>.svg` to review **before** any satellite quota is
  spent; `--plan-file` writes the committed `tracks/<slug>/<slug>.capture.json`
  that [`dispatch-capture.yml`](.github/workflows/dispatch-capture.yml) reads to
  drive the private capture repo. `--all` does every track; `--json` prints the
  plan. Tuning lives in the `CONFIG` block of
  [`scripts/derive-capture-frame.mjs`](scripts/derive-capture-frame.mjs);
  per-track center/span overrides go in `scripts/capture-frame.overrides.json`.

## How consumers read it

This repo is published as the **`@pixelsonly/pixelsonly-racing-circuits`** package on **GitHub
Packages**. `npm run build` compiles the YAML records into the JSON the package
ships (`build/circuits.json` plus `build/data/<slug>/circuit.json` with narrative
inlined and assets copied alongside).

- **Apex site (Astro v6) via the Content Layer:** the recommended integration is a
  small **custom loader** the package exports, so the consumer writes one typed
  line:

  ```ts
  // src/content.config.ts (apex site)
  import { defineCollection } from "astro:content";
  import { circuitsLoader } from "@pixelsonly/pixelsonly-racing-circuits"; // bundled loader (to be finalized in the apex build)
  export const collections = {
    circuits: defineCollection({ loader: circuitsLoader() }),
  };
  ```

  The simpler, guaranteed-to-work fallback uses Astro's built-in `glob()` loader
  against the shipped JSON:

  ```ts
  import { defineCollection } from "astro:content";
  import { glob } from "astro/loaders";
  import { createRequire } from "node:module";
  const base = createRequire(import.meta.url)
    .resolve("@pixelsonly/pixelsonly-racing-circuits/package.json")
    .replace(/package\.json$/, "build/data");
  export const collections = {
    circuits: defineCollection({ loader: glob({ pattern: "*/circuit.json", base }) }),
  };
  ```

  > The custom `circuitsLoader()` is intentionally finalized in the apex build (it
  > needs verifying against the live Astro v6 loader interface). Start on the
  > `glob()` fallback if you want data flowing immediately.

- **Install (consumers authenticate to GitHub Packages):** add an `.npmrc` with
  `@pixelsonly:registry=https://npm.pkg.github.com/` and a token, then
  `npm i @pixelsonly/pixelsonly-racing-circuits`. Pin a version per the SemVer policy below.

- **Poster workflow:** reads the subset it needs (display name, locality,
  country/flag, selected-layout turns/length/elevation, map SVG, imagery
  derivative) — from the same package or directly from the repo.

## Versioning (SemVer)

Releases follow [Semantic Versioning](https://semver.org). The guiding principle:
**the schema is the API contract; the data is content.** A version bump answers
one question — *could this change break a consumer (the apex site) that was working
before?*

| Bump | Meaning | What triggers it | Examples |
|---|---|---|---|
| **MAJOR** (`1.0.0` → `2.0.0`) | Breaking change to the contract | Anything that can break an existing consumer | Removing or renaming a field; changing a field's type; making an existing **optional field required**; **removing a track** (its `/circuits/<slug>` route disappears); tightening validation so previously-valid data is now rejected |
| **MINOR** (`1.0.0` → `1.1.0`) | Backward-compatible addition | Additive **and** optional | Adding a **new track**; adding a **new optional** field/property to the schema; adding a new layout to an existing track |
| **PATCH** (`1.0.0` → `1.0.1`) | Backward-compatible fix | No shape change | Correcting a value (turns, length, lap time); fixing a typo in narrative; swapping an asset for a corrected one |

The one trap to remember: **adding a *required* field is MAJOR, not minor** — even
though it feels additive, it breaks consumers that assume the old shape. Additive
**and optional** is the test for minor.

### How the version is computed

Versions are derived from [Conventional Commit](https://www.conventionalcommits.org)
messages by **release-please**, so the changelog and bump are automatic:

| Commit prefix | Bump | Use for |
|---|---|---|
| `fix:` / `data:` | patch | value corrections, typos |
| `feat:` | minor | new track, new optional field |
| `feat!:` or a `BREAKING CHANGE:` footer | major | schema break, track/field removal, optional→required |

release-please accrues these into a **release PR**; merging that PR cuts the
tagged release, writes `CHANGELOG.md`, and publishes the package to GitHub Packages
([`.github/workflows/release.yml`](.github/workflows/release.yml)). Releases are
therefore deliberate (one per merged release PR), which is what SemVer needs.

## Licensing

Multi-licensed: data under **ODbL-1.0**, narrative under **CC-BY-SA-4.0**, assets
per-asset, code under MIT. See [`LICENSE.md`](LICENSE.md),
[`LICENSE-DATA.md`](LICENSE-DATA.md), [`LICENSE-CONTENT.md`](LICENSE-CONTENT.md),
and [`LICENSE-ASSETS.md`](LICENSE-ASSETS.md).

## Scope

In: structured per-track data, layout variants, per-corner records, lap records by
class, narrative, sim-racing context, and visual assets. Out (for now): real-time
data, user-generated content, anything not serving the poster line or track-guide
content.

> Satellite **capture** tooling is intentionally **not** here — it's operational IP
> in a separate private repo, and raw masters live in private storage. Only the
> finished stylized derivative is published into a track folder.
