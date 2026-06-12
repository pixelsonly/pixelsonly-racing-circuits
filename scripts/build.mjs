#!/usr/bin/env node
/**
 * Pixelsonly Racing Circuits — package build.
 *
 * Compiles the human-authored YAML records into the JSON artifacts the published
 * @pixelsonly/pixelsonly-racing-circuits package ships, so consumers (the apex site's Astro Content
 * Layer, the poster pipeline) never have to parse YAML themselves.
 *
 * Output (build/):
 *   build/circuits.json            — array of all records, narrative inlined.
 *   build/data/<slug>/circuit.json — one record per track, narrative inlined.
 *   build/data/<slug>/<assets>     — that track's SVGs / imagery, copied verbatim.
 *
 * Consumers can either import the whole array (package main -> build/circuits.json)
 * or point Astro's glob() loader at build/data (see README "How consumers read it").
 */

import {
  readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync,
  copyFileSync, statSync,
} from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tracksDir = join(repoRoot, "tracks");
const buildDir = join(repoRoot, "build");
const dataDir = join(buildDir, "data");

// Clean + recreate build/
if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const folders = readdirSync(tracksDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const all = [];

for (const slug of folders) {
  const folderPath = join(tracksDir, slug);
  const recordPath = join(folderPath, `${slug}.yaml`);
  if (!existsSync(recordPath)) {
    console.warn(`skip ${slug}: no ${slug}.yaml`);
    continue;
  }

  const record = parseYaml(readFileSync(recordPath, "utf8"));

  // Inline the narrative markdown so the package is self-contained.
  const narFile = record?.editorial?.narrative_md;
  if (narFile) {
    const narPath = join(folderPath, narFile);
    if (existsSync(narPath)) {
      record.editorial.narrative = readFileSync(narPath, "utf8");
    }
  }

  // Per-track output folder + assets.
  const outDir = join(dataDir, slug);
  mkdirSync(outDir, { recursive: true });

  for (const entry of readdirSync(folderPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === `${slug}.yaml`) continue;           // source record — not shipped
    if (name.startsWith("._") || name === ".DS_Store") continue;
    if (name.endsWith(".capture.json")) continue;    // private satellite-capture frame — not shipped

    // copy assets verbatim (svg, webp, md, etc.)
    copyFileSync(join(folderPath, name), join(outDir, name));
  }

  writeFileSync(join(outDir, "circuit.json"), JSON.stringify(record, null, 2) + "\n");
  all.push(record);
}

writeFileSync(join(buildDir, "circuits.json"), JSON.stringify(all, null, 2) + "\n");

console.log(`Built ${all.length} record(s) -> build/circuits.json + build/data/<slug>/circuit.json`);
