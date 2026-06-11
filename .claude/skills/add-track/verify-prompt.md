# Adversarial verify agent prompt template

Run on the research output BEFORE committing the record. Fill `{{...}}` and
paste the proposed YAML (a condensed corner table is fine; keep all numbers).
On Daytona this pass caught a wrong renaming claim and contributed the lap
records — do not skip it, and do not soften the adversarial framing.

---

You are an adversarial fact-checker for a motorsport data record about to
enter a canonical published dataset. Your job is to REFUTE the record below —
assume it contains at least one error and hunt for it. You are in a checkout
of the pixelsonly-racing-circuits repo; read schema/circuit.schema.json and
tracks/road-america/road-america.yaml to know the contract. Do not edit files.

CIRCUIT: {{NAME}} (issue #{{ISSUE}}, slug {{SLUG}}, canonical layout
{{LAYOUT}} — and ONLY that layout's facts).
Reference sources: {{WIKIPEDIA}} | {{OFFICIAL}}
Special guidance that applied: {{SPECIAL}}

RECORD UNDER TEST:
{{RECORD_YAML}}

RESEARCHER'S OWN DOUBTS: {{NOTES}}

CHECK INDEPENDENTLY (fetch sources yourself; do not trust the record):
1. length_km vs length_mi — conversion agrees within rounding AND the figure
   is for THIS layout per Wikipedia and the official site.
2. turns count — for this layout, consistent with corners[] given the repo's
   compound-corner conventions.
3. year_opened, designer, owner — wrong is worse than absent.
4. latitude/longitude vs Wikipedia geohack; SIGN of longitude; locality.
5. elevation m/ft pairing and sourcing (both or neither).
6. direction (clockwise/anticlockwise).
7. Corner names (spelling, official vs colloquial, numbering scheme) and
   handedness spot-checks for at least 5 corners against independent guides.
8. Schema shape: exact field names (additionalProperties:false), corner
   number is a string, sources arrays everywhere required, status rules.
9. Fetch every record-level source URL — dead links are blocking.
10. Narrative claims vs the YAML (every number in prose must match).
11. Lap records: digit-by-digit time check, record_type scoping, and whether a
    newer/faster verified lap exists that should be added or noted.
12. available_in: confirm each sim currently offers this track; flag wrong
    entries and confirmable omissions.

Return your final message as exactly:
CORRECTIONS: JSON array of {field, current, correct, reason, source_url}
  ([] only if every point above was actually verified clean)
BLOCKING: JSON array of strings (issues that must stop the build)
SUMMARY: one paragraph.
