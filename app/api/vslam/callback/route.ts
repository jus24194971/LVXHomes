import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AppEnv } from "@/lib/cf";
import { putDoc, latestVslamJobForSlug, updateVslamJob } from "@/lib/store";
import { r2PublicUrl } from "@/lib/r2-presign";

export const dynamic = "force-dynamic";

/**
 * Modal posts here when a cloud job finishes. PUBLIC path (not Access-gated, so
 * Modal can reach it) — authenticated by the shared VSLAM_CALLBACK_TOKEN bearer.
 * Make sure your Cloudflare Access app does NOT cover /api/vslam/*.
 *
 * On "ready" we pull the produced plan.json out of R2, repoint its base image at
 * the public R2 URL (lean doc, same as the aerial flow), and persist it as the
 * live plan for `slug` — so the floor shows up in the Floorplan Studio + tour.
 */
async function appEnv(): Promise<AppEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env as unknown as AppEnv;
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  return m ? m[1] : null;
}

// TEMP diagnostic — reports which token the route sees (fingerprint only, irreversible)
// and whether the Authorization header survives Cloudflare. Remove once the wire is confirmed.
export async function GET(req: NextRequest) {
  const env = await appEnv();
  const expected = env.VSLAM_CALLBACK_TOKEN || "";
  const fp = async (s: string) => {
    if (!s) return "";
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  };
  return NextResponse.json({
    token_set: !!expected,
    token_len: expected.length,
    token_fp: await fp(expected),
    saw_auth: !!req.headers.get("authorization"),
    saw_xhdr: !!req.headers.get("x-lvx-token"),
    recv_fp: await fp(req.headers.get("x-lvx-token") || bearer(req) || ""),
  });
}

export async function POST(req: NextRequest) {
  const env = await appEnv();
  const expected = env.VSLAM_CALLBACK_TOKEN;
  const provided = req.headers.get("x-lvx-token") || bearer(req); // CF rewrites Authorization; use a custom header
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    slug?: string;
    status?: string;
    plan?: string;
    base?: string;
    error?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const slug = (body.slug || "").trim();
  if (!slug) return NextResponse.json({ error: "need slug" }, { status: 400 });

  const job = await latestVslamJobForSlug(slug);

  if (body.status === "failed") {
    if (job) {
      await updateVslamJob(job.id, {
        status: "failed",
        error: body.error ?? "processing failed",
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (!env.MEDIA) {
    return NextResponse.json({ error: "R2 (MEDIA) not bound" }, { status: 503 });
  }
  const planKey = body.plan;
  if (!planKey) return NextResponse.json({ error: "need plan key" }, { status: 400 });

  const obj = await env.MEDIA.get(planKey);
  if (!obj) {
    return NextResponse.json({ error: `plan not in R2: ${planKey}` }, { status: 404 });
  }
  const text = await new Response(obj.body).text();
  let plan: { sheets?: Array<{ satUrl?: string }> };
  try {
    plan = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "plan.json parse failed" }, { status: 422 });
  }

  // Point the interior base at its public R2 URL so the stored doc stays lean.
  if (body.base && Array.isArray(plan.sheets)) {
    const url = r2PublicUrl(env, body.base);
    for (const s of plan.sheets) s.satUrl = url;
  }

  await putDoc("plan", slug, plan, "vslam-cloud");
  if (job) {
    await updateVslamJob(job.id, {
      status: "ready",
      plan_key: planKey,
      base_key: body.base ?? null,
    });
  }

  return NextResponse.json({ ok: true, slug });
}
