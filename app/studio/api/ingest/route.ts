import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";

export const dynamic = "force-dynamic";

/** Proxy a room photo to the Modal scene-ingest endpoint (Lab tab). The image
 *  forwards as raw bytes so EXIF (focal length) survives; auth reuses the
 *  VSLAM shared token — the Modal side checks x-lvx-token against
 *  LVX_CALLBACK_TOKEN in its `lvx-callback` secret. */
export async function POST(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { env } = a;

  if (!env.MODAL_INGEST_URL || !env.VSLAM_CALLBACK_TOKEN) {
    return NextResponse.json(
      { error: "ingest isn't configured (MODAL_INGEST_URL + VSLAM_CALLBACK_TOKEN)" },
      { status: 503 },
    );
  }

  const body = await req.arrayBuffer();
  if (body.byteLength < 1000) {
    return NextResponse.json({ error: "no image body" }, { status: 400 });
  }

  try {
    const r = await fetch(env.MODAL_INGEST_URL, {
      method: "POST",
      headers: {
        "x-lvx-token": env.VSLAM_CALLBACK_TOKEN.trim(),
        "content-type": req.headers.get("content-type") ?? "application/octet-stream",
      },
      body,
    });
    const data = (await r.json()) as Record<string, unknown>;
    return NextResponse.json(data, { status: r.status });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "ingest proxy failed" },
      { status: 502 },
    );
  }
}
