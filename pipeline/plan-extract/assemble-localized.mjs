#!/usr/bin/env node
/**
 * Place each room polygon at its LOCALIZED feet position (from localize.json, the ORB
 * still↔frame match), oriented to the building axis. True spots, no grid. -> _zones.json + _localized.png
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const CEIL = 9, ROT = 300, FLIP = 1, AXIS = 27.5;
const { ftw, fth, flight } = JSON.parse(fs.readFileSync(dir + "/_rooms.json", "utf8"));
const loc = JSON.parse(fs.readFileSync(dir + "/_localize.json", "utf8"));
const names = { "0009": "Kitchen", "0010": "Living", "0011": "Guest Bath", "0012": "Bonus", "0013": "Master Bed", "0014": "Master Bath" };

function roomPoly(id) {
  const L = JSON.parse(fs.readFileSync(`${dir}/_layout_${id}.json`, "utf8"));
  const z0 = L.z0, z1 = Math.abs(L.z1), camH = CEIL * z1 / (z0 + z1);
  const floor = L.uv.filter((_, i) => i % 2 === 1).map(([u, v]) => {
    const lon = (u - 0.5) * 2 * Math.PI, lat = (0.5 - v) * Math.PI, d = camH / Math.tan(Math.abs(lat));
    return [Math.sin(lon) * d, Math.cos(lon) * d];
  });
  const r = AXIS * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const p = floor.map(([x, y]) => [x * c - y * s, x * s + y * c]);
  const cx = p.reduce((a, q) => a + q[0], 0) / p.length, cy = p.reduce((a, q) => a + q[1], 0) / p.length;
  return p.map(([x, y]) => [x - cx, y - cy]); // centered on camera
}

const zones = [];
for (const id of Object.keys(names)) {
  if (!loc[id] || !loc[id].feet) continue;
  const [px, py] = loc[id].feet;
  const poly = roomPoly(id).map(([x, y]) => [Math.round((px + x) * 100) / 100, Math.round((py + y) * 100) / 100]);
  zones.push({ id, label: names[id], points: poly, matches: loc[id].matches });
}
fs.writeFileSync(dir + "/_zones.json", JSON.stringify(zones.map(({ id, label, points }) => ({ id, label, points })), null, 1));

const photo = dir + "/_fused.jpg", meta = await sharp(photo).metadata();
const W = meta.width, H = meta.height, X = (x) => (x / ftw * W).toFixed(1), Y = (y) => (y / fth * H).toFixed(1);
const cols = { Kitchen: "#5c9bff", Living: "#5cff8f", "Guest Bath": "#ffd24d", Bonus: "#ff5c5c", "Master Bed": "#d98cff", "Master Bath": "#4dd9d9" };
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
zones.forEach((z) => {
  svg += `<polygon points="${z.points.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="${cols[z.label]}" fill-opacity="0.32" stroke="${cols[z.label]}" stroke-width="3"/>`;
  const cx = z.points.reduce((a, p) => a + p[0], 0) / z.points.length, cy = z.points.reduce((a, p) => a + p[1], 0) / z.points.length;
  svg += `<circle cx="${X(cx)}" cy="${Y(cy)}" r="4" fill="#fff"/>`;
});
svg += `<polyline points="${flight.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.5"/></svg>`;
let v = sharp(await sharp(photo).composite([{ input: Buffer.from(svg) }]).png().toBuffer());
if (ROT) v = v.rotate(ROT, { background: { r: 12, g: 12, b: 12 } });
if (FLIP) v = v.flop();
await v.resize(950).png().toFile(dir + "/_localized.png");
console.log(`localized ${zones.length} rooms:`);
zones.forEach((z) => console.log(`  ${z.label}: ${z.matches} matches @ (${loc[z.id].feet})`));
console.log("-> _localized.png + _zones.json");
