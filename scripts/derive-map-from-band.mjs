#!/usr/bin/env node
/**
 * Pixelsonly Racing Circuits — map.svg deriver for FILLED-BAND sources.
 *
 * Some Commons track maps draw the track as a single black FILLED path (outer
 * contour + hole subpaths) rather than a stroked centerline (e.g. the 2024-era
 * "Road Course" style: Daytona, Watkins Glen). For those, Phase B path-extract
 * (docs/intake-checklist.md step 5) has nothing to extract and
 * scripts/derive-corner-positions.mjs cannot recover an affine. This script
 * fills that gap:
 *
 *   1. Samples the band path's subpaths (bezier-aware) and rasterizes the
 *      region with the even-odd rule.
 *   2. Thins the raster to a 1-px skeleton (Zhang-Suen), builds the skeleton
 *      graph (junction clusters + edges), prunes short spurs.
 *   3. Walks the racing-line cycle by greedy direction-continuity from
 *      --start, skipping edges near --avoid points (pit roads, access roads).
 *   4. Smooths + simplifies the loop (Douglas-Peucker), affine-fits it into
 *      the normalized 0 0 1000 1000 viewBox, and writes tracks/<slug>/map.svg
 *      with the repo's stroke conventions and a derivation comment.
 *   5. Projects the source's numbered marker CIRCLES onto the traced line,
 *      orders them by lap distance from --sf, and prints a ready-to-paste
 *      position{x,y} snippet plus a signed-turn handedness estimate per
 *      marker (negative = LEFT in SVG's y-down coordinates when the trace
 *      runs in race direction).
 *
 * The operator stays in the loop: render the source first (macOS:
 * `qlmanage -t -s 3000 -o /tmp tracks/<slug>/map-source.svg`) to pick --start
 * / --avoid / --sf, then check that the reported marker lap order comes out
 * 1..N — that ordering is the strongest correctness signal. Use --reverse if
 * it comes out backwards (trace ran against race direction).
 *
 * Usage:
 *   npm run map-band -- <slug> --start "x,y" [options]
 *   node scripts/derive-map-from-band.mjs daytona \
 *     --start "125,640" --heading "0,1" --avoid "1500,1350" --sf "1500,1500"
 *
 * Options:
 *   --source <file>   source SVG (default tracks/<slug>/map-source.svg)
 *   --out <file>      output SVG (default tracks/<slug>/map.svg)
 *   --path <n>        band path candidate index (default 0 = largest bbox)
 *   --px <u>          raster resolution, source units per pixel (default 1.5)
 *   --start "x,y"     point near the racing line where the walk starts
 *   --heading "dx,dy" initial walk direction (default "0,1")
 *   --avoid "x,y;..." exclude skeleton edges whose midpoint is within
 *                     --avoid-r (default 40) of any of these points
 *   --via "x,y;..."   prefer edges passing within --via-r (default 60) of
 *                     these points when a junction offers a choice
 *   --sf "x,y"        start/finish reference for lap ordering (default --start)
 *   --reverse         reverse the traced direction before reporting/writing
 *   --eps <u>         Douglas-Peucker tolerance, source units (default 2.2)
 *   --margin <u>      viewBox margin in map units (default 50)
 *   --spur <px>       prune spurs shorter than this many pixels (default 60)
 *   --dry             compute and report, but do not write map.svg
 *
 * Dependency-free except `yaml` (already a devDependency), used only to pull
 * the display name + map attribution out of the track record for the output
 * comment; both degrade gracefully if the record or fields are missing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ---------------------------------------------------------------- CLI args
const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--"));
function opt(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) {
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? true : v;
  }
  const kv = argv.find((a) => a.startsWith(`--${name}=`));
  if (kv) return kv.slice(name.length + 3);
  return dflt;
}
if (!slug || opt("help", false)) {
  console.error('Usage: node scripts/derive-map-from-band.mjs <slug> --start "x,y" [options] (see header)');
  process.exit(1);
}
const srcPath = opt("source", join(repoRoot, "tracks", slug, "map-source.svg"));
const outPath = opt("out", join(repoRoot, "tracks", slug, "map.svg"));
const PX = parseFloat(opt("px", "1.5"));
const EPS = parseFloat(opt("eps", "2.2"));
const MARGIN = parseFloat(opt("margin", "50"));
const SPUR = parseInt(opt("spur", "60"), 10);
const AVOID_R = parseFloat(opt("avoid-r", "40"));
const VIA_R = parseFloat(opt("via-r", "60"));
const DRY = !!opt("dry", false);
const REVERSE = !!opt("reverse", false);
const pathIdx = parseInt(opt("path", "0"), 10);
function parsePt(s) {
  if (!s || s === true) return null;
  const [x, y] = String(s).split(",").map(Number);
  return [x, y];
}
function parsePts(s) {
  if (!s || s === true) return [];
  return String(s).split(";").map((p) => parsePt(p)).filter(Boolean);
}
const START = parsePt(opt("start", null));
const HEADING = parsePt(opt("heading", "0,1"));
const AVOID = parsePts(opt("avoid", null));
const VIA = parsePts(opt("via", null));
const SF = parsePt(opt("sf", null)) ?? START;
if (!START) fail('--start "x,y" is required (render the source and pick a point on the racing line).');

// ------------------------------------------------- minimal SVG element scan
// Walks tags maintaining the ancestor transform stack; collects <path> and
// <circle> elements with their composed 2x3 transform. Good enough for
// Inkscape/Illustrator Commons exports; not a general XML parser.
function mat(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) { return [a, b, c, d, e, f]; }
function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function matApply(m, [x, y]) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
function parseTransform(s) {
  let m = mat();
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(s))) {
    const v = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let n = mat();
    if (t[1] === "matrix" && v.length === 6) n = v;
    else if (t[1] === "translate") n = mat(1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0);
    else if (t[1] === "scale") n = mat(v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0);
    else if (t[1] === "rotate") {
      const a = ((v[0] ?? 0) * Math.PI) / 180, cx = v[1] ?? 0, cy = v[2] ?? 0;
      const cos = Math.cos(a), sin = Math.sin(a);
      n = matMul(matMul(mat(1, 0, 0, 1, cx, cy), mat(cos, sin, -sin, cos, 0, 0)), mat(1, 0, 0, 1, -cx, -cy));
    }
    m = matMul(m, n);
  }
  return m;
}
function scanSvg(text) {
  const paths = [], circles = [];
  const stack = [mat()];
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(text))) {
    const [, close, name, attrs, selfClose] = m;
    if (name === "?xml" || name.startsWith("!")) continue;
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const attr = (k) => {
      const am = attrs.match(new RegExp(`(?:^|\\s)${k}\\s*=\\s*("([^"]*)"|'([^']*)')`));
      return am ? (am[2] ?? am[3]) : undefined;
    };
    const ctm = matMul(stack[stack.length - 1], parseTransform(attr("transform")));
    if (name === "path" && attr("d")) paths.push({ d: attr("d"), ctm, raw: attrs.slice(0, 80) });
    if (name === "circle") {
      circles.push({ c: matApply(ctm, [parseFloat(attr("cx") ?? "0"), parseFloat(attr("cy") ?? "0")]), r: parseFloat(attr("r") ?? "0") });
    }
    if (!selfClose) stack.push(ctm);
  }
  return { paths, circles };
}

// ----------------------------------------------------------- path sampling
const TOK = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?)/g;
function samplePath(d, ctm, step = 4.0) {
  const toks = [];
  let t;
  TOK.lastIndex = 0;
  while ((t = TOK.exec(d))) toks.push(t[1] ?? parseFloat(t[2]));
  let i = 0, cmd = null, cur = [0, 0], start = [0, 0], prevC = null;
  const subs = [];
  let pts = [];
  const num = () => toks[i++];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const bez = (p0, p1, p2, p3) => {
    const n = Math.max(2, Math.floor(dist(p0, p3) / step) + 2);
    const out = [];
    for (let k = 1; k <= n; k++) {
      const u = k / n, v = 1 - u;
      out.push([
        v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0],
        v * v * v * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * p3[1],
      ]);
    }
    return out;
  };
  while (i < toks.length) {
    if (typeof toks[i] === "string") cmd = toks[i++];
    const c = cmd;
    if (c === "Z" || c === "z") {
      if (pts.length) { pts.push(start.slice()); subs.push({ pts, closed: true }); pts = []; }
      cur = start.slice(); prevC = null; continue;
    }
    if (c === "M" || c === "m") {
      let x = num(), y = num();
      if (c === "m") { x += cur[0]; y += cur[1]; }
      if (pts.length) { subs.push({ pts, closed: false }); pts = []; }
      cur = [x, y]; start = cur.slice(); pts = [cur.slice()];
      cmd = c === "M" ? "L" : "l"; prevC = null; continue;
    }
    if (c === "L" || c === "l") {
      let x = num(), y = num();
      if (c === "l") { x += cur[0]; y += cur[1]; }
      cur = [x, y]; pts.push(cur.slice()); prevC = null; continue;
    }
    if (c === "H" || c === "h") { let x = num(); if (c === "h") x += cur[0]; cur = [x, cur[1]]; pts.push(cur.slice()); prevC = null; continue; }
    if (c === "V" || c === "v") { let y = num(); if (c === "v") y += cur[1]; cur = [cur[0], y]; pts.push(cur.slice()); prevC = null; continue; }
    if (c === "C" || c === "c") {
      const v = [num(), num(), num(), num(), num(), num()];
      if (c === "c") for (let k = 0; k < 6; k++) v[k] += cur[k % 2];
      const p1 = [v[0], v[1]], p2 = [v[2], v[3]], p3 = [v[4], v[5]];
      pts.push(...bez(cur, p1, p2, p3)); prevC = p2; cur = p3; continue;
    }
    if (c === "S" || c === "s") {
      const v = [num(), num(), num(), num()];
      if (c === "s") for (let k = 0; k < 4; k++) v[k] += cur[k % 2];
      const p2 = [v[0], v[1]], p3 = [v[2], v[3]];
      const p1 = prevC ? [2 * cur[0] - prevC[0], 2 * cur[1] - prevC[1]] : cur;
      pts.push(...bez(cur, p1, p2, p3)); prevC = p2; cur = p3; continue;
    }
    if (c === "Q" || c === "q" || c === "T" || c === "t") {
      const n = c === "Q" || c === "q" ? 4 : 2;
      const v = [];
      for (let k = 0; k < n; k++) v.push(num());
      if (c === c.toLowerCase()) for (let k = 0; k < n; k++) v[k] += cur[k % 2];
      cur = [v[n - 2], v[n - 1]]; pts.push(cur.slice()); prevC = null; continue;
    }
    if (c === "A" || c === "a") {
      // arcs are rare in these sources; approximated by their chord (warned)
      const v = [];
      for (let k = 0; k < 7; k++) v.push(num());
      let x = v[5], y = v[6];
      if (c === "a") { x += cur[0]; y += cur[1]; }
      arcWarn = true;
      cur = [x, y]; pts.push(cur.slice()); prevC = null; continue;
    }
    fail(`Unsupported path command "${c}"`);
  }
  if (pts.length) subs.push({ pts, closed: false });
  for (const s of subs) s.pts = s.pts.map((p) => matApply(ctm, p));
  return subs;
}
let arcWarn = false;

// ----------------------------------------------------------------- pipeline
const svgText = readFileSync(srcPath, "utf8");
const { paths, circles } = scanSvg(svgText);
if (!paths.length) fail(`No <path> elements found in ${srcPath}`);

// loop-based extents: sampled point arrays can exceed the spread-argument limit
function extent(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

const candidates = paths
  .map((p, idx) => {
    const subs = samplePath(p.d, p.ctm);
    const bbox = extent(subs.flatMap((s) => s.pts));
    return { idx, subs, bbox, area: (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]), dlen: p.d.length };
  })
  .sort((a, b) => b.area - a.area);
console.log("Band path candidates (by bbox area):");
for (const c of candidates.slice(0, 5)) {
  console.log(
    `  [${candidates.indexOf(c)}] path#${c.idx} dlen=${c.dlen} subpaths=${c.subs.length} ` +
    `bbox=(${c.bbox.map((v) => v.toFixed(0)).join(",")})`
  );
}
const band = candidates[pathIdx];
if (!band) fail(`--path ${pathIdx} out of range`);
console.log(`Using candidate [${pathIdx}] (path#${band.idx}); override with --path <n> if wrong.\n`);
if (arcWarn) console.log("⚠️  Source contains arc commands; approximated by chords — inspect the output.\n");

// rasterize (even-odd) — scanline crossings per row
const [minX, minY, maxX, maxY] = extent(band.subs.flatMap((s) => s.pts));
const W = Math.ceil((maxX - minX) / PX) + 4, H = Math.ceil((maxY - minY) / PX) + 4;
const toPx = ([x, y]) => [(x - minX) / PX + 2, (y - minY) / PX + 2];
const toSrc = ([px, py]) => [(px - 2) * PX + minX, (py - 2) * PX + minY];
const rows = Array.from({ length: H }, () => []);
for (const s of band.subs) {
  const n = s.pts.length;
  for (let i = 0; i < n; i++) {
    let [x0, y0] = toPx(s.pts[i]);
    let [x1, y1] = toPx(s.pts[(i + 1) % n]);
    if (y0 === y1) continue;
    if (y0 > y1) { [x0, y0, x1, y1] = [x1, y1, x0, y0]; }
    for (let r = Math.max(Math.ceil(y0), 0); r < Math.min(y1, H); r++) {
      rows[r].push(x0 + ((x1 - x0) * (r - y0)) / (y1 - y0));
    }
  }
}
const img = new Uint8Array(W * H);
let filled = 0;
for (let r = 0; r < H; r++) {
  const xs = rows[r].sort((a, b) => a - b);
  for (let k = 0; k + 1 < xs.length; k += 2) {
    for (let c = Math.max(Math.ceil(xs[k]), 0); c <= Math.min(Math.floor(xs[k + 1]), W - 1); c++) {
      if (!img[r * W + c]) { img[r * W + c] = 1; filled++; }
    }
  }
}
console.log(`Raster: ${W}x${H}px @ ${PX}u/px, ${filled} filled px`);

// Zhang-Suen thinning (sparse candidate set)
const N8 = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1];
function zsPass(cand, phase, deleted) {
  for (const i of cand) {
    if (!img[i]) continue;
    const p = N8.map((o) => img[i + o] ?? 0);
    const B = p.reduce((a, b) => a + b, 0);
    if (B < 2 || B > 6) continue;
    let A = 0;
    for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) A++;
    if (A !== 1) continue;
    if (phase === 0) { if ((p[0] && p[2] && p[4]) || (p[2] && p[4] && p[6])) continue; }
    else { if ((p[0] && p[2] && p[6]) || (p[0] && p[4] && p[6])) continue; }
    deleted.push(i);
  }
  for (const i of deleted) img[i] = 0;
}
let cand = new Set();
for (let i = 0; i < img.length; i++) if (img[i]) cand.add(i);
for (let iter = 0; iter < 500; iter++) {
  const d0 = []; zsPass(cand, 0, d0);
  const d1 = []; zsPass(cand, 1, d1);
  if (!d0.length && !d1.length) break;
  cand = new Set();
  for (const i of [...d0, ...d1]) for (const o of N8) cand.add(i + o);
}
const skel = new Set();
for (let i = 0; i < img.length; i++) if (img[i]) skel.add(i);
console.log(`Skeleton: ${skel.size}px`);

// graph build: junction clusters + edges
const deg = (i) => N8.reduce((a, o) => a + (img[i + o] ?? 0), 0);
function buildGraph() {
  const nodePx = new Set([...skel].filter((i) => deg(i) !== 2));
  const cid = new Map();
  const clusters = [];
  for (const p of nodePx) {
    if (cid.has(p)) continue;
    const comp = [];
    const stack = [p];
    while (stack.length) {
      const q = stack.pop();
      if (cid.has(q)) continue;
      cid.set(q, clusters.length); comp.push(q);
      for (const o of N8) { const r = q + o; if (nodePx.has(r) && !cid.has(r)) stack.push(r); }
    }
    clusters.push(comp);
  }
  const edges = [];
  const used = new Set();
  for (let ci = 0; ci < clusters.length; ci++) {
    for (const p of clusters[ci]) {
      for (const o of N8) {
        const q = p + o;
        if (!skel.has(q) || cid.has(q) || used.has(p * img.length + q)) continue;
        const path = [p, q];
        let prev = p, cur = q, ok = true;
        while (!cid.has(cur)) {
          let nxt = null;
          const recent = path.slice(-4, -1);
          for (const oo of N8) {
            const r = cur + oo;
            if (skel.has(r) && r !== prev && !recent.includes(r)) { nxt = r; if (cid.has(r)) break; }
          }
          if (nxt === null) { ok = false; break; }
          path.push(nxt); prev = cur; cur = nxt;
        }
        if (ok) {
          used.add(p * img.length + q);
          used.add(path[path.length - 1] * img.length + path[path.length - 2]);
          edges.push({ a: ci, b: cid.get(cur), path });
        }
      }
    }
  }
  return { clusters, edges };
}
function pruneSpurs(g) {
  let changed = true;
  while (changed) {
    changed = false;
    const cnt = new Map();
    for (const e of g.edges) { cnt.set(e.a, (cnt.get(e.a) ?? 0) + 1); cnt.set(e.b, (cnt.get(e.b) ?? 0) + 1); }
    const keep = [];
    for (const e of g.edges) {
      const dead = e.a !== e.b && e.path.length < SPUR * 2 && (cnt.get(e.a) === 1 || cnt.get(e.b) === 1);
      const tinyLoop = e.a === e.b && e.path.length < 12;
      if (dead || tinyLoop) {
        for (const q of e.path.slice(1, -1)) skel.delete(q), (img[q] = 0);
        changed = true;
      } else keep.push(e);
    }
    g.edges = keep;
  }
}
let graph = buildGraph();
pruneSpurs(graph);
graph = buildGraph(); // rebuild after pruning (degrees changed)
pruneSpurs(graph);
console.log(`Graph: ${graph.clusters.length} junction clusters, ${graph.edges.length} edges`);

const pxToXY = (i) => toSrc([i % W, Math.floor(i / W)]);
function edgeMid(e) {
  const pts = e.path.map(pxToXY);
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}
const excluded = new Set();
for (const e of graph.edges) {
  const m = edgeMid(e);
  if (AVOID.some((a) => Math.hypot(m[0] - a[0], m[1] - a[1]) <= AVOID_R)) excluded.add(e);
}
if (AVOID.length) console.log(`Excluded ${excluded.size} edge(s) near --avoid points`);

// greedy direction-continuity walk
function edgeXY(e, fromCluster) {
  const pts = e.path.map(pxToXY);
  return fromCluster === e.b ? pts.slice().reverse() : pts;
}
let startEdge = null, startD = Infinity;
for (const e of graph.edges) {
  if (excluded.has(e)) continue;
  for (const q of e.path) {
    const p = pxToXY(q);
    const d = Math.hypot(p[0] - START[0], p[1] - START[1]);
    if (d < startD) { startD = d; startEdge = e; }
  }
}
if (!startEdge) fail("Could not find a skeleton edge near --start");
console.log(`Start edge found ${startD.toFixed(0)}u from --start`);
// orient by heading
{
  const pts = edgeXY(startEdge, startEdge.a);
  const v = [pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]];
  const dot = v[0] * HEADING[0] + v[1] * HEADING[1];
  startEdge._from = dot >= 0 ? startEdge.a : startEdge.b;
}
const adj = new Map();
for (const e of graph.edges) {
  if (!adj.has(e.a)) adj.set(e.a, []);
  if (!adj.has(e.b)) adj.set(e.b, []);
  adj.get(e.a).push(e); adj.get(e.b).push(e);
}
let line = [];
{
  let curE = startEdge, fromC = startEdge._from;
  const startC = fromC;
  const visited = new Set();
  for (let step = 0; step < 2000; step++) {
    const pts = edgeXY(curE, fromC);
    line.push(...(line.length ? pts.slice(1) : pts));
    visited.add(curE);
    const nextC = fromC === curE.a ? curE.b : curE.a;
    if (nextC === startC && step > 3) { console.log(`Cycle closed after ${step + 1} edges`); break; }
    const tail = line.slice(-Math.min(6, line.length));
    let h = [line[line.length - 1][0] - tail[0][0], line[line.length - 1][1] - tail[0][1]];
    const hl = Math.hypot(...h) || 1; h = [h[0] / hl, h[1] / hl];
    let best = null;
    for (const e2 of adj.get(nextC) ?? []) {
      if (e2 === curE || excluded.has(e2) || visited.has(e2)) continue;
      const q = edgeXY(e2, nextC);
      if (q.length < 2) continue;
      const k = Math.min(5, q.length - 1);
      let v = [q[k][0] - q[0][0], q[k][1] - q[0][1]];
      const vl = Math.hypot(...v) || 1;
      let score = (v[0] * h[0] + v[1] * h[1]) / vl;
      const m = edgeMid(e2);
      if (VIA.some((p) => Math.hypot(m[0] - p[0], m[1] - p[1]) <= VIA_R)) score += 0.5;
      if (!best || score > best.score) best = { score, e: e2 };
    }
    if (!best) fail(`Dead end at cluster ${nextC} after ${step + 1} edges — adjust --start/--avoid/--heading`);
    curE = best.e; fromC = nextC;
  }
}
if (Math.hypot(line[0][0] - line[line.length - 1][0], line[0][1] - line[line.length - 1][1]) < PX * 2.5) line.pop();
if (REVERSE) line.reverse();
const N = line.length;
let length = 0;
for (let i = 0; i < N; i++) length += Math.hypot(line[(i + 1) % N][0] - line[i][0], line[(i + 1) % N][1] - line[i][1]);
console.log(`Traced loop: ${N} pts, length ${length.toFixed(0)}u\n`);

// smooth (closed moving average, 2 passes, window 5)
for (let pass = 0; pass < 2; pass++) {
  line = line.map((_, i) => {
    let sx = 0, sy = 0;
    for (let k = -2; k <= 2; k++) { const p = line[(i + k + N) % N]; sx += p[0]; sy += p[1]; }
    return [sx / 5, sy / 5];
  });
}
// Douglas-Peucker on the closed loop, split at index 0 and N/2
function dp(pts, eps) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const ab = [b[0] - a[0], b[1] - a[1]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  let imax = 0, dmax = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    let d;
    if (!l2) d = Math.hypot(p[0] - a[0], p[1] - a[1]);
    else {
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
      d = Math.hypot(p[0] - (a[0] + t * ab[0]), p[1] - (a[1] + t * ab[1]));
    }
    if (d > dmax) { imax = i; dmax = d; }
  }
  if (dmax <= eps) return [a, b];
  const left = dp(pts.slice(0, imax + 1), eps), right = dp(pts.slice(imax), eps);
  return left.slice(0, -1).concat(right);
}
const half = Math.floor(N / 2);
const simp = dp(line.slice(0, half + 1), EPS).slice(0, -1).concat(dp(line.slice(half).concat([line[0]]), EPS).slice(0, -1));
console.log(`Simplified: ${N} -> ${simp.length} pts (eps ${EPS}u)`);

// affine fit
const [bx0, by0, bx1, by1] = extent(simp);
const s = (1000 - 2 * MARGIN) / Math.max(bx1 - bx0, by1 - by0);
const tx = (1000 - (bx1 - bx0) * s) / 2 - bx0 * s;
const ty = (1000 - (by1 - by0) * s) / 2 - by0 * s;
const T = (p) => [p[0] * s + tx, p[1] * s + ty];
console.log(`Affine: s=${s.toFixed(6)} t=(${tx.toFixed(2)}, ${ty.toFixed(2)})\n`);

// record metadata for the comment (best-effort)
let displayName = slug, attribLine = "a Wikimedia Commons source (see assets.map_attribution)";
try {
  const { parse } = await import("yaml");
  const rec = parse(readFileSync(join(repoRoot, "tracks", slug, `${slug}.yaml`), "utf8"));
  displayName = rec?.name ?? displayName;
  const at = rec?.assets?.map_attribution;
  if (at?.source_title) {
    attribLine = `File:${at.source_title}${at.artist ? ` by ${at.artist}` : ""}` + (at.license ? ` (${at.license})` : "");
  }
} catch { /* record not written yet — generic comment */ }
const clean = (t) => String(t).replace(/-{2,}/g, "-"); // XML comments cannot contain "--"
const comment = `${clean(displayName)}, traced single-line outline.
     Derived from ${clean(attribLine)} on Wikimedia Commons. The source draws
     the track as a filled band; its racing-line centerline was extracted by
     scripts/derive-map-from-band.mjs (even-odd raster, skeleton, cycle walk)
     and affine-fit to the normalized 0 0 1000 1000 viewBox. License is
     recorded in LICENSE-ASSETS.md. To re-fetch the source, see
     scripts/fetch-map.mjs.`;
