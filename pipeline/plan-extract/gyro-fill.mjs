#!/usr/bin/env node
/**
 * gyro-fill — reconstruct a flight's GPS-less opening from the per-frame gimbal
 * yaw (gb_yaw) in the SRT, anchored between the takeoff pin and the first GPS fix.
 *
 * The principled version of reconstruct-opening: instead of mirroring the return,
 * integrate the REAL heading curve through the un-tracked leg, then affine-fit it
 * (one scale + one rotation) so it lands exactly on the two anchors. The rotation
 * absorbs the constant gimbal-mount offset (≈ -19.5° here), and check-gyro proved
 * gb_yaw tracks travel (R=0.975), so the shape is faithful.
 *
 *   node gyro-fill.mjs <flight.SRT> <plan.json> [--start x,y] [--keys 36] [--out plan.json]
 *
 * --start  takeoff pin in sheet coords (default: the path's last key — correct
 *          when start==end, as on George). The first GPS key is the other anchor.
 *
 * Self-test (no files):  node gyro-fill.mjs --selftest
 *   fabricates a known curved leg, derives gb_yaw (+mount offset +noise), and
 *   checks the reconstruction matches the truth.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);

const D2R = Math.PI / 180;
const dirOf = (yawDeg) => [Math.sin(yawDeg * D2R), -Math.cos(yawDeg * D2R)]; // bearing → unit (x east, y south)

/** Integrate per-frame headings into a unit-speed shape, then affine-fit so
 *  shape[0]→A and shape[last]→B. Returns sampled {t,x,y} along the leg. */
function reconstruct(frames, A, B, nKeys) {
  const shape = [[0, 0]];
  for (let i = 1; i < frames.length; i++) {
    const [dx, dy] = dirOf(frames[i - 1].yaw);
    const dt = Math.max(1e-3, frames[i].t - frames[i - 1].t);
    shape.push([shape[i - 1][0] + dx * dt, shape[i - 1][1] + dy * dt]);
  }
  const end = shape[shape.length - 1];
  const endMag = Math.hypot(end[0], end[1]) || 1e-9;
  const ab = [B[0] - A[0], B[1] - A[1]];
  const scale = Math.hypot(ab[0], ab[1]) / endMag;
  const theta = Math.atan2(ab[1], ab[0]) - Math.atan2(end[1], end[0]);
  const c = Math.cos(theta) * scale, s = Math.sin(theta) * scale;
  const place = (p) => [A[0] + (c * p[0] - s * p[1]), A[1] + (s * p[0] + c * p[1])];

  const t0 = frames[0].t, t1 = frames[frames.length - 1].t;
  const out = [];
  for (let k = 0; k < nKeys; k++) {
    const tt = t0 + (k / nKeys) * (t1 - t0);
    let i = 0; while (i < frames.length - 1 && frames[i + 1].t < tt) i++;
    const f = (tt - frames[i].t) / Math.max(1e-3, (frames[i + 1]?.t ?? frames[i].t) - frames[i].t);
    const p0 = shape[i], p1 = shape[Math.min(i + 1, shape.length - 1)];
    const [x, y] = place([p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f]);
    out.push({ t: tt, x, y, yaw: frames[i].yaw });
  }
  return { keys: out, scale, thetaDeg: (theta / D2R) };
}

