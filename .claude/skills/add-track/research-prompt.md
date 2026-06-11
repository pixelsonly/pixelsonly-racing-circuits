# Research agent prompt template

Fill every `{{...}}` placeholder from the GitHub issue, then launch a
general-purpose agent with web access. `{{SPECIAL}}` carries per-track guidance
(layout decisions, source substitutions, known traps).

---

You are compiling the canonical data record for a new circuit in the
pixelsonly-racing-circuits repo (you are in a checkout of it; read files
freely, but WRITE NOTHING — your deliverable is text output only).

CIRCUIT (from GitHub issue #{{ISSUE}}):
- Name: {{NAME}}
- Slug (permanent, binding): {{SLUG}}
- Country: {{COUNTRY}} ({{CC}})
- Canonical layout: {{LAYOUT}}
- Commons map source named in the issue: {{COMMONS}}
- Wikipedia: {{WIKIPEDIA}}
- Official site: {{OFFICIAL}}
- Special guidance: {{SPECIAL}}

REPO CONVENTIONS (read these files first — they are authoritative):
- AGENTS.md and CLAUDE.md (repo root); docs/intake-checklist.md;
  schema/circuit.schema.json (additionalProperties:false everywhere — field
  names must be exact).
- tracks/road-america/road-america.yaml and .md — the gold-standard exemplar.
  Match its structure, comment style, field ordering, and formatting EXACTLY
  (non-indented block sequences, folded ">-" descriptions, header comment).

HARD RULES:
- Every fact traceable to a source; >=3 record-level sources (Wikipedia +
  official site + one more, e.g. RacingCircuits.info), each with
  accessed: {{TODAY}}.
- BOTH metric and imperial for every length/elevation pair, at layout AND
  corner level (or omit both members of a pair). Omit elevation if unsourced.
- Corner scope Tier 1 + sourced Tier 2 ONLY: id, number, name, direction,
  factual description, sources, plus apex_type / signed elevation ONLY where a
  source backs it. EXCLUDE coaching and landmark entirely. Unnamed corners are
  "Turn N"; named corners get their proper name. Flag signature corner(s) with
  signature: true + a story block.
- One corner entry per numbered turn up to ~20 turns (compound "X-Y" entries
  where sources treat a complex as one corner); above ~20, cover the lap with
  the famous named corners (Spa/Nürburgring precedent).
- lap_records: [] unless you have an exact, source-verified time matching
  m:ss.mmm.
- status: verified. editorial.available_in: ONLY sims you can confirm.
- commerce.card_url: https://pixelsonly.racing/circuits/{{SLUG}} with the
  exemplar's trailing comment.
- assets.satellite: source_key tracks/{{SLUG}}/{{SLUG}}.tiff and attribution
  "Contains modified Copernicus Sentinel data 2026" (mirrors the exemplar).
- Narrative .md: ~25-35 lines, structured like road-america.md; author notes
  as HTML comments (never blockquotes) top and bottom.
- DO NOT include corner position fields, and DO NOT include
  assets.map_source / map_attribution (scripts write those).

RESEARCH METHOD (proven on prior tracks):
- Start from Wikipedia (coordinates via geohack — watch the longitude sign;
  year opened, designer, owner, layout history, length, turns, direction,
  corner names). Cross-check layout facts against the official site.
- Per-corner data: one broad WebSearch like "{{NAME}} turn by turn guide each
  corner left right Turn 1" returns a synthesized per-turn breakdown across
  guides. diysimstudio.com gives explicit per-turn handedness when it exists;
  racingcircuits.info for layout history. AVOID fetching nasaspeed.news (403)
  and trackpedia.racetrackdriving.com (TLS error).
- Handedness needs two independent statements; list every corner you are NOT
  sure of in your notes — the build stage re-checks handedness against map
  geometry and GEOMETRY WINS.

DELIVERABLE — your final message must contain exactly three sections:
1. A fenced yaml block: the COMPLETE proposed tracks/{{SLUG}}/{{SLUG}}.yaml.
2. A fenced markdown block: the COMPLETE proposed tracks/{{SLUG}}/{{SLUG}}.md.
3. "NOTES:" — layout decisions, uncertain handedness, ambiguities, confirmed
   sims, sources used per corner.
Your final message is consumed by a machine pipeline — return exactly those
three sections, no extra preamble.
