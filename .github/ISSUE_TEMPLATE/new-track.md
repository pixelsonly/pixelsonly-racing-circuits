---
name: New track proposal
about: Propose a circuit to add to the database
title: "[track] <circuit name>"
labels: new-track
---

**Circuit name:**

**Proposed slug:** <!-- kebab-case, becomes the permanent URL key -->

**Country:**

**Which layout should be canonical?** <!-- GP / IMSA / etc. — flag if ambiguous -->

**Wikimedia Commons track-map SVG:**
<!-- The Commons "File:" page (or its URL) for the layout's outline SVG. This
     feeds `npm run fetch-map -- <slug> --from "<this>"` directly. Pick an SVG of
     the SELECTED layout specifically — many circuits have per-era variants
     (e.g. Spa pre/post-2007, the Nürburgring GP circuit vs the Nordschleife).
     Public-domain is preferred; CC-BY-SA is fine but obligates share-alike on
     the derived map. -->

**Wikipedia article:**
<!-- URL of the circuit's Wikipedia page. Anchors the narrative and is a handy
     cross-reference for turns, length, elevation, and layout history. -->

**Do you intend to open a PR, or is this a request?**

**Other sources you'd build it from:**
<!-- The more authoritative, the better: official circuit site, FIA/IMSA,
     RacingCircuits.info, etc. -->

---

- [ ] The Wikimedia Commons SVG above is the **selected/canonical layout**, not a different configuration of the same circuit.
