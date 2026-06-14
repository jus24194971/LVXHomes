import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";

export const dynamic = "force-dynamic";

/**
 * Same-origin proxy for Esri World Imagery satellite tiles, so the Floorplan
 * Studio can stitch them onto a canvas without tainting it (cross-origin tiles
 * would block toDataURL). Access-gated by the /studio path.
 */
const tileUrl = (z: string, y: string, x: string) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

export async function GET(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;

  const p = new URL(req.url).searchParams;
  const z = p.get("z");
  const x = p.get("x");
  const y = p.get("y");
  if (![z, x, y].every((v) => v && /^\d+$/.test(v))) {
    return NextResponse.json({ error: "z, x, y (integers) required" }, { status: 400 });
  }

  const res = await fetch(tileUrl(z as string, y as string, x as string));
  if (!res.ok) {
    return NextResponse.json({ error: `tile ${res.status}` }, { status: 502 });
  }
  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg",
      "Cache-Control": "public, max-age=604800",
    },
  });
}
