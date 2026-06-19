#!/usr/bin/env node
/**
 * stills-localized-plan — the FINAL CLEANING PASS.
 *
 * Each still's HorizonNet room shape is placed at its VSLAM-LOCALIZED position (precise,
 * inherited from the flythrough frame it overlaps) instead of its noisy individual GPS.
 * The flight path is locally accurate, so this collapses the room-overlap that indoor
 * GPS couldn't fix. A GPS<->path similarity (solved from the well-matched stills) rotates
 * the whole thing north-up and georeferences it onto the aerial base.
 *
 *   node stills-localized-plan.mjs <_stills_layout.json> <localize.json> <out.plan.json>
 *        [--ceil 8.5] [--maxD 14] [--minMatch 20] [--maxAgl 10] [--rot 0] [--axis auto]
 */
import fs from "node:fs";

const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const rawLay = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const lay = Array.isArray(rawLay) ? rawLay : rawLay.stills || [];
const loc = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const outPath = process.argv[4] || "plan.json";
const CEIL = parseFloat(A("ceil", "8.5")), MAXD = parseFloat(A("maxD", "14"));
const MINMATCH = parseInt(A("minMatch", "20"), 10), MAXAGL = parseFloat(A("maxAgl", "10")), ROT = parseFloat(A("rot", "0"));
const NORTHFIX = parseFloat(A("northFix", "0"));   // global rotation correction (deg) to true north — rotates rooms + base together
const CALP = A("cal", "");                          // calibration.json from calibrate.mjs (measured scale + heading)
const cal = CALP && fs.existsSync(CALP) ? JSON.parse(fs.readFileSync(CALP, "utf8")) : null;
const HEADREF = parseFloat(A("headRef", "90"));    // poly +y (equirect centre) vs camera-forward, empirical offset
const SNAP = process.argv.includes("--snapAxis");  // also snap head-oriented rooms to the consensus building axis

const byName = {}; for (const s of lay) byName[s.name] = s;
const rooms = [];
for (const [name, L] of Object.entries(loc)) {
  if (name === "_meta" || !L || !L.feet) continue;
  const s = byName[name];
  if (!s || !s.uv || (s.relAlt != null && s.relAlt >= MAXAGL) || (L.matches || 0) < MINMATCH) continue;
  rooms.push({ name, feet: L.feet, matches: L.matches, uv: s.uv, z0: s.z0, z1: s.z1, gimbalYaw: s.gimbalYaw, head: L.head ?? null, lat: s.lat, lon: s.lon });
}
if (rooms.length < 2) { console.error(`only ${rooms.length} localized rooms (need >=2)`); process.exit(1); }

// ---- similarity GPS<->VSLAM-feet (Umeyama 2D) from the matched stills ----
const gr = rooms.filter((r) => r.lat != null);
const lat0 = gr.reduce((a, r) => a + r.lat, 0) / gr.length, lon0 = gr.reduce((a, r) => a + r.lon, 0) / gr.length;
const mPerLat = 111320, mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180), FT = 3.28084;
const P = gr.map((r) => [(r.lon - lon0) * mPerLon, (r.lat - lat0) * mPerLat]);  // GPS east/north metres
const Q = gr.map((r) => r.feet);                                                // VSLAM feet
const pm = [P.reduce((a, p) => a + p[0], 0) / P.length, P.reduce((a, p) => a + p[1], 0) / P.length];
const qm = [Q.reduce((a, p) => a + p[0], 0) / Q.length, Q.reduce((a, p) => a + p[1], 0) / Q.length];
let aa = 0, bb = 0, dp = 0;
for (let i = 0; i < P.length; i++) {
  const px = P[i][0] - pm[0], py = P[i][1] - pm[1], qx = Q[i][0] - qm[0], qy = Q[i][1] - qm[1];
  aa += px * qx + py * qy; bb += px * qy - py * qx; dp += px * px + py * py;
}
const theta = Math.atan2(bb, aa);                  // rotation GPS-north -> VSLAM frame
const thetaDeg = (theta * 180) / Math.PI;
const ftPerM = Math.sqrt(aa * aa + bb * bb) / dp;  // VSLAM feet per GPS metre (~3.28 if scale is true)
const fitErr = (() => {                            // RMS residual of the fit, feet
  const c = Math.cos(theta), s = Math.sin(theta); let e = 0;
  for (let i = 0; i < P.length; i++) {
    const ex = ftPerM * (c * (P[i][0] - pm[0]) - s * (P[i][1] - pm[1])) + qm[0];
    const ey = ftPerM * (s * (P[i][0] - pm[0]) + c * (P[i][1] - pm[1])) + qm[1];
    e += (ex - Q[i][0]) ** 2 + (ey - Q[i][1]) ** 2;
  }
  return Math.sqrt(e / P.length);
})();
const PSCALE = cal?.scale?.pscale ?? (ftPerM > 0 ? FT / ftPerM : 1);  // calibrated metric scale (marker/GPS), else local GPS fit
// north-up: rotate VSLAM feet by -theta so +y points North
const cN = Math.cos(-theta + (NORTHFIX * Math.PI) / 180), sN = Math.sin(-theta + (NORTHFIX * Math.PI) / 180);
const toNorth = ([x, y]) => [x * cN * PSCALE - y * sN * PSCALE, x * sN * PSCALE + y * cN * PSCALE];

