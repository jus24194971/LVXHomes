#!/usr/bin/env node
/**
 * calibrate — cross-stream self-calibration for the localized floorplan fusion.
 *
 * The disparate capture streams cross-reference each other to MEASURE the two
 * constants the fusion otherwise hand-guesses (no more --northFix / --northRef):
 *
 *   • metric SCALE     VSLAM is scale-free; GPS (absolute metres) pins feet-per-metre
 *                      via a 2D Umeyama fit of the matched stills. A ground-truth
 *                      marker (--marker "A,B,ft") overrides/validates it — kills drift.
 *
 *   • heading / NORTH  three independent bearings per still are reconciled:
 *                        head_i      camera forward in the VSLAM floor frame (trajectory
 *                                    pose; emitted by localize_stills as "head")
 *                        gimbalYaw_i the drone's calibrated COMPASS heading (magnetic)
 *                        GPS↔feet θ  true-north direction in the floor frame (Umeyama)
 *                      Nf_true = θ + 90°                  (where true north points)
 *                      Nf_comp = circ-mean(head_i + gimbalYaw_i)  (where compass north points)
 *                      declination Δ = Nf_comp − Nf_true  (the compass error we were guessing)
 *                      spread(head_i + gimbalYaw_i) is the compass-consistency check
 *                      (high spread ⇒ indoor magnetic interference, trust GPS/VSLAM more).
 *
 * Emits calibration.json (consumed by stills-localized-plan.mjs) + a confidence line so
 * a clean property is obvious vs one that needs a manual look.
 *
 *   node calibrate.mjs <_stills_layout.json> <localize.json> [--out calibration.json]
 *        [--marker "A,B,ft"] [--minMatch 20] [--maxAgl 10]
 */
import fs from "node:fs";

const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const rawLay = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const lay = Array.isArray(rawLay) ? rawLay : rawLay.stills || [];
const loc = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const outPath = A("out", "calibration.json");
const MINMATCH = parseInt(A("minMatch", "20"), 10), MAXAGL = parseFloat(A("maxAgl", "10"));
const FT = 3.28084;

const byName = {}; for (const s of lay) byName[s.name] = s;
const R = [];
for (const [name, L] of Object.entries(loc)) {
  if (name === "_meta" || !L || !L.feet) continue;
  const s = byName[name];
  if (!s || s.lat == null || (s.relAlt != null && s.relAlt >= MAXAGL) || (L.matches || 0) < MINMATCH) continue;
  R.push({ name, feet: L.feet, head: L.head ?? null, matches: L.matches, gimbalYaw: s.gimbalYaw, flightYaw: s.flightYaw, lat: s.lat, lon: s.lon });
}
if (R.length < 2) { console.error(`only ${R.length} usable stills (need >=2)`); process.exit(1); }

// ---- Umeyama 2D: GPS (east,north metres) -> VSLAM feet ----
const lat0 = R.reduce((a, r) => a + r.lat, 0) / R.length, lon0 = R.reduce((a, r) => a + r.lon, 0) / R.length;
const mPerLat = 111320, mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const P = R.map((r) => [(r.lon - lon0) * mPerLon, (r.lat - lat0) * mPerLat]);
const Q = R.map((r) => r.feet);
const pm = [P.reduce((a, p) => a + p[0], 0) / P.length, P.reduce((a, p) => a + p[1], 0) / P.length];
const qm = [Q.reduce((a, p) => a + p[0], 0) / Q.length, Q.reduce((a, p) => a + p[1], 0) / Q.length];
let aa = 0, bb = 0, dp = 0;
for (let i = 0; i < P.length; i++) {
  const px = P[i][0] - pm[0], py = P[i][1] - pm[1], qx = Q[i][0] - qm[0], qy = Q[i][1] - qm[1];
  aa += px * qx + py * qy; bb += px * qy - py * qx; dp += px * px + py * py;
}
const theta = Math.atan2(bb, aa), thetaDeg = (theta * 180) / Math.PI;   // GPS-north -> feet rotation
const ftPerM = Math.sqrt(aa * aa + bb * bb) / dp;
const fitErr = (() => {
  const c = Math.cos(theta), s = Math.sin(theta); let e = 0;
  for (let i = 0; i < P.length; i++) {
    const ex = ftPerM * (c * (P[i][0] - pm[0]) - s * (P[i][1] - pm[1])) + qm[0];
    const ey = ftPerM * (s * (P[i][0] - pm[0]) + c * (P[i][1] - pm[1])) + qm[1];
    e += (ex - Q[i][0]) ** 2 + (ey - Q[i][1]) ** 2;
  }
  return Math.sqrt(e / P.length);
})();

