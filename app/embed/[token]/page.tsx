import type { Metadata } from "next";
import { TourViewer } from "@/components/tour/viewer";
import { getGrant, getPlanLive, getTourLive } from "@/lib/store";
import { CF_STREAM_CUSTOMER_CODE } from "@/lib/stream";

/**
 * Permission-gated embed. The `[token]` is an embed-grant code issued from the
 * Studio — no valid, unrevoked grant, no embed. Renders a tour or a film,
 * branded (LVX mark) only when the grant says so. Public + noindex; framable
 * anywhere via the CSP `frame-ancestors *` header in next.config.ts.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "360 Tour",
  robots: { index: false, follow: false },
};

function Mark() {
  return (
    <a
      href="https://lvxhomes.com"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="An LVX Homes production"
      className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5 rounded-full bg-ink/55 px-2.5 py-1 font-sans text-[0.6rem] uppercase tracking-[0.18em] text-paper/70 backdrop-blur transition-colors hover:text-champagne"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-champagne" aria-hidden /> LVX
    </a>
  );
}

function Unavailable() {
  return (
    <div className="flex h-[100svh] w-full flex-col items-center justify-center gap-4 bg-ink px-6 text-center">
      <span className="h-2 w-2 rounded-full bg-champagne" aria-hidden />
      <p className="font-display text-lg uppercase tracking-[0.18em] text-paper">
        Tour unavailable
      </p>
      <p className="max-w-sm font-sans text-sm font-light leading-relaxed text-paper/55">
        This embed code is inactive or has been revoked.
      </p>
      <a
        href="https://lvxhomes.com"
        target="_blank"
        rel="noopener noreferrer"
        className="font-sans text-xs uppercase tracking-[0.18em] text-champagne transition-opacity hover:opacity-70"
      >
        LVX Homes ↗
      </a>
    </div>
  );
}

export default async function EmbedPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const grant = await getGrant(token);
  if (!grant || grant.revoked) return <Unavailable />;
  const branded = grant.branded === 1;

  if (grant.kind === "tour") {
    const tour = await getTourLive(grant.ref);
    if (!tour) return <Unavailable />;
    return (
      <div className="relative h-[100svh] w-full overflow-hidden bg-ink">
        <TourViewer
          tour={tour}
          plan={await getPlanLive(tour.slug)}
          className="h-full w-full"
        />
        {branded && <Mark />}
      </div>
    );
  }

  // film — Cloudflare Stream's player, full-bleed
  return (
    <div className="relative h-[100svh] w-full overflow-hidden bg-ink">
      <iframe
        src={`https://customer-${CF_STREAM_CUSTOMER_CODE}.cloudflarestream.com/${grant.ref}/iframe`}
        className="absolute inset-0 h-full w-full"
        style={{ border: 0 }}
        allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
        allowFullScreen
        title="Film"
      />
      {branded && <Mark />}
    </div>
  );
}