// ---- shapes ----
function floorPoly(s) {
  const z0 = s.z0, z1 = Math.abs(s.z1), camH = CEIL * z1 / (z0 + z1);
  const fl = s.uv.filter((_, i) => i % 2 === 1);
  return fl.map(([u, v]) => {
    const lon = (u - 0.5) * 2 * Math.PI, lat = (0.5 - v) * Math.PI;
    let d = camH / Math.tan(Math.abs(lat));
    if (MAXD > 0 && d > MAXD) d = MAXD;
    return [Math.sin(lon) * d, Math.cos(lon) * d];
  });
}
function polyAxis(poly) {
  const h = new Array(180).fill(0);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = (((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) % 90 + 90) % 90;
    h[Math.round(ang * 2) % 180] += len;
  }
  let bi = 0; for (let i = 0; i < 180; i++) if (h[i] > h[bi]) bi = i;
  return bi / 2;
}
// building axis (north-up): vector-mean the rooms' wall directions after orienting each by -gimbalYaw
let sx = 0, sy = 0;
for (const r of rooms) { const a = ((polyAxis(floorPoly(r)) - (r.gimbalYaw || 0)) * 4 * Math.PI) / 180; sx += Math.cos(a); sy += Math.sin(a); }
let AXIS = A("axis", "auto") === "auto" ? (((Math.atan2(sy, sx) * 180) / Math.PI) / 4 + 90) % 90 : parseFloat(A("axis", "auto"));
// building axis from the GPS-true-north room positions (compass-FREE) — PCA of the centroids.
// Reveals the building's real orientation independent of the (indoor-noisy) compass.
const _compassAxis = AXIS;
const _pp = rooms.map((r) => toNorth(r.feet));
const _pmx = _pp.reduce((a, p) => a + p[0], 0) / _pp.length, _pmy = _pp.reduce((a, p) => a + p[1], 0) / _pp.length;
let _sxx = 0, _syy = 0, _sxy = 0;
for (const [x, y] of _pp) { const dx = x - _pmx, dy = y - _pmy; _sxx += dx * dx; _syy += dy * dy; _sxy += dx * dy; }
const POSAXIS = ((((0.5 * Math.atan2(2 * _sxy, _sxx - _syy) * 180) / Math.PI) % 90) + 90) % 90;
const AXISMODE = A("axisFrom", "compass");
if (AXISMODE === "pca" && A("axis", "auto") === "auto") AXIS = POSAXIS;  // explicit --axis (e.g. 0 = cardinal ground-truth) wins
console.error(`[axis] compass-mean ${_compassAxis.toFixed(1)}° · position-PCA ${POSAXIS.toFixed(1)}° · using ${AXIS.toFixed(1)}° (${AXISMODE})`);

const rot = (p, deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return p.map(([x, y]) => [x * c - y * s, x * s + y * c]); };

