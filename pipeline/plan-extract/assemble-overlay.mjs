#!/usr/bin/env node
/**
 * Detailed pass: drop the 6 TRUE still-room polygons onto the overview at their cluster
 * positions (aspect-fit to resolve the 90° facing), thread the flight path, render the
 * overlay, and emit zones (raw feet) ready to push as draggable plan rooms.
 *   node assemble-overlay.mjs  -> _overlay.png + _zones.json
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const CEIL = 9, ROT = 300, FLIP = 1, AXIS = 27.5;
const { ftw, fth, flight } = JSON.parse(fs.readFileSync(dir + "/_rooms.json", "utf8"));
const rects = JSON.parse(fs.readFileSync(dir + "/_walls.json", "utf8")); // 6 cluster rects (closed)
// cluster sixRooms order = [z0-N, z0-S, z1-N, z1-S, z2-N, z2-S]; map to rooms (flip if render shows swaps)
const order = ["0012", "0011", "0010", "0009", "0013", "0014"];
const names = { "0009": "Kitchen", "0010": "Living", "0011": "Guest Bath", "0012": "Bonus", "0013": "Master Bed", "0014": "Master Bath" };

const rad = (d) => d * Math.PI / 180;
const rot = (poly, deg) => { const c = Math.cos(rad(deg)), s = Math.sin(rad(deg)); return poly.map(([x, y]) => [x * c - y * s, x * s + y * c]); };
const bb = (poly) => { const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]); return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 }; };

function stillPoly(id) {
  const L = JSON.parse(fs.readFileSync(`${dir}/_layout_${id}.json`, "utf8"));
  const z0 = L.z0, z1 = Math.abs(L.z1), camH = CEIL * z1 / (z0 + z1);
  const floor = L.uv.filter((_, i) => i % 2 === 1).map(([u, v]) => {
    const lon = (u - 0.5) * 2 * Math.PI, lat = (0.5 - v) * Math.PI, d = camH / Math.tan(Math.abs(lat));
    return [Math.sin(lon) * d, Math.cos(lon) * d];
  });
  const b = bb(floor);
  return floor.map(([x, y]) => [x - b.cx, y - b.cy]); // centered at origin
}

const zones = [];
rects.forEach((rect, i) => {
  const id = order[i]; if (!id) return;
  let poly = stillPoly(id);
  const rc = rect.slice(0, 4);
  const rcx = rc.reduce((s, p) => s + p[0], 0) / 4, rcy = rc.reduce((s, p) => s + p[1], 0) / 4;
  const rb = bb(rot(rc.map((p) => [p[0] - rcx, p[1] - rcy]), -AXIS)); // rect aspect in the axis frame
  const pb = bb(poly);
  const deg = ((pb.w > pb.h) !== (rb.w > rb.h)) ? AXIS + 90 : AXIS; // match long axis
  poly = rot(poly, deg).map(([x, y]) => [x + rcx, y + rcy]);
  zones.push({ id, label: names[id], points: poly.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]) });
});
fs.writeFileSync(dir + "/_zones.json", JSON.stringify(zones, null, 1));

// overlay render (display orientation)
const photo = dir + "/_fused.jpg", meta = await sharp(photo).metadata();
const W = meta.width, H = meta.height, X = (x) => (x / ftw * W).toFixed(1), Y = (y) => (y / fth * H).toFixed(1);
const cols = ["#ff5c5c", "#ffd24d", "#5cff8f", "#5c9bff", "#d98cff", "#4dd9d9"];
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
zones.forEach((z, i) => { svg += `<polygon points="${z.points.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="${cols[i % 6]}" fill-opacity="0.28" stroke="${cols[i % 6]}" stroke-width="3"/>`; });
svg += `<polyline points="${flight.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.6"/></svg>`;
let v = sharp(await sharp(photo).composite([{ input: Buffer.from(svg) }]).png().toBuffer());
if (ROT) v = v.rotate(ROT, { background: { r: 12, g: 12, b: 12 } });
if (FLIP) v = v.flop();
await v.resize(950).png().toFile(dir + "/_overlay.png");
console.log(`${zones.length} rooms placed -> _overlay.png + _zones.json  (order: ${order.map((id) => names[id]).join(", ")})`);
