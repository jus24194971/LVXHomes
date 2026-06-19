import fs from "node:fs";
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stills = d.stills || d;
const pad = (v, w, dec = 6) => String(v == null ? "-" : (typeof v === "number" ? v.toFixed(dec) : v)).padEnd(w);
console.log(pad("name", 10), pad("lat", 11), pad("lon", 13), pad("AGLm", 7, 1), pad("gimYaw", 8, 1), pad("preYaw", 8, 1), pad("z0", 7, 2), pad("z1", 7, 2), "uvN");
console.log("-".repeat(92));
for (const s of stills) {
  console.log(pad((s.name || "").slice(0, 8), 10), pad(s.lat, 11), pad(s.lon, 13), pad(s.relAlt, 7, 1), pad(s.gimbalYaw, 8, 1), pad(s.preprocessYaw, 8, 1), pad(s.z0, 7, 2), pad(s.z1, 7, 2), (s.uv ? s.uv.length : 0));
}
const agl = stills.map(s => s.relAlt).filter(x => x != null);
const lats = stills.map(s => s.lat).filter(x => x != null), lons = stills.map(s => s.lon).filter(x => x != null);
const span = a => Math.max(...a) - Math.min(...a);
console.log("-".repeat(92));
if (agl.length) console.log(`AGL: ${Math.min(...agl).toFixed(1)} - ${Math.max(...agl).toFixed(1)} m   (high ones = overview/mapping passes)`);
if (lats.length) console.log(`GPS footprint: ~${(span(lats)*111320).toFixed(0)} m N-S x ${(span(lons)*111320*Math.cos(lats[0]*Math.PI/180)).toFixed(0)} m E-W`);
const noz = stills.filter(s => s.z0 == null || s.z1 == null).length;
console.log(`missing z0/z1: ${noz}/${stills.length}`);