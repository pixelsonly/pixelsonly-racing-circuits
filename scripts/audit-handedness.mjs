// Handedness audit — nominates corners whose YAML `direction` disagrees with the
// track centerline geometry, so a human can confirm against a source.
//
//   npm run build && npm run audit:handedness
//
// Method (see also the corner-handedness notes in the dev memory):
//   1. Flatten each layout's map.svg <path> into a dense polyline. All maps use
//      the 0 0 1000 1000 viewBox, so a corner's normalized position * 1000 lands
//      on the path.
//   2. For each corner with a single direction (left|right) and a position,
//      measure the SIGNED heading change through the corner at two arclength
//      windows (tight + wide), plus the apex-chord cross product of the
//      neighbouring markers. y-down convention: + = right, - = left.
//   3. Calibrate the per-track sign by majority agreement with the YAML — this
//      auto-detects maps whose <path> is drawn in REVERSED race order.
//   4. Flag mismatches and grade confidence.
//
// IMPORTANT: geometry only NOMINATES. It over-flags on tight clusters (a flick
// between two same-hand corners) and on heavy-compound-corner tracks, where a
// window bleeds into a neighbour. ALWAYS confirm a flag against a written source
// before changing data. HIGH-confidence flags are the ones worth checking first.
//
// Coverage gaps: layouts with no per-corner positions (e.g. Nürburgring,
// Portimão) and compound directions (left-right / right-left / chicane) are not
// geometry-checked and are reported as skipped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SINGLE = new Set(['left', 'right']);
const WIN_WIDE = 0.03;   // ±3% of lap
const WIN_TIGHT = 0.015; // ±1.5% of lap — isolates a corner from close neighbours
const HIGH_ANGLE = 20;   // deg
const HIGH_DIST = 40;    // px (in the 1000-unit viewBox)

// ---- SVG path flattener (M m L l H h V v C c S s Q q T t A a Z z) ----------
function flatten(d) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = '', prevCmd = '', pcx = 0, pcy = 0;
  const pts = [];
  const n = () => parseFloat(toks[i++]);
  const push = (x, y) => pts.push([x, y]);
  const cubic = (p0, p1, p2, p3, steps = 24) => {
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      push(u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
           u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]);
    }
  };
  const quad = (p0, p1, p2, steps = 18) => {
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      push(u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0], u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1]);
    }
  };
  const arc = (x1, y1, rx, ry, phiDeg, fa, fs, x2, y2, steps = 32) => {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx === 0 || ry === 0) { push(x2, y2); return; }
    const phi = phiDeg * Math.PI / 180, cP = Math.cos(phi), sP = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cP*dx + sP*dy, y1p = -sP*dx + cP*dy;
    const lam = (x1p*x1p)/(rx*rx) + (y1p*y1p)/(ry*ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const sign = fa === fs ? -1 : 1;
    const num = Math.max(0, rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p);
    const den = rx*rx*y1p*y1p + ry*ry*x1p*x1p;
    const co = sign * Math.sqrt(den === 0 ? 0 : num / den);
    const cxp = co*rx*y1p/ry, cyp = -co*ry*x1p/rx;
    const cxc = cP*cxp - sP*cyp + (x1 + x2)/2;
    const cyc = sP*cxp + cP*cyp + (y1 + y2)/2;
    const ang = (ux, uy, vx, vy) => {
      const dd = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      let c = dd === 0 ? 1 : (ux*vx + uy*vy) / dd;
      c = Math.max(-1, Math.min(1, c));
      return (ux*vy - uy*vx < 0 ? -1 : 1) * Math.acos(c);
    };
    const th1 = ang(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry);
    let dth = ang((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry);
    if (!fs && dth > 0) dth -= 2*Math.PI;
    if (fs && dth < 0) dth += 2*Math.PI;
    for (let s = 1; s <= steps; s++) {
      const t = th1 + dth*(s/steps);
      push(cP*rx*Math.cos(t) - sP*ry*Math.sin(t) + cxc,
           sP*rx*Math.cos(t) + cP*ry*Math.sin(t) + cyc);
    }
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) { prevCmd = cmd; cmd = toks[i++]; }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    if (C === 'M') { let x = n(), y = n(); if (rel) { x += cx; y += cy; } cx = x; cy = y; sx = x; sy = y; push(cx, cy); cmd = rel ? 'l' : 'L'; }
    else if (C === 'L') { let x = n(), y = n(); if (rel) { x += cx; y += cy; } cx = x; cy = y; push(cx, cy); }
    else if (C === 'H') { let x = n(); if (rel) x += cx; cx = x; push(cx, cy); }
    else if (C === 'V') { let y = n(); if (rel) y += cy; cy = y; push(cx, cy); }
    else if (C === 'C') { let x1 = n(), y1 = n(), x2 = n(), y2 = n(), x = n(), y = n(); if (rel) { x1+=cx; y1+=cy; x2+=cx; y2+=cy; x+=cx; y+=cy; } cubic([cx,cy],[x1,y1],[x2,y2],[x,y]); pcx=x2; pcy=y2; cx=x; cy=y; }
    else if (C === 'S') { let x2 = n(), y2 = n(), x = n(), y = n(); if (rel) { x2+=cx; y2+=cy; x+=cx; y+=cy; } const r='CS'.includes(prevCmd.toUpperCase()); cubic([cx,cy],[r?2*cx-pcx:cx, r?2*cy-pcy:cy],[x2,y2],[x,y]); pcx=x2; pcy=y2; cx=x; cy=y; }
    else if (C === 'Q') { let x1 = n(), y1 = n(), x = n(), y = n(); if (rel) { x1+=cx; y1+=cy; x+=cx; y+=cy; } quad([cx,cy],[x1,y1],[x,y]); pcx=x1; pcy=y1; cx=x; cy=y; }
    else if (C === 'T') { let x = n(), y = n(); if (rel) { x+=cx; y+=cy; } const r='QT'.includes(prevCmd.toUpperCase()); quad([cx,cy],[r?2*cx-pcx:cx, r?2*cy-pcy:cy],[x,y]); cx=x; cy=y; }
    else if (C === 'A') { let rx=n(), ry=n(), rot=n(), fa=n(), fs=n(), x=n(), y=n(); if (rel) { x+=cx; y+=cy; } arc(cx,cy,rx,ry,rot,fa,fs,x,y); cx=x; cy=y; }
    else if (C === 'Z') { push(sx, sy); cx = sx; cy = sy; }
    else { i++; }
    prevCmd = cmd;
  }
  return pts;
}

