#!/usr/bin/env node
/**
 * Pixelsonly Racing Circuits — country flag fetcher.
 *
 * Resolves a track's country flag from Wikimedia Commons via Wikidata, writes
 * it into the track folder as `flag.svg`, optimizes it, and updates the
 * `LICENSE-ASSETS.md` register with the flag's actual license + attribution.
 *
 * The schema requires every record to carry a flag asset and the license
 * register to list every committed flag's license — this script automates both
 * sides of that contract so a contributor never ships a placeholder or
 * undocumented-license flag.
 *
 * Flow:
 *   1. Read tracks/<slug>/<slug>.yaml, extract country_code (ISO 3166-1 alpha-2).
 *   2. SPARQL Wikidata: country_code -> the country's "flag image" (P41) on Commons.
 *      Using the structured property avoids brittle "Flag of <country>" filename
 *      guessing (the noun varies: "the United States", "South Korea", etc.).
 *   3. Query the Commons MediaWiki API for that file's canonical URL + license
 *      metadata (LicenseShortName, Artist, LicenseUrl).
 *   4. Download the SVG to tracks/<slug>/flag.svg and run SVGO (via npx, using
 *      the repo's svgo.config.mjs).
 *   5. Update LICENSE-ASSETS.md: replace any existing row for this track's flag,
 *      or append a new row to the register.
 *
 * Usage:
 *   node scripts/fetch-flag.mjs <track-slug>
 *   npm run fetch-flag -- <track-slug>
 *
 * Dependencies: yaml (already in devDependencies). No new runtime deps; SVGO is
 * invoked via the same `npx svgo` pattern used in the svg-optimize workflow.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  USER_AGENT,
  commonsImageInfo,
  commonsFilePageUrl,
  readTrackRecord,
  stripHtml,
  stripTrailingPunctuation,
  escapePipe,
  escapeRegex,
} from "./lib/commons.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

const slug = process.argv[2];
if (!slug) {
  console.error("Usage: node scripts/fetch-flag.mjs <track-slug>");
  process.exit(1);
}

const trackDir = join(repoRoot, "tracks", slug);
const yamlPath = join(trackDir, `${slug}.yaml`);
const flagPath = join(trackDir, "flag.svg");
const registerPath = join(repoRoot, "LICENSE-ASSETS.md");

const record = await readTrackRecord(yamlPath).catch((e) => fail(e.message));
const code = record?.country_code;
if (!code || !/^[A-Z]{2}$/.test(code)) {
  fail(`Missing or invalid country_code in ${yamlPath} (got: ${code ?? "(none)"})`);
}
const countryName = record?.country_name ?? code;

console.log(`Fetching flag for ${slug} (${code} — ${countryName})…`);

// 1. Wikidata: ISO alpha-2 -> Commons flag filename via P41 (flag image).
const flagFileUrl = await sparqlFlag(code);
const filename = decodeURIComponent(flagFileUrl.split("/").pop());
if (!filename.toLowerCase().endsWith(".svg")) {
  fail(
    `Wikidata returned a non-SVG flag for ${code} (${filename}). ` +
      `This script only handles SVG flags — download and license-record manually.`
  );
}
const title = `File:${filename}`;
console.log(`  Wikidata -> ${title}`);

// 2. Commons API: imageinfo for canonical URL + license metadata.
const info = await commonsImageInfo(title).catch((e) => fail(e.message));
const svgUrl = info.url;
const meta = info.extmetadata ?? {};
const licenseShortName = stripHtml(meta.LicenseShortName?.value ?? "unknown");
const licenseUrl = meta.LicenseUrl?.value ?? "";
const artist = stripHtml(meta.Artist?.value ?? "");
const filePageUrl = commonsFilePageUrl(title);

console.log(`  Source:  ${svgUrl}`);
console.log(`  License: ${licenseShortName}${licenseUrl ? ` (${licenseUrl})` : ""}`);
if (artist) console.log(`  Artist:  ${artist}`);

// 3. Download.
const svgRes = await fetch(svgUrl, { headers: { "User-Agent": USER_AGENT } });
if (!svgRes.ok) fail(`Download failed: HTTP ${svgRes.status} from ${svgUrl}`);
const svgText = await svgRes.text();
await writeFile(flagPath, svgText);
console.log(`  Wrote ${relative(flagPath)} (${svgText.length.toLocaleString()} bytes)`);

// 4. Optimize via SVGO.
const svgo = spawnSync(
  "npx",
  ["--yes", "svgo@^3", "--config", "svgo.config.mjs", flagPath, "--quiet"],
  { cwd: repoRoot, stdio: "inherit" }
);
if (svgo.status !== 0) fail("SVGO optimization failed.");

// 4b. Guarantee a viewBox. SVGO's removeViewBox:false only prevents removal —
// it won't synthesize one when the source SVG sizes itself with width/height
// alone. Without a viewBox, a consumer that CSS-scales the inline SVG (the apex
// site sizes flags by height) draws the content 1:1 and shows a top-left crop.
// Derive viewBox="0 0 <width> <height>" from the width/height attributes.
await ensureViewBox(flagPath);

// 5. Update LICENSE-ASSETS.md register.
const today = new Date().toISOString().slice(0, 10);
const noteParts = [];
if (artist) noteParts.push(`Artist: ${escapePipe(stripTrailingPunctuation(artist))}`);
noteParts.push(`Fetched ${today} from Wikimedia Commons via Wikidata P41`);
const newRow =
  `| \`${slug}/flag.svg\` ` +
  `| [${escapePipe(filename)}](${filePageUrl}) ` +
  `| ${escapePipe(licenseShortName)} ` +
  `| ${noteParts.join(". ")}. |`;

let register = await readFile(registerPath, "utf8");
const rowRegex = new RegExp(
  `^\\| \\\`${escapeRegex(slug)}/flag\\.svg\\\`.*$`,
  "m"
);
if (rowRegex.test(register)) {
  register = register.replace(rowRegex, newRow);
  console.log(`  Updated LICENSE-ASSETS.md row for ${slug}/flag.svg`);
} else {
  register = register.trimEnd() + "\n" + newRow + "\n";
  console.log(`  Appended LICENSE-ASSETS.md row for ${slug}/flag.svg`);
}
await writeFile(registerPath, register);

// Summary + non-PD safety nudge.
console.log("\n✔ Flag fetch complete.");
const isPublicDomain = /public domain|^pd\b|cc0/i.test(licenseShortName);
if (!isPublicDomain) {
  console.log(
    `\n⚠️  ${licenseShortName} is NOT public domain. ` +
      `Confirm the LICENSE-ASSETS.md row carries the right attribution and that the ` +
      `poster + web rendering credits the source. Many CC-BY-SA flags also require ` +
      `share-alike on derivative renderings.`
  );
}

// --- helpers ---

async function sparqlFlag(isoAlpha2) {
  const query = `
    SELECT ?flag WHERE {
      ?country wdt:P297 "${isoAlpha2}".
      ?country wdt:P41 ?flag.
    } LIMIT 1
  `;
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
  });
  if (!res.ok) fail(`Wikidata SPARQL failed: HTTP ${res.status}`);
  const json = await res.json();
  const flagValue = json?.results?.bindings?.[0]?.flag?.value;
  if (!flagValue) {
    fail(
      `No P41 (flag image) found on Wikidata for ISO 3166-1 alpha-2 "${isoAlpha2}". ` +
        `Verify the country_code is correct, or source the flag manually.`
    );
  }
  return flagValue;
}

/**
 * Ensure the SVG at `path` carries a viewBox on its root <svg> element. If one
 * is already present, leave the file untouched. Otherwise derive it from the
 * width/height attributes (viewBox="0 0 <width> <height>"). Bare numeric and
 * px-suffixed dimensions are supported; if either dimension is missing or
 * non-numeric (e.g. a percentage), we warn and leave the file as-is rather than
 * write a broken viewBox.
 */
async function ensureViewBox(path) {
  const svg = await readFile(path, "utf8");
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!openTag) {
    console.warn("  ⚠️  Could not find an <svg> tag to check for a viewBox.");
    return;
  }
  if (/\bviewBox\s*=/i.test(openTag)) return;

  const dim = (name) => {
    const raw = openTag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
    const num = raw && Number.parseFloat(raw.replace(/px$/i, "").trim());
    return Number.isFinite(num) && num > 0 ? num : null;
  };
  const width = dim("width");
  const height = dim("height");
  if (!width || !height) {
    console.warn(
      `  ⚠️  ${relative(path)} has no viewBox and no usable width/height to derive one. ` +
        `Add a viewBox manually so consumers can scale it.`
    );
    return;
  }

  const viewBox = `viewBox="0 0 ${width} ${height}"`;
  const patched = svg.replace(openTag, openTag.replace(/<svg\b/i, `<svg ${viewBox}`));
  await writeFile(path, patched);
  console.log(`  Added ${viewBox} to ${relative(path)} (derived from width/height)`);
}

function relative(p) {
  return p.startsWith(repoRoot + "/") ? p.slice(repoRoot.length + 1) : p;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
