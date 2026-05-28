# Contributing

This repository is the data behind [pixelsonly.racing](https://pixelsonly.racing/circuits).
The same records feed printed posters and public circuit pages, so the quality
bar is deliberately higher than a typical open-source project: **a wrong value
here becomes a wrong value on an aluminum print and a public page.**

We accept external pull requests. We review them carefully, and we may be slow —
this is maintained by a very small team, so response times vary.

## Ground rules

1. **Every factual change needs a source.** Turn counts, lengths, elevation,
   lap records, opening years, corner facts — each must trace to an authoritative
   source recorded in the record's `sources` (or a corner / lap-record `sources`
   block). PRs without sources will be asked for them before review.
2. **Persist both units.** Every length carries `length_km` *and* `length_mi`;
   every elevation carries `elevation_change_m` *and* `elevation_change_ft`.
3. **Match the selected layout.** Turns, length, and elevation must correspond to
   the specific layout they sit under — not a different configuration of the same
   circuit. Multi-layout circuits get one `layouts[]` entry per configuration.
4. **Validation must pass.** `npm run validate` is the gate; CI runs it on every PR.

## Repository layout

Each circuit is one folder under `tracks/<slug>/`, containing everything for that
track:

```
tracks/laguna-seca/
├── laguna-seca.yaml   # the structured record (validates against schema/circuit.schema.json)
├── laguna-seca.md     # long-form narrative (CC-BY-SA)
├── map.svg            # simplified single-line outline of the selected layout
├── flag.svg           # country flag (carries its source license)
└── satellite.webp     # (optional) stylized imagery derivative
```

The structured fields and the JSON Schema contract are documented inline in
[`schema/circuit.schema.json`](schema/circuit.schema.json).

## Adding a new track

1. Create `tracks/<slug>/` (kebab-case slug; this becomes the URL and is permanent).
2. Copy the structure of an existing record (e.g. `tracks/laguna-seca/`) and fill
   in the fields. Keep `slug` equal to the folder name.
3. Determine the layout. If a circuit has multiple configurations, use the Grand
   Prix or IMSA layout — but **if it is ambiguous which to use, open an issue and
   ask first.** Do not guess: the layout choice drives turns, length, elevation,
   and the map.
4. Add the SVG assets (map of the selected layout, country flag). Record any
   flag's license in `LICENSE-ASSETS.md`.
5. Run `npm install` then `npm run validate` until it passes.
6. Open a PR using the template and list your sources.

## Commit messages (Conventional Commits)

Versioning and the changelog are automated from commit messages, so the prefix you
use determines the release. Follow [Conventional Commits](https://www.conventionalcommits.org):

| Prefix | Release bump | Use for |
|---|---|---|
| `fix:` or `data:` | patch | correcting a value, fixing a typo |
| `feat:` | minor | adding a new track or a new **optional** field |
| `feat!:` (or any type with `!`, or a `BREAKING CHANGE:` footer) | major | removing/renaming/retyping a field, removing a track, making an optional field required |

Examples:

```
feat: add Mugello (mugello)
fix: correct Laguna Seca elevation to 55 m / 180 ft
feat!: remove deprecated `region` field from all records
```

See the README's **Versioning** section for the full major/minor/patch policy.

## Licensing of contributions

By contributing you agree your contribution is licensed under this repository's
terms (data under ODbL-1.0, narrative under CC-BY-SA-4.0 — see
[`LICENSE.md`](LICENSE.md)). Only contribute assets you have the right to license
this way; flags and any third-party geometry must be license-cleared and recorded
in [`LICENSE-ASSETS.md`](LICENSE-ASSETS.md).

## Local setup

```
npm install
npm run validate
```

Node 20+ required.