// ---------- self-test ----------
if (has("selftest")) {
  // Closed-loop: build truth at CONSTANT speed from a turning heading curve, derive
  // gb_yaw (+mount offset +jitter), reconstruct, compare. Constant speed isolates the
  // algorithm (integrate + 2-anchor affine fit + offset absorption) from the inherent
  // unknown-speed slack, which we measure separately below.
  const v = 1.5, dt = 0.5, N = 140;
  const headingAt = (u) => 250 - 40 * u - 28 * Math.sin(u * Math.PI * 1.5); // a real turning leg, deg
  const truth = [[172, 16]];
  const frames = [];
  for (let k = 1; k <= N; k++) {
    const u = (k - 1) / N;
    const [dx, dy] = dirOf(headingAt(u));
    truth.push([truth[k - 1][0] + v * dt * dx, truth[k - 1][1] + v * dt * dy]);
    frames.push({ t: (k - 1) * dt, yaw: headingAt(u) + 19.5 + (((k * 12.9) % 7) - 3.5) }); // mount + jitter
  }
  frames.push({ t: N * dt, yaw: frames[frames.length - 1].yaw });
  const A = truth[0], B = truth[truth.length - 1];
  const { keys, scale, thetaDeg } = reconstruct(frames, A, B, truth.length);
  let sum = 0, max = 0;
  for (let k = 0; k < truth.length; k++) {
    const d = Math.hypot(keys[k].x - truth[k][0], keys[k].y - truth[k][1]);
    sum += d; max = Math.max(max, d);
  }
  const span = Math.hypot(B[0] - A[0], B[1] - A[1]);
  console.log(`self-test: scale ${scale.toFixed(3)} · θ ${thetaDeg.toFixed(1)}° (absorbs the +19.5° mount offset)`);
  console.log(`  mean dev ${(sum / keys.length).toFixed(2)} m · max ${max.toFixed(2)} m  (span ${span.toFixed(0)} m → ${(100 * sum / keys.length / span).toFixed(1)}% mean)`);
  console.log(sum / keys.length < 0.03 * span ? "  ✓ math faithful (shape + endpoints). Real flights add ~few-% along-track slack from unknown speed." : "  ✗ off — investigate");
  process.exit(0);
}

// ---------- real run ----------
const srtPath = args[0], planPath = args[1];
if (!srtPath || !planPath) { console.error("usage: node gyro-fill.mjs <flight.SRT> <plan.json>  (or --selftest)"); process.exit(1); }
const nKeys = parseInt(opt("keys", "36"), 10);
const outPath = opt("out", planPath);

const num = (b, re) => { const m = b.match(re); return m ? parseFloat(m[1]) : null; };
const text = fs.readFileSync(srtPath, "utf8");
const track = [];
for (const b of text.split(/\r?\n\r?\n/)) {
  const tc = b.match(/(\d\d):(\d\d):(\d\d),(\d\d\d)\s*-->/);
  if (!tc) continue;
  track.push({
    t: +tc[1] * 3600 + +tc[2] * 60 + +tc[3] + +tc[4] / 1000,
    lat: num(b, /latitude:\s*([-\d.]+)/), lon: num(b, /longitude:\s*([-\d.]+)/),
    yaw: num(b, /gb_yaw:\s*([-\d.]+)/),
  });
}
track.sort((a, b) => a.t - b.t);

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const sheet = plan.sheets.find((s) => s.paths && Object.keys(s.paths).length) ?? plan.sheets[0];
const chId = Object.keys(sheet.paths)[0];
const keys = sheet.paths[chId].filter((k) => k.h !== undefined).sort((a, b) => a.t - b.t); // the GPS keys
if (!keys.length) { console.error("plan has no GPS keys (with h) to anchor to"); process.exit(1); }

const tLock = keys[0].t;
const startArg = opt("start");
const A = startArg ? startArg.split(",").map(Number) : [keys[keys.length - 1].x, keys[keys.length - 1].y];
const B = [keys[0].x, keys[0].y];

const opening = track.filter((p) => p.t < tLock && p.yaw != null);
if (opening.length < 5) { console.error(`only ${opening.length} pre-lock frames with gb_yaw — is this the right SRT?`); process.exit(1); }

const { keys: lead, scale, thetaDeg } = reconstruct(opening, A, B, nKeys);
const round = (n) => Math.round(n * 100) / 100;
const leadKeys = lead.map((k) => ({ t: round(k.t), x: round(k.x), y: round(k.y), h: Math.round(k.yaw) }));

sheet.paths[chId] = [...leadKeys, ...keys];
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));

console.log(`gyro-fill → ${outPath}`);
console.log(`  ${opening.length} pre-lock frames (t 0..${tLock}s) → ${leadKeys.length} reconstructed keys`);
console.log(`  anchored ${A.map(round)} (takeoff) → ${B.map(round)} (first GPS) · scale ${scale.toFixed(3)} · θ ${thetaDeg.toFixed(1)}°`);
console.log(`  full path: ${sheet.paths[chId].length} keys`);
