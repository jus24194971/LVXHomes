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
        // Matches the 3D-rendered demo house exactly (plan units = meters;
        // plan y = world z). Path keys are sampled from the render spline.
        id: "main",
        label: "Main Floor",
        kind: "floor",
        width: 16,
        height: 7,
        strokes: [
          [
            [0, 0], [16, 0], [16, 7], [9.5, 7], [9.5, 4], [7, 4], [7, 6], [0, 6], [0, 0],
          ],
        ],
        zones: [
          { id: "kitchen", label: "Kitchen", kind: "room", points: [[0, 0], [7, 0], [7, 6], [0, 6]], videoTime: 2 },
          { id: "hall", label: "Hall", kind: "room", points: [[7, 2], [9.5, 2], [9.5, 4], [7, 4]], videoTime: 7.5 },
          { id: "suite", label: "Primary Suite", kind: "room", points: [[9.5, 0], [16, 0], [16, 7], [9.5, 7]], videoTime: 12 },
          // furniture footprints — visual detail only
          { id: "island", label: "", kind: "structure", points: [[2.3, 2.45], [4.7, 2.45], [4.7, 3.55], [2.3, 3.55]] },
          { id: "bed", label: "", kind: "structure", points: [[11.9, 4.6], [14.1, 4.6], [14.1, 6.6], [11.9, 6.6]] },
        ],
        paths: {
          flight: [
            { t: 0, x: 1, y: 1 },
            { t: 1, x: 1.8, y: 2 },
            { t: 2, x: 2.4, y: 3.1 },
            { t: 3, x: 2.9, y: 4.3 },
            { t: 4, x: 4, y: 4.4 },
            { t: 5, x: 5.1, y: 3.7 },
            { t: 6, x: 6.2, y: 3.1 },
            { t: 7, x: 7.4, y: 3 },
            { t: 8, x: 8.7, y: 3 },
            { t: 9, x: 10, y: 3.1 },
            { t: 10, x: 11.1, y: 2.6 },
            { t: 11, x: 12.4, y: 2.4 },
            { t: 12, x: 13.5, y: 2.8 },
            { t: 13, x: 14.4, y: 3.8 },
            { t: 14, x: 13.8, y: 4.8 },
            { t: 15, x: 12.7, y: 4.6 },
            { t: 16, x: 11.9, y: 3.6 },
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
