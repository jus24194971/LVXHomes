import type { AppEnv } from "@/lib/cf";
import type { Asset } from "@/lib/store";
import { r2PublicUrl } from "@/lib/r2-presign";
import { streamHls } from "@/lib/stream";

/** Public/playable URL for an asset: Stream HLS for films, R2 public URL for
 *  360 clips and panos. Tours wire a 360 clip's URL into a chapter's video.src
 *  and a pano's URL into panos[].src. */
export function assetUrl(env: AppEnv, a: Asset): string | undefined {
  if (a.kind === "film") return a.stream_uid ? streamHls(a.stream_uid) : undefined;
  return a.r2_key ? r2PublicUrl(env, a.r2_key) : undefined;
}

export function withUrl(env: AppEnv, a: Asset): Asset & { url?: string } {
  return { ...a, url: assetUrl(env, a) };
}
