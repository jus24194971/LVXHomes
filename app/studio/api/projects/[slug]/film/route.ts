import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { getProjectBySlug, listProjectFiles, createAsset } from "@/lib/store";
import { importStreamFromUrl, streamConfigured } from "@/lib/stream-admin";
import { r2UploadConfigured, presignR2Get } from "@/lib/r2-presign";

export const dynamic = "force-dynamic";

/** Make a capture project's tour video selectable in the Pin Studio: hand its R2
 *  key to Stream (copy-from-URL, no re-upload) and register a Library FILM asset.
 *  Once Stream finishes transcoding, the film shows up in every film picker. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { env, email } = a;

  if (!streamConfigured(env)) {
    return NextResponse.json(
      { error: "Stream isn't configured (set CF_ACCOUNT_ID + CF_API_TOKEN)" },
      { status: 503 },
    );
  }

  const { slug } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  let body: { fileId?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* optional body — default to the tour video */
  }
  const files = await listProjectFiles(project.id);
  const file = body.fileId
    ? files.find((f) => f.id === body.fileId)
    : files.find((f) => f.role === "video");
  if (!file) {
    return NextResponse.json(
      { error: "no tour video on this project — upload one (role: video) first" },
      { status: 400 },
    );
  }

  // Always hand Stream a presigned GET with the Content-Type forced in the URL:
  // Stream preflights the source and 10005-rejects URLs that don't identify as
  // video, and bulk-uploaded objects (e.g. standard.mp4) may be stored without a
  // content type. The signed override covers every object, stored metadata or not.
  if (!r2UploadConfigured(env)) {
    return NextResponse.json(
      { error: "R2 credentials aren't configured (needed to presign the video for Stream)" },
      { status: 503 },
    );
  }
  const url = await presignR2Get(env, file.r2_key, {
    responseContentType: file.content_type || "video/mp4",
  });

  try {
    const { uid } = await importStreamFromUrl(env, {
      url,
      name: `${project.title} — tour film`,
    });
    const id = crypto.randomUUID();
    await createAsset({
      id,
      kind: "film",
      title: `${project.title} — tour film`,
      status: "processing",
      stream_uid: uid,
      created_by: email,
    });
    return NextResponse.json({ assetId: id, uid });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Stream import failed" },
      { status: 502 },
    );
  }
}
