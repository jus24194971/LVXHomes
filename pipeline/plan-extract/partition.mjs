#!/usr/bin/env node
/** Partition the footprint into NON-overlapping rooms: each floor pixel -> its nearest
 *  localized room center (Chebyshev in the building frame = axis-aligned walls). Kitchen
 *  anchored to the flight start. Then level + crop + sharpen. -> _partition.png */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const ANG = parseFloat(process.argv[2] || "-27.5"), FLOP = (process.argv[3] || "1") === "1", TH0 = 27.5;
const { ftw, fth, flight } = JSON.parse(fs.readFileSync(dir + "/_rooms.json", "utf8"));
const loc = JSON.parse(fs.readFileSync(dir + "/_localize.json", "utf8"));

const seeds = [
  { label: "Kitchen", feet: flight[0] },            // user's hard anchor: kitchen = flight start
  { label: "Living", feet: loc["0010"].feet },
  { label: "Guest Bath", feet: loc["0011"].feet },
  { label: "Bonus", feet: loc["0012"].feet },
  { label: "Master Bed", feet: loc["0013"].feet },
  { label: "Master Bath", feet: loc["0014"].feet },
];
const c0 = Math.cos(TH0 * Math.PI / 180), s0 = Math.sin(TH0 * Math.PI / 180);
const rot = ([x, y]) => [x * c0 + y * s0, -x * s0 + y * c0];
const seedR = seeds.map((s) => ({ label: s.label, r: rot(s.feet) }));
const cols = { Kitchen: [92, 155, 255], Living: [92, 255, 143], "Guest Bath": [255, 210, 77], Bonus: [255, 92, 92], "Master Bed": [217, 140, 255], "Master Bath": [77, 217, 217] };

const photo = fs.existsSync(dir + "/_overview_filled.jpg") ? dir + "/_overview_filled.jpg" : dir + "/_overview_hd.jpg";
const { data, info } = await sharp(photo).raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, ch = info.channels;
const overlay = Buffer.alloc(W * H * 4, 0);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * ch;
  if (data[i] + data[i + 1] + data[i + 2] <= 34) continue; // outside footprint
  const [rx, ry] = rot([x / W * ftw, y / H * fth]);
  let best = seedR[0], bd = Infinity;
  for (const s of seedR) { const d = Math.max(Math.abs(rx - s.r[0]), Math.abs(ry - s.r[1])); if (d < bd) { bd = d; best = s; } }
  const c = cols[best.label], o = (y * W + x) * 4;
  overlay[o] = c[0]; overlay[o + 1] = c[1]; overlay[o + 2] = c[2]; overlay[o + 3] = 96;
}
const ov = await sharp(overlay, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
const comp = await sharp(photo).composite([{ input: ov }]).png().toBuffer();
let rb = await sharp(comp).rotate(ANG, { background: { r: 0, g: 0, b: 0 } }).png().toBuffer();
if (FLOP) rb = await sharp(rb).flop().png().toBuffer();
const rm = await sharp(rb).metadata(), Wn = rm.width, Hn = rm.height;
const { data: d2, info: i2 } = await sharp(rb).raw().toBuffer({ resolveWithObject: true }), ch2 = i2.channels;
let minx = Wn, miny = Hn, maxx = 0, maxy = 0;
for (let y = 0; y < Hn; y++) for (let x = 0; x < Wn; x++) { const i = (y * Wn + x) * ch2; if (d2[i] + d2[i + 1] + d2[i + 2] > 34) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; } }
await sharp(rb).extract({ left: minx, top: miny, width: maxx - minx, height: maxy - miny }).sharpen({ sigma: 1.1 }).modulate({ brightness: 1.05, saturation: 1.1 }).resize(920).png().toFile(dir + "/_partition.png");
console.log(`partition: 6 rooms (kitchen=flight-start), Chebyshev tiling, leveled ${ANG}° + cropped + sharpened -> _partition.png`);
console.log("legend: kitchen=blue living=green guestbath=yellow bonus=red masterbed=purple masterbath=cyan");
const feetW = Math.round((maxx - minx) * ftw / W * 10) / 10, feetH = Math.round((maxy - miny) * fth / H * 10) / 10;
fs.writeFileSync(dir + "/_plan_meta.json", JSON.stringify({ feetW, feetH }));
console.log(`plan dims: ${feetW} x ${feetH} ft -> _plan_meta.json`);
