#!/usr/bin/env node
/** ortho-preview — detect the building axis in an interior orthophoto, rotate it
 *  axis-aligned (north-up look), and trim the black periphery → a clean floorplan-style
 *  preview.  node ortho-preview.mjs <in.jpg> <out.jpg> */
import sharp from "sharp";
const inp = process.argv[2], out = process.argv[3];
const { data, info } = await sharp(inp).greyscale().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, at = (x, y) => data[y * W + x];
const hist = new Float64Array(180);
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  const c = at(x, y); if (c < 20) continue;
  const l = at(x - 1, y), r = at(x + 1, y), u = at(x, y - 1), d = at(x, y + 1);
  if (l < 20 || r < 20 || u < 20 || d < 20) continue;
  const gx = r - l, gy = d - u, m = Math.hypot(gx, gy); if (m < 25) continue;
  const a = (((Math.atan2(gy, gx) * 180) / Math.PI) % 90 + 90) % 90;
  hist[Math.round(a * 2) % 180] += m;
}
let bi = 0; for (let i = 0; i < 180; i++) if (hist[i] > hist[bi]) bi = i;
let ax = bi / 2; if (ax > 45) ax -= 90;
await sharp(inp).rotate(-ax, { background: { r: 0, g: 0, b: 0 } }).trim({ background: "#000000", threshold: 12 }).png().toFile(out);
console.log(`building axis ${ax.toFixed(1)}° → rotated to cardinal + trimmed → ${out}`);
