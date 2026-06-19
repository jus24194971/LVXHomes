#!/usr/bin/env node
/**
 * GPS-fused floorplan — the still-driven path.
 *
 * Each dedicated 360 still already carries its own GPS + gimbal yaw (EXIF/XMP) and,
 * from HorizonNet, its room's floor/ceiling layout. So we don't need video, VSLAM, or
 * ORB localization: GPS *positions* every room (and every separate structure — house,
 * casita), and HorizonNet gives the *shape*. This is what makes a multi-structure,
 * indoor/outdoor/indoor capture fuse cleanly — visual SLAM would drift across the yard;
 * GPS does not.
 *
 * Input (from the modified Modal `still_layout`, which returns layout + EXIF together):
 *   _stills_layout.json = [{ name, lat, lon, gimbalYaw, relAlt, uv:[[u,v]...], z0, z1, preprocessYaw? }]
 *
 * Output: an LVX plan sheet — zones (room polygons, feet) + a geo bbox that lines the
 * aerial base (aerial-to-base.mjs) up underneath it.
 *
 *   node stills-gps-plan.mjs [in=_stills_layout.json] [out=plan.json] [--ceil 9] [--axis auto] [--rot 0] [--maxAgl 10]
 */
import fs from "node:fs";

const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const inPath = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "_stills_layout.json";
const outPath = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "plan.json";
const CEIL = parseFloat(A("ceil", "9"));        // ceiling height (ft) → camera height above floor
const MAXAGL = parseFloat(A("maxAgl", "10"));   // AGL above this = an overview shot, not a room
const ROT = parseFloat(A("rot", "0"));          // global orientation nudge (tune on real data)
const MAXD = parseFloat(A("maxD", "0"));        // clamp floor-corner distance (ft); 0 = off. Tames near-horizon blow-ups
let AXIS = A("axis", "auto");                   // building axis (deg) or "auto"

const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
const all = Array.isArray(raw) ? raw : raw.stills || [];
const rooms = all.filter((s) => s.lat != null && s.uv && s.uv.length && (s.relAlt == null || s.relAlt < MAXAGL));
if (!rooms.length) { console.error("no interior room stills with GPS + layout in " + inPath); process.exit(1); }

// ---- geo → feet frame (x east from the west edge, y south/down from the north edge) ----
const lats = rooms.map((r) => r.lat), lons = rooms.map((r) => r.lon);
const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
const lat0 = (minLat + maxLat) / 2, FT = 3.28084;
const mPerLat = 111320, mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const toFt = (lat, lon) => [(lon - minLon) * mPerLon * FT, (maxLat - lat) * mPerLat * FT];

// ---- a still's floor polygon (camera at origin, feet), from the HorizonNet layout ----
function floorPoly(s) {
  const z0 = s.z0, z1 = Math.abs(s.z1), camH = CEIL * z1 / (z0 + z1);
  const floor = s.uv.filter((_, i) => i % 2 === 1); // odd indices = floor corners
  return floor.map(([u, v]) => {
    const lon = (u - 0.5) * 2 * Math.PI, lat = (0.5 - v) * Math.PI;
    let d = camH / Math.tan(Math.abs(lat));
    if (MAXD > 0 && d > MAXD) d = MAXD; // near-horizon corners blow up; cap the radius
    return [Math.sin(lon) * d, Math.cos(lon) * d]; // [east, north] in the camera frame
  });
}
// dominant wall direction of a polygon, folded into [0,90)
function polyAxis(poly) {
  const hist = new Array(180).fill(0);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = (((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) % 90 + 90) % 90;
    hist[Math.round(ang * 2) % 180] += len;
  }
  let bi = 0; for (let i = 0; i < 180; i++) if (hist[i] > hist[bi]) bi = i;
  return bi / 2;
}

// ---- building axis: vector-mean the rooms' wall directions (Manhattan world) ----
if (AXIS === "auto") {
  let sx = 0, sy = 0;
  for (const s of rooms) { const a = (polyAxis(floorPoly(s)) * 4 * Math.PI) / 180; sx += Math.cos(a); sy += Math.sin(a); }
  AXIS = (((Math.atan2(sy, sx) * 180) / Math.PI) / 4 + 90) % 90;
} else AXIS = parseFloat(AXIS);

// ---- place each room: rotate to the building axis (gimbal yaw breaks the 90° tie), then translate to its GPS ----
const rot = (p, deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return p.map(([x, y]) => [x * c - y * s, x * s + y * c]); };
const round2 = (v) => Math.round(v * 100) / 100;
const zones = rooms.map((s, idx) => {
  const poly = floorPoly(s);
  let theta = AXIS - polyAxis(poly);
  const heading = (s.gimbalYaw || 0) + (s.preprocessYaw || 0);
  theta += Math.round((heading - theta) / 90) * 90; // pick the 90° quadrant from the measured heading
  theta += ROT;
  const [cx, cy] = toFt(s.lat, s.lon);
  const pts = rot(poly, theta).map(([x, y]) => [cx + x, cy + y]);
  return { id: s.name, label: `Room ${idx + 1}`, points: pts };
});

// ---- sheet extent (feet) + a geo bbox matching it exactly, so the aerial base registers ----
const xs = zones.flatMap((z) => z.points.map((p) => p[0])), ys = zones.flatMap((z) => z.points.map((p) => p[1]));
const pad = 5;
const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
const W = Math.ceil(Math.max(...xs) - x0 + pad), H = Math.ceil(Math.max(...ys) - y0 + pad);
for (const z of zones) z.points = z.points.map(([x, y]) => [round2(x - x0), round2(y - y0)]);

const lonAt = (xft) => minLon + (x0 + xft) / (mPerLon * FT);
const latAt = (yft) => maxLat - (y0 + yft) / (mPerLat * FT);
const geo = { minLon: lonAt(0), maxLon: lonAt(W), maxLat: latAt(0), minLat: latAt(H) };

const plan = { sheets: [{ width: W, height: H, geo, buildingAxis: round2(AXIS), zones }] };
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
console.log(`${zones.length} rooms fused by GPS · building axis ${AXIS.toFixed(1)}° · sheet ${W} x ${H} ft -> ${outPath}`);
console.log(`geo: ${geo.minLat.toFixed(6)},${geo.minLon.toFixed(6)} .. ${geo.maxLat.toFixed(6)},${geo.maxLon.toFixed(6)}  (run aerial-to-base.mjs next for the base)`);
