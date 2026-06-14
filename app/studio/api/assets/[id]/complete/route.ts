import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { getAsset, updateAsset } from "@/lib/store";
import { getStreamVideo } from "@/lib/stream-admin";
import { r2PublicUrl } from "@/lib/r2-presign";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Called after the browser finishes uploading the bytes. For films we poll
 *  Stream for readiness + thumbnail; for R2 the object exists, so mark ready. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { env } = a;
  const { id } = await ctx.params;

  const asset = await getAsset(id);
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  let body: { bytes?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* optional */
  }

  if (asset.kind === "film" && asset.stream_uid) {
    const v = await getStreamVideo(env, asset.stream_uid);
    await updateAsset(id, {
      status: v?.readyToStream ? "ready" : "processing",
      thumb_url: v?.thumbnail ?? asset.thumb_url ?? null,
      bytes: v?.size ?? asset.bytes ?? null,
    });
  } else {
    await updateAsset(id, {
      status: "ready",
      bytes: body.bytes ?? asset.bytes ?? null,
      thumb_url:
        asset.kind === "pano" && asset.r2_key
          ? r2PublicUrl(env, asset.r2_key)
          : asset.thumb_url ?? null,
    });
  }

  return NextResponse.json({ asset: await getAsset(id) });
}
