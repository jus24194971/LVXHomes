import type { Plan, PlanZone } from "@/data/plans";

/**
 * Measurement sheets — the laser-capture front-end of the spatial model.
 *
 * A MeasureDoc is generated from a delivered plan's room polygons: every wall
 * edge, one diagonal per room, and chord+depth pairs across detected curved
 * runs become ASKS — each a dimension line on the BIM-style sheet with a
 * fillable field. The operator lasers each span on site and types the value;
 * entries carry the raw string (as typed), the parsed decimal feet, and a
 * timestamp. Predictions (the capture's own edge lengths) are stored per ask
 * so every entry shows its delta the moment it lands — predictions locked
 * before truth, per the registry discipline.
 */

export type MeasureAskKind = "wall" | "diagonal" | "chord" | "depth";

export type MeasureAsk = {
  id: string;
  sheetId: string;
  zoneId: string;
  label: string;
  kind: MeasureAskKind;
  /** Endpoints in plan units (feet), sheet coordinates. */
  a: [number, number];
  b: [number, number];
  /** The capture's own value for this span — the locked prediction. */
  predicted_ft: number;
  /** Curve-group id linking a chord with its depth ask. */
  group?: string;
};

export type MeasureValue = { raw: string; ft: number; at: number };

export type MeasureDoc = {
  slug: string;
  generated_at: number;
  note?: string;
  asks: MeasureAsk[];
  values: Record<string, MeasureValue>;
};

const dist = (a: [number, number], b: [number, number]) =>
  Math.hypot(b[0] - a[0], b[1] - a[1]);

const mid = (a: [number, number], b: [number, number]): [number, number] => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
];

/** Perpendicular distance from point p to the line through a-b. */
function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const L = dist(a, b);
  if (L < 1e-9) return dist(p, a);
  return (
    Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / L
  );
}

/** Radius of the circular arc implied by a chord c and mid-depth (sagitta) s. */
export function radiusFromChord(c: number, s: number): number | null {
  if (!(c > 0) || !(s > 0)) return null;
  return (c * c) / (8 * s) + s / 2;
}

/** Zones that carry walls worth lasering. */
const MEASURABLE: PlanZone["kind"][] = ["room", "structure"];

/** Consecutive short edges (a polygonized curve) get collapsed to chord+depth. */
const CURVE_EDGE_MAX_FT = 3.5;
const CURVE_MIN_EDGES = 3;
const WALL_MIN_FT = 1.75;

export function generateMeasureDoc(
  plan: Plan,
  slug: string,
  prev?: MeasureDoc | null,
): MeasureDoc {
  const asks: MeasureAsk[] = [];

  for (const sheet of plan.sheets) {
    for (const zone of sheet.zones) {
      if (!MEASURABLE.includes(zone.kind)) continue;
      const pts = zone.points;
      const n = pts.length;
      if (n < 3) continue;

      const edgeLen = (i: number) => dist(pts[i], pts[(i + 1) % n]);
      const isShort = Array.from({ length: n }, (_, i) => edgeLen(i) < CURVE_EDGE_MAX_FT);

      // Maximal circular runs of short edges -> curve groups.
      const inCurve = new Array<boolean>(n).fill(false);
      let gi = 0;
      let i = 0;
      while (i < n) {
        if (!isShort[i]) {
          i++;
          continue;
        }
        let j = i;
        while (j < n && isShort[j]) j++;
        const runLen = j - i;
        if (runLen >= CURVE_MIN_EDGES) {
          for (let k = i; k < j; k++) inCurve[k] = true;
          const a = pts[i];
          const b = pts[j % n];
          const midVertex = pts[i + Math.floor(runLen / 2)];
          const group = `${zone.id}-c${gi++}`;
          asks.push({
            id: `${group}-chord`,
            sheetId: sheet.id,
            zoneId: zone.id,
            label: `${zone.label} — curve chord`,
            kind: "chord",
            a,
            b,
            predicted_ft: dist(a, b),
            group,
          });
          asks.push({
            id: `${group}-depth`,
            sheetId: sheet.id,
            zoneId: zone.id,
            label: `${zone.label} — curve depth (chord mid → wall)`,
            kind: "depth",
            a: mid(a, b),
            b: midVertex,
            predicted_ft: perpDist(midVertex, a, b),
            group,
          });
        }
        i = j;
      }

      // Straight wall edges.
      let w = 0;
      for (let e = 0; e < n; e++) {
        if (inCurve[e]) continue;
        const L = edgeLen(e);
        if (L < WALL_MIN_FT) continue;
        w++;
        asks.push({
          id: `${zone.id}-e${e}`,
          sheetId: sheet.id,
          zoneId: zone.id,
          label: `${zone.label} — wall ${w}`,
          kind: "wall",
          a: pts[e],
          b: pts[(e + 1) % n],
          predicted_ft: L,
        });
      }

      // One validating diagonal: the longest vertex-to-vertex span.
      let best: [number, number] = [0, 1];
      let bestL = 0;
      for (let p = 0; p < n; p++)
        for (let q = p + 2; q < n; q++) {
          const L = dist(pts[p], pts[q]);
          if (L > bestL) {
            bestL = L;
            best = [p, q];
          }
        }
      if (bestL > WALL_MIN_FT * 2) {
        asks.push({
          id: `${zone.id}-diag`,
          sheetId: sheet.id,
          zoneId: zone.id,
          label: `${zone.label} — diagonal`,
          kind: "diagonal",
          a: pts[best[0]],
          b: pts[best[1]],
          predicted_ft: bestL,
        });
      }
    }
  }

  // Regeneration keeps anything already lasered, matched by ask id.
  const values: Record<string, MeasureValue> = {};
  if (prev?.values) {
    const ids = new Set(asks.map((a) => a.id));
    for (const [id, v] of Object.entries(prev.values)) if (ids.has(id)) values[id] = v;
  }

  return { slug, generated_at: Date.now(), note: prev?.note, asks, values };
}

