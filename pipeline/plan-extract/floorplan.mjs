#!/usr/bin/env node
/** Composite the localized room outlines onto the RAW top-down, then level (VSLAM axis),
 *  mirror, crop to footprint, sharpen — rooms ride the same transform so they stay locked
 *  to their objects. legend: kitchen=blue living=green guestbath=yellow bonus=red masterbed=purple masterbath=cyan */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const ANG = parseFloat(process.argv[2] || "-27.5"), FLOP = (process.argv[3] || "1") === "1";
const { ftw, fth } = JSON.parse(fs.readFileSync(dir + "/_rooms.json", "utf8"));
const zones = JSON.parse(fs.readFileSync(dir + "/_zones.json", "utf8"));
const photo = dir + "/_overview_hd.jpg";
const meta = await sharp(photo).metadata(), Wr = meta.width, Hr = meta.height;
const Xr = (x) => (x / ftw * Wr).toFixed(1), Yr = (y) => (y / fth * Hr).toFixed(1);
const cols = { Kitchen: "#5c9bff", Living: "#5cff8f", "Guest Bath": "#ffd24d", Bonus: "#ff5c5c", "Master Bed": "#d98cff", "Master Bath": "#4dd9d9" };

let svg = `<svg width="${Wr}" height="${Hr}" xmlns="http://www.w3.org/2000/svg">`;
zones.forEach((z) => { svg += `<polygon points="${z.points.map((p) => `${Xr(p[0])},${Yr(p[1])}`).join(" ")}" fill="${cols[z.label] || "#fff"}" fill-opacity="0.12" stroke="${cols[z.label] || "#fff"}" stroke-width="3.5"/>`; });
svg += `</svg>`;
const comp = await sharp(photo).composite([{ input: Buffer.from(svg) }]).png().toBuffer();

let rb = await sharp(comp).rotate(ANG, { background: { r: 0, g: 0, b: 0 } }).png().toBuffer();
if (FLOP) rb = await sharp(rb).flop().png().toBuffer();
const rmeta = await sharp(rb).metadata(), Wn = rmeta.width, Hn = rmeta.height;
const { data, info } = await sharp(rb).raw().toBuffer({ resolveWithObject: true }), ch = info.channels;
let minx = Wn, miny = Hn, maxx = 0, maxy = 0;
for (let y = 0; y < Hn; y++) for (let x = 0; x < Wn; x++) { const i = (y * Wn + x) * ch; if (data[i] + data[i + 1] + data[i + 2] > 34) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; } }
const cw = maxx - minx, cT = maxy - miny;

await sharp(rb).extract({ left: minx, top: miny, width: cw, height: cT })
  .sharpen({ sigma: 1.2 }).modulate({ brightness: 1.06, saturation: 1.12 }).resize(920).png().toFile(dir + "/_floorplan.png");
console.log(`floorplan: leveled ${ANG}° flop${FLOP ? 1 : 0} · cropped ${cw}x${cT} · sharpened · ${zones.length} rooms`);
console.log("legend: kitchen=blue living=green guestbath=yellow bonus=red masterbed=purple masterbath=cyan");
