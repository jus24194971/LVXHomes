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
        // 16s demo: Great Room (0–5) → Kitchen (6–10) → Primary Suite (11–16),
        // with timed hotspot rings hanging on each room's drawn doorways.
        id: "flight",
        label: "The Flight",
        video: {
          src: "https://media.lvxhomes.com/tours/test/demo-flight.mp4?v=1",
          fallbackSrc: "/tours/demo-flight.mp4",
        },
        hotspots: [
          { id: "hs-kitchen", label: "Kitchen", start: 0.5, end: 4.8, yaw: 60, pitch: -4, panoId: "kitchen" },
          { id: "hs-suite", label: "Primary Suite", start: 0.5, end: 4.8, yaw: -60, pitch: -4, panoId: "suite" },
          { id: "hs-great-k", label: "Great Room", start: 6.2, end: 9.8, yaw: -70, pitch: -4, panoId: "great" },
          { id: "hs-great-s", label: "Great Room", start: 11.2, end: 15.5, yaw: 70, pitch: -4, panoId: "great" },
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
        id: "great",
        label: "The Great Room",
        src: "https://media.lvxhomes.com/tours/test/pano-great.jpg?v=1",
      },
      {
        id: "kitchen",
        label: "The Kitchen",
        src: "https://media.lvxhomes.com/tours/test/pano-kitchen.jpg?v=1",
      },
      {
        id: "suite",
        label: "The Primary Suite",
        src: "https://media.lvxhomes.com/tours/test/pano-suite.jpg?v=1",
      },
    ],
    hidden: true,
  },
];

export const getTour = (slug: string): Tour | undefined =>
  TOURS.find((t) => t.slug === slug);
