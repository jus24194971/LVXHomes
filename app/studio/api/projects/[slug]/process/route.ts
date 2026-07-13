import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import {
  getProjectBySlug,
  listProjectFiles,
  createVslamJob,
  updateVslamJob,
  updateProject,
} from "@/lib/store";

export const dynamic = "force-dynamic";

/** Kick off cloud processing for a project: VSLAM on its 360 video → floor/plan.
 *  (Multi-file correlation + GPS map come once the pipeline emits them.) */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { env, email } = a;
  const { slug } = await ctx.params;

  const project = await getProjectBySlug(slug);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  if (!env.MODAL_SUBMIT_URL) {
    return NextResponse.json(
      { error: "Cloud processing isn't wired yet (MODAL_SUBMIT_URL unset)" },
      { status: 503 },
    );
  }
  let body: { ceiling_ft?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* optional body */
  }
  // Laser-measured ceiling height = the GPS-denied scale anchor (proven +0.12%).
  const ceilingFt =
    typeof body.ceiling_ft === "number" && body.ceiling_ft >= 5 && body.ceiling_ft <= 30
      ? body.ceiling_ft
      : 9;

  const files = await listProjectFiles(project.id);
  const cinematic = files.find((f) => f.role === "video"); // the immersive tour walkthrough
  const nadir = files.find((f) => f.role === "nadir");     // the dedicated down-facing floorplan pass
  const floorVideo = nadir ?? cinematic; // floorplan/VSLAM runs on the nadir pass when present; else the cinematic (1112 demo)
  const stills = files.filter((f) => f.role === "still");
  const telemetry = files.filter((f) => f.role === "telemetry");
  const srt = telemetry.find((f) => /\.srt$/i.test(f.filename ?? f.r2_key));
  const raw = files.filter((f) => f.role === "raw");
  if (!floorVideo && stills.length === 0) {
    const hint =
      raw.length > 0
        ? "Those .osv files are raw 360 — export the equirect MP4 in DJI Studio, then upload that."
        : "Add a 360 video (or dedicated nadir stills) before processing.";
    return NextResponse.json({ error: hint }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await createVslamJob({
    id,
    slug: project.slug,
    r2_key: floorVideo?.r2_key ?? stills[0]?.r2_key ?? "",
    status: "processing",
    created_by: email,
  });
  await updateProject(project.id, { status: "processing" });

  try {
    // Fan out by role: video → VSLAM + ortho, stills → stitch. ceiling_ft anchors
    // the GPS-denied scale (AZ standard 9 ft). raw/.osv is flagged above, not sent.
    const res = await fetch(env.MODAL_SUBMIT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: project.slug,
        video_key: floorVideo?.r2_key,        // floorplan source: nadir pass preferred
        cinematic_key: cinematic?.r2_key,     // the tour walkthrough (for path/context)
        is_nadir: !!nadir,                    // true once a dedicated nadir pass exists
        still_keys: stills.map((s) => s.r2_key),
        srt_key: srt?.r2_key,                 // GPS/baro/gimbal telemetry -> georeferencing weld
        telemetry_keys: telemetry.map((t) => t.r2_key),
        ceiling_ft: ceilingFt,
        token: env.VSLAM_CALLBACK_TOKEN ?? "",
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      await updateVslamJob(id, { status: "failed", error: `Modal ${res.status}: ${txt.slice(0, 200)}` });
      return NextResponse.json({ error: `Modal trigger failed (${res.status})`, jobId: id }, { status: 502 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "trigger error";
    await updateVslamJob(id, { status: "failed", error: msg });
    return NextResponse.json({ error: "Could not reach Modal", jobId: id }, { status: 502 });
  }

  return NextResponse.json({ jobId: id, status: "processing" });
}
