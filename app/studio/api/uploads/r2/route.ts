import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { presignR2Put, r2PublicUrl, r2UploadConfigured } from "@/lib/r2-presign";
import { createAsset, type AssetKind } from "@/lib/store";

export const dynamic = "force-dynamic";

const R2_KINDS: AssetKind[] = ["video360", "pano"];

function extOf(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "bin";
}

/** Presign an R2 PUT + register the asset (status: uploading). The browser PUTs
 *  the file straight to putUrl, then calls /complete. */
export async function POST(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { env, email } = a;

  if (!r2UploadConfigured(env)) {
    return NextResponse.json(
      { error: "R2 uploads aren't configured (set the R2 S3 credentials)" },
      { status: 503 },
    );
  }

  let body: { title?: string; kind?: string; filename?: string; contentType?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* validated below */
  }
  const kind = body.kind as AssetKind;
  if (!R2_KINDS.includes(kind)) {
    return NextResponse.json({ error: "kind must be 'video360' or 'pano'" }, { status: 400 });
  }
  const title = (body.title || body.filename || "Untitled").trim();
  const id = crypto.randomUUID();
  const key = `library/${kind}/${id}.${extOf(body.filename || "")}`;

  try {
    const putUrl = await presignR2Put(env, key);
    await createAsset({
      id,
      kind,
      title,
      status: "uploading",
      r2_key: key,
      content_type: body.contentType ?? null,
      created_by: email,
    });
    return NextResponse.json({ assetId: id, putUrl, key, publicUrl: r2PublicUrl(env, key) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "R2 presign failed" },
      { status: 502 },
    );
  }
}
