#!/usr/bin/env node
/**
 * srt-to-plan — DJI Avata 360 telemetry → georeferenced site plan.
 *
 * Parses a DJI .SRT (per-frame GPS / heading / altitude), and when GPS is
 * present (outdoor flights) projects the flight to local meters, writes a `site`
 * PlanSheet in our data/plans.ts schema (with the flight path + dwell-detected
 * amenity stops), and emits a free Esri World Imagery satellite URL for the
 * property bbox — use that PNG as the Floorplan Studio trace underlay.
 *
 * Indoor flights have no GPS (lat/lon = 0); for those this just reports the
 * heading/altitude profile and points you at the VSLAM stage.
 *
 * Usage:
 *   node srt-to-plan.mjs <input.SRT> [--slug the-george] [--label "Grounds"]
 *                        [--pad 0.15] [--dwell 2] [--out plan.json] [--sat sat.png]
 *
 * Pure Node (>=18), no dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { readGpsExif } from "./exif-gps.mjs";

// ---------- args ----------
const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith("--")) {
  console.error("usage: node srt-to-plan.mjs <input.SRT> [--slug s] [--out plan.json] [--sat sat.png]");
  process.exit(1);
}
const srtPath = args[0];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const slug = opt("slug", path.basename(srtPath).replace(/\.[^.]+$/, ""));
const label = opt("label", "Grounds");
const pad = parseFloat(opt("pad", "0.15")); // bbox padding, fraction of span
const dwellSecs = parseFloat(opt("dwell", "2")); // min hover to count as a stop
const outPath = opt("out", "plan.json");
const satPath = opt("sat", null); // if set, download the satellite PNG too

// ---------- parse SRT ----------
const num = (block, re) => {
  const m = block.match(re);
  return m ? parseFloat(m[1]) : null;
};
const text = fs.readFileSync(srtPath, "utf8");
const blocks = text.split(/\r?\n\r?\n/).filter((b) => b.trim());

const track = [];
for (const b of blocks) {
  const tc = b.match(/(\d\d):(\d\d):(\d\d),(\d\d\d)\s*-->/);
  if (!tc) continue;
  const t = +tc[1] * 3600 + +tc[2] * 60 + +tc[3] + +tc[4] / 1000;
  track.push({
    t,
    lat: num(b, /latitude:\s*([-\d.]+)/),
    lon: num(b, /longitude:\s*([-\d.]+)/),
    relAlt: num(b, /rel_alt:\s*([-\d.]+)/),
    yaw: num(b, /gb_yaw:\s*([-\d.]+)/),
  });
}
console.log(`Parsed ${track.length} frames from ${path.basename(srtPath)}`);

const gps = track.filter((p) => p.lat != null && p.lon != null && Math.abs(p.lat) > 1e-4 && Math.abs(p.lon) > 1e-4);

// ---------- indoor (no GPS) ----------
if (gps.length < 10) {
  const yaws = track.map((p) => p.yaw).filter((y) => y != null);
  const alts = track.map((p) => p.relAlt).filter((a) => a != null);
  console.log("\nNo usable GPS — this is an indoor/GPS-denied clip.");
  console.log(`  heading swept ${yaws.length ? `${Math.min(...yaws).toFixed(0)}°..${Math.max(...yaws).toFixed(0)}°` : "n/a"}`);
  console.log(`  altitude ${alts.length ? `${Math.min(...alts).toFixed(1)}..${Math.max(...alts).toFixed(1)} m` : "n/a"}`);
  console.log("  → run the VSLAM stage (stella_vslam) for geometry; see README.");
  process.exit(0);
}

// ---------- project GPS → local meters ----------
const lat0 = gps.reduce((s, p) => s + p.lat, 0) / gps.length;
const mPerLat = 111320;
const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);

let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
for (const p of gps) {
  minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
}
// pad the bbox so the plan/satellite has margin
const dLon = (maxLon - minLon) || 1e-4, dLat = (maxLat - minLat) || 1e-4;
minLon -= dLon * pad; maxLon += dLon * pad;
minLat -= dLat * pad; maxLat += dLat * pad;

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
// plan coords: origin = NW corner (minLon, maxLat); x east, y south (screen-down)
const toPlan = (p) => ({
  x: round((p.lon - minLon) * mPerLon),
  y: round((maxLat - p.lat) * mPerLat),
});
const width = round((maxLon - minLon) * mPerLon);
const height = round((maxLat - minLat) * mPerLat);

// flight path keyframes (decimate to ~1 every 0.5s to keep it light)
const pathKeys = [];
let lastT = -1;
for (const p of gps) {
  if (p.t - lastT < 0.5) continue;
  lastT = p.t;
  const xy = toPlan(p);
  pathKeys.push({ t: round(p.t, 1), x: xy.x, y: xy.y, ...(p.yaw != null ? { h: round(p.yaw, 0) } : {}) });
}

// ---------- dwell detection (hovers ≈ amenities) ----------
const speedAt = (i) => {
  if (i === 0) return 0;
  const a = gps[i - 1], b = gps[i];
  const dx = (b.lon - a.lon) * mPerLon, dy = (b.lat - a.lat) * mPerLat;
  const dt = b.t - a.t || 1 / 30;
  return Math.hypot(dx, dy) / dt; // m/s
};
const SPEED_STOP = 0.6; // m/s
const stops = [];
let run = null;
for (let i = 1; i < gps.length; i++) {
  const slow = speedAt(i) < SPEED_STOP;
  if (slow) run = run ?? { from: i, sumX: 0, sumY: 0, n: 0, t: gps[i].t };
  if (run) { const xy = toPlan(gps[i]); run.sumX += xy.x; run.sumY += xy.y; run.n++; }
  if ((!slow || i === gps.length - 1) && run) {
    if (gps[i].t - run.t >= dwellSecs) {
      stops.push({ t: round(run.t, 1), x: round(run.sumX / run.n), y: round(run.sumY / run.n) });
    }
    run = null;
  }
}

// ---------- amenity zones: prefer GPS-tagged stills, else dwell stops ----------
// Each amenity 360 still carries its own GPS — drop a zone at that exact spot
// (you reshape it in the Studio). Falls back to flight dwell-stops if no stills.
const stillsDir = opt("stills", path.dirname(srtPath));
const amenities = [];
try {
  const jpgs = fs
    .readdirSync(stillsDir)
    .filter((f) => /\.jpe?g$/i.test(f) && !f.startsWith("_"))
    .sort();
  for (const f of jpgs) {
    const g = readGpsExif(path.join(stillsDir, f));
    if (!g) continue;
    if (g.lon < minLon || g.lon > maxLon || g.lat < minLat || g.lat > maxLat) continue;
    amenities.push(toPlan({ lat: g.lat, lon: g.lon }));
  }
} catch {
  /* no stills directory */
}
const fromStills = amenities.length > 0;
const points = fromStills ? amenities : stops;
const zr = Math.max(2, Math.min(width, height) * 0.04);
const zones = points.map((p, i) => ({
  id: `amenity-${i + 1}`,
  label: `Amenity ${i + 1}`,
  kind: "outdoor",
  points: [
    [round(p.x - zr), round(p.y - zr)],
    [round(p.x + zr), round(p.y - zr)],
    [round(p.x + zr), round(p.y + zr)],
    [round(p.x - zr), round(p.y + zr)],
  ],
}));

