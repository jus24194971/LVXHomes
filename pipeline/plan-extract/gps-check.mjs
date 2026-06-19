// One-off: validate GPS + attitude on the Scottsdale stills.
import { readDjiMeta } from "./exif-gps.mjs";
import fs from "node:fs";
import path from "node:path";

const dir = "C:/Users/jus24/Videos/Maria Real Estate/Scottsdale House";
const jpgs = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();

const pad = (v, w, d = 6) => String(v == null ? "—" : (typeof v === "number" ? v.toFixed(d) : v)).padEnd(w);
console.log(pad("file", 32), pad("lat", 12), pad("lon", 13), pad("AGL m", 8, 1), pad("gimYaw", 8, 1), pad("fltYaw", 8, 1), "W x H");
console.log("-".repeat(96));

const rows = [];
for (const f of jpgs) {
  const m = readDjiMeta(path.join(dir, f));
  rows.push(m);
  console.log(
    pad(f, 32),
    pad(m.lat, 12), pad(m.lon, 13),
    pad(m.relAlt, 8, 1), pad(m.gimbalYaw, 8, 1), pad(m.flightYaw, 8, 1),
    m.width && m.height ? `${m.width} x ${m.height}` : "—",
  );
}

const geo = rows.filter((r) => r.lat != null);
console.log("-".repeat(96));
console.log(`geotagged: ${geo.length}/${rows.length}`);
if (geo.length) {
  const lats = geo.map((r) => r.lat), lons = geo.map((r) => r.lon);
  const span = (a) => (Math.max(...a) - Math.min(...a));
  // ~ meters: 1 deg lat ~111320 m; 1 deg lon ~111320*cos(lat)
  const mlat = span(lats) * 111320;
  const mlon = span(lons) * 111320 * Math.cos((lats[0] * Math.PI) / 180);
  console.log(`GPS footprint: ~${mlat.toFixed(0)} m (N-S) x ${mlon.toFixed(0)} m (E-W)`);
  console.log(`center: ${(lats.reduce((a, b) => a + b) / lats.length).toFixed(6)}, ${(lons.reduce((a, b) => a + b) / lons.length).toFixed(6)}`);
  const alts = geo.map((r) => r.relAlt).filter((x) => x != null);
  if (alts.length) console.log(`AGL range: ${Math.min(...alts).toFixed(1)} - ${Math.max(...alts).toFixed(1)} m`);
}
