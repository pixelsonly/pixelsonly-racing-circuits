#!/usr/bin/env node
/**
 * Pixelsonly Racing Circuits — track-map source fetcher.
 *
 * Phase A of the two-phase map workflow (see docs/intake-checklist.md step 5).
 * Downloads the raw Wikimedia Commons SVG for a circuit's selected layout,
 * commits it alongside the production map as map-source.svg, records its
 * license in LICENSE-ASSETS.md, AND mirrors the license/credit into the track
 * record's assets.map_attribution block so the apex site and downstream tools
 * never have to scrape provenance.
 *
 * Why this is a separate script from fetch-flag despite the structural overlap:
 *   - Flags resolve from country_code via Wikidata P41 — fully automatic.
 *   - Track-layout SVGs have no clean structured property on Wikidata. Every
 *     track will name its own source file in the new-track issue, so this
 *     script takes that filename/URL as an explicit `--from` argument.
 *   - The downloaded file is a multi-element Commons SVG (color fills, pit
 *     lane, labels, etc.) — NOT the production map.svg. The contributor then
 *     produces map.svg from it (Phase B: path-extract or Affinity trace) at
 *     the normalized 0 0 1000 1000 viewBox the schema expects.
 *
 * Flow:
 *   1. Read tracks/<slug>/<slug>.yaml to confirm the slug is valid and to pull
 *      the track display name for log output.
 *   2. Normalize the `--from` argument into a "File:Name.svg" Commons title.
 *   3. Query Commons imageinfo for the canonical URL + license metadata.
 *   4. Download to tracks/<slug>/map-source.svg (committed — the website may
 *      render this richer original).
 *   5. Write assets.map_source + assets.map_attribution into the track YAML
 *      (comment-preserving surgical edit), and upsert the LICENSE-ASSETS.md
 *      "Track maps" register row for <slug>/map.svg.
 *
 * Usage:
 *   node scripts/fetch-map.mjs <slug> --from "File:Laguna Seca.svg"
 *   node scripts/fetch-map.mjs <slug> --from https://commons.wikimedia.org/wiki/File:Laguna_Seca.svg
 *   npm run fetch-map -- <slug> --from "<commons-title-or-url>"
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import {
  USER_AGENT,
  commonsImageInfo,
  commonsFilePageUrl,
  normalizeCommonsTitle,
  readTrackRecord,
  stripHtml,
  stripTrailingPunctuation,
  escapePipe,
  escapeRegex,
} from "./lib/commons.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
if (!args.slug || !args.from) {
  console.error(
    'Usage: node scripts/fetch-map.mjs <slug> --from "<commons-title-or-url>"'
  );
  process.exit(1);
}

const { slug } = args;
const SOURCE_FILENAME = "map-source.svg";
const trackDir = join(repoRoot, "tracks", slug);
const yamlPath = join(trackDir, `${slug}.yaml`);
const sourcePath = join(trackDir, SOURCE_FILENAME);
const registerPath = join(repoRoot, "LICENSE-ASSETS.md");

const record = await readTrackRecord(yamlPath).catch((e) => fail(e.message));
const displayName = record?.display_name ?? record?.name ?? slug;
console.log(`Fetching map source for ${slug} (${displayName})…`);

const title = normalizeCommonsTitle(args.from);
console.log(`  Commons -> ${title}`);

const info = await commonsImageInfo(title).catch((e) => fail(e.message));
const svgUrl = info.url;
if (!svgUrl.toLowerCase().endsWith(".svg")) {
  fail(
    `Resolved source is not an SVG (${svgUrl}). ` +
      "Pick an SVG file from Commons — raster maps can't drive a clean Phase B trace."
  );
}
const meta = info.extmetadata ?? {};
const licenseShortName = stripHtml(meta.LicenseShortName?.value ?? "unknown");
const licenseUrl = meta.LicenseUrl?.value ?? "";
const artist = stripHtml(meta.Artist?.value ?? "");
const filePageUrl = commonsFilePageUrl(title);
const filename = title.replace(/^File:/, "");

console.log(`  Source:  ${svgUrl}`);
console.log(`  License: ${licenseShortName}${licenseUrl ? ` (${licenseUrl})` : ""}`);
if (artist) console.log(`  Artist:  ${artist}`);

const svgRes = await fetch(svgUrl, { headers: { "User-Agent": USER_AGENT } });
if (!svgRes.ok) fail(`Download failed: HTTP ${svgRes.status} from ${svgUrl}`);
const svgText = await svgRes.text();
await writeFile(sourcePath, svgText);
console.log(`  Wrote ${relative(sourcePath)} (${svgText.length.toLocaleString()} bytes)`);

// Optimize in place so the committed source is CI-clean immediately (the
// svg-optimize workflow fails on any unoptimized tracks/**/*.svg). SVGO is
// lossless for rendering and the repo config keeps viewBox/ids/comments —
// it strips only editor metadata + redundant precision. License + credit
// live in map_attribution + LICENSE-ASSETS.md, so dropping the embedded RDF
// metadata loses nothing.
const svgo = spawnSync(
  "npx",
  ["--yes", "svgo@^3", "--config", "svgo.config.mjs", sourcePath, "--quiet"],
  { cwd: repoRoot, stdio: "inherit" }
);
if (svgo.status !== 0) fail("SVGO optimization of the map source failed.");

