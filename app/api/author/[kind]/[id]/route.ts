import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AppEnv } from "@/lib/cf";
import { authorize } from "@/lib/access";
import { getDocLive, putDoc, KINDS, type Kind } from "@/lib/store";

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
  const doc = await getDocLive(kind, id);
  return NextResponse.json({ doc });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { kind, id } = await ctx.params;
  if (!isKind(kind)) {
    return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
  }
  const auth = await authorize(req, await appEnv());
  if (!auth.ok) {
    return NextResponse.json({ error: auth.msg }, { status: auth.status });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    await putDoc(kind, id, body, auth.email);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
