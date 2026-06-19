#!/usr/bin/env node
/** Downsample the 6 full-res stills to 2048×1024 for HorizonNet upload. */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/Videos/The George 360/Interior 1112";
const out = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const files = fs.readdirSync(dir).filter((f) => /_\d{4}_D\.JPG$/i.test(f)).sort();
for (const f of files) {
  const id = f.match(/_(\d{4})_D/)[1];
  await sharp(path.join(dir, f), { limitInputPixels: 300000000 })
    .resize(2048, 1024, { fit: "fill" }).jpeg({ quality: 88 })
    .toFile(path.join(out, `_still_hd_${id}.jpg`));
  console.log(`${id} -> _still_hd_${id}.jpg`);
}
