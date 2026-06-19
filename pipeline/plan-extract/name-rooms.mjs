#!/usr/bin/env node
/**
 * name-rooms — PLACEHOLDER room names from the layout (area rank → listing room mix).
 * Honest first pass for the editor; the real job is feature-based auto-naming later
 * (detect bed/stove/couch → Bedroom/Kitchen/Living). Largest→common areas, smallest→baths.
 *
 *   node name-rooms.mjs <in.plan.json> <out.plan.json> [--template "A,B,C,..."]
 */
import fs from "node:fs";
const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sh = plan.sheets[0];
const area = (pts) => Math.abs(pts.reduce((a, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return a + (x * y2 - x2 * y); }, 0)) / 2;
// ordered large → small for a 5bd/4ba + casita home
const TEMPLATE = A("template", "Great Room,Primary Bedroom,Kitchen,Dining,Bedroom 2,Bedroom 3,Bedroom 4,Bedroom 5,Casita,Primary Bath,Bath 2,Bath 3,Bath 4").split(",");
const ranked = sh.zones.map((z, i) => ({ z, i, a: area(z.points) })).sort((p, q) => q.a - p.a);
ranked.forEach((r, rank) => {
  const name = TEMPLATE[rank] || `Room ${rank + 1}`;
  r.z.label = name;
  r.z.id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${r.i}`;
});
fs.writeFileSync(process.argv[3], JSON.stringify(plan, null, 2));
console.log("named (largest→smallest):");
ranked.forEach((r) => console.log(`  ${Math.round(r.a)} sqft  ${r.z.label}`));
