#!/usr/bin/env node
/**
 * Wall-projection experiment: fuse FLIGHT data + the OVERVIEW image.
 *  · wall axis  = dominant flight-segment heading (drone flies parallel to walls)
 *  · wall lines = overview edges whose GRADIENT is perpendicular to a wall axis,
 *                 accumulated per perpendicular bin (rejects furniture/texture)
 *  · flight path overlaid = the open space the walls must bound
 *   node wall-project.mjs <fused.jpg> <rooms.json> [rot=300] [flip=1] [edgeThresh=40] [keep=0.30]
 *   -> _project_viz.png  + _walls.json
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const photoPath = process.argv[2] || "_fused.jpg";
const roomsPath = process.argv[3] || "_rooms.json";
const ROT = parseFloat(process.argv[4] || "300");
const FLIP = (process.argv[5] || "1") === "1";
const ETHRESH = parseFloat(process.argv[6] || "40");
const KEEP = parseFloat(process.argv[7] || "0.30");
const dir = path.dirname(roomsPath);

const { ftw, fth, flight } = JSON.parse(fs.readFileSync(roomsPath, "utf8"));

// 1. wall axis from FLIGHT segments (length-weighted heading histogram, mod 90)
const hist = new Array(180).fill(0);
for (let i = 1; i < flight.length; i++) {
  const dx = flight[i][0] - flight[i - 1][0], dy = flight[i][1] - flight[i - 1][1];
  const len = Math.hypot(dx, dy);
  if (len < 0.5) continue;
  hist[Math.round((((Math.atan2(dy, dx) * 180 / Math.PI) % 90) + 90) % 90 * 2) % 180] += len;
}
let bi = 0; for (let i = 0; i < 180; i++) if (hist[i] > hist[bi]) bi = i;
const AXIS = process.argv[8] ? parseFloat(process.argv[8]) : null; // override the wall axis (deg)
const th0 = (AXIS !== null ? AXIS * Math.PI / 180 : (bi / 2) * Math.PI / 180), c0 = Math.cos(th0), s0 = Math.sin(th0);

// 2. overview -> grayscale raw pixels
const { data, info } = await sharp(photoPath).greyscale().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, g = (x, y) => data[y * W + x];
const X = (x) => (x / ftw * W).toFixed(1), Y = (y) => (y / fth * H).toFixed(1); // feet->px for flight

// 3. Sobel; bin wall-aligned edges per perpendicular coordinate, per axis
const axes = [
  { ux: c0, uy: s0, px: -s0, py: c0, bins: new Map() },   // axis0 runs along (c0,s0); perp dir (-s0,c0)
  { ux: -s0, uy: c0, px: c0, py: s0, bins: new Map() },   // axis1
];
const PERPBIN = 2;
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  if (g(x, y) < 12) continue; // no-data (black) cell
  const gx = (g(x + 1, y - 1) + 2 * g(x + 1, y) + g(x + 1, y + 1)) - (g(x - 1, y - 1) + 2 * g(x - 1, y) + g(x - 1, y + 1));
  const gy = (g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1)) - (g(x - 1, y - 1) + 2 * g(x, y - 1) + g(x + 1, y - 1));
  const mag = Math.hypot(gx, gy);
  if (mag < ETHRESH) continue;
  const gnx = gx / mag, gny = gy / mag;
  for (const ax of axes) {
    if (Math.abs(gnx * ax.px + gny * ax.py) < 0.85) continue; // gradient ⟂ wall? (1 = aligned)
    const pc = x * ax.px + y * ax.py, al = x * ax.ux + y * ax.uy, key = Math.round(pc / PERPBIN);
    const b = ax.bins.get(key) || ax.bins.set(key, { w: 0, pc: 0, amin: 1e9, amax: -1e9 }).get(key);
    b.w += mag; b.pc += pc * mag; b.amin = Math.min(b.amin, al); b.amax = Math.max(b.amax, al);
  }
}

// 4. strong lines -> NMS (suppress near-parallel duplicates) -> endpoints
const cand = [];
for (const ax of axes) {
  const maxw = Math.max(...[...ax.bins.values()].map((b) => b.w), 1);
  for (const b of ax.bins.values()) {
    const ext = b.amax - b.amin;
    if (b.w < maxw * KEEP || ext < W * 0.08) continue;
    cand.push({ ax, pc: b.pc / b.w, w: b.w, amin: b.amin, amax: b.amax });
  }
}
cand.sort((a, b) => b.w - a.w);
const kept = [];
for (const c of cand) {
  if (kept.some((k) => k.ax === c.ax && Math.abs(k.pc - c.pc) < 5)) continue;
  kept.push(c);
}
const wallsPx = kept.map((c) => [
  [c.pc * c.ax.px + c.amin * c.ax.ux, c.pc * c.ax.py + c.amin * c.ax.uy],
  [c.pc * c.ax.px + c.amax * c.ax.ux, c.pc * c.ax.py + c.amax * c.ax.uy],
]);
const r2 = (p) => [Math.round(p[0] / W * ftw * 100) / 100, Math.round(p[1] / H * fth * 100) / 100];
fs.writeFileSync(path.join(dir, "_walls.json"), JSON.stringify(wallsPx.map((w) => w.map(r2))));
console.log(`axis ${(th0 * 180 / Math.PI).toFixed(1)}deg (from flight) · ${cand.length} candidates · ${kept.length} walls`);

// 5. viz: projected walls + flight over the overview, in the locked orientation
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
svg += `<polyline points="${flight.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#ffcc22" stroke-width="2" opacity="0.6"/>`;
for (const w of wallsPx) {
  svg += `<line x1="${w[0][0].toFixed(1)}" y1="${w[0][1].toFixed(1)}" x2="${w[1][0].toFixed(1)}" y2="${w[1][1].toFixed(1)}" stroke="#ffffff" stroke-width="5"/>`;
  svg += `<line x1="${w[0][0].toFixed(1)}" y1="${w[0][1].toFixed(1)}" x2="${w[1][0].toFixed(1)}" y2="${w[1][1].toFixed(1)}" stroke="#181410" stroke-width="2"/>`;
}
svg += `</svg>`;
const composited = await sharp(photoPath).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
let v = sharp(composited);
if (ROT) v = v.rotate(ROT, { background: { r: 12, g: 12, b: 12 } });
if (FLIP) v = v.flop();
await v.resize(900).png().toFile(path.join(dir, "_project_viz.png"));
console.log("viz -> _project_viz.png");
