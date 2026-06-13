/**
 * 360 flight tours. A tour is one or more CHAPTERS — flight segments like
 * "Main Floor", "Upstairs", "Grounds" — each an equirectangular flythrough
 * video with its own hotspots. Still 360 panos are shared across chapters.
 * Each chapter remembers where the viewer left it, so switching back resumes.
 *
 * Authoring: open /tours/<slug>?author=1, fly to the moment, click where the
 * hotspot should hang, then copy the JSON from the panel into this file.
 */

export type TourHotspot = {
  id: string;
  label: string;
  /** Seconds into the chapter when the hotspot appears / disappears. */
  start: number;
  end: number;
  /** Degrees from the center of the equirect frame (FRONT); positive = right. */
  yaw: number;
  /** Degrees above the horizon; positive = up. */
  pitch: number;
  panoId: string;
};

export type TourPano = {
  id: string;
  label: string;
  src: string;
  /** Optional starting view direction inside the pano (degrees from center). */
  initialYaw?: number;
};

export type TourChapter = {
  id: string;
  label: string;
  video: { src: string; fallbackSrc?: string };
  hotspots: TourHotspot[];
};

export type Tour = {
  slug: string;
  title: string;
  location?: string;
  chapters: TourChapter[];
  panos: TourPano[];
  /** Lab/test tours stay out of search engines and listings. */
  hidden?: boolean;
};

const TEST_VIDEO = {
  src: "https://media.lvxhomes.com/tours/lvx-360-test.mp4?v=1",
  fallbackSrc: "/tours/lvx-360-test.mp4",
};

export const TOURS: Tour[] = [
  {
    slug: "test",
    title: "Engine Test Flight",
    chapters: [
      {
        // 16s 3D-rendered flight: kitchen sweep → island pass → hallway →
        // primary suite → arc over the bed. Hotspot yaws computed from the
        // render spline against real scene anchors.
        id: "flight",
        label: "The Flight",
        video: {
          src: "https://media.lvxhomes.com/tours/test/demo-flight-3d.mp4?v=1",
          fallbackSrc: "/tours/demo-flight-3d.mp4",
        },
        hotspots: [
          { id: "hs-kitchen", label: "Kitchen", start: 1, end: 4, yaw: -45, pitch: -12, panoId: "kitchen" },
          { id: "hs-suite", label: "Primary Suite", start: 11, end: 14.5, yaw: 65, pitch: -10, panoId: "suite" },
        ],
      },
      {
        // Same clip reused as a second chapter — proves chapter switching,
        // per-chapter resume, and cross-chapter plan links before real footage.
        id: "grounds",
        label: "Grounds Pass",
        video: TEST_VIDEO,
        hotspots: [
          { id: "hs-pool-suite", label: "Primary Suite", start: 0, end: 999, yaw: 0, pitch: -10, panoId: "suite" },
        ],
      },
    ],
    panos: [
      {
        id: "kitchen",
        label: "The Kitchen",
        src: "https://media.lvxhomes.com/tours/test/pano-kitchen-3d.jpg?v=1",
        initialYaw: -125, // face the island from the capture point
      },
      {
        id: "suite",
        label: "The Primary Suite",
        src: "https://media.lvxhomes.com/tours/test/pano-suite-3d.jpg?v=1",
        initialYaw: 65, // face the bed
      },
    ],
    hidden: true,
  },
];

export const getTour = (slug: string): Tour | undefined =>
  TOURS.find((t) => t.slug === slug);
