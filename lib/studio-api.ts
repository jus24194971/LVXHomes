import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import type { AppEnv } from "@/lib/cf";
import { authorize } from "@/lib/access";

/** Shared helpers for the /studio/api/* routes (Access-gated by the /studio path). */

export async function getEnv(): Promise<AppEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env as unknown as AppEnv;
}

/** Resolve env + enforce Access. Returns the 403/503 response on failure so the
 *  caller can `if (x instanceof NextResponse) return x;`. */
export async function requireAuth(
  req: Request,
): Promise<{ env: AppEnv; email: string | null } | NextResponse> {
  const env = await getEnv();
  const auth = await authorize(req, env);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.msg }, { status: auth.status });
  }
  return { env, email: auth.email };
}
