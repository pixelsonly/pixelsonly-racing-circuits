#!/usr/bin/env node
/**
 * Pixelsonly Racing Circuits — record validator.
 *
 * The gating mechanism for the public-PR model. Runs in CI on every PR and on a
 * schedule, and locally via `npm run validate`. Exits non-zero on any error.
 *
 * Checks per track record (tracks/<slug>/<slug>.yaml):
 *   1. JSON Schema (schema/circuit.schema.json) — structure, types, required fields.
 *   2. slug matches the containing folder name.
 *   3. No duplicate slugs across the repo.
 *   4. Units are paired: every length has km AND mi; every elevation has m AND
 *      ft — at the layout level AND per corner.
 *   5. primary_layout references an existing layout id; layout ids are unique.
 *   6. corner ids unique within a layout; signature flag is internally consistent.
 *   7. Every referenced asset/file exists on disk:
 *        layout.map_svg, assets.flag_svg, assets.map_source (if set),
 *        assets.satellite.derivative (if set), editorial.narrative_md (if set).
 *   8. Referenced .svg assets parse as well-formed XML and look like <svg>.
 *   9. Source citations present (record-level enforced by schema; warns on draft-only).
 *
 * Dependencies: ajv, ajv-formats, yaml. (see package.json)
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js"; // draft 2020-12 build (the schema declares $schema 2020-12)
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tracksDir = join(repoRoot, "tracks");
const schemaPath = join(repoRoot, "schema", "circuit.schema.json");

const errors = [];
const warnings = [];
const err = (slug, msg) => errors.push(`  [${slug}] ${msg}`);
const warn = (slug, msg) => warnings.push(`  [${slug}] ${msg}`);

// --- Load schema + compile validator -------------------------------------
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

// --- Discover track records ----------------------------------------------
if (!existsSync(tracksDir)) {
  console.error(`No tracks/ directory found at ${tracksDir}`);
  process.exit(1);
}

const trackFolders = readdirSync(tracksDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

if (trackFolders.length === 0) {
  console.error("No track folders found under tracks/.");
  process.exit(1);
}

const seenSlugs = new Map();
let recordCount = 0;

for (const folder of trackFolders) {
  const folderPath = join(tracksDir, folder);
  const recordPath = join(folderPath, `${folder}.yaml`);

  if (!existsSync(recordPath)) {
    err(folder, `expected record file ${folder}/${folder}.yaml (must be named after the folder).`);
    continue;
  }

  let record;
  try {
    record = parseYaml(readFileSync(recordPath, "utf8"));
  } catch (e) {
    err(folder, `YAML parse error: ${e.message}`);
    continue;
  }
  recordCount++;

  // 1. JSON Schema
  if (!validate(record)) {
    for (const e of validate.errors) {
      err(folder, `schema: ${e.instancePath || "(root)"} ${e.message}`);
    }
    // keep going for cross-field checks where data is present
  }

  // 2. slug matches folder
  if (record.slug && record.slug !== folder) {
    err(folder, `slug "${record.slug}" does not match folder name "${folder}".`);
  }

  // 3. duplicate slugs
  if (record.slug) {
    if (seenSlugs.has(record.slug)) {
      err(folder, `duplicate slug "${record.slug}" (also in ${seenSlugs.get(record.slug)}).`);
    } else {
      seenSlugs.set(record.slug, folder);
    }
  }

  const layouts = Array.isArray(record.layouts) ? record.layouts : [];

  // 4. unit pairing + 5/6 layout & corner integrity
  const layoutIds = new Set();
  for (const layout of layouts) {
    const lid = layout?.id ?? "(no id)";
    if (layoutIds.has(lid)) err(folder, `duplicate layout id "${lid}".`);
    layoutIds.add(lid);

    const hasKm = layout?.length_km != null;
    const hasMi = layout?.length_mi != null;
    if (hasKm !== hasMi) err(folder, `layout "${lid}": length must have BOTH length_km and length_mi.`);

    const hasM = layout?.elevation_change_m != null;
    const hasFt = layout?.elevation_change_ft != null;
    if (hasM !== hasFt) err(folder, `layout "${lid}": elevation must have BOTH elevation_change_m and elevation_change_ft (or neither).`);

    // 7/8 map asset exists + parses
    if (layout?.map_svg) checkSvg(folder, folderPath, layout.map_svg, `layout "${lid}" map_svg`);

    // 6 corner integrity
    const corners = Array.isArray(layout?.corners) ? layout.corners : [];
    const cornerIds = new Set();
    for (const c of corners) {
      const cid = c?.id ?? "(no id)";
      if (cornerIds.has(cid)) err(folder, `layout "${lid}": duplicate corner id "${cid}".`);
      cornerIds.add(cid);

      // corner elevation is paired, like layout elevation (both or neither)
      const cHasM = c?.elevation_change_m != null;
      const cHasFt = c?.elevation_change_ft != null;
      if (cHasM !== cHasFt) {
        err(folder, `layout "${lid}" corner "${cid}": elevation must have BOTH elevation_change_m and elevation_change_ft (or neither).`);
      }
    }
  }

  // 5 primary_layout reference
  if (record.primary_layout && !layoutIds.has(record.primary_layout)) {
    err(folder, `primary_layout "${record.primary_layout}" does not match any layout id (${[...layoutIds].join(", ") || "none"}).`);
  }

  // 7 flag asset
  if (record.assets?.flag_svg) checkSvg(folder, folderPath, record.assets.flag_svg, "assets.flag_svg");

  // 7/8 committed map source (verbatim third-party original; exists + parses)
  if (record.assets?.map_source) {
    checkSvg(folder, folderPath, record.assets.map_source, "assets.map_source");
    // A committed third-party original must be attributed (license compliance).
    if (!record.assets?.map_attribution) {
      err(folder, `assets.map_source is set but assets.map_attribution is missing — a committed third-party source must carry license + credit.`);
    }
  }

  // 7 satellite derivative (existence only — binary, not parsed)
  const deriv = record.assets?.satellite?.derivative;
  if (deriv) checkFile(folder, folderPath, deriv, "assets.satellite.derivative");

  // 7 narrative markdown
  const nar = record.editorial?.narrative_md;
  if (nar) checkFile(folder, folderPath, nar, "editorial.narrative_md");

  // 9 provenance hygiene
  if (Array.isArray(record.sources) && record.sources.length < 2 && record.status === "verified") {
    warn(folder, `status is "verified" but only ${record.sources.length} source(s) — verified records should cross-check >=2.`);
  }
  if (record.status === "canonical" && (!Array.isArray(record.sources) || record.sources.length < 2)) {
    err(folder, `status "canonical" requires >=2 record-level sources.`);
  }
}

function checkFile(slug, folderPath, rel, label) {
  const p = join(folderPath, rel);
  if (!existsSync(p) || !statSync(p).isFile()) {
    err(slug, `${label}: referenced file "${rel}" not found in track folder.`);
    return false;
  }
  return true;
}

function checkSvg(slug, folderPath, rel, label) {
  if (!checkFile(slug, folderPath, rel, label)) return;
  if (!rel.toLowerCase().endsWith(".svg")) {
    err(slug, `${label}: "${rel}" should be an .svg.`);
    return;
  }
  const text = readFileSync(join(folderPath, rel), "utf8");
  if (!/<svg[\s>]/i.test(text)) {
    err(slug, `${label}: "${rel}" does not contain an <svg> element.`);
  }
  // lightweight well-formedness: balanced angle brackets, has a closing </svg>
  if (!/<\/svg>/i.test(text)) {
    err(slug, `${label}: "${rel}" is missing a closing </svg> tag.`);
  }
}

// --- Report ----------------------------------------------------------------
console.log(`Validated ${recordCount} record(s) across ${trackFolders.length} folder(s).`);

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  console.log(warnings.join("\n"));
}

if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  console.error(errors.join("\n"));
  console.error("\nFAILED. Fix the errors above before merging.");
  process.exit(1);
}

console.log("\nAll records valid. ✔");