// --- north calibration: a reference still whose true north we know should point UP ---
const NREF = A("northRef", "");
if (NREF) {
  const ref = rooms.find((r) => r.name.slice(0, NREF.length) === NREF);
  if (ref) {
    let thr = AXIS - polyAxis(floorPoly(ref));
    thr += Math.round((-(ref.gimbalYaw || 0) - thr) / 90) * 90;
    thr += ROT;                                            // baseline orientation, no northFix
    const lonN = (-(ref.flightYaw || 0) * Math.PI) / 180;  // floorPoly lon whose world azimuth = North
    const np = rot([[Math.sin(lonN), Math.cos(lonN)]], thr)[0];
    let rec = -90 - (Math.atan2(np[1], np[0]) * 180) / Math.PI;  // rotate north to image-up (0,-1)
    rec = (((rec % 360) + 540) % 360) - 180;
    console.log(`[northRef ${NREF}] flightYaw ${ref.flightYaw}deg -> recommended --northFix ${rec.toFixed(1)}`);
  } else {
    console.log(`[northRef] still ${NREF} not found among localized rooms`);
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
const zones = rooms.map((r, idx) => {
  const poly = floorPoly(r);
  let th;
  const HC = cal && cal.heading;
  if (AXISMODE === "pca") {
    // COMPASS-FREE: align each room's own shape axis to the GPS-derived building axis.
    th = AXIS - polyAxis(poly) + ROT + NORTHFIX;
  } else if (HC && HC.phi != null && r.gimbalYaw != null) {
    // CALIBRATED: the still's floor-frame heading via the SRT compass bridge
    // (phi + slope*gimbalYaw) — same frame as the positions. poly +y (camera forward)
    // rotates to that heading; -theta + NORTHFIX matches toNorth -> one true-north frame.
    const stillHead = HC.phi + (HC.slope ?? 1) * r.gimbalYaw;
    th = (stillHead - HEADREF) - thetaDeg + ROT + NORTHFIX;
    if (SNAP) th += Math.round((AXIS - (th + polyAxis(poly))) / 90) * 90;
  } else {
    // FALLBACK (no head): magnetic gimbal axis + consensus building axis (the old path).
    th = AXIS - polyAxis(poly);
    const heading = -(r.gimbalYaw || 0);                  // gimbal yaw resolves the 90° quadrant
    th += Math.round((heading - th) / 90) * 90;
    th += ROT + NORTHFIX;
  }
  const pos = toNorth(r.feet);
  const pts = rot(poly, th).map(([x, y]) => [pos[0] + x, pos[1] + y]);
  return { id: r.name, label: `Room ${idx + 1}`, kind: "room", points: pts, matches: r.matches };
});

// ---- sheet extent + geo (centroid of north-up feet <-> GPS centroid) ----
const ncx = gr.reduce((a, r) => a + toNorth(r.feet)[0], 0) / gr.length;
const ncy = gr.reduce((a, r) => a + toNorth(r.feet)[1], 0) / gr.length;
const xs = zones.flatMap((z) => z.points.map((p) => p[0])), ys = zones.flatMap((z) => z.points.map((p) => p[1]));
const pad = 5;
const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
const W = Math.ceil(Math.max(...xs) - x0 + pad), H = Math.ceil(Math.max(...ys) - y0 + pad);
for (const z of zones) z.points = z.points.map(([x, y]) => [r2(x - x0), r2(y - y0)]);
// a sheet feet point (sx,sy) -> world: +x East, +y North (feet) about the centroid -> GPS
const f2gps = (sxft, syft) => {
  const ef = (sxft + x0) - ncx, nf = (syft + y0) - ncy;            // east/north feet from centroid
  return [lat0 + (nf / FT) / mPerLat, lon0 + (ef / FT) / mPerLon];
};
const cor = [[0, 0], [W, 0], [0, H], [W, H]].map(([a, b]) => f2gps(a, b));
const lats = cor.map((c) => c[0]), lons = cor.map((c) => c[1]);
const geo = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };

const plan = { sheets: [{ width: W, height: H, geo, buildingAxis: r2(AXIS), zones }] };
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
console.log(`${zones.length} rooms localized+placed · axis ${AXIS.toFixed(1)}° · GPS<->path: rot ${(theta * 180 / Math.PI).toFixed(1)}°, ${ftPerM.toFixed(2)} ft/m (true 3.28), fit RMS ${fitErr.toFixed(1)} ft · sheet ${W}x${H} ft`);
console.log(`geo: ${geo.minLat.toFixed(6)},${geo.minLon.toFixed(6)} .. ${geo.maxLat.toFixed(6)},${geo.maxLon.toFixed(6)}`);
