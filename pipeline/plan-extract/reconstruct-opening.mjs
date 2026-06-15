#!/usr/bin/env node
/**
 * reconstruct-opening — fill the GPS-less opening of a flight path so the
 * you-are-here dot starts where the flight actually started, instead of freezing
 * on the first GPS-locked frame.
 *
 * The anchored-routing idea, applied to the data we already have. Two modes:
 *
 *   --mode mirror  (default)  out-and-back flights: the un-tracked outbound leg
 *                  is ~the reverse of the GPS-tracked return leg, so we mirror the
 *                  recorded path in time. Starts at the last key (= takeoff, when
 *                  start==end), traces out to the turnaround, hands off seamlessly
 *                  to the real GPS track. No extra data needed.
 *
 *   --mode leadin  one-way flights: a single eased segment from a start pin to the
 *                  first GPS point. Give the pin with --start x,y (defaults to the
 *                  last key — the return point).
 *
 * Future mode (needs the full-rate SRT or VSLAM/IMU): integrate per-frame heading
 * through the gap and affine-fit it to the two anchors for the true curve.
 *
 *   node reconstruct-opening.mjs <plan.json> [--mode mirror|leadin] [--start x,y]
 *        [--keys 28] [--out plan.json] [--slug the-george]
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const planPath = args[0];
if (!planPath) { console.error("usage: node reconstruct-opening.mjs <plan.json> [--mode mirror|leadin]"); process.exit(1); }
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const mode = opt("mode", "mirror");
const N = parseInt(opt("keys", "28"), 10);
const outPath = opt("out", planPath);

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const sheet = plan.sheets.find((s) => s.paths && Object.keys(s.paths).length) ?? plan.sheets[0];
const chId = Object.keys(sheet.paths)[0];
const keys = sheet.paths[chId].slice().sort((a, b) => a.t - b.t);
if (keys.length < 2) { console.error("need ≥2 path keys"); process.exit(1); }

const firstT = keys[0].t;
const lastT = keys[keys.length - 1].t;
if (firstT <= 1.5) { console.log(`opening already covered (first key at t=${firstT}s) — nothing to do`); process.exit(0); }

// linear sample of the recorded path at an arbitrary time
const interpAt = (time) => {
  if (time <= firstT) return [keys[0].x, keys[0].y];
  if (time >= lastT) return [keys[keys.length - 1].x, keys[keys.length - 1].y];
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t < time) i++;
  const a = keys[i], b = keys[i + 1];
  const f = (time - a.t) / (b.t - a.t || 1);
  return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f];
};

const round = (n) => Math.round(n * 100) / 100;
const lead = [];

if (mode === "mirror") {
  // synthetic outbound: as synth-time goes 0→firstT, walk the recorded path from
  // its END (takeoff/landing) back to its START (turnaround).
  for (let j = 0; j < N; j++) {
    const p = j / N;
    const [x, y] = interpAt(lastT - p * (lastT - firstT));
    lead.push({ t: round(p * firstT), x: round(x), y: round(y) });
  }
} else {
  // leadin: straight eased run from the start pin to the first GPS point
  const startArg = opt("start");
  const [sx, sy] = startArg ? startArg.split(",").map(Number) : [keys[keys.length - 1].x, keys[keys.length - 1].y];
  for (let j = 0; j < N; j++) {
    const p = j / N;
    const e = p * p * (3 - 2 * p); // smoothstep
    lead.push({ t: round(p * firstT), x: round(sx + (keys[0].x - sx) * e), y: round(sy + (keys[0].y - sy) * e) });
  }
}

sheet.paths[chId] = [...lead, ...keys];
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));

console.log(`reconstructed opening (${mode}) → ${outPath}`);
console.log(`  +${lead.length} keys over t=0..${firstT}s  (dot now starts at ${lead[0].x},${lead[0].y})`);
console.log(`  full path: ${sheet.paths[chId].length} keys, t=0..${lastT}s`);