function analyzeLayout(slug, lay) {
  let d;
  try {
    const svg = readFileSync(resolve(ROOT, 'tracks', slug, lay.map_svg), 'utf8');
    d = svg.match(/\sd="([^"]+)"/)[1];
  } catch { return { slug, layout: lay.id, error: 'map.svg unreadable' }; }
  const pts = flatten(d);
  if (pts.length < 10) return { slug, layout: lay.id, error: 'path flatten failed' };
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k-1] + Math.hypot(pts[k][0]-pts[k-1][0], pts[k][1]-pts[k-1][1]));
  const total = cum[cum.length-1];
  if (!(total > 0)) return { slug, layout: lay.id, error: 'zero-length path' };

  const at = (a) => { a = Math.max(0, Math.min(total, a)); let lo = 0, hi = cum.length-1; while (lo < hi) { const m = (lo+hi)>>1; if (cum[m] < a) lo = m+1; else hi = m; } return pts[lo]; };
  const heading = (a, win) => { const A = at(a-win), B = at(a), Cp = at(a+win); const v1=[B[0]-A[0],B[1]-A[1]], v2=[Cp[0]-B[0],Cp[1]-B[1]]; return Math.atan2(v1[0]*v2[1]-v1[1]*v2[0], v1[0]*v2[0]+v1[1]*v2[1]) * 180/Math.PI; };
  const nearest = (px, py) => { let best = 1e9, bi = 0; for (let k = 0; k < pts.length; k++) { const dd = Math.hypot(pts[k][0]-px, pts[k][1]-py); if (dd < best) { best = dd; bi = k; } } return { dist: best, arc: cum[bi] }; };

  const placed = (lay.corners || []).filter(co => co.position);
  const rows = placed.map((co) => {
    const px = co.position.x*1000, py = co.position.y*1000;
    const nr = nearest(px, py);
    return { co, px, py, arc: nr.arc, dist: nr.dist, wide: heading(nr.arc, total*WIN_WIDE), tight: heading(nr.arc, total*WIN_TIGHT) };
  });
  rows.forEach((r, j) => {
    const prev = rows[(j-1+rows.length)%rows.length], next = rows[(j+1)%rows.length];
    const v1 = [r.px-prev.px, r.py-prev.py], v2 = [next.px-r.px, next.py-r.py];
    r.chord = v1[0]*v2[1] - v1[1]*v2[0];
  });

  const singles = rows.filter(r => SINGLE.has(r.co.direction) && Math.abs(r.wide) > 1e-6);
  const agreeUnder = (flip) => singles.filter(r => ((flip ? -r.wide : r.wide) > 0 ? 'right' : 'left') === r.co.direction).length;
  const aN = agreeUnder(false), aF = agreeUnder(true), flip = aF > aN;
  const dir = (v) => ((flip ? -v : v) > 0 ? 'right' : 'left');

  const flags = [];
  for (const r of singles) {
    if (dir(r.wide) === r.co.direction) continue; // agrees with YAML
    const tightAgreesYaml = dir(r.tight) === r.co.direction;
    const chordAgreesYaml = dir(r.chord) === r.co.direction;
    // HIGH: wide, tight, and apex-chord all disagree with the YAML, with a
    // meaningful turn angle and a good marker-to-path match.
    const high = !tightAgreesYaml && !chordAgreesYaml &&
                 Math.abs(r.wide) >= HIGH_ANGLE && r.dist <= HIGH_DIST;
    flags.push({
      number: r.co.number, name: r.co.name, yaml: r.co.direction,
      geom: dir(r.wide), level: high ? 'HIGH' : 'low',
      wideDeg: +r.wide.toFixed(1), tightDeg: +r.tight.toFixed(1),
      tightFlips: !tightAgreesYaml, chordFlips: !chordAgreesYaml,
      matchDist: +r.dist.toFixed(1),
    });
  }
  const skipped = (lay.corners || []).filter(co => !co.position || !SINGLE.has(co.direction))
    .map(co => `${co.number}:${co.position ? co.direction : 'no-position'}`);
  return {
    slug, layout: lay.id, singles: singles.length, agree: Math.max(aN, aF),
    reversed: flip, flags, skipped,
  };
}

