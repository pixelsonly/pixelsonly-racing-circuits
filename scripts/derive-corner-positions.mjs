#!/usr/bin/env node
/**
 * Pixelsonly Racing Circuits — corner-position deriver.
 *
 * Reads a track's numbered turn markers out of tracks/<slug>/map-source.svg and
 * reports their normalized {x, y} positions on the production map.svg viewBox —
 * the `position:` field each corner record wants (schema + intake step 5C).
 *
 * Why this exists: the source Wikimedia SVGs carry numbered turn markers placed
 * by the original cartographer. Because map.svg was affine-fit from the source's
 * track path (`matrix(s 0 0 s tx ty)` per the map.svg header comment), the SAME
 * affine maps those markers onto map.svg exactly. That turns "eyeball the apex"
 * into an arithmetic step. Doing it by hand is error-prone — especially when the
 * markers are matrix-transformed (Spa) rather than plain translates (Laguna).
 *
 * What it handles:
 *   - Affine recovered from the first cubic segment + start point of the two
 *     track paths (cross-checked against a bbox-ratio scale and a full-path
 *     residual). Uniform scale + translation only — matches how map.svg is fit.
 *   - A real SVG transform-stack resolver (translate/scale/matrix/rotate, incl.
 *     multi-arg + rotate-about-point), so a marker's position is composed
 *     through every ancestor <g> and converted back into the track path's local
 *     coordinate space before the affine is applied.
 *   - Marker formats seen across tracks: a <circle>/<ellipse> dot, OR a dot
 *     drawn as a <path> of arcs/beziers (Spa), OR no dot at all — just the
 *     numbered <text> label (Mugello T1–12). Dot preferred; text is the
 *     fallback. Dot centre = bbox centre of the dot's on-curve points (robust
 *     for both arc- and bezier-drawn circles).
 *
 * It does NOT write the YAML. Turn numbers map to corner records by hand
 * (compound entries like Spa's "2-4" cover several markers), so this prints a
 * review table + a ready-to-paste snippet and leaves authoring to a human.
 *
 * Usage:
 *   node scripts/derive-corner-positions.mjs <slug>
 *   npm run positions -- <slug>
 */

import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const IDENTITY = [1, 0, 0, 1, 0, 0];

const slug = process.argv[2];
if (!slug) {
  console.error("Usage: node scripts/derive-corner-positions.mjs <slug>");
  process.exit(1);
}

const trackDir = join(repoRoot, "tracks", slug);
const mapText = await readFile(join(trackDir, "map.svg"), "utf8").catch((e) =>
  fail(`Cannot read tracks/${slug}/map.svg — ${e.message}`)
);
const sourceText = await readFile(join(trackDir, "map-source.svg"), "utf8").catch(
  (e) => fail(`Cannot read tracks/${slug}/map-source.svg — ${e.message}`)
);

// --- production map.svg: viewBox, single track path, and the source path id ---
const viewBox = mapText.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
if (!viewBox) fail("map.svg has no `viewBox=\"0 0 W H\"`.");
const vbW = Number(viewBox[1]);
const vbH = Number(viewBox[2]);

const mapPathD = mapText.match(/<path\b[^>]*\sd="([^"]+)"/)?.[1];
if (!mapPathD) fail("map.svg has no <path d=…>.");

