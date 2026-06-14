import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import type { AppEnv } from "@/lib/cf";
import {
  listAssets,
  createAsset,
  updateAsset,
  type Asset,
  type AssetKind,
} from "@/lib/store";
import { listStreamVideos, streamConfigured } from "@/lib/stream-admin";
import { withUrl } from "@/lib/asset-url";
import { r2PublicUrl } from "@/lib/r2-presign";

export const dynamic = "force-dynamic";

/** Pull the account's Stream videos into the asset catalog so films already on
 *  Stream show up, and keep their status/thumbnail fresh. Best-effort. */
async function syncStream(env: AppEnv, existing: Asset[]): Promise<void> {
  if (!streamConfigured(env)) return;
  let videos;
  try {
    videos = await listStreamVideos(env);
  } catch {
    return;
  }
  const byUid = new Map(
    existing.filter((a) => a.stream_uid).map((a) => [a.stream_uid as string, a]),
  );
  for (const v of videos) {
    const status: Asset["status"] = v.readyToStream ? "ready" : "processing";
    const found = byUid.get(v.uid);
    if (!found) {
      try {
        await createAsset({
          id: crypto.randomUUID(),
          kind: "film",
          title: v.meta?.name || `Film ${v.uid.slice(0, 6)}`,
          status,
          stream_uid: v.uid,
          thumb_url: v.thumbnail ?? null,
          bytes: v.size ?? null,
        });
      } catch {
        /* race / dup — ignore */
      }
    } else if (found.status !== status || (!found.thumb_url && v.thumbnail)) {
      try {
        await updateAsset(found.id, {
          status,
          thumb_url: v.thumbnail ?? found.thumb_url ?? null,
        });
      } catch {
        /* ignore */
      }
    }
  }
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i;

function kindForKey(key: string): "video360" | "pano" | null {
  if (VIDEO_EXT.test(key)) return "video360";
  if (IMAGE_EXT.test(key)) return "pano";
  return null;
}

/** Catalog existing R2 objects (360 clips + panos already in lvx-media) so the
 *  media that predates the Library shows up. Best-effort, idempotent by key. */
async function syncR2(env: AppEnv, existing: Asset[]): Promise<void> {
  if (!env.MEDIA) return;
  let listed: { objects: { key: string }[] };
  try {
    listed = await env.MEDIA.list({ limit: 1000 });
  } catch {
    return;
  }
  const have = new Set(
    existing.filter((a) => a.r2_key).map((a) => a.r2_key as string),
  );
  for (const obj of listed.objects ?? []) {
    if (have.has(obj.key)) continue;
    const kind = kindForKey(obj.key);
    if (!kind) continue;
    const name = obj.key.split("/").pop() || obj.key;
    try {
      await createAsset({
        id: crypto.randomUUID(),
        kind,
        title: name.replace(/\.[^.]+$/, ""),
        status: "ready",
        r2_key: obj.key,
        thumb_url: kind === "pano" ? r2PublicUrl(env, obj.key) : null,
      });
    } catch {
      /* race / dup — ignore */
    }
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { env } = auth;

  const url = new URL(req.url);
  const kind = (url.searchParams.get("kind") as AssetKind | null) ?? undefined;
  const includeArchived = url.searchParams.get("archived") === "1";
  const doSync = url.searchParams.get("sync") !== "0";

  if (doSync) {
    const all = await listAssets({ includeArchived: true });
    if (!kind || kind === "film") await syncStream(env, all);
    if (!kind || kind === "video360" || kind === "pano") await syncR2(env, all);
  }

  const assets = (await listAssets({ kind, includeArchived })).map((a) =>
    withUrl(env, a),
  );
  return NextResponse.json({ assets });
}
