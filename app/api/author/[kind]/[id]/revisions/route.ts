import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AppEnv } from "@/lib/cf";
import { authorize } from "@/lib/access";
import { KINDS, listRevisions, restoreRevision, type Kind } from "@/lib/store";

export const dynamic = "force-dynamic";

const isKind = (k: string): k is Kind => (KINDS as string[]).includes(k);

async function appEnv(): Promise<AppEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env as unknown as AppEnv;
}

type Ctx = { params: Promise<{ kind: string; id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { kind, id } = await ctx.params;
  if (!isKind(kind)) {
    return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
  }
  const auth = await authorize(req, await appEnv());
  if (!auth.ok) {
    return NextResponse.json({ error: auth.msg }, { status: auth.status });
  }
  return NextResponse.json({ revisions: await listRevisions(kind, id) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { kind, id } = await ctx.params;
  if (!isKind(kind)) {
    return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
  }
  const auth = await authorize(req, await appEnv());
  if (!auth.ok) {
    return NextResponse.json({ error: auth.msg }, { status: auth.status });
  }
  let payload: { revisionId?: number };
  try {
    payload = (await req.json()) as { revisionId?: number };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof payload.revisionId !== "number") {
    return NextResponse.json({ error: "revisionId (number) required" }, { status: 400 });
  }
  try {
    const doc = await restoreRevision(kind, id, payload.revisionId, auth.email);
    if (doc === null) {
      return NextResponse.json({ error: "Revision not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, doc });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
