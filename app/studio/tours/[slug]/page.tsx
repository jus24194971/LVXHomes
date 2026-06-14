import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TourViewer } from "@/components/tour/viewer";
import { Container } from "@/components/ui/container";
import { getPlanLive, getTourLive } from "@/lib/store";
import { TourSettings } from "@/components/studio/tour-settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Ring Authoring" };

export default async function StudioTourAuthor({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tour = await getTourLive(slug);
  if (!tour) notFound();

  return (
    <Container className="max-w-[1400px] py-6 sm:py-8">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-sans text-[0.7rem] uppercase tracking-[0.2em] text-champagne">
            Ring authoring
          </p>
          <h1 className="mt-1 truncate font-display text-2xl font-normal tracking-[0.04em] text-paper">
            {tour.title.toUpperCase()}
          </h1>
        </div>
        <Link
          href="/studio/tours"
          className="shrink-0 font-sans text-[0.7rem] uppercase tracking-[0.16em] text-paper/50 transition-colors hover:text-champagne"
        >
          ‹ All tours
        </Link>
      </div>

      <div className="overflow-hidden rounded-lg border border-paper/15">
        <TourViewer
          tour={tour}
          plan={await getPlanLive(tour.slug)}
          authorMode
          className="aspect-video w-full"
        />
      </div>

      <p className="mt-3 font-sans text-xs leading-relaxed text-paper/40">
        Hit Play, scrub to where an amenity appears, click it in the 360 to drop a
        tracking keyframe, then <span className="text-champagne/80">Save to site</span>.
        Use <span className="text-champagne/80">History</span> to roll back a bad save.
      </p>

      <TourSettings tour={tour} />
    </Container>
  );
}
