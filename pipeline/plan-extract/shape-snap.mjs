#!/usr/bin/env node
/**
 * shape-snap — de-overlap GPS-fused rooms into an abutting floorplan.
 *
 * Indoor GPS (±2-3 m) drops each room in the right neighborhood but piled on its
 * neighbors. The room's HorizonNet *shape* is trustworthy; its absolute *position*
 * is not. So treat each room as a rigid body and relax:
 *   • repel any overlapping pair — push apart along the shallower axis until the
 *     boxes just separate (walls abut),
 *   • a weak spring holds each room near its original GPS anchor.
 * Equilibrium = rooms touching, near where GPS said they were. Translation only,
 * shapes stay rigid. AABB proxy for overlap (rooms are axis-aligned to the building).
 *
 *   node shape-snap.mjs <in.plan.json> <out.plan.json> [--iters 600] [--kgps 0.05] [--krep 1] [--damp 0.5]
 */
import fs from "node:fs";

const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const inPath = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "plan.json";
const outPath = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "plan-snap.json";
const ITERS = parseInt(A("iters", "600"), 10);
const KGPS = parseFloat(A("kgps", "0.05"));   // spring back toward GPS anchor (weak)
const KREP = parseFloat(A("krep", "1.0"));    // overlap repulsion (strong)
const DAMP = parseFloat(A("damp", "0.5"));

const plan = JSON.parse(fs.readFileSync(inPath, "utf8"));
const sheet = plan.sheets[0];
const Z = sheet.zones, N = Z.length;
const polys = Z.map((z) => z.points.map((p) => [p[0], p[1]]));
const t = polys.map(() => [0, 0]);            // per-room translation (0 = at GPS)

const box = (poly, tt) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [px, py] of poly) {
    const x = px + tt[0], y = py + tt[1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};
const maxOverlap = () => {
  let m = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const a = box(polys[i], t[i]), b = box(polys[j], t[j]);
    const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (ox > 0 && oy > 0) m = Math.max(m, Math.min(ox, oy));
  }
  return m;
};

const before = maxOverlap();
for (let it = 0; it < ITERS; it++) {
  const f = polys.map(() => [0, 0]);
  // pairwise overlap repulsion — separate along the axis of least penetration
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const a = box(polys[i], t[i]), b = box(polys[j], t[j]);
    const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (ox > 0 && oy > 0) {
      if (ox <= oy) {
        const dir = (a[0] + a[2]) >= (b[0] + b[2]) ? 1 : -1;
        f[i][0] += dir * ox * 0.5 * KREP; f[j][0] -= dir * ox * 0.5 * KREP;
      } else {
        const dir = (a[1] + a[3]) >= (b[1] + b[3]) ? 1 : -1;
        f[i][1] += dir * oy * 0.5 * KREP; f[j][1] -= dir * oy * 0.5 * KREP;
      }
    }
  }
  // weak spring back to the GPS anchor (resists drifting far from where GPS placed it)
  for (let i = 0; i < N; i++) { f[i][0] -= KGPS * t[i][0]; f[i][1] -= KGPS * t[i][1]; }
  for (let i = 0; i < N; i++) { t[i][0] += DAMP * f[i][0]; t[i][1] += DAMP * f[i][1]; }
}
const after = maxOverlap();

// apply translations
let moved = 0;
const placed = polys.map((poly, i) => {
  moved = Math.max(moved, Math.hypot(t[i][0], t[i][1]));
  return poly.map(([x, y]) => [x + t[i][0], y + t[i][1]]);
});

// re-frame the sheet + re-derive geo from the original frame so the aerial base still registers
const g0 = sheet.geo, W0 = sheet.width, H0 = sheet.height;
const ftPerDegLon = W0 / (g0.maxLon - g0.minLon), ftPerDegLat = H0 / (g0.maxLat - g0.minLat);
const xs = placed.flatMap((p) => p.map((q) => q[0])), ys = placed.flatMap((p) => p.map((q) => q[1]));
const pad = 4;
const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
const W = Math.ceil(Math.max(...xs) - x0 + pad), H = Math.ceil(Math.max(...ys) - y0 + pad);
Z.forEach((z, i) => { z.points = placed[i].map(([x, y]) => [Math.round((x - x0) * 100) / 100, Math.round((y - y0) * 100) / 100]); });
sheet.width = W; sheet.height = H;
sheet.geo = {
  minLon: g0.minLon + x0 / ftPerDegLon, maxLon: g0.minLon + (x0 + W) / ftPerDegLon,
  maxLat: g0.maxLat - y0 / ftPerDegLat, minLat: g0.maxLat - (y0 + H) / ftPerDegLat,
};
delete sheet.satUrl; // base must be re-reprojected for the new geo bbox

fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
console.log(`snap: max overlap ${before.toFixed(1)} -> ${after.toFixed(1)} ft · max room move ${moved.toFixed(1)} ft · sheet ${W} x ${H} ft -> ${outPath}`);
console.log(`geo: ${sheet.geo.minLat.toFixed(6)},${sheet.geo.minLon.toFixed(6)} .. ${sheet.geo.maxLat.toFixed(6)},${sheet.geo.maxLon.toFixed(6)}  (re-run aerial-to-base)`);
