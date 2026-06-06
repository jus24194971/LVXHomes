/**
 * Cloudflare Stream helpers. The customer code is the <CODE> in
 * customer-<CODE>.cloudflarestream.com. Until it's set (and real UIDs are
 * uploaded), the Stream components fall back to a tasteful placeholder, so the
 * site looks finished before any video exists.
 */
export const CF_STREAM_CUSTOMER_CODE =
  process.env.NEXT_PUBLIC_CF_STREAM_CUSTOMER_CODE ?? "";

export const streamConfigured = (): boolean => Boolean(CF_STREAM_CUSTOMER_CODE);

// TODO: replace with real Stream UIDs once videos are uploaded. Single source.
export const PLACEHOLDER_STREAM_UID = "TODO_STREAM_UID";
// TODO: the 45–75s showreel for the homepage hero.
export const HERO_STREAM_UID = PLACEHOLDER_STREAM_UID;

/** Poster/thumbnail URL for a Stream video. */
export function streamPoster(
  uid: string,
  opts?: { time?: string; height?: number },
): string {
  const code = CF_STREAM_CUSTOMER_CODE || "PLACEHOLDER";
  const params = new URLSearchParams();
  if (opts?.time) params.set("time", opts.time);
  if (opts?.height) params.set("height", String(opts.height));
  const qs = params.toString();
  return `https://customer-${code}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg${
    qs ? `?${qs}` : ""
  }`;
}
