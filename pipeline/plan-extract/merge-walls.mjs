#!/usr/bin/env node
/**
 * Merge AI consensus walls into the LIVE plan (preserving flipX/rotation/zones),
 * trim to the N longest walls + subsample the flight so the upsert stays inline-sized.
 *
 *   node merge-walls.mjs <live_raw.json> <wallplan.json> [maxWalls=16] [maxFlight=18]
 *
 * live_raw.json = wrangler `--json` output of SELECT body FROM doc (...).
 * wallplan.json = plans/<slug>.plan.json from make_walls_ai (R2). -> _merged_plan.json
 */
import fs from "node:fs";
import path from "node:path";

const liveRaw = process.argv[2];
const wallPlan = process.argv[3];
const maxWalls = parseInt(process.argv[4] || "16", 10);
const maxFlight = parseInt(process.argv[5] || "18", 10);

const _raw = fs.readFileSync(liveRaw, "utf8");
const live = JSON.parse(JSON.parse(_raw.charCodeAt(0) === 0xFEFF ? _raw.slice(1) : _raw)[0].results[0].body);
const wall = JSON.parse(fs.readFileSync(wallPlan, "utf8"));
const sh = live.sheets[0];
sh.rotation = parseFloat(process.argv[6] || "300"); // locked display rotation (deg)

const newStrokes = Array.isArray(wall) ? wall : ((wall.sheets?.[0]?.strokes) || []);
const plen = (s) => {
  let d = 0;
  for (let i = 0; i < s.length - 1; i++) d += Math.hypot(s[i + 1][0] - s[i][0], s[i + 1][1] - s[i][1]);
  return d;
};
// keep the footprint outline (the longest closed ring) + the N longest interior walls
const sorted = newStrokes.slice().sort((a, b) => plen(b) - plen(a));
sh.strokes = sorted.slice(0, maxWalls);

// subsample the flight path (keep endpoints) to hold the payload down
const f = (sh.paths && sh.paths.flight) || [];
if (f.length > maxFlight) {
  const step = Math.ceil(f.length / maxFlight);
  sh.paths.flight = f.filter((_, i) => i % step === 0 || i === f.length - 1);
}

const out = path.join(path.dirname(liveRaw), "_merged_plan.json");
const body = JSON.stringify(live);
fs.writeFileSync(out, body, "utf8");
console.log(`merged -> ${out}`);
console.log(`  walls: ${sh.strokes.length}  flight: ${sh.paths.flight.length}  flipX: ${sh.flipX}  rotation: ${sh.rotation || 0}  zones: ${sh.zones.length}`);
console.log(`  body: ${(body.length / 1024).toFixed(1)} KB  (target <2KB for inline d1 execute)`);
