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
export type PlanPathKey = { t: number; x: number; y: number; h?: number; z?: number };

/**
 * A toggleable base/underlay image. A sheet can stack several — a drone aerial
 * overview, the interior ortho ("Floor"), a satellite of the whole lot — rendered
 * bottom→top with per-layer opacity + visibility. Placement defaults to the full
 * sheet; a wider layer (satellite of the lot) sets x/y/width/height in plan units to
 * extend beyond the sheet, georeferenced so the building still lines up when zoomed out.
 */
export type PlanLayer = {
  id: string;
  label: string;
  /** data-URL or R2 URL of the image. */
  url: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** 0..1, default 1. */
  opacity?: number;
  /** default true. */
  visible?: boolean;
  /** degrees, clockwise about the layer centre; default 0. */
  rotation?: number;
  /** mirror about the layer centre. */
  flipH?: boolean;
  flipV?: boolean;
};

/** SVG transform for a base layer image — rotate + flip about its centre. */
export function layerTransform(L: PlanLayer, sheetW: number, sheetH: number): string | undefined {
  const w = L.width ?? sheetW;
  const h = L.height ?? sheetH;
  const cx = (L.x ?? 0) + w / 2;
  const cy = (L.y ?? 0) + h / 2;
  const sx = L.flipH ? -1 : 1;
  const sy = L.flipV ? -1 : 1;
  const parts: string[] = [];
  if (L.rotation) parts.push(`rotate(${L.rotation} ${cx} ${cy})`);
  if (sx < 0 || sy < 0) parts.push(`translate(${sx < 0 ? 2 * cx : 0} ${sy < 0 ? 2 * cy : 0}) scale(${sx} ${sy})`);
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * A single wall segment you can CLICK to record its lased length — the
 * "measure onto the plan" workflow. `measured` is free text (`18'4"`) so ft-in
 * reads naturally in the field; the drawn length (endpoints × sheet scale, i.e.
 * plan-unit ≈ feet) renders beside it so the field number and the plan agree.
 */
export type PlanWall = {
  id: string;
  a: [number, number];
  b: [number, number];
  measured?: string;
};

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
  /** Clickable, measurable wall segments — click one, type its lased length. */
  walls?: PlanWall[];
  /** Flight-path keyframes per chapter id — drives the traveling dot. */
  paths?: Record<string, PlanPathKey[]>;
  /** WGS84 bbox when georeferenced from GPS — enables the Studio's one-click
   *  satellite trace (the sheet's metre extents map 1:1 onto this box). */
  geo?: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  /** Saved satellite base image (data-URL) for a georeferenced site sheet —
   *  the Studio stitches it from the bbox, and both the Studio and the player
   *  minimap render the flight path + amenity dots over it. */
  satUrl?: string;
  /** Stacked, toggleable base layers (aerial overview, interior ortho, satellite of
   *  the lot). Rendered bottom→top; each may extend beyond the sheet. Falls back to
   *  `satUrl` when absent. */
  layers?: PlanLayer[];
  /** Degrees to rotate the base image + drawn content for display — straightens
   *  a diagonally-captured floorplan. Drawing accounts for it; the viewer applies
   *  the same rotation so zones stay locked to the image. */
  rotation?: number;
  /** Mirror the base image + content across the vertical axis — corrects a
   *  handedness-flipped orthomosaic. Composes with rotation; drawing accounts for it. */
  flipX?: boolean;
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
        height: 10,
        strokes: [
          // exterior shell incl. the grand foyer wing
          [
            [0, 0], [16, 0], [16, 7], [9.5, 7], [9.5, 4], [7, 4], [7, 10], [1.5, 10], [1.5, 6], [0, 6], [0, 0],
          ],
          // interior walls
          [[7, 0], [7, 2]],
          [[7, 2], [9.5, 2]],
          [[7, 4], [9.5, 4]],
          [[9.5, 0], [9.5, 2]],
          [[9.5, 4], [9.5, 7]],
          [[0, 6], [3, 6]],
          [[4.6, 6], [7, 6]],
          [[9.5, 2.5], [10.2, 2.5]],
          [[11.2, 2.5], [12, 2.5]],
          [[12, 0], [12, 2.5]],
        ],
        zones: [
          // Rooms carry a panoId → a floorplan tap warps into the static 360
          // (pausing the flight). videoTime stays as a fallback + dot anchor.
          { id: "foyer", label: "Grand Foyer", kind: "room", points: [[1.5, 6], [7, 6], [7, 10], [1.5, 10]], panoId: "foyer", videoTime: 1 },
          { id: "kitchen", label: "Kitchen", kind: "room", points: [[0, 0], [7, 0], [7, 6], [0, 6]], panoId: "kitchen", videoTime: 5 },
          { id: "hall", label: "Hall", kind: "room", points: [[7, 2], [9.5, 2], [9.5, 4], [7, 4]], videoTime: 11 },
          { id: "bath", label: "Master Bath", kind: "room", points: [[9.5, 0], [12, 0], [12, 2.5], [9.5, 2.5]], panoId: "bath", videoTime: 15.5 },
          { id: "suite", label: "Primary Suite", kind: "room", points: [[9.5, 2.5], [12, 2.5], [12, 0], [16, 0], [16, 7], [9.5, 7]], panoId: "suite", videoTime: 19 },
          // furniture footprints — visual detail only
          { id: "island", label: "", kind: "structure", points: [[2.3, 2.45], [4.7, 2.45], [4.7, 3.55], [2.3, 3.55]] },
          { id: "bed", label: "", kind: "structure", points: [[11.9, 4.6], [14.1, 4.6], [14.1, 6.6], [11.9, 6.6]] },
          { id: "tub", label: "", kind: "water", points: [[10.3, 1.46], [11.9, 1.46], [11.9, 2.24], [10.3, 2.24]] },
          { id: "vanity", label: "", kind: "structure", points: [[9.6, 0.08], [11.6, 0.08], [11.6, 0.64], [9.6, 0.64]] },
        ],
        // Sampled from the render spline — the dot IS the camera.
        paths: {
          flight: [
            { t: 0, x: 4.2, y: 9.2 },
            { t: 1, x: 4.1, y: 8 },
            { t: 2, x: 3.9, y: 6.8 },
            { t: 3, x: 3.4, y: 5.7 },
            { t: 4, x: 2.8, y: 4.7 },
            { t: 5, x: 2.4, y: 3.6 },
            { t: 6, x: 2.7, y: 2.5 },
            { t: 7, x: 3.7, y: 1.9 },
            { t: 8, x: 4.8, y: 2.3 },
            { t: 9, x: 5.9, y: 2.8 },
            { t: 10, x: 7, y: 3 },
            { t: 11, x: 8.2, y: 3 },
            { t: 12, x: 9.4, y: 3.1 },
            { t: 13, x: 10.5, y: 2.8 },
            { t: 14, x: 10.5, y: 1.7 },
            { t: 15, x: 11.1, y: 1.3 },
            { t: 16, x: 11, y: 2.2 },
            { t: 17, x: 12, y: 2.8 },
            { t: 18, x: 13.1, y: 3.3 },
            { t: 19, x: 14.1, y: 4 },
            { t: 20, x: 13.9, y: 5 },
            { t: 21, x: 12.7, y: 4.9 },
            { t: 22, x: 12, y: 4 },
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
  {
    // The George — SCHEMATIC first-pass site plan (no GPS lock, so this is
    // drawn by eye from the aerial frames, NOT survey-accurate). Refine the
    // amenity positions + the dot path in /studio/plan. Tap an amenity to step
    // into its 360 still; the dot traces the ~4 min flight (chapter "flight").
    tourSlug: "the-george",
    sheets: [
      {
        id: "site",
        label: "The Grounds",
        kind: "site",
        width: 100,
        height: 70,
        strokes: [[[3, 3], [97, 3], [97, 67], [3, 67], [3, 3]]],
        zones: [
          { id: "courtyard", label: "Outdoor Cornhole", kind: "outdoor", points: [[10, 22], [45, 22], [45, 48], [10, 48]], panoId: "courtyard", videoTime: 12 },
          { id: "firepit", label: "Firepit Lounge", kind: "hardscape", points: [[12, 24], [22, 24], [22, 33], [12, 33]], panoId: "firepit", videoTime: 25 },
          { id: "garden", label: "Bocce Ball", kind: "outdoor", points: [[46, 22], [60, 22], [60, 48], [46, 48]], panoId: "garden", videoTime: 45 },
          { id: "clubhouse", label: "Soccer Pool", kind: "structure", points: [[62, 30], [75, 30], [75, 43], [62, 43]], panoId: "clubhouse", videoTime: 95 },
          { id: "pool", label: "Resort Style Pool", kind: "water", points: [[78, 24], [95, 24], [95, 50], [78, 50]], panoId: "pool", videoTime: 180 },
          // building footprints — context only
          { id: "bldg-nw", label: "", kind: "structure", points: [[8, 8], [45, 8], [45, 18], [8, 18]] },
          { id: "bldg-ne", label: "", kind: "structure", points: [[55, 8], [92, 8], [92, 18], [55, 18]] },
          { id: "bldg-sw", label: "", kind: "structure", points: [[8, 54], [45, 54], [45, 64], [8, 64]] },
          { id: "bldg-se", label: "", kind: "structure", points: [[55, 54], [78, 54], [78, 64], [55, 64]] },
        ],
        paths: {
          flight: [
            { t: 0, x: 15, y: 35 },
            { t: 20, x: 28, y: 32 },
            { t: 40, x: 42, y: 30 },
            { t: 60, x: 55, y: 32 },
            { t: 80, x: 66, y: 34 },
            { t: 100, x: 72, y: 37 },
            { t: 120, x: 82, y: 31 },
            { t: 140, x: 60, y: 56 },
            { t: 160, x: 75, y: 45 },
            { t: 180, x: 87, y: 38 },
            { t: 200, x: 58, y: 40 },
            { t: 220, x: 34, y: 38 },
            { t: 238, x: 20, y: 36 },
          ],
        },
      },
    ],
  },
  {
    // Apartment 1112 — SCHEMATIC interior floor (drawn by eye from the panos;
    // refine room shapes + the dot path in /studio/plan). Tap a room to step in.
    tourSlug: "apartment-1112",
    sheets: [
      {
        id: "floor",
        label: "Apartment 1112",
        kind: "floor",
        width: 16,
        height: 12,
        strokes: [[[0, 0], [16, 0], [16, 12], [0, 12], [0, 0]]],
        zones: [
          { id: "living", label: "Living Room", kind: "room", points: [[0.5, 0.5], [7.5, 0.5], [7.5, 5.5], [0.5, 5.5]], panoId: "living", videoTime: 5 },
          { id: "kitchen", label: "Kitchen", kind: "room", points: [[8, 0.5], [15.5, 0.5], [15.5, 5.5], [8, 5.5]], panoId: "kitchen", videoTime: 20 },
          { id: "bonus", label: "Bonus Room", kind: "room", points: [[0.5, 6], [6, 6], [6, 11.5], [0.5, 11.5]], panoId: "bonus", videoTime: 45 },
          { id: "guest-bath", label: "Guest Bath", kind: "room", points: [[6.5, 6], [9.5, 6], [9.5, 8.5], [6.5, 8.5]], panoId: "guest-bath", videoTime: 35 },
          { id: "primary-bath", label: "Primary Bath", kind: "room", points: [[10, 6], [15.5, 6], [15.5, 8.5], [10, 8.5]], panoId: "primary-bath", videoTime: 100 },
          { id: "bedroom", label: "Primary Bedroom", kind: "room", points: [[6.5, 9], [15.5, 9], [15.5, 11.5], [6.5, 11.5]], panoId: "bedroom", videoTime: 80 },
        ],
        paths: {
          flight: [
            { t: 0, x: 4, y: 3 },
            { t: 15, x: 11, y: 3 },
            { t: 30, x: 8, y: 6 },
            { t: 45, x: 3, y: 9 },
            { t: 60, x: 8, y: 8 },
            { t: 80, x: 12, y: 10 },
            { t: 100, x: 13, y: 7 },
            { t: 120, x: 9, y: 7 },
            { t: 128, x: 6, y: 5 },
          ],
        },
      },
    ],
  },
];

export const getPlan = (tourSlug: string): Plan | undefined =>
  PLANS.find((p) => p.tourSlug === tourSlug);
