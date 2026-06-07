/**
 * Cloudflare Stream helpers. The customer code is PUBLIC (it appears in every
 * video embed URL), so it's baked in as the default — no env var required to
 * deploy. An env override is still honored if you ever rotate accounts.
 */
export const CF_STREAM_CUSTOMER_CODE =
  process.env.NEXT_PUBLIC_CF_STREAM_CUSTOMER_CODE ||
  "a61cc14bdbaa22ac7c9a5f73b3670446";

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

/** Poster/thumbnail URL for a Stream video. */
export function streamPoster(
  uid: string,
  opts?: { time?: string; height?: number },
): string {
  const params = new URLSearchParams();
  if (opts?.time) params.set("time", opts.time);
  if (opts?.height) params.set("height", String(opts.height));
  const qs = params.toString();
  return `https://customer-${CF_STREAM_CUSTOMER_CODE}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg${
    qs ? `?${qs}` : ""
  }`;
}
