#!/usr/bin/env node
/**
 * Cluster the 44 per-pano room-boxes into actual ROOMS, fit one robust rectangle each,
 * emit the room edges as walls. Beats edge-voting: each room becomes ONE clean rect
 * instead of a mesh. DBSCAN on box centers (rotated frame) -> median extents per cluster.
 *
 *   node cluster-rooms.mjs <rooms.json> <fused.jpg> [eps=3.5] [minPts=2] [minArea=12]
 *   -> _walls.json (feet strokes) + _rooms_viz.png
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const roomsPath = process.argv[2] || "_rooms.json";
const photoPath = process.argv[3] || "_fused.jpg";
const EPS = parseFloat(process.argv[4] || "3.5");      // cluster radius on box centers (ft)
const MINPTS = parseInt(process.argv[5] || "2", 10);   // min panos to form a room
const MINAREA = parseFloat(process.argv[6] || "12");   // drop rooms smaller than this (sqft)
const ROT = parseFloat(process.argv[7] || "0");        // display rotation (deg, clockwise) for the viz
const FLIP = (process.argv[8] || "0") === "1";         // mirror the viz horizontally (after rotate)

const data = JSON.parse(fs.readFileSync(roomsPath, "utf8"));
const { ftw, fth, rooms, flight } = data;
const dir = path.dirname(roomsPath);

// building axis: weighted angle histogram of all edges, mod 90
const edges = [];
for (const rm of rooms) for (let i = 0; i < rm.poly.length; i++) {
  const a = rm.poly[i], b = rm.poly[(i + 1) % rm.poly.length];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len > 1) edges.push({ ang: Math.atan2(b[1] - a[1], b[0] - a[0]), len });
}
const hist = new Array(180).fill(0);
for (const e of edges) hist[Math.round(((((e.ang * 180 / Math.PI) % 90) + 90) % 90) * 2) % 180] += e.len;
let bi = 0; for (let i = 0; i < 180; i++) if (hist[i] > hist[bi]) bi = i;
const th0 = (bi / 2) * Math.PI / 180, c0 = Math.cos(th0), s0 = Math.sin(th0);
const toRot = (p) => [p[0] * c0 + p[1] * s0, p[0] * (-s0) + p[1] * c0];
const fromRot = (q) => [q[0] * c0 - q[1] * s0, q[0] * s0 + q[1] * c0];

// each box -> bounding rect in the rotated (axis-aligned) frame + center
const boxes = rooms.map((rm) => {
  const R = rm.poly.map(toRot), a0 = R.map((q) => q[0]), a1 = R.map((q) => q[1]);
  const min0 = Math.min(...a0), max0 = Math.max(...a0), min1 = Math.min(...a1), max1 = Math.max(...a1);
  return { min0, max0, min1, max1, cx: (min0 + max0) / 2, cy: (min1 + max1) / 2 };
});

// DBSCAN on CAMERA positions (rotated frame) — where the drone actually was, which
// separates rooms; box centers all collapse to the unit's middle.
const pts = rooms.map((rm) => toRot(rm.cam));
const dist = (a, b) => Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
const neighbors = (i) => { const r = []; for (let j = 0; j < pts.length; j++) if (dist(i, j) <= EPS) r.push(j); return r; };
const labels = new Array(pts.length).fill(-2);
let cid = 0;
for (let i = 0; i < pts.length; i++) {
  if (labels[i] !== -2) continue;
  const nb = neighbors(i);
  if (nb.length < MINPTS) { labels[i] = -1; continue; }
  labels[i] = cid;
  const seeds = nb.filter((j) => j !== i);
  for (let k = 0; k < seeds.length; k++) {
    const j = seeds[k];
    if (labels[j] === -1) labels[j] = cid;
    if (labels[j] !== -2) continue;
    labels[j] = cid;
    const nb2 = neighbors(j);
    if (nb2.length >= MINPTS) for (const x of nb2) if (!seeds.includes(x)) seeds.push(x);
  }
  cid++;
}

// robust room rect per cluster = median of member extents
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const clusters = {};
boxes.forEach((b, i) => { if (labels[i] >= 0) (clusters[labels[i]] = clusters[labels[i]] || []).push(b); });
let roomRects = Object.values(clusters).map((c) => ({
  min0: median(c.map((b) => b.min0)), max0: median(c.map((b) => b.max0)),
  min1: median(c.map((b) => b.min1)), max1: median(c.map((b) => b.max1)), n: c.length,
})).filter((r) => (r.max0 - r.min0) * (r.max1 - r.min1) >= MINAREA);

// trim overlaps along the dominant spread axis so zones tile at shared dividers
const spread0 = Math.max(...roomRects.map((r) => (r.min0 + r.max0) / 2)) - Math.min(...roomRects.map((r) => (r.min0 + r.max0) / 2));
const spread1 = Math.max(...roomRects.map((r) => (r.min1 + r.max1) / 2)) - Math.min(...roomRects.map((r) => (r.min1 + r.max1) / 2));
const A = spread0 >= spread1 ? ["min0", "max0"] : ["min1", "max1"];
const B = spread0 >= spread1 ? ["min1", "max1"] : ["min0", "max0"];
roomRects.sort((a, b) => (a[A[0]] + a[A[1]]) / 2 - (b[A[0]] + b[A[1]]) / 2);
for (let i = 0; i < roomRects.length - 1; i++) {
  const a = roomRects[i], b = roomRects[i + 1];
  if (a[A[1]] > b[A[0]]) { const m = (a[A[1]] + b[A[0]]) / 2; a[A[1]] = m; b[A[0]] = m; }
}

// align all zones to the shared cross-extent (footprint depth) for a clean grid
const Bmin = Math.min(...roomRects.map((r) => r[B[0]])), Bmax = Math.max(...roomRects.map((r) => r[B[1]]));
for (const r of roomRects) { r[B[0]] = Bmin; r[B[1]] = Bmax; }

// split each zone into its north/south room pair along the cross axis -> 6 rooms
const sixRooms = [];
for (const r of roomRects) {
  const cmid = (r[B[0]] + r[B[1]]) / 2;
  const n = { ...r }; n[B[0]] = cmid;
  const s = { ...r }; s[B[1]] = cmid;
  sixRooms.push(n, s);
}

// room edges -> walls (feet), de-dup near-coincident shared walls later in merge
const r2 = (p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
const strokes = sixRooms.map((r) =>
  [[r.min0, r.min1], [r.max0, r.min1], [r.max0, r.max1], [r.min0, r.max1], [r.min0, r.min1]].map(fromRot).map(r2));
fs.writeFileSync(path.join(dir, "_walls.json"), JSON.stringify(strokes));
const noise = labels.filter((l) => l < 0).length;
console.log(`axis ${(th0 * 180 / Math.PI).toFixed(1)}deg · ${roomRects.length} zones -> ${sixRooms.length} rooms · ${noise} noise panos`);

// viz: room rects (colored) + flight over the photo
const meta = await sharp(photoPath).metadata();
const SC = 960 / meta.width, PW = Math.round(meta.width * SC), PH = Math.round(meta.height * SC);
const X = (x) => (x / ftw * PW).toFixed(1), Y = (y) => (y / fth * PH).toFixed(1);
const cols = ["#ff5c5c", "#5cff8f", "#5c9bff", "#ffd24d", "#d98cff", "#4dd9d9", "#ff9c4d", "#9cff4d"];
let svg = `<svg width="${PW}" height="${PH}" xmlns="http://www.w3.org/2000/svg">`;
sixRooms.forEach((r, i) => {
  const cor = [[r.min0, r.min1], [r.max0, r.min1], [r.max0, r.max1], [r.min0, r.max1]].map(fromRot);
  const c = cols[i % cols.length];
  svg += `<polygon points="${cor.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="3.5"/>`;
});
svg += `<polyline points="${flight.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#ffffff" stroke-width="2.5" opacity="0.85"/>`;
svg += `</svg>`;
const composited = await sharp(photoPath).resize(PW, PH).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
let vpipe = sharp(composited);
if (ROT) vpipe = vpipe.rotate(ROT, { background: { r: 10, g: 10, b: 10 } });
if (FLIP) vpipe = vpipe.flop();
await vpipe.png().toFile(path.join(dir, "_rooms_viz.png"));
console.log("viz -> _rooms_viz.png");
