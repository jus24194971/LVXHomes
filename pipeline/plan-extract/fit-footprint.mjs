#!/usr/bin/env node
/**
 * fit-footprint — gate rooms by the building footprint read off the drone aerial.
 *
 * The roof in the georeferenced aerial tells us where rooms are ALLOWED to be. A room
 * sitting mostly on grass/gravel (low-saturation roof vs saturated vegetation/desert) is
 * a mis-localization — drop it. Kills "rooms projecting outside the home". Roof is the
 * low-saturation gray region; dark (too-oblique) pixels are ignored, not penalised.
 *
 *   node fit-footprint.mjs <in.plan.json> <aerial-base.jpg> <out.plan.json> [--keep 0.4] [--sat 0.18]
 */
import fs from "node:fs";
import sharp from "sharp";

const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const KEEP = parseFloat(A("keep", "0.4"));   // min roof fraction (of non-dark samples) to keep a room
const SATT = parseFloat(A("sat", "0.18"));   // saturation below this = roof/concrete (gray)
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sh = plan.sheets[0];
const { data, info } = await sharp(process.argv[3]).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const BW = info.width, BH = info.height;
const cls = (x, y) => {                       // 1=roof, -1=vegetation/desert, 0=dark/unknown
  const px = Math.max(0, Math.min(BW - 1, x | 0)), py = Math.max(0, Math.min(BH - 1, y | 0));
  const i = (py * BW + px) * 3, r = data[i], g = data[i + 1], b = data[i + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 28) return 0;                       // masked / too-oblique → ignore
  return (mx > 0 ? (mx - mn) / mx : 0) < SATT ? 1 : -1;
};
const toPx = (x, y) => [(x / sh.width) * BW, (y / sh.height) * BH];

const kept = [], dropped = [];
for (const z of sh.zones) {
  let roof = 0, veg = 0;
  for (const [x, y] of z.points) { const c = cls(...toPx(x, y)); if (c > 0) roof++; else if (c < 0) veg++; }
  const cx = z.points.reduce((a, p) => a + p[0], 0) / z.points.length;
  const cy = z.points.reduce((a, p) => a + p[1], 0) / z.points.length;
  const cOnRoof = cls(...toPx(cx, cy)) >= 0;   // centroid not on vegetation
  const frac = roof + veg > 0 ? roof / (roof + veg) : 1;
  if (frac >= KEEP || cOnRoof) kept.push(z);   // keep if mostly-on-roof OR centroid on roof; drop only clearly-off rooms
  else dropped.push({ id: z.label, roofFrac: +frac.toFixed(2), centroidVeg: !cOnRoof });
}
sh.zones = kept;
fs.writeFileSync(process.argv[4], JSON.stringify(plan, null, 2));
console.log(`fit-footprint · kept ${kept.length} / ${kept.length + dropped.length} rooms`);
if (dropped.length) console.log(`  dropped (off-roof): ${dropped.map((d) => `${d.id} roof${d.roofFrac}${d.centroidVeg ? "/cVeg" : ""}`).join(", ")}`);
