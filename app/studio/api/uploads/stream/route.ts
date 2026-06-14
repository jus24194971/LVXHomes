import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { createDirectUpload, streamConfigured } from "@/lib/stream-admin";
import { createAsset } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Mint a Stream direct-creator upload + register the asset (status: processing).
 *  The browser then POSTs the file straight to uploadURL. */
export async function POST(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { env, email } = a;

  if (!streamConfigured(env)) {
    return NextResponse.json(
      { error: "Stream isn't configured (set CF_ACCOUNT_ID + CF_API_TOKEN)" },
      { status: 503 },
    );
  }

  let body: { title?: string; maxDurationSeconds?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* defaults */
  }
  const title = (body.title || "Untitled film").trim();

  try {
    const { uploadURL, uid } = await createDirectUpload(env, {
      name: title,
      maxDurationSeconds: body.maxDurationSeconds,
    });
    const id = crypto.randomUUID();
    await createAsset({
      id,
      kind: "film",
      title,
      status: "processing",
      stream_uid: uid,
      created_by: email,
    });
    return NextResponse.json({ assetId: id, uid, uploadURL });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Stream upload init failed" },
      { status: 502 },
    );
  }
}
