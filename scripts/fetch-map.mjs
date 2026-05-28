#!/usr/bin/env node
/**
 * Pixelsonly Racing Circuits — track-map source fetcher.
 *
 * Phase A of the two-phase map workflow (see docs/intake-checklist.md step 5).
 * Downloads the raw Wikimedia Commons SVG for a circuit's selected layout into
 * a gitignored working file, and records its license in LICENSE-ASSETS.md so
 * the eventual hand-traced map.svg in the same folder has a documented
 * provenance chain.
 *
 * Why this is a separate script from fetch-flag despite the structural overlap:
 *   - Flags resolve from country_code via Wikidata P41 — fully automatic.
 *   - Track-layout SVGs have no clean structured property on Wikidata. Every
 *     track will name its own source file in the new-track issue, so this
 *     script takes that filename/URL as an explicit `--from` argument.
 *   - The downloaded file is a multi-element Commons SVG (color fills, pit
 *     lane, labels, etc.) — NOT the production map.svg. The contributor then
 *     opens it in Affinity (Phase B) to extract a single-path centerline at
 *     the normalized 0 0 1000 1000 viewBox the schema expects.
 *
 * Flow:
 *   1. Read tracks/<slug>/<slug>.yaml to confirm the slug is valid and to pull
 *      the track display name for log output.
 *   2. Normalize the `--from` argument into a "File:Name.svg" Commons title.
 *   3. Query Commons imageinfo for the canonical URL + license metadata.
 *   4. Download to tracks/<slug>/.map-source.svg (gitignored — see .gitignore).
 *   5. Update LICENSE-ASSETS.md "Track maps" register row for <slug>/map.svg
 *      with the source file's actual license + attribution.
 *
 * Usage:
 *   node scripts/fetch-map.mjs <slug> --from "File:Laguna Seca.svg"
 *   node scripts/fetch-map.mjs <slug> --from https://commons.wikimedia.org/wiki/File:Laguna_Seca.svg
 *   npm run fetch-map -- <slug> --from "<commons-title-or-url>"
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const trackDir = join(repoRoot, "tracks", slug);
const yamlPath = join(trackDir, `${slug}.yaml`);
const sourcePath = join(trackDir, ".map-source.svg");
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

const today = new Date().toISOString().slice(0, 10);
const noteParts = [];
if (artist) noteParts.push(`Artist: ${escapePipe(stripTrailingPunctuation(artist))}`);
noteParts.push(`Fetched ${today} from Wikimedia Commons`);
const newRow =
  `| \`${slug}/map.svg\` ` +
  `| [${escapePipe(filename)}](${filePageUrl}) ` +
  `| ${escapePipe(licenseShortName)} ` +
  `| ${noteParts.join(". ")}. |`;

await upsertRegisterRow(registerPath, slug, newRow);

console.log("\n✔ Map source fetched.");
console.log(
  "\nNext: open the .map-source.svg in Affinity Designer (Phase B in\n" +
    "docs/intake-checklist.md step 5). Trace a single closed centerline of\n" +
    "the selected layout onto a 1000×1000 canvas, export to\n" +
    `tracks/${slug}/map.svg with the repo's stroke conventions, then run\n` +
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
