import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { presignR2Put, r2UploadConfigured } from "@/lib/r2-presign";
import { getProjectBySlug, addProjectFile, type ProjectFileRole } from "@/lib/store";

export const dynamic = "force-dynamic";

const VIDEO = /\.(mp4|mov|m4v|webm)$/i; // processable equirect / standard clip
const RAW360 = /\.(osv|insv)$/i; // proprietary raw — needs DJI/Insta360 stitch first
const PROXY = /\.(lrf|lrv)$/i; // low-res proxy — preview only, not processed
const STILL = /\.(jpe?g|png|webp|avif|dng|tiff?|insp)$/i;
const TELEM = /\.(srt|csv|gpx|json|txt)$/i;

function roleFor(name: string): ProjectFileRole {
  if (RAW360.test(name)) return "raw";
  if (PROXY.test(name)) return "proxy";
  if (VIDEO.test(name)) return "video";
  if (STILL.test(name)) return "still";
  if (TELEM.test(name)) return "telemetry";
  return "other";
}
const extOf = (n: string) => (/\.([a-z0-9]+)$/i.exec(n || "")?.[1] || "bin").toLowerCase();

/** Presign an R2 PUT for a project file + register it. Browser PUTs to putUrl. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { env, email } = a;
  if (!r2UploadConfigured(env)) {
    return NextResponse.json({ error: "R2 uploads aren't configured" }, { status: 503 });
  }
  const { slug } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  let body: { filename?: string; contentType?: string; role?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* validated below */
  }
  const filename = (body.filename || "file").trim();
  const role = ((body.role as ProjectFileRole) || roleFor(filename)) as ProjectFileRole;
  const id = crypto.randomUUID();
  const key = `projects/${slug}/${role}/${id}.${extOf(filename)}`;
  try {
    const putUrl = await presignR2Put(env, key);
    await addProjectFile({
      id,
      project_id: project.id,
      role,
      r2_key: key,
      filename,
      content_type: body.contentType ?? null,
      created_by: email,
    });
    return NextResponse.json({ fileId: id, putUrl, key, role });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "presign failed" },
      { status: 502 },
    );
  }
}
