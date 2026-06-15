import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { getProjectBySlug, listProjectFiles } from "@/lib/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { slug } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const files = await listProjectFiles(project.id);
  return NextResponse.json({ project, files });
}
