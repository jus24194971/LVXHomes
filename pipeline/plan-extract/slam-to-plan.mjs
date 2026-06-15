#!/usr/bin/env node
/**
 * slam-to-plan — turn a (stella_vslam / stella_vslam_dense) result into an LVX
 * interior Plan: a top-down "interior base" image (the point-cloud density, the
 * indoor equivalent of the satellite base) + the flight route, ready to refine
 * in the Floorplan Studio exactly like a grounds sheet.
 *
 * Inputs:
 *   --traj  <file>  camera trajectory, TUM format:  timestamp tx ty tz qx qy qz qw
 *   --ply   <file>  point cloud (dense PLY from stella_vslam_dense, or sparse
 *                   landmarks). ascii or binary_little_endian, x/y/z (+rgb).
 *
 * Georeferencing knobs (interior has no GPS — you supply these, or refine in Studio):
 *   --up x,y,z      gravity/up vector in SLAM space (default: estimated from the
 *                   trajectory — a drone flight is ~planar, so its thin axis ≈ up)
 *   --scale <m>     metres per SLAM unit (default 1). See VSLAM.md for how to get
 *                   it from the takeoff-climb barometer or one known length.
 *   --yaw <deg>     rotate the floor so this heading points up (default 0; you can
 *                   also just rotate in the Studio). North/heading from SRT gb_yaw.
 *   --flip          mirror X (handedness fix if the room comes out mirrored)
 *
 * Output:  --out <plan.json>  --slug <tourSlug>  --label "<sheet label>"
 *          plus <out>-base.jpg (the interior base; host on R2 like the aerial one)
 *
 * Self-test (no SLAM needed):  node slam-to-plan.mjs --selftest
 *   fabricates a box-room flight + wall cloud, runs the whole pipeline, and emits
 *   a plan you can preview-plan.mjs — proving the projection/scale/route math.
 *
 * Needs `sharp`.
 */

import fs from "node:fs";
import sharp from "sharp";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

// ---------- tiny linear algebra (3×3) ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };
const mul3 = (M, v) => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
];

