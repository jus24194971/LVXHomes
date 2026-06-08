/**
 * Cloudflare Stream helpers. The customer code is PUBLIC (it appears in every
 * video embed URL), so it's baked in as the default — no env var required to
 * deploy. An env override is still honored if you ever rotate accounts.
 */
export const CF_STREAM_CUSTOMER_CODE =
  process.env.NEXT_PUBLIC_CF_STREAM_CUSTOMER_CODE ||
  "n5hwfs53ea1n75e6";

/** Sentinel for "no real video uploaded yet". */
export const PLACEHOLDER_STREAM_UID = "TODO_STREAM_UID";

/**
 * Homepage hero reel. Still a placeholder — until a real 45–75s showreel UID is
 * set here, the hero shows the gold LVX title card instead of a video.
 */
export const HERO_STREAM_UID = PLACEHOLDER_STREAM_UID;

/** Whether the Stream account is configured (always true now it's baked in). */
export const streamConfigured = (): boolean => Boolean(CF_STREAM_CUSTOMER_CODE);

/** A video is ready to play when the account is set AND the UID is real. */
export const streamReady = (uid: string): boolean =>
  streamConfigured() && Boolean(uid) && uid !== PLACEHOLDER_STREAM_UID;

/**
 * Per-video poster timestamp overrides. Some clips open on a black/near-black
 * frame, so the default thumbnail (t=0) is useless — pin a better moment.
 */
const POSTER_TIME: Record<string, string> = {
  // San Tan Valley opens on a black frame; 4s lands on the hero aerial.
  d0cde33269c8528f1a71ad128aa54310: "4s",
};

/** Poster/thumbnail URL for a Stream video. */
export function streamPoster(
  uid: string,
  opts?: { time?: string; height?: number },
): string {
  const time = opts?.time ?? POSTER_TIME[uid];
  const params = new URLSearchParams();
  if (time) params.set("time", time);
  if (opts?.height) params.set("height", String(opts.height));
  const qs = params.toString();
  return `https://customer-${CF_STREAM_CUSTOMER_CODE}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg${
    qs ? `?${qs}` : ""
  }`;
}
