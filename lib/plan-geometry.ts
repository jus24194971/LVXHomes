/**
 * Shared plan geometry helpers — used by both the player minimap
 * (components/tour/plan.tsx) and the Floorplan Studio (components/studio/plan-editor.tsx)
 * so the flight path and zone labels render identically in both.
 */

type Pt = { x: number; y: number } | [number, number];
const ax = (p: Pt) => (Array.isArray(p) ? p[0] : p.x);
const ay = (p: Pt) => (Array.isArray(p) ? p[1] : p.y);
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A flowing SVG path for a flight track. Hand-flown paths are jagged, so we
 * apply a light moving-average (endpoints preserved, so start/end markers stay
 * put) and then a Catmull-Rom → cubic-Bézier conversion for smooth curves.
 * Approximate by design — it reads as a graceful flight line, not GPS confetti.
 */
export function smoothPathD(pts: Pt[], smoothing = 1): string {
  const raw = pts.map((p) => ({ x: ax(p), y: ay(p) }));
  if (raw.length < 2) return "";

  let P = raw;
  if (smoothing > 0 && raw.length > 3) {
    P = raw.map((p, i) => {
      if (i === 0 || i === raw.length - 1) return p;
      let sx = 0, sy = 0, n = 0;
      for (let k = -smoothing; k <= smoothing; k++) {
        const j = i + k;
        if (j >= 0 && j < raw.length) { sx += raw[j].x; sy += raw[j].y; n++; }
      }
      return { x: sx / n, y: sy / n };
    });
  }
  if (P.length === 2) return `M ${r2(P[0].x)} ${r2(P[0].y)} L ${r2(P[1].x)} ${r2(P[1].y)}`;

  let d = `M ${r2(P[0].x)} ${r2(P[0].y)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] ?? P[i];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${r2(c1x)} ${r2(c1y)} ${r2(c2x)} ${r2(c2y)} ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return d;
}

/** Centroid of a polygon, accepting either point shape. */
export function centroidOf(points: Pt[]): [number, number] {
  let x = 0, y = 0;
  for (const p of points) { x += ax(p); y += ay(p); }
  return [x / points.length, y / points.length];
}

/**
 * Time at which a flight path passes closest to a point — the GPS/VSLAM-driven
 * "fly me to this amenity" target, so a map jump resumes at the right moment
 * without any hand-authored keyframe. Returns null if there's no path.
 */
export function closestApproachT(
  flightKeys: Array<{ t: number; x: number; y: number }>,
  point: [number, number],
): number | null {
  if (!flightKeys?.length) return null;
  const [px, py] = point;
  let best = Infinity;
  let bt = flightKeys[0].t;
  for (const k of flightKeys) {
    const d = (k.x - px) ** 2 + (k.y - py) ** 2;
    if (d < best) { best = d; bt = k.t; }
  }
  return bt;
}

/**
 * Time-aware closest approach. A room the flight covers twice has two PASSES
 * (local minima of distance to the point). Resume at the pass nearest the
 * viewer's CURRENT moment — just past the kitchen for the first time, tapping
 * "Kitchen" continues from that first pass, not a later, globally-closer one.
 * Falls back to the plain closest approach when there's a single pass or no
 * current time.
 */
export function closestApproachNearT(
  flightKeys: Array<{ t: number; x: number; y: number }>,
  point: [number, number],
  nowT: number | null,
): number | null {
  if (!flightKeys?.length) return null;
  const [px, py] = point;
  const d2 = flightKeys.map((k) => (k.x - px) ** 2 + (k.y - py) ** 2);
  let best = Infinity;
  for (const d of d2) if (d < best) best = d;
  // passes = distinct dips comparable to the best approach (+6 plan-unit slack)
  const thresh = (Math.sqrt(best) + 6) ** 2;
  const passes: Array<{ t: number; d: number }> = [];
  for (let i = 0; i < d2.length; i++) {
    const prev = i > 0 ? d2[i - 1] : Infinity;
    const next = i < d2.length - 1 ? d2[i + 1] : Infinity;
    if (d2[i] <= prev && d2[i] <= next && d2[i] <= thresh) {
      const last = passes[passes.length - 1];
      if (last && Math.abs(flightKeys[i].t - last.t) < 6) {
        if (d2[i] < last.d) { last.t = flightKeys[i].t; last.d = d2[i]; }
      } else {
        passes.push({ t: flightKeys[i].t, d: d2[i] });
      }
    }
  }
  if (!passes.length) return closestApproachT(flightKeys, point);
  if (nowT == null) return passes[0].t;
  let pick = passes[0];
  for (const p of passes) {
    if (Math.abs(p.t - nowT) < Math.abs(pick.t - nowT)) pick = p;
  }
  return pick.t;
}

/**
 * Font size (in plan units) that keeps `label` inside the zone's bounding box.
 * Shrinks to fit width AND height, floored at `min` so it never vanishes.
 * Returns `base` for empty labels (unused). Solves the "label overflows a small
 * amenity box" problem on both the live minimap and the editor.
 */
export function zoneFontSize(points: Pt[], label: string, base: number, min: number): number {
  if (!label) return base;
  const xs = points.map(ax), ys = points.map(ay);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const n = Math.max(1, label.length);
  // glyph advance ≈ 0.6em + 0.12em letter-spacing; keep ~88% of the box width
  const widthFit = (w * 0.88) / (n * 0.72);
  const heightFit = h * 0.62;
  return Math.max(min, Math.min(base, widthFit, heightFit));
}
