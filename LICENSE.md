# Licensing

This repository is multi-licensed because it holds three different kinds of work,
and one license does not fit all of them. The split was chosen deliberately
(share-alike, to keep derivatives open):

| Part of the repo | What it covers | License | SPDX |
|---|---|---|---|
| **Data** | The structured records: stats, turns, lengths, elevation, lap records, coordinates, per-corner data — everything in the `.yaml` files except narrative prose. | Open Database License v1.0 | `ODbL-1.0` — see [`LICENSE-DATA.md`](LICENSE-DATA.md) |
| **Narrative content** | Long-form prose: the `.md` narrative files and the prose `description` / `story` fields. | Creative Commons Attribution-ShareAlike 4.0 | `CC-BY-SA-4.0` — see [`LICENSE-CONTENT.md`](LICENSE-CONTENT.md) |
| **Visual assets** | SVG track maps, country flags, imagery derivatives. | Per asset — see [`LICENSE-ASSETS.md`](LICENSE-ASSETS.md) |
| **Code** | Validation scripts, workflows, schema tooling. | MIT — included below |

In plain terms: you are free to use, share, and adapt the data and narrative,
including commercially, **provided you attribute Pixelsonly Racing and keep any
adapted database / content under the same license** (share-alike). Visual assets
carry their own terms — country flags in particular keep the license of their
original source.

> ⚠️ **Before this repo goes public, paste the verbatim canonical license texts.**
> The files below currently carry the official summaries, SPDX identifiers, and
> source URLs, but GitHub's license detection and proper legal effect want the
> full canonical text. Copy it from:
> - ODbL 1.0 — https://opendatacommons.org/licenses/odbl/1-0/
> - CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/legalcode

---

## Code (MIT)

Copyright (c) 2026 Pixelsonly Racing

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