const today = new Date().toISOString().slice(0, 10);
const cleanArtist = artist ? stripTrailingPunctuation(artist) : "";

// Ready-to-render credit (TASL order: Title, Author, Source, License).
const attributionText =
  `Track map derived from "${filename}"` +
  (cleanArtist ? ` by ${cleanArtist}` : "") +
  `, ${licenseShortName}, via Wikimedia Commons.`;

await writeMapAttribution(yamlPath, {
  source_title: filename,
  source_url: filePageUrl,
  license: licenseShortName,
  ...(licenseUrl ? { license_url: licenseUrl } : {}),
  ...(cleanArtist ? { artist: cleanArtist } : {}),
  attribution_text: attributionText,
  accessed: today,
});

const noteParts = [];
if (cleanArtist) noteParts.push(`Artist: ${escapePipe(cleanArtist)}`);
noteParts.push(`Source committed (SVGO-optimized) as \`${slug}/${SOURCE_FILENAME}\``);
noteParts.push(`Fetched ${today} from Wikimedia Commons`);
const newRow =
  `| \`${slug}/map.svg\` ` +
  `| [${escapePipe(filename)}](${filePageUrl}) ` +
  `| ${escapePipe(licenseShortName)} ` +
  `| ${noteParts.join(". ")}. |`;

await upsertRegisterRow(registerPath, slug, newRow);

console.log("\n✔ Map source fetched.");
console.log(
  `\nNext: produce tracks/${slug}/map.svg from ${SOURCE_FILENAME} (Phase B in\n` +
    "docs/intake-checklist.md step 5) — path-extract if the source has a clean\n" +
    "centerline path, else trace in Affinity. Target the normalized\n" +
    "0 0 1000 1000 viewBox and the repo's stroke conventions, then run\n" +
    "  npx svgo --config svgo.config.mjs -rf tracks\n" +
    "and  npm run validate."
);

const isShareAlike = /share[\s-]?alike|cc[\s-]?by[\s-]?sa/i.test(licenseShortName);
if (isShareAlike) {
  console.log(
    `\n⚠️  ${licenseShortName} is share-alike. ` +
      "Any traced derivative carries the same obligation — confirm the\n" +
      "LICENSE-ASSETS.md row reflects this and that downstream renderings\n" +
      "(poster + web) credit the source."
  );
}

// --- helpers ---

function parseArgs(argv) {
  const out = { slug: null, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") {
      out.from = argv[++i];
    } else if (a.startsWith("--from=")) {
      out.from = a.slice("--from=".length);
    } else if (!out.slug && !a.startsWith("-")) {
      out.slug = a;
    }
  }
  return out;
}

// Surgically set assets.map_source + assets.map_attribution in the track YAML
// without disturbing the file's existing comments/formatting. Idempotent:
// re-running overwrites the two keys in place.
async function writeMapAttribution(path, attribution) {
  const doc = parseDocument(await readFile(path, "utf8"));
  if (!doc.has("assets")) doc.set("assets", doc.createNode({}));
  doc.setIn(["assets", "map_source"], SOURCE_FILENAME);
  // Build the attribution as an explicit block-style map node.
  const node = doc.createNode(attribution);
  node.flow = false;
  doc.setIn(["assets", "map_attribution"], node);
  // Match the repo's YAML style so the edit is a minimal append rather than a
  // whole-file rewrite: non-indented block sequences, and no auto line-wrapping
  // of the existing long folded scalars (descriptions, taglines).
  await writeFile(path, doc.toString({ indentSeq: false, lineWidth: 0 }));
  console.log(`  Wrote assets.map_source + assets.map_attribution to ${relative(path)}`);
}

async function upsertRegisterRow(path, slug, newRow) {
  let register = await readFile(path, "utf8");
  const rowRegex = new RegExp(
    `^\\| \\\`${escapeRegex(slug)}/map\\.svg\\\`.*$`,
    "m"
  );
  if (rowRegex.test(register)) {
    register = register.replace(rowRegex, newRow);
    console.log(`  Updated LICENSE-ASSETS.md row for ${slug}/map.svg`);
  } else {
    // Insert under the "## Track maps" register table. The table header is
    // added by hand (one-time) when this script first runs; if it's missing
    // we fail loudly rather than guess where to put the row.
    const tableHeaderRegex =
      /## Track maps\n[\s\S]*?\| Track \/ map \| Source \| License \| Notes \|\n\|[^\n]*\|\n/;
    const match = register.match(tableHeaderRegex);
    if (!match) {
      fail(
        'LICENSE-ASSETS.md is missing the "## Track maps" register table. ' +
          "Add the section + table header once, then re-run."
      );
    }
    const insertAt = match.index + match[0].length;
    register = register.slice(0, insertAt) + newRow + "\n" + register.slice(insertAt);
    console.log(`  Appended LICENSE-ASSETS.md row for ${slug}/map.svg`);
  }
  await writeFile(path, register);
}

function relative(p) {
  return p.startsWith(repoRoot + "/") ? p.slice(repoRoot.length + 1) : p;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
