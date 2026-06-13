/**
 * Plans — 2D floor plans AND site/grounds plans, linked to a tour's flight.
 *
 * A plan has one or more SHEETS. A sheet is either a floor ("Main Floor",
 * "Suite 200") or a site ("Grounds") — same geometry either way: zones
 * (clickable polygons), strokes (walls / fences / boundaries), and labels.
 * Coordinates are arbitrary plan units (think feet); the renderer fits the
 * sheet's width/height to the viewport, so residential, commercial, and
 * estate-grounds sheets all just work.
 *
 * A zone can link into the flight two ways:
 *   videoTime — tap → the flight seeks to that moment
 *   panoId    — tap → step into that room's still 360
 */

export type PlanZoneKind =
  | "room" // interior space
  | "structure" // building footprint on a site sheet
  | "outdoor" // lawns, gardens, desert
  | "water" // pool, spa, pond
  | "hardscape"; // drives, courts, patios

export type PlanZone = {
  id: string;
  label: string;
  kind: PlanZoneKind;
  /** Polygon in plan units. */
  points: [number, number][];
  /** Flight chapter this zone seeks into (defaults to the first chapter). */
  chapterId?: string;
  videoTime?: number;
  panoId?: string;
};

/**
 * A keyframe on the flight path: at `t` seconds into a chapter the camera is
 * at (x, y) on this sheet. Optional `h` = the plan bearing (degrees clockwise
 * from sheet-up) that the equirect frame's FRONT faces at that moment — when
 * omitted, the direction of travel (path tangent) is used, which suits
 * camera-locked footage. The live view cone = this base heading + the
 * viewer's current look direction.
 */
export type PlanPathKey = { t: number; x: number; y: number; h?: number };

export type PlanSheet = {
  id: string;
  label: string;
  kind: "floor" | "site";
  /** Plan-unit extents — the renderer scales to fit. */
  width: number;
  height: number;
  zones: PlanZone[];
  /** Heavy strokes: exterior walls, property boundary, fences. */
  strokes?: [number, number][][];
  /** Flight-path keyframes per chapter id — drives the traveling dot. */
  paths?: Record<string, PlanPathKey[]>;
};

export type Plan = {
  tourSlug: string;
  sheets: PlanSheet[];
};

export const PLANS: Plan[] = [
  {
    tourSlug: "test",
    sheets: [
      {
        id: "main",
        label: "Main Floor",
        kind: "floor",
        width: 100,
        height: 70,
        strokes: [
          [
            [10, 10],
            [90, 10],
            [90, 60],
            [10, 60],
            [10, 10],
          ],
        ],
        zones: [
          { id: "suite", label: "Primary Suite", kind: "room", points: [[10, 10], [30, 10], [30, 40], [10, 40]], panoId: "suite" },
          { id: "foyer", label: "Foyer", kind: "room", points: [[10, 40], [30, 40], [30, 60], [10, 60]], videoTime: 0 },
          { id: "great", label: "Great Room", kind: "room", points: [[30, 10], [65, 10], [65, 60], [30, 60]], videoTime: 4 },
          { id: "kitchen", label: "Kitchen", kind: "room", points: [[65, 10], [90, 10], [90, 35], [65, 35]], panoId: "kitchen" },
          { id: "dining", label: "Dining", kind: "room", points: [[65, 35], [90, 35], [90, 60], [65, 60]], videoTime: 8 },
        ],
        // Traveling-dot keyframes for the 12s test loop: foyer → great room →
        // kitchen pass → dining → back. Headings fall back to path tangent.
        paths: {
          flight: [
            { t: 0, x: 20, y: 50 },
            { t: 2, x: 38, y: 42 },
            { t: 4, x: 47, y: 22 },
            { t: 6, x: 62, y: 24 },
            { t: 8, x: 77, y: 46 },
            { t: 10, x: 50, y: 52 },
            { t: 12, x: 20, y: 50 },
          ],
        },
      },
      {
        id: "grounds",
        label: "Grounds",
        kind: "site",
        width: 140,
        height: 100,
        strokes: [
          [
            [5, 5],
            [135, 5],
            [135, 95],
            [5, 95],
            [5, 5],
          ],
        ],
        zones: [
          // Grounds zones live in the "grounds" flight chapter — tapping one
          // switches chapters and seeks, proving cross-chapter plan links.
          { id: "residence", label: "Residence", kind: "structure", points: [[45, 25], [95, 25], [95, 60], [45, 60]], chapterId: "grounds", videoTime: 0 },
          { id: "lawn", label: "North Lawn", kind: "outdoor", points: [[10, 10], [40, 10], [40, 90], [10, 90]], chapterId: "grounds", videoTime: 10 },
          { id: "court", label: "Motor Court", kind: "hardscape", points: [[95, 10], [130, 10], [130, 40], [95, 40]], chapterId: "grounds", videoTime: 2 },
          { id: "patio", label: "Courtyard", kind: "hardscape", points: [[45, 60], [95, 60], [95, 75], [45, 75]], chapterId: "grounds", videoTime: 6 },
          { id: "pool", label: "Pool", kind: "water", points: [[100, 65], [125, 65], [125, 85], [100, 85]], chapterId: "grounds", videoTime: 8 },
        ],
        paths: {
          grounds: [
            { t: 0, x: 112, y: 25 },
            { t: 2, x: 98, y: 35 },
            { t: 4, x: 70, y: 42 },
            { t: 6, x: 70, y: 68 },
            { t: 8, x: 112, y: 75 },
            { t: 10, x: 40, y: 80 },
            { t: 12, x: 25, y: 40 },
          ],
        },
      },
    ],
  },
];

export const getPlan = (tourSlug: string): Plan | undefined =>
  PLANS.find((p) => p.tourSlug === tourSlug);
