import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/studio-api";
import { getVslamJob, latestVslamJobForSlug, listVslamJobs } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Poll job state. ?id=<job> or ?slug=<tour> for one, otherwise the recent list. */
export async function GET(req: NextRequest) {
  const a = await requireAuth(req);
  if (a instanceof NextResponse) return a;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const slug = url.searchParams.get("slug");
  if (id) return NextResponse.json({ job: await getVslamJob(id) });
  if (slug) return NextResponse.json({ job: await latestVslamJobForSlug(slug) });
  return NextResponse.json({ jobs: await listVslamJobs() });
}