let dStr = `M${T(simp[0]).map((v) => v.toFixed(1)).join(" ")}`;
for (const p of simp.slice(1)) dStr += `L${T(p).map((v) => v.toFixed(1)).join(" ")}`;
dStr += "Z";
const outSvg = `<!--${comment}-->
<svg xmlns="http://www.w3.org/2000/svg" aria-label="${clean(displayName)} track map" role="img" viewBox="0 0 1000 1000">
  <path fill="none" stroke="#1f1f21" stroke-linecap="round" stroke-linejoin="round" stroke-width="10" d="${dStr}"/>
</svg>
`;
if (DRY) console.log(`--dry: not writing ${outPath}`);
else { writeFileSync(outPath, outSvg); console.log(`Wrote ${outPath} (${outSvg.length} bytes)`); }

// ------------------------------------------------------------- markers
// marker circles = the most common radius among <circle> elements (>=3 of it)
let markers = [];
if (circles.length >= 3) {
  const byR = new Map();
  for (const c of circles) {
    const key = c.r.toFixed(1);
    byR.set(key, (byR.get(key) ?? []).concat([c]));
  }
  const top = [...byR.values()].sort((a, b) => b.length - a.length)[0];
  if (top.length >= 3) markers = top.map((c) => c.c);
}
if (!markers.length) {
  console.log("\nNo marker circles found — derive positions another way (see corner-position memory/notes).");
} else {
  const cum = [0];
  for (let i = 1; i < N; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const nearestIdx = (p) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i++) {
      const d = (line[i][0] - p[0]) ** 2 + (line[i][1] - p[1]) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const sfI = nearestIdx(SF);
  const lapd = (i) => (cum[i] - cum[sfI] + length) % length;
  const turnAt = (i, win = 30) => {
    let tot = 0;
    for (let k = i - win; k < i + win; k++) {
      const a = line[(k - 2 + N) % N], b = line[(k + N) % N], c = line[(k + 2 + N) % N];
      const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      tot += Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]);
    }
    return (tot * 180) / Math.PI;
  };
  const rep = markers.map((p) => {
    const i = nearestIdx(p);
    const q = T(line[i]);
    return { lap: lapd(i), src: p, off: Math.hypot(line[i][0] - p[0], line[i][1] - p[1]), x: q[0] / 1000, y: q[1] / 1000, turn: turnAt(i) };
  }).sort((a, b) => a.lap - b.lap);
  console.log(`\n${markers.length} marker circles, ordered by lap distance from --sf`);
  console.log("(verify against a render that the source numerals match this 1..N order; --reverse if backwards)");
  console.log("order | lapdist | marker(src)      | offtrack | signed turn | direction | position");
  rep.forEach((r, k) => {
    const dir = Math.abs(r.turn) < 12 ? "?" : r.turn < 0 ? "left" : "right";
    console.log(
      `  ${String(k + 1).padStart(3)} | ${r.lap.toFixed(0).padStart(7)} | (${r.src[0].toFixed(0)},${r.src[1].toFixed(0)})`.padEnd(46) +
      `| ${r.off.toFixed(0).padStart(8)} | ${r.turn.toFixed(1).padStart(11)} | ${dir.padEnd(9)} | { x: ${r.x.toFixed(3)}, y: ${r.y.toFixed(3)} }`
    );
  });
  console.log("\nReady-to-adapt YAML (map order->corner ids yourself; compound corners share markers):");
  rep.forEach((r, k) => console.log(`  # turn ${k + 1}\n    position: { x: ${r.x.toFixed(3)}, y: ${r.y.toFixed(3)} }`));
}
console.log(
  "\nNext: npx svgo --config svgo.config.mjs -f tracks/" + slug +
  " && npm run validate. Render the result (qlmanage -t -s 800) and compare with the source."
);

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
