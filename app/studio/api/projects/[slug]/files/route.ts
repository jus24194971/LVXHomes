import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { getProjectBySlug, setProjectFileRole, type ProjectFileRole } from "@/lib/store";

export const dynamic = "force-dynamic";

const ROLES = new Set<ProjectFileRole>([
  "video",
  "still",
  "hero",
  "telemetry",
  "proxy",
  "raw",
  "other",
]);

/** Re-tag a project file's role — e.g. mark a pano `hero` (→ tour zoom-point), or
 *  bump a still into the stitch set. Used by the project detail screen. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { slug } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  let body: { fileId?: string; role?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* validated below */
  }
  if (!body.fileId || !body.role || !ROLES.has(body.role as ProjectFileRole)) {
    return NextResponse.json({ error: "need fileId + a valid role" }, { status: 400 });
  }
  await setProjectFileRole(body.fileId, body.role as ProjectFileRole);
  return NextResponse.json({ ok: true });
}
