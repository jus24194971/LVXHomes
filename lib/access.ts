import type { AppEnv } from "@/lib/cf";

/**
 * Cloudflare Zero Trust (Access) gate for the author API.
 *
 * The PRIMARY protection is the Cloudflare Access application configured over
 * /studio/* and /api/author/* at the edge: by the time a request reaches the
 * Worker it has already passed that policy, and Access injects the verified
 * identity as the `Cf-Access-Authenticated-User-Email` header.
 *
 * When ACCESS_TEAM_DOMAIN + ACCESS_AUD are set we ALSO cryptographically verify
 * the Access JWT here (defense-in-depth), and AUTHOR_ALLOWLIST can pin the exact
 * emails allowed to write. With nothing configured and no Access header present,
 * we fail closed — so a forgotten Access app can't leave writes wide open.
 */

type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string };

// Module-scoped JWKS cache. Access rotates keys rarely; an hour is plenty.
let jwksCache: { keys: Jwk[]; exp: number } | null = null;

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.exp > now) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { keys: body.keys ?? [], exp: now + 60 * 60 * 1000 };
  return jwksCache.keys;
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 ? "=".repeat(4 - (t.length % 4)) : "";
  const bin = atob(t + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeSegment<T>(seg: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(seg))) as T;
  } catch {
    return null;
  }
}

/** Verify a Cloudflare Access JWT. Returns the email claim on success, else null. */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeSegment<{ alg: string; kid: string }>(parts[0]);
  const payload = decodeSegment<{
    aud?: string | string[];
    email?: string;
    exp?: number;
    nbf?: number;
    iss?: string;
  }>(parts[1]);
  if (!header || !payload || header.alg !== "RS256" || !header.kid) return null;

  const jwk = (await getJwks(teamDomain)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(aud)
    : payload.aud === aud;
  if (!audOk) return null;
  if (payload.iss && payload.iss !== `https://${teamDomain}`) return null;

  return payload.email ?? null;
}

export type AuthResult =
  | { ok: true; email: string | null }
  | { ok: false; status: number; msg: string };

export async function authorize(req: Request, env: AppEnv): Promise<AuthResult> {
  const headerEmail =
    req.headers.get("Cf-Access-Authenticated-User-Email") ?? null;
  const allow = (env.AUTHOR_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  let email = headerEmail;

  if (teamDomain && aud) {
    const token =
      req.headers.get("Cf-Access-Jwt-Assertion") ??
      readCookie(req, "CF_Authorization");
    if (!token) return { ok: false, status: 403, msg: "No Access token" };
    let verified: string | null;
    try {
      verified = await verifyAccessJwt(token, teamDomain, aud);
    } catch {
      return { ok: false, status: 503, msg: "Access verification unavailable" };
    }
    if (verified === null) {
      return { ok: false, status: 403, msg: "Invalid Access token" };
    }
    email = verified || headerEmail;
  } else if (!headerEmail) {
    // No in-Worker verification configured AND no Access header → we cannot
    // prove this request passed a Zero Trust policy. Fail closed.
    return { ok: false, status: 403, msg: "Access is not configured" };
  }

  if (allow.length > 0 && (!email || !allow.includes(email.toLowerCase()))) {
    return { ok: false, status: 403, msg: "Email not allowed" };
  }
  return { ok: true, email };
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
