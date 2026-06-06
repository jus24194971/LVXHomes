import { NextResponse, type NextRequest } from "next/server";

/**
 * Contact inquiry handler. Delivers via Resend's REST API over fetch (no SDK)
 * so it runs unchanged on Vercel or Cloudflare Workers. Degrades gracefully:
 * with no RESEND_API_KEY/CONTACT_TO_EMAIL set, it validates + logs and returns
 * success, so the form is testable before email is wired up.
 */

// Best-effort in-memory rate limit. Note: in serverless this is per-instance,
// not global — a real limiter (e.g. Cloudflare KV / Upstash) is a later upgrade.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Honeypot: silently accept and send nothing.
  if (typeof body.company === "string" && body.company.trim() !== "") {
    return NextResponse.json({ ok: true });
  }

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim();
  const message = String(body.message ?? "").trim();

  if (!name || !isEmail(email) || !message) {
    return NextResponse.json(
      { error: "Please add your name, a valid email, and a message." },
      { status: 422 },
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many messages. Please try again in a minute." },
      { status: 429 },
    );
  }

  const fields = {
    name,
    email,
    phone: String(body.phone ?? "").trim(),
    brokerage: String(body.brokerage ?? "").trim(),
    listingAddress: String(body.listingAddress ?? "").trim(),
    priceRange: String(body.priceRange ?? "").trim(),
    packageInterest: String(body.packageInterest ?? "").trim(),
    message,
  };

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL;

  if (!apiKey || !to) {
    console.info("[contact] inquiry received (Resend not configured):", fields);
    return NextResponse.json({ ok: true, delivered: false });
  }

  const subject = `New LVX inquiry — ${fields.name}${
    fields.priceRange ? ` (${fields.priceRange})` : ""
  }`;
  const text = [
    `Name: ${fields.name}`,
    `Email: ${fields.email}`,
    `Phone: ${fields.phone || "—"}`,
    `Brokerage: ${fields.brokerage || "—"}`,
    `Listing address: ${fields.listingAddress || "—"}`,
    `Price range: ${fields.priceRange || "—"}`,
    `Package interest: ${fields.packageInterest || "—"}`,
    "",
    fields.message,
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // TODO: use a verified LVX <hello@lvxhomes.com> sender once the domain
        // is verified in Resend; onboarding@resend.dev works to start.
        from: process.env.CONTACT_FROM_EMAIL || "LVX Homes <onboarding@resend.dev>",
        to: [to],
        reply_to: fields.email,
        subject,
        text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[contact] Resend error:", res.status, detail);
      return NextResponse.json(
        { error: "We couldn't send that just now. Please email us directly." },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, delivered: true });
  } catch (err) {
    console.error("[contact] send failed:", err);
    return NextResponse.json(
      { error: "We couldn't send that just now. Please try again." },
      { status: 502 },
    );
  }
}