// The header comment names the source centerline path (e.g. "The source path2840 …").
const sourcePathId = mapText.match(/\bThe source(?:'s)?\s+(path[\w-]+)/)?.[1] ?? null;

// --- parse map-source.svg into an AST (dependency-free; svgo isn't installed) ---
const ast = parseSvg(sourceText);
if (!ast.children.length) fail("Could not parse map-source.svg.");

// Walk the tree once: record each element's parent and its "self matrix"
// (parent content matrix · own transform). An element's geometry — and its
// children — live under this matrix.
const parentOf = new Map();
const selfMatrix = new Map();
let trackPathNode = null;
const candidatePaths = []; // for source-path fallback

(function walk(node, parentMatrix, parent) {
  parentOf.set(node, parent);
  const own = parseTransform(node.attributes?.transform);
  const self = mul(parentMatrix, own);
  selfMatrix.set(node, self);

  if (node.type === "element" && node.name === "path" && node.attributes?.d) {
    if (sourcePathId && node.attributes.id === sourcePathId) trackPathNode = node;
    candidatePaths.push(node);
  }
  for (const child of node.children ?? []) walk(child, self, node);
})(ast, IDENTITY, null);

// Fallback: if the comment didn't name the path (or it's gone), the track
// centerline is the path with the most on-curve points.
if (!trackPathNode) {
  trackPathNode = candidatePaths
    .map((n) => ({ n, len: pathAnchors(n.attributes.d).length }))
    .sort((a, b) => b.len - a.len)[0]?.n;
  if (!trackPathNode) fail("No <path> found in map-source.svg to fit against.");
  warn(
    `map.svg comment didn't name a source path id — falling back to the longest path (id="${trackPathNode.attributes.id ?? "?"}").`
  );
}

// --- recover the affine: source path d-values -> map.svg viewBox ---
const srcAnchors = pathAnchors(trackPathNode.attributes.d);
const mapAnchors = pathAnchors(mapPathD);
if (srcAnchors.length < 2 || mapAnchors.length < 2)
  fail("Track path has too few points to fit an affine.");

// Primary: scale from the first segment (projection — robust to which axis
// dominates), translation from the start point. This is exact when SVGO left
// the first segment intact, which is the case for the Wikimedia-derived maps.
const dSrc = sub(srcAnchors[1], srcAnchors[0]);
const dMap = sub(mapAnchors[1], mapAnchors[0]);
const s = dot(dMap, dSrc) / dot(dSrc, dSrc);
const tx = mapAnchors[0].x - s * srcAnchors[0].x;
const ty = mapAnchors[0].y - s * srcAnchors[0].y;

// Cross-checks: bbox-ratio scale, and (when point counts match) the worst-case
// residual across the whole path. These catch a bad fit before it ships.
const sBboxX = bbox(mapAnchors).w / bbox(srcAnchors).w;
const sBboxY = bbox(mapAnchors).h / bbox(srcAnchors).h;
let residual = null;
if (srcAnchors.length === mapAnchors.length) {
  residual = 0;
  for (let i = 0; i < srcAnchors.length; i++) {
    const px = s * srcAnchors[i].x + tx;
    const py = s * srcAnchors[i].y + ty;
    residual = Math.max(residual, Math.hypot(px - mapAnchors[i].x, py - mapAnchors[i].y));
  }
}

const affineMatrix = [s, 0, 0, s, tx, ty];
const trackSelf = selfMatrix.get(trackPathNode); // d-values render through this
const invTrack = invert(trackSelf);

// --- collect numbered markers and resolve each to a normalized position ---
const markers = [];
for (const [node] of selfMatrix) {
  if (node.type !== "element" || node.name !== "text") continue;
  const label = textContent(node).trim();
  const m = label.match(/^(\d{1,2})([a-z])?$/i);
  if (!m) continue; // skip "N" compass, place names, etc.

  const turn = m[2] ? `${m[1]}${m[2].toLowerCase()}` : m[1];
  const parent = parentOf.get(node);

  // The label's own rendered anchor.
  const lx = Number(node.attributes.x ?? firstTspanCoord(node, "x"));
  const ly = Number(node.attributes.y ?? firstTspanCoord(node, "y"));
  const textPt =
    Number.isFinite(lx) && Number.isFinite(ly)
      ? apply(selfMatrix.get(node), { x: lx, y: ly })
      : null;

  // Prefer the marker dot drawn in the same marker group (the label's parent
  // subtree). A group can hold several labels + several dots (e.g. Mugello's
  // Biondetti/Bucine cluster) or nest the dot one level down (Laguna T10), so
  // pair each label to the CLOSEST dot rather than the first one. Fall back to
  // the label's own anchor when the marker is text-only (e.g. some Mugello T1–12).
  const dots = [];
  collectDots(parent, dots);
  let rendered = textPt;
  let via = "text";
  let best = Infinity;
  for (const d of dots) {
    const p = apply(selfMatrix.get(d), dotCentre(d));
    const dist = textPt ? Math.hypot(p.x - textPt.x, p.y - textPt.y) : 0;
    if (dist < best) {
      best = dist;
      rendered = p;
      via = `dot:${d.name}`;
    }
  }
  if (!rendered) continue;

  // rendered (root space) -> track path's local space -> map viewBox -> 0..1
  const local = apply(invTrack, rendered);
  const mapX = s * local.x + tx;
  const mapY = s * local.y + ty;
  markers.push({
    turn,
    sort: Number(m[1]) + (m[2] ? 0.5 : 0),
    x: +(mapX / vbW).toFixed(3),
    y: +(mapY / vbH).toFixed(3),
    via,
  });
}

markers.sort((a, b) => a.sort - b.sort);

// --- report ---
console.log(`\nCorner positions for ${slug} (map.svg viewBox ${vbW}×${vbH})\n`);
console.log(
  `  affine: x' = ${s.toFixed(5)}·x ${fmtSigned(tx)},  y' = ${s.toFixed(5)}·y ${fmtSigned(ty)}`
);
console.log(
  `  scale cross-check (bbox): x ${sBboxX.toFixed(5)}, y ${sBboxY.toFixed(5)}` +
    (residual != null ? `   full-path residual: ${residual.toFixed(2)} px` : "")
);
const sOk = Math.abs(sBboxX - s) / s < 0.02 && Math.abs(sBboxY - s) / s < 0.02;
if (!sOk) warn("bbox scale disagrees with first-segment scale by >2% — inspect the fit before trusting positions.");
if (residual != null && residual > 5) warn(`full-path residual ${residual.toFixed(1)} px is high — the affine may be off.`);
if (!markers.length) warn("No numbered markers found — this source map may have none (e.g. Nürburgring); positions must be placed manually.");

console.log(`\n  turn   x       y       source`);
for (const mk of markers) {
  console.log(
    `  ${mk.turn.padEnd(5)}  ${mk.x.toFixed(3)}   ${mk.y.toFixed(3)}   ${mk.via}`
  );
}

console.log(`\n  ready-to-paste (one per marker — merge into compound entries by hand):`);
for (const mk of markers) {
  console.log(`    position: { x: ${mk.x.toFixed(3)}, y: ${mk.y.toFixed(3)} } # T${mk.turn}`);
}
console.log("");

// ---------------------------------------------------------------------------
// geometry + transform helpers
// ---------------------------------------------------------------------------

// 2×3 affine multiply: returns A·B (apply B first, then A).
function mul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}
function apply(M, p) {
  return { x: M[0] * p.x + M[2] * p.y + M[4], y: M[1] * p.x + M[3] * p.y + M[5] };
}
function invert(M) {
  const det = M[0] * M[3] - M[1] * M[2];
  if (!det) fail("Non-invertible transform on the track path.");
  return [
    M[3] / det,
    -M[1] / det,
    -M[2] / det,
    M[0] / det,
    (M[2] * M[5] - M[3] * M[4]) / det,
    (M[1] * M[4] - M[0] * M[5]) / det,
  ];
}

// Parse an SVG transform attribute (possibly several functions) into one matrix.
function parseTransform(str) {
  if (!str) return IDENTITY;
  let M = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(str))) {
    const a = m[2].trim().split(/[\s,]+/).map(Number);
    M = mul(M, fnMatrix(m[1], a));
  }
  return M;
}
function fnMatrix(name, a) {
  switch (name) {
    case "matrix":
      return a.length === 6 ? a : IDENTITY;
    case "translate":
      return [1, 0, 0, 1, a[0] || 0, a[1] || 0];
    case "scale": {
      const sx = a[0] ?? 1;
      return [sx, 0, 0, a[1] ?? sx, 0, 0];
    }
    case "rotate": {
      const r = ((a[0] || 0) * Math.PI) / 180;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      const rot = [cos, sin, -sin, cos, 0, 0];
      if (a.length >= 3) {
        return mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]);
      }
      return rot;
    }
    case "skewX":
      return [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0];
    case "skewY":
      return [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
    default:
      return IDENTITY;
  }
}

