import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { createVslamJob, updateVslamJob } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Kick off a cloud VSLAM job: record it, then trigger the Modal endpoint.
 *  Modal runs async and POSTs /api/vslam/callback when the floor is ready. */
export async function POST(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { env, email } = a;

  let body: { slug?: string; r2_key?: string; scale?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* validated below */
  }
  const slug = (body.slug || "").trim();
  const r2_key = (body.r2_key || "").trim();
  if (!slug || !r2_key) {
    return NextResponse.json({ error: "need slug and r2_key" }, { status: 400 });
  }
  if (!env.MODAL_SUBMIT_URL) {
    return NextResponse.json(
      { error: "MODAL_SUBMIT_URL is not set (deploy the Modal app first)" },
      { status: 503 },
    );
  }

  const id = crypto.randomUUID();
  await createVslamJob({
    id,
    slug,
    r2_key,
    status: "processing",
    scale: body.scale ?? null,
    created_by: email,
  });

  try {
    const res = await fetch(env.MODAL_SUBMIT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        r2_key,
        scale: body.scale ?? 1,
        token: env.VSLAM_CALLBACK_TOKEN ?? "",
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      await updateVslamJob(id, {
        status: "failed",
        error: `Modal ${res.status}: ${txt.slice(0, 200)}`,
      });
      return NextResponse.json(
        { error: `Modal trigger failed (${res.status})`, jobId: id },
        { status: 502 },
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "trigger error";
    await updateVslamJob(id, { status: "failed", error: msg });
    return NextResponse.json({ error: "Could not reach Modal", jobId: id }, { status: 502 });
  }

  return NextResponse.json({ jobId: id, status: "processing" });
}
