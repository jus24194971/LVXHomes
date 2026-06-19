#!/usr/bin/env node
/**
 * Reconcile cached room polys (rooms.json) into clean axis-aligned consensus walls.
 * Edge-cluster by line, weight by proximity (near pano wins), snap to the building axis.
 * Pure JS geometry — iterate locally in seconds, no GPU.
 *
 *   node reduce-walls.mjs <rooms.json> <fused.jpg> [minScore=0.22] [minExt=3.0] [tolDeg=20]
 *   -> _walls.json (feet strokes) + _reduce_viz.png (walls over the photo)
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const roomsPath = process.argv[2] || "_rooms.json";
const photoPath = process.argv[3] || "_fused.jpg";
const MINSCORE = parseFloat(process.argv[4] || "0.22"); // fraction of strongest line
const MINEXT = parseFloat(process.argv[5] || "3.0");    // min wall length (ft)
const TOLDEG = parseFloat(process.argv[6] || "20");     // max deviation from axis to count
const MAXWALLS = parseInt(process.argv[7] || "14", 10); // keep only the N strongest walls

const data = JSON.parse(fs.readFileSync(roomsPath, "utf8"));
const { ftw, fth, rooms, flight } = data;
const dir = path.dirname(roomsPath);

// 1. all polygon edges, weighted by proximity to the pano that drew them
const edges = [];
for (const rm of rooms) {
  const poly = rm.poly, cam = rm.cam;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1.0) continue;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const dist = Math.hypot(mid[0] - cam[0], mid[1] - cam[1]);
    edges.push({ a, b, dx, dy, len, mid, w: 1 / (1 + dist / 6), ang: Math.atan2(dy, dx) });
  }
}

// 2. global building axis: weighted angle histogram mod 90 (0.5deg bins)
const hist = new Array(180).fill(0);
for (const e of edges) { const d = (((e.ang * 180 / Math.PI) % 90) + 90) % 90; hist[Math.round(d * 2) % 180] += e.len * e.w; }
let bi = 0; for (let i = 0; i < 180; i++) if (hist[i] > hist[bi]) bi = i;
const th0 = (bi / 2) * Math.PI / 180;
const c0 = Math.cos(th0), s0 = Math.sin(th0);
const lineAngDiff = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };

// 3. snap each edge to the nearer axis, bin by perpendicular position
const PERPBIN = 0.5, TOL = TOLDEG * Math.PI / 180;
const lines = { 0: new Map(), 1: new Map() };
for (const e of edges) {
  const d0 = lineAngDiff(e.ang, th0), d1 = lineAngDiff(e.ang, th0 + Math.PI / 2);
  let axis, perp, al0, al1;
  if (d0 < d1) {
    if (d0 > TOL) continue; axis = 0;
    perp = e.mid[0] * (-s0) + e.mid[1] * c0; al0 = e.a[0] * c0 + e.a[1] * s0; al1 = e.b[0] * c0 + e.b[1] * s0;
  } else {
    if (d1 > TOL) continue; axis = 1;
    perp = e.mid[0] * c0 + e.mid[1] * s0; al0 = e.a[0] * (-s0) + e.a[1] * c0; al1 = e.b[0] * (-s0) + e.b[1] * c0;
  }
  const key = Math.round(perp / PERPBIN), m = lines[axis];
  if (!m.has(key)) m.set(key, { wlen: 0, perpW: 0, amin: 1e9, amax: -1e9 });
  const sl = m.get(key);
  sl.wlen += e.len * e.w; sl.perpW += perp * e.len * e.w;
  sl.amin = Math.min(sl.amin, al0, al1); sl.amax = Math.max(sl.amax, al0, al1);
}

// 4. candidate lines -> filter by strength + length -> merge near-parallel
let cand = [];
for (const axis of [0, 1]) for (const [, sl] of lines[axis])
  cand.push({ axis, perp: sl.perpW / sl.wlen, score: sl.wlen, amin: sl.amin, amax: sl.amax, ext: sl.amax - sl.amin });
const maxsc = Math.max(...cand.map((c) => c.score), 1e-9);
cand = cand.filter((c) => c.score >= maxsc * MINSCORE && c.ext >= MINEXT).sort((a, b) => b.score - a.score);
const kept = [];
for (const c of cand) {
  const near = kept.find((k) => k.axis === c.axis && Math.abs(k.perp - c.perp) < 1.2);
  if (near) { near.amin = Math.min(near.amin, c.amin); near.amax = Math.max(near.amax, c.amax); }
  else kept.push({ ...c });
}
kept.sort((a, b) => b.score - a.score);
const top = kept.slice(0, MAXWALLS);

// 5. back to feet endpoints
const seg = (c) => {
  const ua = c.axis === 0 ? [c0, s0] : [-s0, c0], up = c.axis === 0 ? [-s0, c0] : [c0, s0];
  return [[c.perp * up[0] + c.amin * ua[0], c.perp * up[1] + c.amin * ua[1]],
          [c.perp * up[0] + c.amax * ua[0], c.perp * up[1] + c.amax * ua[1]]];
};
const r2 = (p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
const walls = top.map(seg).map((s) => s.map(r2));
fs.writeFileSync(path.join(dir, "_walls.json"), JSON.stringify(walls));
console.log(`axis ${(th0 * 180 / Math.PI).toFixed(1)}deg · ${edges.length} edges · ${cand.length} lines · ${walls.length} walls`);

// 6. viz: walls (+ faint rooms + flight) composited over the fused photo
const meta = await sharp(photoPath).metadata();
const SC = 960 / meta.width;
const PW = Math.round(meta.width * SC), PH = Math.round(meta.height * SC);
const X = (x) => (x / ftw * PW).toFixed(1), Y = (y) => (y / fth * PH).toFixed(1);
let svg = `<svg width="${PW}" height="${PH}" xmlns="http://www.w3.org/2000/svg">`;
for (const rm of rooms) svg += `<polygon points="${rm.poly.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#19e0e0" stroke-width="0.6" opacity="0.16"/>`;
svg += `<polyline points="${flight.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#ffcc22" stroke-width="2" opacity="0.65"/>`;
for (const w of walls) {
  svg += `<line x1="${X(w[0][0])}" y1="${Y(w[0][1])}" x2="${X(w[1][0])}" y2="${Y(w[1][1])}" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>`;
  svg += `<line x1="${X(w[0][0])}" y1="${Y(w[0][1])}" x2="${X(w[1][0])}" y2="${Y(w[1][1])}" stroke="#1a1410" stroke-width="3" stroke-linecap="round"/>`;
}
svg += `</svg>`;
await sharp(photoPath).resize(PW, PH).composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(dir, "_reduce_viz.png"));
console.log("viz -> _reduce_viz.png");
