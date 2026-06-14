import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { createGrant, getGrant, listGrants, type EmbedKind } from "@/lib/store";

export const dynamic = "force-dynamic";

const KINDS: EmbedKind[] = ["tour", "film"];

// Unambiguous base-56 token (no 0/O/1/I/l) — the embed code.
function token(n = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

export async function GET(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  const url = new URL(req.url);
  const kind = (url.searchParams.get("kind") as EmbedKind | null) ?? undefined;
  const ref = url.searchParams.get("ref") ?? undefined;
  return NextResponse.json({ grants: await listGrants(kind, ref) });
}

export async function POST(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;

  let body: { kind?: string; ref?: string; branded?: boolean; label?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!KINDS.includes(body.kind as EmbedKind) || !body.ref) {
    return NextResponse.json({ error: "kind ('tour'|'film') and ref are required" }, { status: 400 });
  }

  const id = token();
  await createGrant({
    id,
    kind: body.kind as EmbedKind,
    ref: body.ref,
    branded: body.branded !== false, // default branded
    label: body.label?.trim() || null,
    created_by: a.email,
  });
  return NextResponse.json({ grant: await getGrant(id) });
}
