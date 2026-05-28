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
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const USER_AGENT =
  "pixelsonly-racing-circuits/0.1.0 (https://github.com/pixelsonly/pixelsonly-racing-circuits)";
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

const slug = process.argv[2];
if (!slug) {
  console.error("Usage: node scripts/fetch-flag.mjs <track-slug>");
  process.exit(1);
}

const trackDir = join(repoRoot, "tracks", slug);
const yamlPath = join(trackDir, `${slug}.yaml`);
const flagPath = join(trackDir, "flag.svg");
const registerPath = join(repoRoot, "LICENSE-ASSETS.md");

const record = parseYaml(await readFileText(yamlPath));
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
const info = await commonsImageInfo(title);
const svgUrl = info.url;
const meta = info.extmetadata ?? {};
const licenseShortName = stripHtml(meta.LicenseShortName?.value ?? "unknown");
const licenseUrl = meta.LicenseUrl?.value ?? "";
const artist = stripHtml(meta.Artist?.value ?? "");
const filePageUrl = `https://commons.wikimedia.org/wiki/${encodeURI(title.replace(/ /g, "_"))}`;

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

let register = await readFileText(registerPath);
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

async function commonsImageInfo(title) {
  const url = new URL(COMMONS_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata");
  url.searchParams.set("titles", title);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("redirects", "1");
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) fail(`Commons API failed: HTTP ${res.status}`);
  const json = await res.json();
  const page = json?.query?.pages?.[0];
  if (!page || page.missing || !page.imageinfo?.[0]) {
    fail(`Commons did not return imageinfo for ${title}.`);
  }
  return page.imageinfo[0];
}

async function readFileText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    fail(`Cannot read ${path}: ${e.message}`);
  }
}

function stripHtml(html) {
  return String(html).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function stripTrailingPunctuation(s) {
  return String(s).replace(/[.\s]+$/, "");
}

function escapePipe(s) {
  return String(s).replace(/\|/g, "\\|");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relative(p) {
  return p.startsWith(repoRoot + "/") ? p.slice(repoRoot.length + 1) : p;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
