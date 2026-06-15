#!/usr/bin/env node
/**
 * aerial-to-base — turn a high-altitude 360 photo into a georeferenced top-down
 * base for a plan, for when satellite imagery is stale or missing.
 *
 * Reprojects the downward hemisphere of the equirect onto the ground plane,
 * using the drone's GPS (centre), height-above-ground (scale) and heading
 * (rotation), sampled exactly into the plan sheet's GPS bbox — so the existing
 * flight path + amenity dots line up on it. Writes the result into the plan as
 * sheet.satUrl (a data-URL).
 *
 * Usage:
 *   node aerial-to-base.mjs <aerial.JPG> <plan.json> [--out plan.json]
 *        [--heading <deg>] [--flip] [--minDep 20] [--width 1400]
 *
 * Needs `sharp` (for the 120 MP decode/resize).
 */

import fs from "node:fs";
import sharp from "sharp";
import { readDjiMeta } from "./exif-gps.mjs";

const args = process.argv.slice(2);
const aerialPath = args[0];
const planPath = args[1];
if (!aerialPath || !planPath) {
  console.error("usage: node aerial-to-base.mjs <aerial.JPG> <plan.json> [--heading d] [--flip]");
  process.exit(1);
}
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const outPath = opt("out", planPath);
const flip = args.includes("--flip");
const minDep = parseFloat(opt("minDep", "18")); // deg below horizon to keep
const outW = parseInt(opt("width", "1500"), 10);

const meta = readDjiMeta(aerialPath);
if (meta.lat == null || meta.relAlt == null) {
  console.error("aerial photo is missing GPS or RelativeAltitude metadata");
  process.exit(1);
}
const heading = parseFloat(opt("heading", String(meta.flightYaw ?? 0)));

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const sheet = plan.sheets.find((s) => s.geo) ?? plan.sheets[0];
const g = sheet.geo;
if (!g) {
  console.error("plan sheet has no `geo` bbox — generate it with srt-to-plan first");
  process.exit(1);
}

const lat0 = (g.minLat + g.maxLat) / 2;
const mPerLat = 111320;
const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const outH = Math.round((outW * sheet.height) / sheet.width);

// downsample the equirect to something quick to sample (still plenty of detail)
const eqW = 8000;
const eqH = 4000;
const { data: eq } = await sharp(aerialPath)
  .resize(eqW, eqH, { fit: "fill" })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const out = Buffer.alloc(outW * outH * 3);
let kept = 0;
for (let py = 0; py < outH; py++) {
  const lat = g.maxLat - (py / outH) * (g.maxLat - g.minLat);
  for (let px = 0; px < outW; px++) {
    const lon = g.minLon + (px / outW) * (g.maxLon - g.minLon);
    const oi = (py * outW + px) * 3;

    // ground point offset from the drone, in metres
    const E = (lon - meta.lon) * mPerLon;
    const N = (lat - meta.lat) * mPerLat;
    const d = Math.hypot(E, N);
    const dep = (Math.atan2(meta.relAlt, d) * 180) / Math.PI; // depression below horizon
    if (dep < minDep) {
      out[oi] = 14; out[oi + 1] = 13; out[oi + 2] = 16; // too oblique → near-black
      continue;
    }

    // azimuth from north (CW), relative to the equirect's centre (front)
    let az = (Math.atan2(E, N) * 180) / Math.PI; // 0=N, 90=E
    let rel = az - heading;
    if (flip) rel = -rel;
    let u = (rel / 360) * eqW + eqW / 2;
    u = ((u % eqW) + eqW) % eqW;
    const v = ((90 + dep) / 180) * eqH; // below-horizon rows

    const sx = Math.min(eqW - 1, Math.max(0, Math.floor(u)));
    const sy = Math.min(eqH - 1, Math.max(0, Math.floor(v)));
    const si = (sy * eqW + sx) * 3;
    out[oi] = eq[si]; out[oi + 1] = eq[si + 1]; out[oi + 2] = eq[si + 2];
    kept++;
  }
}

const jpg = await sharp(out, { raw: { width: outW, height: outH, channels: 3 } })
  .jpeg({ quality: 82 })
  .toBuffer();

// raw JPEG on disk (for R2 upload) + a self-contained data-URL in the plan (so
// the local preview works offline). For D1 the data-URL is swapped for the R2
// URL by push-d1.mjs --satUrl — D1 caps single-statement size, a 556 KB base64
// literal blows SQLITE_TOOBIG, and an R2 URL is lighter for every client anyway.
const jpgPath = outPath.replace(/\.(plan\.)?json$/i, "-base.jpg");
fs.writeFileSync(jpgPath, jpg);
sheet.satUrl = `data:image/jpeg;base64,${jpg.toString("base64")}`;
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));

console.log(`Aerial reprojected → ${outW}×${outH} base (${(jpg.length / 1024).toFixed(0)} KB)`);
console.log(`  base JPEG → ${jpgPath}`);
console.log(`  drone @ ${meta.lat.toFixed(6)},${meta.lon.toFixed(6)}  ·  ${meta.relAlt} m AGL  ·  heading ${heading}°${flip ? " (flipped)" : ""}`);
console.log(`  covered ${((100 * kept) / (outW * outH)).toFixed(0)}% of the sheet (rest too oblique)`);
console.log(`  wrote ${outPath} (sheet.satUrl set)`);
