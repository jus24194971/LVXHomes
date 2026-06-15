#!/usr/bin/env node
/**
 * check-gyro — does the gimbal yaw (gb_yaw, stored as key.h) actually predict the
 * drone's TRAVEL direction? If yes (with a roughly constant offset), we can trust
 * gyro to reconstruct a GPS-less leg. If the spread is wide, the camera panned
 * independently of motion and gyro alone won't do it (→ VSLAM/IMU).
 *
 * Uses the GPS-locked keys (which carry both h and a real position) as ground truth.
 *   node check-gyro.mjs <plan.json>
 */
import fs from "node:fs";

const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sheet = plan.sheets.find((s) => s.paths && Object.keys(s.paths).length) ?? plan.sheets[0];
const keys = Object.values(sheet.paths)[0].filter((k) => k.h !== undefined).sort((a, b) => a.t - b.t);
const norm = (d) => (((d + 180) % 360) + 360) % 360 - 180;

const diffs = [];
for (let i = 0; i < keys.length - 1; i++) {
  const a = keys[i], b = keys[i + 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 0.6) continue; // ignore near-stationary frames (bearing is noise)
  const bearing = (Math.atan2(dx, -dy) * 180) / Math.PI; // same convention as the viewer
  diffs.push(norm(bearing - a.h));
}

// circular stats on the gyro→travel offset
const mx = diffs.reduce((s, d) => s + Math.cos((d * Math.PI) / 180), 0) / diffs.length;
const my = diffs.reduce((s, d) => s + Math.sin((d * Math.PI) / 180), 0) / diffs.length;
const meanOff = (Math.atan2(my, mx) * 180) / Math.PI;
const R = Math.hypot(mx, my); // mean resultant length: 1 = gyro perfectly predicts travel, 0 = random
const std = Math.sqrt(diffs.map((d) => norm(d - meanOff) ** 2).reduce((s, v) => s + v, 0) / diffs.length);

console.log(`samples (moving frames): ${diffs.length} of ${keys.length} GPS keys`);
console.log(`gyro → travel mean offset: ${meanOff.toFixed(1)}°  (constant offset is fine — it's absorbable)`);
console.log(`concentration R: ${R.toFixed(3)}   (>0.8 strong · 0.5–0.8 usable · <0.5 unreliable)`);
console.log(`residual spread (1σ): ±${std.toFixed(1)}°`);
console.log(
  R > 0.8 ? "→ gyro tracks travel well — SRT reconstruction will be faithful."
  : R > 0.5 ? "→ gyro is usable with smoothing — SRT reconstruction worth doing."
  : "→ gyro decoupled from motion — needs VSLAM/IMU, not gyro alone.",
);
