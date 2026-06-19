#!/usr/bin/env node
/** Fill the black MVS holes in the top-down: each black pixel takes the average of its
 *  non-black 8-neighbors, iterated, so the floor reads continuous. Far-outside stays black
 *  (won't be reached in the pass budget) so the footprint crop still works. -> _overview_filled.jpg */
import fs from "node:fs";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const PASSES = parseInt(process.argv[2] || "70", 10);
const { data, info } = await sharp(dir + "/_overview_hd.jpg").raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, ch = info.channels;
const buf = Buffer.from(data);
const black = (i) => buf[i] + buf[i + 1] + buf[i + 2] <= 34;
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

for (let p = 0; p < PASSES; p++) {
  let cnt = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * ch;
    if (!black(i)) continue;
    let r = 0, g = 0, b = 0, n = 0;
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = (ny * W + nx) * ch;
      if (!black(j)) { r += buf[j]; g += buf[j + 1]; b += buf[j + 2]; n++; }
    }
    if (n > 0) { buf[i] = (r / n) | 0; buf[i + 1] = (g / n) | 0; buf[i + 2] = (b / n) | 0; cnt++; }
  }
  if (cnt === 0) break;
}
await sharp(buf, { raw: { width: W, height: H, channels: ch } }).jpeg({ quality: 90 }).toFile(dir + "/_overview_filled.jpg");
console.log(`filled holes (${PASSES} passes) -> _overview_filled.jpg`);
