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

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { env } = auth;

  const url = new URL(req.url);
  const kind = (url.searchParams.get("kind") as AssetKind | null) ?? undefined;
  const includeArchived = url.searchParams.get("archived") === "1";
  const doSync = url.searchParams.get("sync") !== "0";

  if (doSync && (!kind || kind === "film")) {
    const all = await listAssets({ includeArchived: true });
    await syncStream(env, all);
  }

  const assets = (await listAssets({ kind, includeArchived })).map((a) =>
    withUrl(env, a),
  );
  return NextResponse.json({ assets });
}
