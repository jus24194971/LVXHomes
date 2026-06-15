import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { createProject, listProjects, getProjectBySlug } from "@/lib/store";

export const dynamic = "force-dynamic";

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export async function GET(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  return NextResponse.json({ projects: await listProjects() });
}

export async function POST(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  let body: { title?: string; slug?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* validated below */
  }
  const title = (body.title || "").trim();
  if (!title) return NextResponse.json({ error: "need a title" }, { status: 400 });
  const slug = slugify(body.slug || title);
  if (!slug) return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  if (await getProjectBySlug(slug)) {
    return NextResponse.json({ error: `project '${slug}' already exists` }, { status: 409 });
  }
  const id = crypto.randomUUID();
  await createProject({ id, slug, title, created_by: a.email });
  return NextResponse.json({ project: { id, slug, title } });
}
