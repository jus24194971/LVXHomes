#!/usr/bin/env node
/** area-check — sanity-check plan scale against a known total floor area (e.g. listing sqft).
 *   node area-check.mjs <plan.json> [--sqft 2839]
 * Sums per-room polygon areas (shoelace). NOTE: rooms overlap + HorizonNet over-shoots,
 * so the sum is an UPPER bound; the sheet bbox is the loose outer bound. Use as a coarse
 * scale signal (area scales as scale^2), not an exact match. */
import fs from "node:fs";
const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sh = plan.sheets[0];
const ref = parseFloat(A("sqft", "2839"));
const area = (pts) => Math.abs(pts.reduce((a, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return a + (x * y2 - x2 * y); }, 0)) / 2;
const areas = sh.zones.map((z) => area(z.points)).sort((a, b) => b - a);
const sum = areas.reduce((a, b) => a + b, 0);
console.log(`rooms ${sh.zones.length} · Σ room area (overlapping) ${sum.toFixed(0)} sqft · sheet bbox ${(sh.width * sh.height).toFixed(0)} sqft`);
console.log(`listing ref ${ref} sqft · Σ/ref ${(sum / ref).toFixed(2)}x · implied scale err ${(((Math.sqrt(sum / ref)) - 1) * 100).toFixed(0)}% (if Σ≈ref)`);
console.log(`largest rooms: ${areas.slice(0, 6).map((a) => a.toFixed(0)).join(", ")} sqft`);
