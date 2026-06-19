#!/usr/bin/env node
/**
 * Project one still's HorizonNet room layout onto the overview, solving Δ — the fixed
 * offset between the drone gimbal frame and the VSLAM/overview frame.
 *   θ_total = gimbalYaw + preprocessYaw + Δ   (per room)
 * Solve θ_total on this room by snapping its detected walls to the building axis,
 * then Δ = θ_total − gimbalYaw − preprocessYaw is reusable for every other still.
 *
 *   node project-still.mjs <id=0012> <ceilFt=9> <axisDeg=27.5> <camX> <camY> <rot=0> <flip=0>
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const ID = process.argv[2] || "0012";
const CEIL = parseFloat(process.argv[3] || "9");
const AXIS = parseFloat(process.argv[4] || "27.5");
const CAMX = parseFloat(process.argv[5] || "17");
const CAMY = parseFloat(process.argv[6] || "17");
const ROT = parseFloat(process.argv[7] || "0");
const FLIP = (process.argv[8] || "0") === "1";

const stills = JSON.parse(fs.readFileSync(path.join(dir, "_stills.json"), "utf8"));
const gimbalYaw = parseFloat(stills.find((s) => s.id === ID).gimbalYaw);
const layout = JSON.parse(fs.readFileSync(path.join(dir, `_layout_${ID}.json`), "utf8"));
const { ftw, fth } = JSON.parse(fs.readFileSync(path.join(dir, "_rooms.json"), "utf8"));

// 1. preprocess yaw: circular cross-correlation of the horizon band, orig vs aligned
async function prof(p) {
  const { data, info } = await sharp(p).greyscale().resize(1024, 512, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, a = new Float64Array(W);
  for (let x = 0; x < W; x++) { let s = 0; for (let y = 200; y < 312; y++) s += data[y * W + x]; a[x] = s; }
  return a;
}
const oa = await prof(path.join(dir, `_orig_${ID}.png`)), ob = await prof(path.join(dir, `_aligned_${ID}.png`));
const n = oa.length, am = oa.reduce((s, v) => s + v) / n, bm = ob.reduce((s, v) => s + v) / n;
let shift = 0, bv = -Infinity;
for (let s = 0; s < n; s++) { let c = 0; for (let i = 0; i < n; i++) c += (oa[i] - am) * (ob[(i + s) % n] - bm); if (c > bv) { bv = c; shift = s; } }
const preprocessDeg = (shift / n) * 360;

// 2. floor polygon from layout corners (camera at origin, feet)
const z0 = layout.z0, z1 = Math.abs(layout.z1), camH = CEIL * z1 / (z0 + z1);
const floor = layout.uv.filter((_, i) => i % 2 === 1);
const poly = floor.map(([u, v]) => {
  const lon = (u - 0.5) * 2 * Math.PI, lat = (0.5 - v) * Math.PI;
  const d = camH / Math.tan(Math.abs(lat));
  return [Math.sin(lon) * d, Math.cos(lon) * d];
});

// 3. solve θ_total: snap the polygon's dominant wall to the building axis
const hist = new Array(180).fill(0);
for (let i = 0; i < poly.length; i++) {
  const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  hist[Math.round((((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI) % 90) + 90) % 90 * 2) % 180] += len;
}
let bi = 0; for (let i = 0; i < 180; i++) if (hist[i] > hist[bi]) bi = i;
const polyAxis = bi / 2;
const thetaTotal = AXIS - polyAxis;
const delta = ((thetaTotal - gimbalYaw + preprocessDeg) % 360 + 360) % 360;
const delta90 = ((delta % 90) + 90) % 90; // the frame offset is only defined mod 90 (Manhattan)

// 4. orient + place
const r = thetaTotal * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
const placed = poly.map(([x, y]) => [CAMX + x * cs - y * sn, CAMY + x * sn + y * cs]);
const w = Math.max(...poly.map((p) => p[0])) - Math.min(...poly.map((p) => p[0]));
const h = Math.max(...poly.map((p) => p[1])) - Math.min(...poly.map((p) => p[1]));
console.log(`[${ID}] camH ${camH.toFixed(2)}ft · room ~${w.toFixed(1)}×${h.toFixed(1)}ft · preprocess ${preprocessDeg.toFixed(1)}° · polyAxis ${polyAxis.toFixed(1)}° · θtotal ${thetaTotal.toFixed(1)}° · gimbal ${gimbalYaw}° · **Δ ${delta.toFixed(1)}°**`);

// 5. overlay on the overview
const photo = path.join(dir, "_fused.jpg"), meta = await sharp(photo).metadata();
const W = meta.width, H = meta.height, X = (x) => (x / ftw * W).toFixed(1), Y = (y) => (y / fth * H).toFixed(1);
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
svg += `<polygon points="${placed.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="#39ff88" fill-opacity="0.22" stroke="#39ff88" stroke-width="3.5"/>`;
svg += `<circle cx="${X(CAMX)}" cy="${Y(CAMY)}" r="5" fill="#ff3333"/></svg>`;
let v = sharp(await sharp(photo).composite([{ input: Buffer.from(svg) }]).png().toBuffer());
if (ROT) v = v.rotate(ROT, { background: { r: 12, g: 12, b: 12 } });
if (FLIP) v = v.flop();
await v.resize(900).png().toFile(path.join(dir, `_project_${ID}.png`));
console.log(`viz -> _project_${ID}.png`);
