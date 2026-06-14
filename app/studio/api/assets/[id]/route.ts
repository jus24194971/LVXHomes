import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { getAsset, updateAsset, deleteAssetRow } from "@/lib/store";
import { deleteStreamVideo } from "@/lib/stream-admin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { id } = await ctx.params;

  let body: { title?: string; archived?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const patch: { title?: string; archived?: number } = {};
  if (typeof body.title === "string") patch.title = body.title.trim();
  if (typeof body.archived === "boolean") patch.archived = body.archived ? 1 : 0;
  await updateAsset(id, patch);
  return NextResponse.json({ asset: await getAsset(id) });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { env } = a;
  const { id } = await ctx.params;

  const asset = await getAsset(id);
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  // Best-effort cleanup of the underlying media before dropping the row.
  try {
    if (asset.kind === "film" && asset.stream_uid) {
      await deleteStreamVideo(env, asset.stream_uid);
    }
    if (asset.r2_key && env.MEDIA) {
      await env.MEDIA.delete(asset.r2_key);
    }
  } catch {
    /* leave orphan media rather than block the delete */
  }
  await deleteAssetRow(id);
  return NextResponse.json({ ok: true });
}