// On-curve (anchor) points of a path `d`. Enough for affine fit + dot centre.
// Handles M/L/H/V/C/S/Q/T/A/Z (abs + rel). Control points are skipped.
function pathAnchors(d) {
  const pts = [];
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = "";
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "M") {
      cx = rel ? cx + num() : num();
      cy = rel ? cy + num() : num();
      sx = cx;
      sy = cy;
      pts.push({ x: cx, y: cy });
      cmd = rel ? "l" : "L"; // subsequent pairs are implicit line-tos
    } else if (C === "L" || C === "T") {
      cx = rel ? cx + num() : num();
      cy = rel ? cy + num() : num();
      pts.push({ x: cx, y: cy });
    } else if (C === "H") {
      cx = rel ? cx + num() : num();
      pts.push({ x: cx, y: cy });
    } else if (C === "V") {
      cy = rel ? cy + num() : num();
      pts.push({ x: cx, y: cy });
    } else if (C === "C") {
      i += 4; // skip two control points
      cx = rel ? cx + num() : num();
      cy = rel ? cy + num() : num();
      pts.push({ x: cx, y: cy });
    } else if (C === "S" || C === "Q") {
      i += 2; // skip one control point
      cx = rel ? cx + num() : num();
      cy = rel ? cy + num() : num();
      pts.push({ x: cx, y: cy });
    } else if (C === "A") {
      i += 5; // rx ry x-rot large-arc sweep (flags assumed whitespace-separated)
      cx = rel ? cx + num() : num();
      cy = rel ? cy + num() : num();
      pts.push({ x: cx, y: cy });
    } else if (C === "Z") {
      cx = sx;
      cy = sy;
    } else {
      i++; // unknown — skip defensively
    }
  }
  return pts;
}

