import fs from "node:fs";
const txt = fs.readFileSync(process.argv[2], "utf8");
const blocks = txt.split(/\r?\n\r?\n/).filter((b) => b.includes("latitude"));
const rows = [];
for (const b of blocks) {
  const tm = b.match(/(\d{2}:\d{2}:\d{2}),\d+\s*-->/);
  const lat = b.match(/latitude:\s*([-\d.]+)/);
  const lon = b.match(/longitude:\s*([-\d.]+)/);
  const ra = b.match(/rel_alt:\s*([-\d.]+)/);
  const yaw = b.match(/gb_yaw:\s*([-\d.]+)/);
  if (lat && lon) rows.push({ t: tm ? tm[1] : "?", lat: +lat[1], lon: +lon[1], ra: ra ? +ra[1] : null, yaw: yaw ? +yaw[1] : null });
}
const dur = rows.length / 30;
console.log(`${rows.length} frames (~${dur.toFixed(0)}s @30fps), alt ${Math.min(...rows.map(r=>r.ra)).toFixed(1)}..${Math.max(...rows.map(r=>r.ra)).toFixed(1)}m`);
console.log("time      lat         lon          alt    yaw    moved(ft, GPS)");
const N = Math.max(1, Math.floor(rows.length / 55));
let prev = null;
for (let i = 0; i < rows.length; i += N) {
  const r = rows[i];
  let mv = "-";
  if (prev) { const dl = (r.lat - prev.lat) * 364000, dn = (r.lon - prev.lon) * 303800; mv = Math.hypot(dl, dn).toFixed(1); }
  console.log(`${r.t}  ${r.lat.toFixed(6)}  ${r.lon.toFixed(6)}  ${String(r.ra).padStart(5)}  ${String(r.yaw).padStart(6)}   ${mv}`);
  prev = r;
}