// ---- metric scale (GPS, or a ground-truth marker override) ----
let pscale = ftPerM > 0 ? FT / ftPerM : 1, scaleSrc = "gps-umeyama";
const marker = A("marker", "");
if (marker) {
  const [na, nb, ftStr] = marker.split(",");
  const ra = R.find((r) => na && r.name.slice(0, na.length) === na), rb = R.find((r) => nb && r.name.slice(0, nb.length) === nb);
  const realFt = parseFloat(ftStr);
  if (ra && rb && realFt > 0) {
    const dFeet = Math.hypot(ra.feet[0] - rb.feet[0], ra.feet[1] - rb.feet[1]); // raw VSLAM feet
    if (dFeet > 0) { pscale = realFt / dFeet; scaleSrc = `marker ${na}↔${nb}=${realFt}ft`; }
  } else console.error(`[marker] could not resolve "${marker}" — using GPS scale`);
}
const scaleErr = (Math.abs(ftPerM - FT) / FT) * 100;

// ---- heading: the flythrough SRT bridge (localize _meta.heading) — one consistent
// compass->floor mapping (phi, slope) from the flythrough's own VSLAM-head vs gb_yaw. ----
const wrap = (d) => (((d % 360) + 540) % 360) - 180;
const NfTrue = wrap(thetaDeg + 90);                        // true north, floor frame
const hc = (loc._meta && loc._meta.heading) || null;      // {phi, slope, spreadDeg, n}
let phi = null, slope = null, headSpread = null, NfComp = null, decl = null;
if (hc && hc.phi != null) {
  phi = hc.phi; slope = hc.slope ?? 1; headSpread = hc.spreadDeg ?? null;
  NfComp = wrap(phi);                                      // compass north in floor frame
  decl = wrap(NfComp - NfTrue);                            // the compass error (declination + bias)
}

// ---- confidence ----
let conf = "high"; const notes = [];
if (fitErr > 4) { conf = "low"; notes.push(`GPS↔path fit RMS ${fitErr.toFixed(1)}ft`); }
else if (fitErr > 2.5) { conf = "medium"; notes.push(`fit RMS ${fitErr.toFixed(1)}ft`); }
if (headSpread != null && headSpread > 25) { conf = "low"; notes.push(`flythrough compass spread ${headSpread.toFixed(0)}° (magnetic interference)`); }
else if (headSpread != null && headSpread > 12 && conf === "high") { conf = "medium"; notes.push(`compass spread ${headSpread.toFixed(0)}°`); }
if (scaleErr > 15 && !marker) { conf = conf === "high" ? "medium" : conf; notes.push(`GPS scale off ${scaleErr.toFixed(0)}% — set a --marker`); }
if (hc == null) notes.push("no SRT heading bridge — pass --srt-key to localize; heading falls back to gimbal/AXIS");

const cal = {
  scale: { ftPerM: +ftPerM.toFixed(3), pscale: +pscale.toFixed(4), source: scaleSrc, gpsScaleErrPct: +scaleErr.toFixed(1) },
  heading: { thetaDeg: +thetaDeg.toFixed(1), NfTrue: +NfTrue.toFixed(1), phi: phi == null ? null : +phi.toFixed(1), slope, NfComp: NfComp == null ? null : +NfComp.toFixed(1), declinationDeg: decl == null ? null : +decl.toFixed(1), compassSpreadDeg: headSpread == null ? null : +headSpread.toFixed(1), nFrames: hc ? hc.n : null },
  fit: { rmsFt: +fitErr.toFixed(2), nStills: R.length },
  confidence: conf, notes,
};
fs.writeFileSync(outPath, JSON.stringify(cal, null, 2));

const northLine = phi != null
  ? `θ ${thetaDeg.toFixed(1)}° · true-N@${NfTrue.toFixed(1)}° · phi ${phi.toFixed(1)}° (slope ${slope}) · declination ${decl.toFixed(1)}° · spread ${headSpread != null ? headSpread.toFixed(1) + "°" : "n/a"}`
  : `θ ${thetaDeg.toFixed(1)}° · true-N@${NfTrue.toFixed(1)}° · (no SRT bridge — pass --srt-key)`;
console.log(`calibrate · ${R.length} stills · heading ${hc ? `SRT bridge (${hc.n} frames)` : "none"}`);
console.log(`  scale   ${ftPerM.toFixed(2)} ft/m (true ${FT}) → pscale ${pscale.toFixed(3)} [${scaleSrc}], GPS scale err ${scaleErr.toFixed(1)}%`);
console.log(`  north   ${northLine}`);
console.log(`  fit     RMS ${fitErr.toFixed(2)} ft · confidence ${conf}${notes.length ? ` (${notes.join("; ")})` : ""}`);
console.log(`  -> ${outPath}`);
