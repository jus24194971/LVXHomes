/**
 * 360 flight tours. A tour is one equirectangular flythrough video plus the
 * still 360 panos a viewer can step into via hotspots placed along the flight.
 *
 * Authoring: open /tours/<slug>?author=1, fly to the moment, click where the
 * hotspot should hang, then copy the JSON from the panel into this file.
 */

export type TourHotspot = {
  id: string;
  label: string;
  /** Seconds into the flight when the hotspot appears / disappears. */
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

export type Tour = {
  slug: string;
  title: string;
  location?: string;
  video: { src: string; fallbackSrc?: string };
  panos: TourPano[];
  hotspots: TourHotspot[];
  /** Lab/test tours stay out of search engines and listings. */
  hidden?: boolean;
};

export const TOURS: Tour[] = [
  {
    slug: "test",
    title: "Engine Test Flight",
    video: {
      src: "https://media.lvxhomes.com/tours/lvx-360-test.mp4?v=1",
      fallbackSrc: "/tours/lvx-360-test.mp4",
    },
    panos: [
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
    // Always-visible windows for engine testing; real tours use timed windows.
    // (±60°, not ±90 — exactly perpendicular is a degenerate projection angle.)
    hotspots: [
      { id: "hs-kitchen", label: "Kitchen", start: 0, end: 999, yaw: -60, pitch: -6, panoId: "kitchen" },
      { id: "hs-suite", label: "Primary Suite", start: 0, end: 999, yaw: 60, pitch: -6, panoId: "suite" },
    ],
    hidden: true,
  },
];

export const getTour = (slug: string): Tour | undefined =>
  TOURS.find((t) => t.slug === slug);
