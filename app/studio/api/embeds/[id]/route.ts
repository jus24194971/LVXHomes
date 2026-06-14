import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { getGrant, setGrantRevoked, deleteGrant } from "@/lib/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { id } = await ctx.params;
  let body: { revoked?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* no-op */
  }
  if (typeof body.revoked === "boolean") await setGrantRevoked(id, body.revoked);
  return NextResponse.json({ grant: await getGrant(id) });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const { id } = await ctx.params;
  await deleteGrant(id);
  return NextResponse.json({ ok: true });
}
