#!/usr/bin/env node
/**
 * add-altitude — fold the drone's barometric height (SRT rel_alt) into a plan's
 * flight path keys as `z`, by nearest timecode. Needed so aerial amenity rings
 * pitch correctly DOWN at the ground (the viewer uses the drone altitude as the
 * camera height). Surgical: only touches path keys — zones, labels, satUrl and
 * everything else you edited are preserved.
 *
 *   node add-altitude.mjs <plan.json> <flight.SRT> [--out plan.json]
 */
import fs from "node:fs";

const planPath = process.argv[2];
const srtPath = process.argv[3];
if (!planPath || !srtPath) { console.error("usage: node add-altitude.mjs <plan.json> <flight.SRT>"); process.exit(1); }
const i = process.argv.indexOf("--out");
const outPath = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : planPath;

const num = (b, re) => { const m = b.match(re); return m ? parseFloat(m[1]) : null; };
const track = [];
for (const b of fs.readFileSync(srtPath, "utf8").split(/\r?\n\r?\n/)) {
  const tc = b.match(/(\d\d):(\d\d):(\d\d),(\d\d\d)\s*-->/);
  if (!tc) continue;
  const t = +tc[1] * 3600 + +tc[2] * 60 + +tc[3] + +tc[4] / 1000;
  const relAlt = num(b, /rel_alt:\s*([-\d.]+)/);
  if (relAlt != null) track.push({ t, relAlt });
}
track.sort((a, b) => a.t - b.t);
if (!track.length) { console.error("no rel_alt frames in the SRT"); process.exit(1); }

const altAt = (t) => {
  let best = track[0], bd = Infinity;
  for (const f of track) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; best = f; } }
  return Math.round(best.relAlt * 10) / 10;
};

const plan = JSON.parse(fs.readFileSync(planPath, "utf8").replace(/^﻿/, ""));
let n = 0;
let lo = Infinity, hi = -Infinity;
for (const s of plan.sheets) {
  if (!s.paths) continue;
  for (const ch of Object.keys(s.paths)) {
    s.paths[ch] = s.paths[ch].map((k) => {
      const z = altAt(k.t);
      lo = Math.min(lo, z); hi = Math.max(hi, z);
      n++;
      return { ...k, z };
    });
  }
}
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
console.log(`added altitude to ${n} path keys (${lo}–${hi} m AGL) → ${outPath}`);
