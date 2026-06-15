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
  const files = await listProjectFiles(project.id);
  const video = files.find((f) => f.role === "video");
  if (!video) {
    return NextResponse.json({ error: "Add a 360 video before processing" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await createVslamJob({
    id,
    slug: project.slug,
    r2_key: video.r2_key,
    status: "processing",
    created_by: email,
  });
  await updateProject(project.id, { status: "processing" });

  try {
    const res = await fetch(env.MODAL_SUBMIT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: project.slug,
        r2_key: video.r2_key,
        scale: 1,
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
