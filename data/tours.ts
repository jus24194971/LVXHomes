/**
 * 360 flight tours. A tour is one or more CHAPTERS — flight segments like
 * "Main Floor", "Upstairs", "Grounds" — each an equirectangular flythrough
 * video with its own hotspots. Still 360 panos are shared across chapters.
 * Each chapter remembers where the viewer left it, so switching back resumes.
 *
 * Authoring: open /tours/<slug>?author=1, fly to the moment, click where the
 * hotspot should hang, then copy the JSON from the panel into this file.
 */

/** A keyframe for a tracked flight ring: at `t` seconds the amenity sits at
 *  `yaw` degrees from frame FRONT and `pitch` degrees above the horizon. */
export type RingKey = { t: number; yaw: number; pitch: number };

export type TourHotspot = {
  id: string;
  label: string;
  /**
   * Keyframed flight ring (preferred for real flights). The ring TRACKS its
   * amenity by interpolating these keys, and only appears during their time
   * span — fading in as you approach and out as you pass. Map-independent.
   */
  keys?: RingKey[];
  /** Fade in/out duration in seconds for keyframed rings (default 0.6). */
  fade?: number;
  /**
   * World anchor (plan units = meters; plan y = world z; h = height in m).
   * When set, the ring is computed live from the camera's plan-path pose —
   * visible from anywhere you look, at any time, scaled down with distance.
   */
  anchor?: { x: number; y: number; h?: number };
  /** Optional time gating (defaults: always). Required for legacy mode. */
  start?: number;
  end?: number;
  /** Legacy timed mode: fixed degrees from frame center (FRONT). */
  yaw?: number;
  /** Legacy timed mode: degrees above the horizon. */
  pitch?: number;
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
        // 22s 3D-rendered flight: grand foyer → kitchen island → hallway →
        // master bath → primary suite. Rings are world-anchored to the rooms
        // themselves — always visible, scaling down with distance.
        id: "flight",
        label: "The Flight",
        video: {
          src: "https://media.lvxhomes.com/tours/test/house-flight.mp4?v=1",
          fallbackSrc: "/tours/house-flight.mp4",
        },
        hotspots: [
          { id: "hs-foyer", label: "Grand Foyer", anchor: { x: 4.25, y: 8, h: 1.5 }, panoId: "foyer" },
          { id: "hs-kitchen", label: "Kitchen", anchor: { x: 3.5, y: 3, h: 1.0 }, panoId: "kitchen" },
          { id: "hs-bath", label: "Master Bath", anchor: { x: 11.1, y: 1.85, h: 0.9 }, panoId: "bath" },
          { id: "hs-suite", label: "Primary Suite", anchor: { x: 13, y: 5.6, h: 0.9 }, panoId: "suite" },
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
        id: "foyer",
        label: "The Grand Foyer",
        src: "https://media.lvxhomes.com/tours/test/pano-foyer.jpg?v=1",
        initialYaw: 170, // look back at the chandelier + entry
      },
      {
        id: "kitchen",
        label: "The Kitchen",
        src: "https://media.lvxhomes.com/tours/test/pano-kitchen-3d.jpg?v=1",
        initialYaw: 66, // face the island
      },
      {
        id: "bath",
        label: "The Master Bath",
        src: "https://media.lvxhomes.com/tours/test/pano-bath.jpg?v=1",
        initialYaw: 175, // look back at the tub + vanity
      },
      {
        id: "suite",
        label: "The Primary Suite",
        src: "https://media.lvxhomes.com/tours/test/pano-suite-3d.jpg?v=1",
        initialYaw: -138, // face the bed
      },
    ],
    hidden: true,
  },
  {
    // First real DJI Avata 360 capture — a ~4 min flythrough of The George, an
    // Arizona luxury apartment community. For v1 the 5 amenity panos are reached
    // from the plan minimap (tap an amenity); in-flight rings can be authored
    // later. Hidden until the property/path is finalized.
    slug: "the-george",
    title: "The George",
    location: "Arizona",
    chapters: [
      {
        id: "flight",
        label: "The Flight",
        video: { src: "https://media.lvxhomes.com/tours/the-george/flight.mp4?v=1" },
        hotspots: [],
      },
    ],
    panos: [
      { id: "courtyard", label: "Resident Courtyard", src: "https://media.lvxhomes.com/tours/the-george/pano-courtyard.jpg?v=1", initialYaw: 0 },
      { id: "firepit", label: "Firepit Lounge", src: "https://media.lvxhomes.com/tours/the-george/pano-firepit.jpg?v=1", initialYaw: 0 },
      { id: "pool", label: "Resort Pool", src: "https://media.lvxhomes.com/tours/the-george/pano-pool.jpg?v=1", initialYaw: 0 },
      { id: "garden", label: "Garden Walk", src: "https://media.lvxhomes.com/tours/the-george/pano-garden.jpg?v=1", initialYaw: 0 },
      { id: "clubhouse", label: "Clubhouse Lawn", src: "https://media.lvxhomes.com/tours/the-george/pano-clubhouse.jpg?v=1", initialYaw: 0 },
    ],
    hidden: true,
  },
];

export const getTour = (slug: string): Tour | undefined =>
  TOURS.find((t) => t.slug === slug);
