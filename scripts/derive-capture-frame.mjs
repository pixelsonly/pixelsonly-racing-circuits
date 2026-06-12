#!/usr/bin/env node
/**
 * Pixelsonly Racing Circuits — satellite capture-frame deriver.
 *
 * Computes, per track, the geographic FRAME the private satellite-capture tool
 * (pixelsonly-racing-track-captures) should shoot: a square centered on the
 * circuit, sized so the track sits prominently with a safe no-clip margin. It
 * replaces the old blind constants (a hardcoded 80 km master span and a
 * 0.6x web crop) with numbers derived from data this repo already owns.
 *
 * Two independent signals, each used for what it's good at:
 *   SIZE  — from the layout's map.svg outline + length_km. The outline gives the
 *           track's true SHAPE/aspect; length_km gives its real scale. Together
 *           they yield the track's ground diameter in km. Robust for every track
 *           (street circuits, multi-facility complexes, the Nordschleife), needs
 *           no network, and is the SOLE source of zoom.
 *   CENTER — refined from OpenStreetMap. The map.svg is normalized (0 0 1000
 *           1000) and NOT georeferenced, so it can't place the track on the
 *           globe. OSM's `highway=raceway` geometry (filtered to motor circuits,
 *           windowed to the right facility, and sanity-checked against the SVG
 *           diameter) gives the true centroid — and corrects records whose
 *           declared latitude/longitude is off (e.g. the Nordschleife was 2.1 km
 *           out). When OSM is missing/ambiguous (street circuits, public-road
 *           layouts) it falls back to the record's declared center.
 *
 * The frame is fully previewable offline (`--preview` writes an SVG per track),
 * so framing is reviewed BEFORE any Copernicus quota is spent.
 *
 * Tuning constants (margin, master headroom, output sizes, OSM gate) live in the
 * CONFIG block below — this file is their source of truth; the capture workflow
 * and dispatcher consume the emitted plan, they don't re-derive it.
 *
 * Usage:
 *   node scripts/derive-capture-frame.mjs <slug> [--json] [--preview]
 *   node scripts/derive-capture-frame.mjs --all --preview        # all tracks + previews
 *   node scripts/derive-capture-frame.mjs spa --json             # machine-readable plan
 *   node scripts/derive-capture-frame.mjs le-mans --no-osm       # SVG sizing + YAML center only
 *   npm run capture-frame -- --all --preview
 *
 * Flags:
 *   --all            process every track under tracks/
 *   --json           print the resolved plan(s) as JSON to stdout
 *   --preview        write previews/capture/<slug>.svg (georeferenced, no quota)
 *   --plan-file      write tracks/<slug>/<slug>.capture.json (committed plan)
 *   --no-osm         skip OSM; use the declared center (offline, sizing only)
 *   --refresh        ignore the OSM cache and refetch
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT, readTrackRecord } from "./lib/commons.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ─────────────────────────────────────────────────────────────── CONFIG
// Source of truth for the framing math. Change these here, re-run --preview to
// review, then re-dispatch. Downstream tools consume the emitted plan only.
const CONFIG = {
  marginFraction: 0.18, // web crop: extra breathing room beyond the track radius, each side
  masterMultiple: 3.0, // master extent = diameter x this (stylization headroom)…
  masterFloorKm: 4.0, // …but never tighter than this (keeps small tracks workable)
  webSize: 2500, // web JPG output: 2500 x 2500 px
  masterSize: 6000, // master output: 6000 x 6000 px
  osm: {
    fetchRadiusM: 6000, // Overpass `around:` radius from the declared center
    windowFactor: 0.75, // keep raceway points within this x diameter of the declared center
    windowFloorKm: 0.6, // …but at least this radius (tiny circuits)
    gateLo: 0.5, // accept OSM center only if its extent is within
    gateHi: 1.4, //   [gateLo, gateHi] x the SVG-derived diameter
    minPoints: 20, // …and it has at least this many points in the window
    endpoints: [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ],
    timeoutMs: 90000,
  },
};

const EARTH_KM_PER_DEG = 111.32; // mean degrees->km; local flat-earth is fine at circuit scale
const cacheDir = join(repoRoot, ".cache", "osm");
const previewDir = join(repoRoot, "previews", "capture");
const overridesPath = join(__dirname, "capture-frame.overrides.json");

// ─────────────────────────────────────────────────────────────── CLI
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const slugs = argv.filter((a) => !a.startsWith("--"));
const opt = {
  all: flags.has("--all"),
  json: flags.has("--json"),
  preview: flags.has("--preview"),
  planFile: flags.has("--plan-file"),
  noOsm: flags.has("--no-osm"),
  refresh: flags.has("--refresh"),
};
if (!opt.all && slugs.length === 0) {
  console.error(
    "Usage: node scripts/derive-capture-frame.mjs <slug> [--json] [--preview] | --all"
  );
  process.exit(1);
}

// ─────────────────────────────────────────────────────────── SVG geometry
// Flatten a single-line outline path to a polyline (viewBox units). Handles the
// command set our production map.svg + path-extracted sources emit (M/L/H/V/C/S/
// Q/T/A/Z, abs+rel). Arcs are rare and approximated by their chord endpoint.
function flattenPath(d, step = 4.0) {
  const toks = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) toks.push(m[1] ?? parseFloat(m[2]));
  let i = 0,
    cmd = null,
    cur = [0, 0],
    start = [0, 0],
    prevC = null;
  const pts = [];
  const num = () => toks[i++];
  const bez = (p0, p1, p2, p3) => {
    const n = Math.max(2, Math.floor(Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / step) + 2);
    for (let k = 1; k <= n; k++) {
      const u = k / n,
        v = 1 - u;
      pts.push([
        v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0],
        v * v * v * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * p3[1],
      ]);
    }
  };
  while (i < toks.length) {
    if (typeof toks[i] === "string") cmd = toks[i++];
    const c = cmd;
    if (c === "Z" || c === "z") {
      cur = start.slice();
      prevC = null;
      continue;
    }
    if (c === "M" || c === "m") {
      let x = num(),
        y = num();
      if (c === "m") (x += cur[0]), (y += cur[1]);
      cur = [x, y];
      start = cur.slice();
      pts.push(cur.slice());
      cmd = c === "m" ? "l" : "L";
      prevC = null;
      continue;
    }
    if (c === "L" || c === "l") {
      let x = num(),
        y = num();
      if (c === "l") (x += cur[0]), (y += cur[1]);
      cur = [x, y];
      pts.push(cur.slice());
      prevC = null;
      continue;
    }
    if (c === "H" || c === "h") {
      let x = num();
      if (c === "h") x += cur[0];
      cur = [x, cur[1]];
      pts.push(cur.slice());
      prevC = null;
      continue;
    }
    if (c === "V" || c === "v") {
      let y = num();
      if (c === "v") y += cur[1];
      cur = [cur[0], y];
      pts.push(cur.slice());
      prevC = null;
      continue;
    }
    if (c === "C" || c === "c") {
      const v = [num(), num(), num(), num(), num(), num()];
      if (c === "c") for (let k = 0; k < 6; k++) v[k] += cur[k % 2];
      bez(cur, [v[0], v[1]], [v[2], v[3]], [v[4], v[5]]);
      prevC = [v[2], v[3]];
      cur = [v[4], v[5]];
      continue;
    }
    if (c === "S" || c === "s") {
      const v = [num(), num(), num(), num()];
      if (c === "s") for (let k = 0; k < 4; k++) v[k] += cur[k % 2];
      const p1 = prevC ? [2 * cur[0] - prevC[0], 2 * cur[1] - prevC[1]] : cur;
      bez(cur, p1, [v[0], v[1]], [v[2], v[3]]);
      prevC = [v[0], v[1]];
      cur = [v[2], v[3]];
      continue;
    }
    if (c === "Q" || c === "q" || c === "T" || c === "t") {
      const n = c === "Q" || c === "q" ? 4 : 2;
      const v = [];
      for (let k = 0; k < n; k++) v.push(num());
      if (c === c.toLowerCase()) for (let k = 0; k < n; k++) v[k] += cur[k % 2];
      cur = [v[n - 2], v[n - 1]];
      pts.push(cur.slice());
      prevC = null;
      continue;
    }
    if (c === "A" || c === "a") {
      const v = [];
      for (let k = 0; k < 7; k++) v.push(num());
      let x = v[5],
        y = v[6];
      if (c === "a") (x += cur[0]), (y += cur[1]);
      cur = [x, y];
      pts.push(cur.slice());
      prevC = null;
      continue;
    }
    fail(`Unsupported path command "${c}" in outline`);
  }
  return pts;
}

function firstPathD(svg) {
  const m = svg.match(/<path\b[^>]*\bd="([^"]+)"/);
  return m ? m[1] : null;
}

function extent(pts) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

// SVG outline -> { diameterKm, kmPerUnit, bbox } using length_km as the scale.
function svgMetrics(svgText, lengthKm) {
  const d = firstPathD(svgText);
  if (!d) fail("No <path> in map.svg");
  const pts = flattenPath(d);
  let unitLen = 0;
  for (let k = 0; k < pts.length - 1; k++)
    unitLen += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
  const bb = extent(pts);
  let rUnits = 0;
  for (const p of pts) rUnits = Math.max(rUnits, Math.hypot(p[0] - bb.cx, p[1] - bb.cy));
  const kmPerUnit = lengthKm / unitLen;
  return { diameterKm: 2 * rUnits * kmPerUnit, kmPerUnit, bbox: bb, points: pts };
}

// ─────────────────────────────────────────────────────────────── geo helpers
// Local east/north offset in km of point p=[lat,lon] from (lat0,lon0).
function toKm(p, lat0, lon0, latRef) {
  return [
    (p[1] - lon0) * EARTH_KM_PER_DEG * Math.cos((latRef * Math.PI) / 180),
    (p[0] - lat0) * EARTH_KM_PER_DEG,
  ];
}
function bboxCenterDiam(pts, latRef) {
  let la0 = Infinity,
    la1 = -Infinity,
    lo0 = Infinity,
    lo1 = -Infinity;
  for (const [la, lo] of pts) {
    if (la < la0) la0 = la;
    if (la > la1) la1 = la;
    if (lo < lo0) lo0 = lo;
    if (lo > lo1) lo1 = lo;
  }
  const clat = (la0 + la1) / 2,
    clon = (lo0 + lo1) / 2;
  let r = 0;
  for (const p of pts) {
    const [e, n] = toKm(p, clat, clon, latRef);
    r = Math.max(r, Math.hypot(e, n));
  }
  return { clat, clon, diameterKm: 2 * r };
}

// ─────────────────────────────────────────────────────────────── OSM
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function overpassQuery(lat, lon, r) {
  return (
    `[out:json][timeout:60];(` +
    `way["highway"="raceway"](around:${r},${lat},${lon});` +
    `relation["highway"="raceway"](around:${r},${lat},${lon});` +
    `);out geom;`
  );
}

async function fetchOsm(slug, lat, lon) {
  const cacheFile = join(cacheDir, `${slug}.json`);
  if (!opt.refresh && existsSync(cacheFile)) {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  }
  const body = new URLSearchParams({ data: overpassQuery(lat, lon, CONFIG.osm.fetchRadiusM) });
  let lastErr;
  for (const ep of CONFIG.osm.endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), CONFIG.osm.timeoutMs);
      try {
        const res = await fetch(ep, {
          method: "POST",
          headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cacheFile, JSON.stringify(json));
        return json;
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
        await sleep(2000);
      }
    }
  }
  throw lastErr;
}

// Raceway geometry as polylines, keeping only motor circuits (drops the adjacent
// karting/motocross/bmx facilities that otherwise inflate complexes like Le Mans).
function racewayWays(osm) {
  const isMotor = (t) => {
    const s = t?.sport ?? "";
    return s === "" || s.startsWith("motor");
  };
  const ways = [];
  for (const el of osm.elements ?? []) {
    if (el.type === "way" && el.geometry && el.tags?.highway === "raceway" && isMotor(el.tags)) {
      ways.push(el.geometry.map((g) => [g.lat, g.lon]));
    }
    if (el.type === "relation" && el.tags?.highway === "raceway" && isMotor(el.tags)) {
      for (const mem of el.members ?? [])
        if (mem.geometry) ways.push(mem.geometry.map((g) => [g.lat, g.lon]));
    }
  }
  return ways;
}

// Decide the capture center. override > OSM (gated) > declared YAML center.
async function resolveCenter(slug, lat, lon, svgDiamKm, override) {
  if (override?.center) {
    return { lat: override.center[0], lon: override.center[1], source: "override", osm: null };
  }
  if (opt.noOsm) return { lat, lon, source: "yaml", osm: null };
  let ways = [];
  try {
    ways = racewayWays(await fetchOsm(slug, lat, lon));
  } catch (e) {
    process.stderr.write(`  [${slug}] OSM fetch failed (${e.message}); using declared center\n`);
    return { lat, lon, source: "yaml", osm: { error: e.message } };
  }
  const all = ways.flat();
  const R = Math.max(CONFIG.osm.windowFactor * svgDiamKm, CONFIG.osm.windowFloorKm);
  const win = all.filter((p) => {
    const [e, n] = toKm(p, lat, lon, lat);
    return Math.hypot(e, n) <= R;
  });
  if (win.length < CONFIG.osm.minPoints) {
    return { lat, lon, source: "yaml", osm: { accepted: false, reason: "too few raceway points", windowPoints: win.length }, ways };
  }
  const { clat, clon, diameterKm } = bboxCenterDiam(win, lat);
  const accepted =
    diameterKm >= CONFIG.osm.gateLo * svgDiamKm && diameterKm <= CONFIG.osm.gateHi * svgDiamKm;
  if (!accepted) {
    return {
      lat,
      lon,
      source: "yaml",
      osm: { accepted: false, reason: "extent mismatch", windowDiameterKm: diameterKm },
      ways,
    };
  }
  return { lat: clat, lon: clon, source: "osm", osm: { accepted: true, windowDiameterKm: diameterKm, windowPoints: win.length }, ways };
}

// ─────────────────────────────────────────────────────────────── plan
function buildPlan(slug, rec, layout, svg, center, override) {
  const diam = svg.diameterKm;
  const webSpan = override?.web_span_km ?? round(diam * (1 + 2 * CONFIG.marginFraction), 3);
  const masterSpan =
    override?.master_span_km ?? round(Math.max(diam * CONFIG.masterMultiple, CONFIG.masterFloorKm), 3);
  return {
    slug,
    layout: layout.id,
    center: { lat: round(center.lat, 6), lon: round(center.lon, 6) },
    center_source: center.source,
    svg_diameter_km: round(diam, 3),
    margin_fraction: CONFIG.marginFraction,
    web: { span_km: webSpan, size: CONFIG.webSize },
    master: { span_km: masterSpan, size: CONFIG.masterSize },
    osm: sanitizeOsm(center.osm),
    derived_from: { length_km: layout.length_km, map_svg: layout.map_svg },
    tool: "derive-capture-frame.mjs",
  };
}

const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

// Round the OSM diagnostic numbers so the committed plan stays tidy.
function sanitizeOsm(osm) {
  if (!osm) return null;
  const out = { ...osm };
  if (typeof out.windowDiameterKm === "number") out.windowDiameterKm = round(out.windowDiameterKm, 3);
  return out;
}

// ─────────────────────────────────────────────────────────────── preview
// Georeferenced (north-up) SVG preview: real OSM raceway geometry inside the
// derived master + web frames, centered on the resolved capture center.
function renderPreview(plan, center) {
  const C = 1000,
    PAD = 70,
    INNER = C - 2 * PAD;
  const masterSpan = plan.master.span_km;
  const ppkm = INNER / masterSpan;
  const cc = C / 2;
  const px = (e, n) => [cc + e * ppkm, cc - n * ppkm];
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${C} ${C}" font-family="ui-monospace,Menlo,monospace">`
  );
  parts.push(`<rect width="${C}" height="${C}" fill="#fafaf8"/>`);
  // OSM raceway geometry (georeferenced about the capture center)
  for (const way of center.ways ?? []) {
    const pts = way
      .map((p) => {
        const [e, n] = toKm(p, center.lat, center.lon, center.lat);
        return px(e, n).map((v) => v.toFixed(1)).join(",");
      })
      .join(" ");
    parts.push(`<polyline points="${pts}" fill="none" stroke="#4682b4" stroke-width="2"/>`);
  }
  // master frame (full) + web frame (dashed)
  parts.push(`<rect x="${PAD}" y="${PAD}" width="${INNER}" height="${INNER}" fill="none" stroke="#3c3c42" stroke-width="3"/>`);
  const hw = (plan.web.span_km / 2) * ppkm;
  parts.push(
    `<rect x="${(cc - hw).toFixed(1)}" y="${(cc - hw).toFixed(1)}" width="${(2 * hw).toFixed(1)}" height="${(2 * hw).toFixed(1)}" fill="none" stroke="#c82828" stroke-width="3" stroke-dasharray="14 10"/>`
  );
  // capture center (blue +) and, if shifted from declared, the declared center (gray x)
  parts.push(`<path d="M${cc - 12} ${cc}H${cc + 12}M${cc} ${cc - 12}V${cc + 12}" stroke="#0078dc" stroke-width="2"/>`);
  if (center.source === "osm" && center.declared) {
    const [e, n] = toKm([center.declared.lat, center.declared.lon], center.lat, center.lon, center.lat);
    const [dx, dy] = px(e, n);
    parts.push(
      `<path d="M${(dx - 9).toFixed(1)} ${(dy - 9).toFixed(1)}l18 18M${(dx + 9).toFixed(1)} ${(dy - 9).toFixed(1)}l-18 18" stroke="#969696" stroke-width="2"/>`
    );
  }
  // labels
  const banner =
    center.source === "osm"
      ? "OSM-refined center (blue +); declared = gray x"
      : center.source === "override"
      ? "manual override center (blue +)"
      : "FALLBACK: declared center (blue +) — verify against a basemap";
  parts.push(`<text x="${PAD}" y="34" font-size="22" fill="#111">${plan.slug}</text>`);
  parts.push(
    `<text x="${PAD}" y="56" font-size="14" fill="#555">web ${plan.web.span_km} km (red, ${plan.web.size}px) / master ${plan.master.span_km} km (black, ${plan.master.size}px) / Ø ${plan.svg_diameter_km} km</text>`
  );
  parts.push(`<text x="${PAD}" y="${C - 22}" font-size="13" fill="#777">blue = OSM motor-raceway geometry • ${banner}</text>`);
  parts.push(`</svg>\n`);
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────── main
async function listSlugs() {
  const entries = await readdir(join(repoRoot, "tracks"), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function loadOverrides() {
  if (!existsSync(overridesPath)) return {};
  try {
    return JSON.parse(await readFile(overridesPath, "utf8"));
  } catch (e) {
    fail(`Could not parse ${rel(overridesPath)}: ${e.message}`);
  }
}

async function processSlug(slug, overrides) {
  const yamlPath = join(repoRoot, "tracks", slug, `${slug}.yaml`);
  const rec = await readTrackRecord(yamlPath).catch((e) => fail(`${slug}: ${e.message}`));
  const layout = rec.layouts?.find((l) => l.id === rec.primary_layout) ?? rec.layouts?.[0];
  if (!layout) fail(`${slug}: no layouts in record`);
  const svgText = await readFile(join(repoRoot, "tracks", slug, layout.map_svg), "utf8");
  const svg = svgMetrics(svgText, layout.length_km);
  const center = await resolveCenter(slug, rec.latitude, rec.longitude, svg.diameterKm, overrides[slug]);
  center.declared = { lat: rec.latitude, lon: rec.longitude };
  const plan = buildPlan(slug, rec, layout, svg, center, overrides[slug]);

  if (opt.preview) {
    await mkdir(previewDir, { recursive: true });
    await writeFile(join(previewDir, `${slug}.svg`), renderPreview(plan, center));
  }
  if (opt.planFile) {
    await writeFile(join(repoRoot, "tracks", slug, `${slug}.capture.json`), JSON.stringify(plan, null, 2) + "\n");
  }
  return plan;
}

const overrides = await loadOverrides();
const targets = opt.all ? await listSlugs() : slugs;
const plans = [];
for (const slug of targets) {
  try {
    plans.push(await processSlug(slug, overrides));
  } catch (e) {
    process.stderr.write(`✗ ${slug}: ${e.message}\n`);
  }
}

if (opt.json) {
  console.log(JSON.stringify(opt.all || plans.length > 1 ? plans : plans[0], null, 2));
} else {
  // human summary table
  const src = { osm: "OSM", yaml: "declared", override: "override" };
  console.log(
    `${"track".padEnd(15)}${"Ø km".padStart(7)}${"web km".padStart(9)}${"master km".padStart(11)}  center`
  );
  console.log("-".repeat(60));
  for (const p of plans) {
    console.log(
      `${p.slug.padEnd(15)}${p.svg_diameter_km.toFixed(2).padStart(7)}${p.web.span_km
        .toFixed(2)
        .padStart(9)}${p.master.span_km.toFixed(2).padStart(11)}  ${src[p.center_source]}` +
        (p.osm?.windowDiameterKm ? ` (osmØ ${p.osm.windowDiameterKm.toFixed(2)})` : "")
    );
  }
  if (opt.preview) console.log(`\npreviews -> ${rel(previewDir)}/  (open: qlmanage -t -s 1400 previews/capture/*.svg)`);
}

function rel(p) {
  return p.startsWith(repoRoot + "/") ? p.slice(repoRoot.length + 1) : p;
}
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
