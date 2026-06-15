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
  /** Anchored rings only: distance-driven fade (plan meters). Full opacity within
   *  `fadeNear`, gone beyond `fadeFar` — an automatic fade in/out window from the
   *  flight geometry, re-triggering on every pass. Set by auto-rings. */
  fadeNear?: number;
  fadeFar?: number;
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
  /** Initial view offset from the equirect front, in degrees — e.g. 180 when
   *  the camera's forward (drone heading) sits opposite the equirect center,
   *  so the flight opens facing the direction of travel. */
  startYaw?: number;
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
        startYaw: 180, // Avata 360 equirect front = drone tail; open facing forward
        // Keyframed fade rings authored in /tours/the-george?author=1. Several
        // amenities are flown past twice — the two keyframe clusters become two
        // fade windows (engine splits on RING_GAP).
        hotspots: [
          { id: "hs-cornhole", label: "Outdoor Cornhole", panoId: "courtyard", fade: 0.6, keys: [
            { t: 36.34, yaw: -143.6, pitch: -12.1 },
            { t: 44.35, yaw: -132.6, pitch: -16.3 },
            { t: 50.36, yaw: -125.2, pitch: -27.1 },
            { t: 53.62, yaw: -113, pitch: -38.1 },
            { t: 204.13, yaw: 100.2, pitch: -48.1 },
            { t: 207.56, yaw: 118, pitch: -61.9 },
          ] },
          { id: "hs-firepit", label: "Firepit Lounge", panoId: "firepit", fade: 0.6, keys: [
            { t: 55.41, yaw: -67.3, pitch: -14.2 },
            { t: 56.96, yaw: -62, pitch: -13.5 },
            { t: 57.74, yaw: -60.2, pitch: -14.8 },
            { t: 64.35, yaw: -51.1, pitch: -23.9 },
            { t: 68.87, yaw: -52.2, pitch: -36 },
            { t: 194.73, yaw: 50.4, pitch: -30.1 },
            { t: 197.94, yaw: 41.7, pitch: -44.3 },
            { t: 200.96, yaw: 14.9, pitch: -52 },
          ] },
          { id: "hs-pool", label: "Resort Style Pool", panoId: "pool", fade: 0.6, keys: [
            { t: 72.49, yaw: -77.7, pitch: -9.9 },
            { t: 80.38, yaw: -80.4, pitch: -18 },
            { t: 86.46, yaw: -101.7, pitch: -29.2 },
            { t: 94.51, yaw: -147.9, pitch: -34.5 },
            { t: 181.22, yaw: 73.8, pitch: -45.9 },
            { t: 183.69, yaw: 48.5, pitch: -48.8 },
            { t: 187.11, yaw: 8, pitch: -45.3 },
            { t: 190.33, yaw: -17.5, pitch: -35.6 },
          ] },
          { id: "hs-bocce", label: "Bocce Ball", panoId: "garden", fade: 0.6, keys: [
            { t: 100.41, yaw: -63.7, pitch: -12.4 },
            { t: 108.13, yaw: -72.2, pitch: -14.6 },
            { t: 119.74, yaw: -78.5, pitch: -45.3 },
            { t: 124.17, yaw: -50.7, pitch: -70.1 },
          ] },
          { id: "hs-soccer", label: "Soccer Pool", panoId: "clubhouse", fade: 0.6, keys: [
            { t: 151.44, yaw: 114.3, pitch: -15.1 },
            { t: 155.24, yaw: 99.5, pitch: -18.3 },
            { t: 159.78, yaw: 80.8, pitch: -21.5 },
            { t: 164.26, yaw: 57.1, pitch: -31.8 },
            { t: 167.92, yaw: 31.9, pitch: -48.2 },
            { t: 171.07, yaw: -16.4, pitch: -53 },
            { t: 174.65, yaw: -58, pitch: -38.3 },
          ] },
        ],
      },
    ],
    panos: [
      // ids stay stable (rings + plan zones reference them); only labels change.
      { id: "courtyard", label: "Outdoor Cornhole", src: "https://media.lvxhomes.com/tours/the-george/pano-courtyard.jpg?v=1", initialYaw: 0 },
      { id: "firepit", label: "Firepit Lounge", src: "https://media.lvxhomes.com/tours/the-george/pano-firepit.jpg?v=1", initialYaw: 0 },
      { id: "pool", label: "Resort Style Pool", src: "https://media.lvxhomes.com/tours/the-george/pano-pool.jpg?v=1", initialYaw: 0 },
      { id: "garden", label: "Bocce Ball", src: "https://media.lvxhomes.com/tours/the-george/pano-garden.jpg?v=1", initialYaw: 0 },
      { id: "clubhouse", label: "Soccer Pool", src: "https://media.lvxhomes.com/tours/the-george/pano-clubhouse.jpg?v=1", initialYaw: 0 },
    ],
    hidden: true,
  },
  {
    // Apartment 1112 — interior unit at The George (~2 min Avata 360 walkthrough).
    // Rings to be authored in /tours/apartment-1112?author=1; panos reachable
    // from the plan minimap meanwhile. Hidden.
    slug: "apartment-1112",
    title: "Apartment 1112",
    location: "The George",
    chapters: [
      {
        id: "flight",
        label: "The Walkthrough",
        video: { src: "https://media.lvxhomes.com/tours/apartment-1112/flight.mp4?v=1" },
        startYaw: 180,
        // Authored in /tours/apartment-1112?author=1.
        hotspots: [
          { id: "hs-living", label: "Living Room", panoId: "living", fade: 0.6, keys: [
            { t: 3.28, yaw: 126.4, pitch: -5.5 },
            { t: 4.67, yaw: 133.6, pitch: -6.1 },
            { t: 59.68, yaw: 165.6, pitch: -3.8 },
            { t: 117.79, yaw: 96.4, pitch: -9.5 },
            { t: 120.27, yaw: 131, pitch: -10.8 },
          ] },
          { id: "hs-kitchen", label: "Kitchen", panoId: "kitchen", fade: 0.6, keys: [
            { t: 14.21, yaw: -62.3, pitch: -3.4 },
            { t: 16.8, yaw: -58.5, pitch: -4.2 },
            { t: 19.57, yaw: -62.3, pitch: -4.9 },
            { t: 37.86, yaw: -96.9, pitch: 1.3 },
            { t: 59.68, yaw: -100.6, pitch: 1 },
            { t: 113.09, yaw: -14.6, pitch: -0.5 },
          ] },
          { id: "hs-bonus", label: "Bonus Room", panoId: "bonus", fade: 0.6, keys: [
            { t: 21.23, yaw: 72.4, pitch: -2.8 },
          ] },
          { id: "hs-guestbath", label: "Guest Bath", panoId: "guest-bath", fade: 0.6, keys: [
            { t: 21.23, yaw: 27.4, pitch: -3.4 },
            { t: 40.75, yaw: 20, pitch: 5.6 },
          ] },
          { id: "hs-bedroom", label: "Primary Bedroom", panoId: "bedroom", fade: 0.6, keys: [
            { t: 68.16, yaw: 178, pitch: -0.9 },
            { t: 70.03, yaw: 156.9, pitch: -2.4 },
            { t: 72.73, yaw: 146.2, pitch: -6.9 },
            { t: 77.35, yaw: -138.5, pitch: -14.6 },
            { t: 91.36, yaw: 117.9, pitch: -8.7 },
          ] },
          { id: "hs-primarybath", label: "Primary Bath", panoId: "primary-bath", fade: 0.6, keys: [
            { t: 79.4, yaw: -74.2, pitch: 1.8 },
            { t: 81.42, yaw: -65.1, pitch: -1.3 },
          ] },
        ],
      },
    ],
    panos: [
      { id: "kitchen", label: "Kitchen", src: "https://media.lvxhomes.com/tours/apartment-1112/pano-kitchen.jpg?v=1", initialYaw: 0 },
      { id: "living", label: "Living Room", src: "https://media.lvxhomes.com/tours/apartment-1112/pano-living.jpg?v=1", initialYaw: 0 },
      { id: "guest-bath", label: "Guest Bath", src: "https://media.lvxhomes.com/tours/apartment-1112/pano-guest-bath.jpg?v=1", initialYaw: 0 },
      { id: "bonus", label: "Bonus Room", src: "https://media.lvxhomes.com/tours/apartment-1112/pano-bonus.jpg?v=1", initialYaw: 0 },
      { id: "bedroom", label: "Primary Bedroom", src: "https://media.lvxhomes.com/tours/apartment-1112/pano-bedroom.jpg?v=1", initialYaw: 0 },
      { id: "primary-bath", label: "Primary Bath", src: "https://media.lvxhomes.com/tours/apartment-1112/pano-primary-bath.jpg?v=1", initialYaw: 0 },
    ],
    hidden: true,
  },
];

export const getTour = (slug: string): Tour | undefined =>
  TOURS.find((t) => t.slug === slug);