/**
 * Parse a laser reading into decimal feet. Accepts the ways a human actually
 * types them: `11.53` (ft) · `11'6"` · `11' 6-3/8"` · `11 ft 6 3/8 in` ·
 * `138.5"` (inches only) · `6-3/8"` — returns null when unparseable.
 */
export function parseFtIn(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;

  const frac = (t: string): number | null => {
    // 6 | 6.5 | 6-3/8 | 6 3/8 | 3/8
    const m = /^(\d+(?:\.\d+)?)?[ -]?(?:(\d+)\/(\d+))?$/.exec(t);
    if (!m || (!m[1] && !m[2])) return null;
    const whole = m[1] ? parseFloat(m[1]) : 0;
    const num = m[2] ? parseInt(m[2], 10) : 0;
    const den = m[3] ? parseInt(m[3], 10) : 1;
    if (den === 0) return null;
    return whole + num / den;
  };

  // inches only: 138.5"  ·  6-3/8 in
  let m = /^([\d./ -]+?)\s*(?:"|in(?:ches)?)$/.exec(s);
  if (m && !s.includes("'") && !/\bft\b/.test(s)) {
    const inches = frac(m[1].trim());
    return inches == null ? null : inches / 12;
  }

  // feet + optional inches: 11' 6-3/8"  ·  11 ft 6 3/8 in  ·  11'6
  m = /^(\d+(?:\.\d+)?)\s*(?:'|ft)\s*(.*)$/.exec(s);
  if (m) {
    const ft = parseFloat(m[1]);
    let rest = m[2].trim();
    if (!rest) return ft;
    rest = rest.replace(/\s*(?:"|in(?:ches)?)$/, "").trim();
    if (!rest) return ft;
    const inches = frac(rest);
    return inches == null ? null : ft + inches / 12;
  }

  // plain decimal -> feet
  m = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return parseFloat(m[1]);

  return null;
}

/** 11.53 -> `11' 6-3/8"` for display beside the decimal. */
export function fmtFtIn(ft: number): string {
  const sign = ft < 0 ? "-" : "";
  const abs = Math.abs(ft);
  let whole = Math.floor(abs);
  const inchesRaw = (abs - whole) * 12;
  let eighths = Math.round(inchesRaw * 8);
  let inches = Math.floor(eighths / 8);
  eighths -= inches * 8;
  if (inches >= 12) {
    whole += 1;
    inches -= 12;
  }
  const fracTxt =
    eighths === 0 ? "" : eighths % 4 === 0 ? "-1/2" : eighths % 2 === 0 ? `-${eighths / 2}/4` : `-${eighths}/8`;
  return `${sign}${whole}' ${inches}${fracTxt}"`;
}
