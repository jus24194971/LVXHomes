/**
 * Flat-video room pins. Unlike the 360 tour's world-anchored rings, these are
 * 2D markers placed directly on ordinary listing footage: a label ("Kitchen")
 * that TRACKS its room as the drone moves, driven by hand-placed keyframes.
 *
 * No 360 pano needed — a pin is a marker, not a step-inside. It's the same
 * "anchors on a timeline" idea, applied to rectilinear video: a fast way to
 * map where rooms live in a real flight.
 *
 * Authoring: open /studio/pins, pick a film, add a pin, then scrub + click the
 * room a few times to drop keyframes. Copy the JSON here.
 */

/** A keyframe: at `t` seconds the room sits at (x, y) as a fraction (0..1) of
 *  the displayed frame — resolution-independent, so it scales to any player. */
export type PinKey = { t: number; x: number; y: number };

export type VideoPin = {
  id: string;
  label: string;
  /** Sorted keyframes. The pin tracks by interpolating between them. */
  keys: PinKey[];
  /** Optional visibility window (defaults to first..last keyframe time). */
  start?: number;
  end?: number;
};

export type VideoPinSet = {
  /** Cloudflare Stream UID this pin set belongs to. */
  uid: string;
  pins: VideoPin[];
};

/** Seconds of lead-in/out a single-keyframe pin stays on screen. */
const SOLO_WINDOW = 2.5;

/** The [start, end] seconds a pin is shown. */
export function pinWindow(pin: VideoPin): [number, number] {
  if (pin.keys.length === 0) return [0, 0];
  const first = pin.keys[0].t;
  const last = pin.keys[pin.keys.length - 1].t;
  const s = pin.start ?? (pin.keys.length === 1 ? first - SOLO_WINDOW : first);
  const e = pin.end ?? (pin.keys.length === 1 ? last + SOLO_WINDOW : last);
  return [s, e];
}

export function pinVisibleAt(pin: VideoPin, t: number): boolean {
  const [s, e] = pinWindow(pin);
  return t >= s && t <= e && pin.keys.length > 0;
}

/**
 * The pin's (x, y) fraction at time t — linearly interpolated between the
 * surrounding keyframes, clamped to the ends. Linear (not spline) keeps
 * authoring predictable: the pin goes straight between the points you set.
 */
export function pinPosAt(pin: VideoPin, t: number): { x: number; y: number } | null {
  const k = pin.keys;
  if (k.length === 0) return null;
  if (k.length === 1 || t <= k[0].t) return { x: k[0].x, y: k[0].y };
  if (t >= k[k.length - 1].t) return { x: k[k.length - 1].x, y: k[k.length - 1].y };
  for (let i = 0; i < k.length - 1; i++) {
    if (t >= k[i].t && t <= k[i + 1].t) {
      const span = k[i + 1].t - k[i].t;
      const f = span <= 0 ? 0 : (t - k[i].t) / span;
      return {
        x: k[i].x + (k[i + 1].x - k[i].x) * f,
        y: k[i].y + (k[i + 1].y - k[i].y) * f,
      };
    }
  }
  return { x: k[0].x, y: k[0].y };
}

/** Authored pin sets, keyed by Stream UID. Empty until you map a film. */
export const VIDEO_PINS: VideoPinSet[] = [];

export const getVideoPins = (uid: string): VideoPin[] =>
  VIDEO_PINS.find((s) => s.uid === uid)?.pins ?? [];
