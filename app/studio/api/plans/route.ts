import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { listPlanSlugs } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Live plan slugs (D1 "plan" rows) so the Floorplan editor can list cloud-delivered
 *  plans, not just the baked ones. Gated like the rest of Studio. */
export async function GET(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;
  return NextResponse.json({ slugs: await listPlanSlugs() });
}