// ---------- satellite underlay link ----------
// The cached World Imagery service doesn't support arbitrary-bbox export (and
// Google/Mapbox static need a key), so we hand you a Google Maps satellite link
// to the property: open it, screenshot the grounds, import as the Floorplan
// Studio trace image, then use the Studio's Move/Size to align it under the path.
const cLat = round((minLat + maxLat) / 2, 6);
const cLon = round((minLon + maxLon) / 2, 6);
const span = Math.max(width, height);
const zoom = span < 100 ? 19 : span < 300 ? 18 : span < 800 ? 17 : 16;
const mapsUrl = `https://www.google.com/maps/@${cLat},${cLon},${zoom}z/data=!3m1!1e3`;

// ---------- emit plan.json (data/plans.ts schema) ----------
const plan = {
  tourSlug: slug,
  sheets: [
    {
      id: "grounds",
      label,
      kind: "site",
      width,
      height,
      zones,
      paths: { flight: pathKeys },
      geo: {
        minLon: round(minLon, 7),
        minLat: round(minLat, 7),
        maxLon: round(maxLon, 7),
        maxLat: round(maxLat, 7),
      },
    },
  ],
};
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));

console.log(`\nGeoreferenced ${gps.length} GPS frames.`);
console.log(`  property bbox  ${minLat.toFixed(6)},${minLon.toFixed(6)}  →  ${maxLat.toFixed(6)},${maxLon.toFixed(6)}`);
console.log(`  site sheet     ${width} × ${height} m   ·   ${pathKeys.length} path keys   ·   ${zones.length} amenity zones${fromStills ? " (from stills' GPS)" : " (from dwell)"}`);
console.log(`  wrote          ${outPath}  (import in /studio/plan)`);
console.log(`\nSatellite trace underlay — open, screenshot the grounds, import in /studio/plan:`);
console.log(`  ${mapsUrl}`);
console.log(`  bbox  NW ${maxLat.toFixed(6)},${minLon.toFixed(6)}   SE ${minLat.toFixed(6)},${maxLon.toFixed(6)}`);