/** Jacobi eigen-decomposition of a symmetric 3×3 → {values, vectors(columns)}. */
function jacobi3(A) {
  const a = A.map((r) => r.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const phi = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
      const c = Math.cos(phi), s = Math.sin(phi);
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const values = [a[0][0], a[1][1], a[2][2]];
  const vectors = [0, 1, 2].map((j) => [V[0][j], V[1][j], V[2][j]]);
  return { values, vectors };
}

/** Rotation matrix sending unit vector `from` onto unit vector `to`. */
function rotateAonto(from, to) {
  const a = norm(from), b = norm(to);
  const v = cross(a, b);
  const c = dot(a, b);
  if (c > 0.9999) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (c < -0.9999) return [[1, 0, 0], [0, -1, 0], [0, 0, -1]]; // 180° about X
  const k = 1 / (1 + c);
  const [x, y, z] = v;
  return [
    [1 - (y * y + z * z) * k, -z + x * y * k, y + x * z * k],
    [z + x * y * k, 1 - (x * x + z * z) * k, -x + y * z * k],
    [-y + x * z * k, x + y * z * k, 1 - (x * x + y * y) * k],
  ];
}

const centroid = (pts) => {
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
};

/** Smallest-variance axis of a point set ≈ its plane normal. */
function thinAxis(pts) {
  const c = centroid(pts);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  const { values, vectors } = jacobi3(cov);
  let mi = 0;
  for (let i = 1; i < 3; i++) if (values[i] < values[mi]) mi = i;
  return norm(vectors[mi]);
}

// ---------- parsers ----------
function parseTum(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const f = line.trim().split(/\s+/).map(Number);
    if (f.length >= 4 && f.every((n) => Number.isFinite(n))) out.push({ t: f[0], p: [f[1], f[2], f[3]] });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function parsePly(file) {
  const buf = fs.readFileSync(file);
  const headEnd = buf.indexOf("end_header");
  const header = buf.toString("ascii", 0, headEnd).split(/\r?\n/);
  let count = 0, format = "ascii";
  const props = [];
  for (const h of header) {
    if (h.startsWith("format")) format = h.split(/\s+/)[1];
    else if (h.startsWith("element vertex")) count = parseInt(h.split(/\s+/)[2], 10);
    else if (h.startsWith("property")) {
      const parts = h.split(/\s+/);
      props.push({ type: parts[1], name: parts[parts.length - 1] });
    }
  }
  const ix = props.findIndex((p) => p.name === "x");
  const ri = props.findIndex((p) => /^(red|r|diffuse_red)$/i.test(p.name));
  const gi = props.findIndex((p) => /^(green|g|diffuse_green)$/i.test(p.name));
  const bi = props.findIndex((p) => /^(blue|b|diffuse_blue)$/i.test(p.name));
  const hasCol = ri >= 0 && gi >= 0 && bi >= 0;
  const pts = [], cols = [];
  if (format === "ascii") {
    const body = buf.toString("ascii", buf.indexOf("\n", headEnd) + 1).split(/\r?\n/);
    for (let i = 0, n = 0; n < count && i < body.length; i++) {
      if (!body[i].trim()) continue;
      const f = body[i].trim().split(/\s+/).map(Number);
      pts.push([f[ix], f[ix + 1], f[ix + 2]]);
      if (hasCol) cols.push([f[ri], f[gi], f[bi]]);
      n++;
    }
  } else {
    const sizeOf = (t) => (t === "double" ? 8 : t === "uchar" || t === "uint8" || t === "char" || t === "int8" ? 1 : t === "ushort" || t === "short" ? 2 : 4);
    const off = []; let stride = 0;
    for (const p of props) { off.push(stride); stride += sizeOf(p.type); }
    const le = format.includes("little");
    let o = buf.indexOf("\n", headEnd) + 1;
    const rdF = (a, t) => (t === "double" ? (le ? buf.readDoubleLE(a) : buf.readDoubleBE(a)) : (le ? buf.readFloatLE(a) : buf.readFloatBE(a)));
    for (let n = 0; n < count; n++, o += stride) {
      pts.push([rdF(o + off[ix], props[ix].type), rdF(o + off[ix + 1], props[ix + 1].type), rdF(o + off[ix + 2], props[ix + 2].type)]);
      if (hasCol) cols.push([buf[o + off[ri]], buf[o + off[gi]], buf[o + off[bi]]]);
    }
  }
  return { pts, cols: hasCol ? cols : null };
}

// ---------- self-test fixture ----------
function fabricate() {
  // a 10×7 m room, walls 3 m tall, with a low table + a ceiling (which the cut
  // plane should remove). Flight loops at 1.2 m, world slightly tilted.
  const W = 10, H = 7, Z = 3;
  const cloud = [], cols = [];
  const add = (p, c) => { cloud.push(p); cols.push(c); };
  for (let i = 0; i < 30000; i++) {
    const e = i % 4; let x, y;
    if (e === 0) { x = Math.random() * W; y = 0; }
    else if (e === 1) { x = Math.random() * W; y = H; }
    else if (e === 2) { x = 0; y = Math.random() * H; }
    else { x = W; y = Math.random() * H; }
    add([x, y, Math.random() * Z], [182, 178, 170]); // walls: light grey
  }
  for (let i = 0; i < 90000; i++) add([Math.random() * W, Math.random() * H, 0], [150, 120, 86]); // floor: warm wood
  for (let i = 0; i < 30000; i++) add([Math.random() * W, Math.random() * H, Z], [242, 242, 242]); // ceiling: white → must be cut
  for (let i = 0; i < 9000; i++) add([3 + Math.random() * 2, 2 + Math.random() * 2, Math.random() * 0.75], [60, 52, 44]); // table: dark
  const traj = [];
  for (let k = 0; k <= 120; k++) {
    const a = (k / 120) * 2 * Math.PI;
    traj.push({ t: k * 0.5, p: [W / 2 + 3 * Math.cos(a), H / 2 + 2 * Math.sin(a), 1.2] });
  }
  const tilt = rotateAonto([0, 0, 1], norm([0.15, 0.1, 1]));
  return {
    cloud: cloud.map((p) => mul3(tilt, p)),
    cols,
    traj: traj.map((s) => ({ t: s.t, p: mul3(tilt, s.p) })),
  };
}

// ---------- main ----------
const selftest = has("selftest");
let traj, cloud, cols;
if (selftest) {
  ({ traj, cloud, cols } = fabricate());
} else {
  const pf = opt("ply");
  if (!pf) { console.error("need --ply <ply>  (or --selftest); --traj is optional"); process.exit(1); }
  ({ pts: cloud, cols } = parsePly(pf));
  const tf = opt("traj");
  traj = tf ? parseTum(tf) : []; // no trajectory → floor still renders, just no route
}
if (!cloud.length) { console.error("empty point cloud"); process.exit(1); }

// 1) up vector → align to +Z. A trajectory (planar flight) gives the cleanest up;
// without one, the cloud's thin axis ≈ up too (a room is wider than it is tall).
const upArg = opt("up");
const up = upArg ? norm(upArg.split(",").map(Number)) : thinAxis(traj.length >= 2 ? traj.map((s) => s.p) : cloud);
const Rup = rotateAonto(up, [0, 0, 1]);

// 2) yaw about Z
const yaw = (parseFloat(opt("yaw", "0")) * Math.PI) / 180;
const cy = Math.cos(yaw), sy = Math.sin(yaw);
const flip = has("flip") ? -1 : 1;
const scale = parseFloat(opt("scale", "1"));
const place3 = (p) => {
  const r = mul3(Rup, p);
  return [(r[0] * cy - r[1] * sy) * flip * scale, (r[0] * sy + r[1] * cy) * scale, r[2] * scale];
};

const cloudA = cloud.map(place3); // aligned [X, Y, Z]
const traj2 = traj.map((s) => { const a = place3(s.p); return { t: s.t, xy: [a[0], a[1]] }; });

// 3) frame to the cloud's robust extent (2–98th pct), min → margin
const pct = (vals, q) => { const s = vals.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]; };
const xs = cloudA.map((p) => p[0]), ys = cloudA.map((p) => p[1]);
const minX = pct(xs, 0.02), maxX = pct(xs, 0.98), minY = pct(ys, 0.02), maxY = pct(ys, 0.98);
const margin = Math.max(0.5, 0.05 * Math.max(maxX - minX, maxY - minY));
const width = +(maxX - minX + 2 * margin).toFixed(2);
const height = +(maxY - minY + 2 * margin).toFixed(2);
const toSheet = ([x, y]) => [+(x - minX + margin).toFixed(2), +(y - minY + margin).toFixed(2)];

// 4) interior base. A colored dense cloud (stella_vslam_dense) → a COLOR
// CUT-PLANE top-down: looking straight down with the ceiling/upper-walls sliced
// off (the "compose a top-down shot" goal) — floor texture, furniture, and wall
// cross-sections, stabilized because the cloud is one consistent SLAM solve.
// `--pxm` sets resolution (zoom), `--cut` the slice height. A colorless/sparse
// cloud falls back to a wall-density raster.
const PXM = parseFloat(opt("pxm", String(Math.min(60, Math.max(20, Math.round(1400 / Math.max(width, height)))))));
const gw = Math.max(64, Math.round(width * PXM));
const gh = Math.max(64, Math.round(height * PXM));
const floorZ = pct(cloudA.map((p) => p[2]), 0.04);
const cutZ = floorZ + parseFloat(opt("cut", "1.5"));
let baseJpg, mode;
if (cols) {
  mode = `color cut ${(cutZ - floorZ).toFixed(1)}m`;
  const topZ = new Float32Array(gw * gh).fill(-Infinity);
  const out = Buffer.alloc(gw * gh * 3);
  const seen = new Uint8Array(gw * gh);
  const splat = parseInt(opt("splat", "1"), 10); // px radius — closes sub-pixel gaps
  for (let i = 0; i < cloudA.length; i++) {
    const P = cloudA[i];
    if (P[2] > cutZ) continue; // remove ceiling + upper walls
    const [sx, syy] = toSheet([P[0], P[1]]);
    const cgx = Math.floor(sx * PXM), cgy = gh - 1 - Math.floor(syy * PXM);
    for (let dy = -splat; dy <= splat; dy++) {
      for (let dx = -splat; dx <= splat; dx++) {
        const gx = cgx + dx, gyy = cgy + dy;
        if (gx < 0 || gx >= gw || gyy < 0 || gyy >= gh) continue;
        const idx = gyy * gw + gx;
        if (P[2] > topZ[idx]) { // highest point below the cut wins (seen from above)
          topZ[idx] = P[2];
          out[idx * 3] = cols[i][0]; out[idx * 3 + 1] = cols[i][1]; out[idx * 3 + 2] = cols[i][2];
          seen[idx] = 1;
        }
      }
    }
  }
  for (let idx = 0; idx < gw * gh; idx++) if (!seen[idx]) { out[idx * 3] = 20; out[idx * 3 + 1] = 18; out[idx * 3 + 2] = 22; }
  baseJpg = await sharp(out, { raw: { width: gw, height: gh, channels: 3 } }).jpeg({ quality: 86 }).toBuffer();
} else {
  mode = "density";
  const acc = new Float32Array(gw * gh);
  for (const p of cloudA) {
    const [sx, syy] = toSheet([p[0], p[1]]);
    const gx = Math.floor(sx * PXM), gyy = gh - 1 - Math.floor(syy * PXM);
    if (gx >= 0 && gx < gw && gyy >= 0 && gyy < gh) acc[gyy * gw + gx] += 1;
  }
  let amax = 0;
  for (const v of acc) if (v > amax) amax = v;
  const out = Buffer.alloc(gw * gh * 3);
  for (let i = 0; i < acc.length; i++) {
    const v = amax > 0 ? Math.log1p(acc[i]) / Math.log1p(amax) : 0;
    out[i * 3] = Math.round(20 + v * (233 - 20));
    out[i * 3 + 1] = Math.round(18 + v * (199 - 18));
    out[i * 3 + 2] = Math.round(22 + v * (126 - 22));
  }
  baseJpg = await sharp(out, { raw: { width: gw, height: gh, channels: 3 } }).jpeg({ quality: 84 }).toBuffer();
}

// 5) route: downsample trajectory to ~2 keys/sec, heading from travel tangent
const keys = [];
const t0 = traj2[0]?.t ?? 0; // empty when no trajectory → no route keys, floor still renders
let lastT = -1e9;
for (let i = 0; i < traj2.length; i++) {
  const s = traj2[i];
  if (s.t - lastT < 0.5 && i !== traj2.length - 1) continue;
  lastT = s.t;
  const [x, y] = toSheet(s.xy);
  const nx = toSheet(traj2[Math.min(i + 1, traj2.length - 1)].xy);
  const h = Math.round((Math.atan2(nx[0] - x, -(nx[1] - y)) * 180) / Math.PI);
  keys.push({ t: +(s.t - t0).toFixed(2), x, y, h });
}

// 6) emit Plan
const slug = opt("slug", selftest ? "selftest-room" : "interior");
const label = opt("label", selftest ? "Self-test Room" : "Interior");
const outPath = opt("out", selftest ? "selftest-room.plan.json" : "interior.plan.json");
const plan = {
  tourSlug: slug,
  sheets: [{
    id: "floor",
    label,
    kind: "floor",
    width,
    height,
    zones: [],
    paths: { flight: keys },
    satUrl: `data:image/jpeg;base64,${baseJpg.toString("base64")}`,
  }],
};
const jpgPath = outPath.replace(/\.(plan\.)?json$/i, "-base.jpg");
fs.writeFileSync(jpgPath, baseJpg);
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));

console.log(`slam-to-plan → ${outPath}`);
console.log(`  cloud ${cloud.length} pts · traj ${traj.length} poses → ${keys.length} route keys`);
console.log(`  floor ${width} × ${height} m  ·  base ${gw}×${gh} [${mode}] (${(baseJpg.length / 1024).toFixed(0)} KB) → ${jpgPath}`);
console.log(`  up=[${up.map((n) => n.toFixed(2))}] scale=${scale} yaw=${opt("yaw", "0")}°${has("flip") ? " flip" : ""}`);