// ---------------------------------------------------------------------------
let circuits;
try { circuits = JSON.parse(readFileSync(resolve(ROOT, 'build/circuits.json'), 'utf8')); }
catch { console.error('build/circuits.json not found — run `npm run build` first.'); process.exit(2); }

const results = [];
for (const c of circuits) for (const lay of c.layouts || []) if (lay.map_svg) results.push(analyzeLayout(c.slug, lay));

let high = 0, low = 0;
const noPos = [];
console.log('Handedness audit (geometry NOMINATES — confirm every flag against a source)\n');
for (const r of results) {
  if (r.error) { console.log(`  ${r.slug}/${r.layout}: ERROR ${r.error}`); continue; }
  if (r.singles === 0) { noPos.push(r.slug); continue; }
  const realFlags = r.flags;
  high += realFlags.filter(f => f.level === 'HIGH').length;
  low += realFlags.filter(f => f.level === 'low').length;
  if (!realFlags.length) continue;
  const pct = r.agree / r.singles;
  const weak = pct < 0.8 ? '  !! WEAK CALIBRATION — flags unreliable (compound corners / draw order); review the whole track visually' : '';
  console.log(`${r.slug}/${r.layout}  agree ${r.agree}/${r.singles}  draw:${r.reversed ? 'REVERSED' : 'normal'}${weak}`);
  for (const f of realFlags.sort((a, b) => (a.level === b.level ? Math.abs(b.wideDeg) - Math.abs(a.wideDeg) : a.level === 'HIGH' ? -1 : 1))) {
    const mark = f.level === 'HIGH' ? '  >>> HIGH ' : '      low  ';
    console.log(`${mark}T${f.number} "${f.name}": YAML=${f.yaml} geom=${f.geom} | wide=${f.wideDeg}° tight=${f.tightDeg}° tightFlips=${f.tightFlips} chordFlips=${f.chordFlips} matchDist=${f.matchDist}px`);
  }
}
console.log(`\nSummary: ${high} HIGH-confidence flag(s), ${low} low-confidence flag(s).`);
if (noPos.length) console.log(`No per-corner positions (not geometry-checkable): ${noPos.join(', ')}`);
console.log('HIGH = wide+tight+apex-chord all disagree with the YAML, |angle|>=20°, good map match. Still verify against a source before editing.');
