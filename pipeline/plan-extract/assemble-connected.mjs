#!/usr/bin/env node
/**
 * Connected floorplan: the 6 true-scale rooms tiled ADJACENT (the schematic Justin loved),
 * placed into the raw plan frame at the building axis so the editor's rot+flip shows it
 * north-up. Rooms share walls; flight path threaded. -> _zones.json + _connected.png
 *   node assemble-connected.mjs [gridRotDeg=27.5] [gflip=0]
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const CEIL = 9, ROT = 300, FLIP = 1;
const GRIDROT = parseFloat(process.argv[2] || "27.5"), GFLIP = (process.argv[3] || "0") === "1";
const { ftw, fth, flight } = JSON.parse(fs.readFileSync(dir + "/_rooms.json", "utf8"));

const size = (id) => {
  const L = JSON.parse(fs.readFileSync(`${dir}/_layout_${id}.json`, "utf8"));
  const z0 = L.z0, z1 = Math.abs(L.z1), camH = CEIL * z1 / (z0 + z1);
  const f = L.uv.filter((_, i) => i % 2 === 1).map(([u, v]) => {
    const lon = (u - 0.5) * 2 * Math.PI, lat = (0.5 - v) * Math.PI, d = camH / Math.tan(Math.abs(lat));
    return [Math.sin(lon) * d, Math.cos(lon) * d];
  });
  const xs = f.map((p) => p[0]), ys = f.map((p) => p[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
const R = { kitchen: size("0009"), living: size("0010"), guest: size("0011"), bonus: size("0012"), master: size("0013"), mbath: size("0014") };
const openW = Math.max(R.kitchen.w, R.living.w), openH = Math.max(R.kitchen.h, R.living.h);
const leftW = Math.max(R.bonus.w, R.guest.w), rightW = Math.max(R.master.w, R.mbath.w);
const livH = openH * R.living.h / (R.living.h + R.kitchen.h);

// connected 3×2 grid, local north-up, top-left origin: [x,y,w,h,label,id]
const cells = [
  [0, 0, leftW, R.bonus.h, "Bonus", "0012"],
  [0, R.bonus.h, leftW, R.guest.h, "Guest Bath", "0011"],
  [leftW, 0, openW, livH, "Living", "0010"],
  [leftW, livH, openW, openH - livH, "Kitchen", "0009"],
  [leftW + openW, 0, rightW, R.master.h, "Master Bed", "0013"],
  [leftW + openW, R.master.h, rightW, R.mbath.h, "Master Bath", "0014"],
];
const totW = leftW + openW + rightW, totH = openH;

// place into raw plan feet: center the grid on the footprint, rotate to the building axis
const r = GRIDROT * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
const place = ([x, y]) => { let lx = x - totW / 2, ly = y - totH / 2; if (GFLIP) lx = -lx; return [ftw / 2 + lx * c - ly * s, fth / 2 + lx * s + ly * c]; };
const zones = cells.map(([x, y, w, h, label, id]) => ({
  label, id, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map(place).map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]),
}));
fs.writeFileSync(dir + "/_zones.json", JSON.stringify(zones, null, 1));

// verify render (display orientation)
const photo = dir + "/_fused.jpg", meta = await sharp(photo).metadata();
const W = meta.width, H = meta.height, X = (x) => (x / ftw * W).toFixed(1), Y = (y) => (y / fth * H).toFixed(1);
const cols = ["#ff5c5c", "#ffd24d", "#5cff8f", "#5c9bff", "#d98cff", "#4dd9d9"];
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
zones.forEach((z, i) => { svg += `<polygon points="${z.points.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="${cols[i]}" fill-opacity="0.3" stroke="${cols[i]}" stroke-width="3"/>`; });
svg += `<polyline points="${flight.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.55"/></svg>`;
let v = sharp(await sharp(photo).composite([{ input: Buffer.from(svg) }]).png().toBuffer());
if (ROT) v = v.rotate(ROT, { background: { r: 12, g: 12, b: 12 } });
if (FLIP) v = v.flop();
await v.resize(950).png().toFile(dir + "/_connected.png");
console.log(`connected ${totW.toFixed(1)}×${totH.toFixed(1)}ft @ ${GRIDROT}° flip${GFLIP ? 1 : 0} -> _connected.png`);
