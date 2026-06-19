#!/usr/bin/env node
/**
 * roofline-axis — derive a building's TRUE orientation from the georeferenced drone
 * aerial, so we can lock a floorplan's axis with NO published plan / MLS listing.
 *
 * The aerial base is reprojected north-up (image x=East, y=South) from the OUTDOOR
 * aerial 360, where the compass is clean. The dominant roof/wall edge direction is the
 * building axis. Sobel the image, histogram gradient angles mod 90 (weighted by edge
 * strength), report the peak = the building's rotation from cardinal (0 = N-S/E-W).
 *
 *   node roofline-axis.mjs <aerial-base.jpg> [--min 24]
 */
import sharp from "sharp";

const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MIN = parseFloat(A("min", "24"));               // skip near-black (too-oblique) pixels
const { data: g, info } = await sharp(process.argv[2]).greyscale().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, at = (x, y) => g[y * W + x];

const hist = new Float64Array(180);                    // 0.5° bins over [0,90)
let n = 0;
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  const c = at(x, y); if (c < MIN) continue;
  const l = at(x - 1, y), r = at(x + 1, y), u = at(x, y - 1), d = at(x, y + 1);
  if (l < MIN || r < MIN || u < MIN || d < MIN) continue;     // skip mask boundary edges
  const gx = r - l, gy = d - u, mag = Math.hypot(gx, gy);
  if (mag < 20) continue;                              // weak edge
  let a = (Math.atan2(gy, gx) * 180) / Math.PI;
  a = ((a % 90) + 90) % 90;                            // mod 90 — orthogonal building grid
  hist[Math.round(a * 2) % 180] += mag; n++;
}
const sm = new Float64Array(180);                      // circular smooth over [0,90)
for (let i = 0; i < 180; i++) { let s = 0; for (let k = -3; k <= 3; k++) s += hist[(((i + k) % 180) + 180) % 180]; sm[i] = s; }
let bi = 0; for (let i = 0; i < 180; i++) if (sm[i] > sm[bi]) bi = i;
let axis = bi / 2; if (axis > 45) axis -= 90;          // report in [-45,45] from cardinal
const peak = sm[bi], mean = sm.reduce((a, b) => a + b, 0) / 180;

console.log(`roofline-axis · ${n} edge px · building axis ${axis.toFixed(1)}° from cardinal`);
console.log(`  peak/mean ${(peak / mean).toFixed(1)}  (>~3 = clear dominant grid; ~1 = no clear axis)`);
console.log(`  -> lock the plan with  --axisFrom pca --axis ${axis.toFixed(1)}`);
