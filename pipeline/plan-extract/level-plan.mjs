#!/usr/bin/env node
/** Level the top-down by the VSLAM building axis (27.5°), crop to the footprint
 *  (drop everything outside the unit), and sharpen. -> _leveled.png */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const ANG = parseFloat(process.argv[2] || "-27.5"); // building axis from VSLAM; sign verified by eye
const photo = dir + "/_overview_hd.jpg";

const rotated = await sharp(photo).rotate(ANG, { background: { r: 0, g: 0, b: 0 } }).png().toBuffer();
const { data, info } = await sharp(rotated).raw().toBuffer({ resolveWithObject: true });
const { width: Wr, height: Hr, channels: ch } = info;
let minx = Wr, miny = Hr, maxx = 0, maxy = 0;
for (let y = 0; y < Hr; y++) for (let x = 0; x < Wr; x++) {
  const i = (y * Wr + x) * ch;
  if (data[i] + data[i + 1] + data[i + 2] > 34) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
}
const cw = maxx - minx, cT = maxy - miny;
await sharp(rotated)
  .extract({ left: minx, top: miny, width: cw, height: cT })
  .sharpen({ sigma: 1.2 })
  .modulate({ brightness: 1.06, saturation: 1.12 })
  .resize(920)
  .png()
  .toFile(dir + "/_leveled.png");
console.log(`leveled @ ${ANG}° · cropped to footprint ${cw}x${cT}px · sharpened -> _leveled.png`);
