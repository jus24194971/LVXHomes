import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TourViewer } from "@/components/tour/viewer";
import { getPlanLive, getTourLive } from "@/lib/store";

/**
 * Chromeless, framable 360 player for embedding on agents' / brokerages' own
 * listing pages (and as the MLS "virtual tour" URL). No site nav/footer — just
 * the player, full-bleed. Public + noindex; framing is allowed for any origin
 * via the CSP `frame-ancestors *` header in next.config.ts.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tour = await getTourLive(slug);
  return {
    title: tour ? `${tour.title} — 360 Tour` : "360 Tour",
    description: tour
      ? `Fly ${tour.title} in an interactive 360 tour.`
      : undefined,
    robots: { index: false, follow: false },
  };
}

export default async function EmbedPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tour = await getTourLive(slug);
  if (!tour) notFound();

  return (
    <div className="relative h-[100svh] w-full overflow-hidden bg-ink">
      <TourViewer
        tour={tour}
        plan={await getPlanLive(tour.slug)}
        className="h-full w-full"
      />
      {/* Subtle credit / drive-back. Becomes a branded/unbranded toggle later. */}
      <a
        href="https://lvxhomes.com"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="An LVX Homes 360 tour"
        className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5 rounded-full bg-ink/55 px-2.5 py-1 font-sans text-[0.6rem] uppercase tracking-[0.18em] text-paper/70 backdrop-blur transition-colors hover:text-champagne"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-champagne" aria-hidden /> LVX
      </a>
    </div>
  );
}