// Collect every dot-shaped element (circle/ellipse/path) in a subtree.
function collectDots(node, out) {
  if (!node) return;
  for (const c of node.children ?? []) {
    if (c.type === "element" && ["circle", "ellipse", "path"].includes(c.name)) out.push(c);
    collectDots(c, out);
  }
}

// Centre of a marker dot, in its own local coordinates.
function dotCentre(node) {
  if (node.name === "circle" || node.name === "ellipse") {
    return { x: Number(node.attributes.cx), y: Number(node.attributes.cy) };
  }
  const b = bbox(pathAnchors(node.attributes.d || ""));
  return { x: b.minX + b.w / 2, y: b.minY + b.h / 2 };
}

function bbox(pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}
function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

// Concatenate all text/cdata descendants of a node.
function textContent(node) {
  if (node.type === "text" || node.type === "cdata") return node.value ?? "";
  return (node.children ?? []).map(textContent).join("");
}
function firstTspanCoord(node, key) {
  for (const c of node.children ?? []) {
    if (c.type === "element" && c.attributes?.[key] != null) return c.attributes[key];
    const nested = firstTspanCoord(c, key);
    if (nested != null) return nested;
  }
  return null;
}

// ---------------------------------------------------------------------------
// minimal SVG/XML parser — produces an SVGO-shaped tree
// ({type:'root'|'element'|'text', name?, attributes?, children?, value?}).
// These files are clean, well-formed XML from Inkscape/SVGO, so a stack-based
// tag scanner is sufficient; it is NOT a general XML parser.
// ---------------------------------------------------------------------------
function parseSvg(text) {
  text = text
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const root = { type: "root", children: [] };
  const stack = [root];
  const tagRe = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(text))) {
    if (m.index > last) {
      const t = text.slice(last, m.index);
      if (t.trim()) stack[stack.length - 1].children.push({ type: "text", value: decode(t) });
    }
    last = tagRe.lastIndex;
    const [, close, name, rawAttrs] = m;
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    let attrStr = rawAttrs;
    let selfClose = false;
    if (/\/\s*$/.test(attrStr)) {
      selfClose = true;
      attrStr = attrStr.replace(/\/\s*$/, "");
    }
    const el = { type: "element", name, attributes: parseAttrs(attrStr), children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}
function parseAttrs(str) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g;
  let m;
  while ((m = re.exec(str))) attrs[m[1]] = decode(m[2].slice(1, -1));
  return attrs;
}
function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function fmtSigned(n) {
  return n >= 0 ? `+ ${n.toFixed(3)}` : `- ${Math.abs(n).toFixed(3)}`;
}
function warn(msg) {
  console.warn(`  ⚠️  ${msg}`);
}
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
