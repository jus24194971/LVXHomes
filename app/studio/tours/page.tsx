import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/ui/container";
import { TOURS } from "@/data/tours";
import { NewTour } from "@/components/studio/new-tour";

export const metadata: Metadata = { title: "Tours" };

export default function StudioTours() {
  return (
    <Container className="max-w-[1400px] py-10 sm:py-14">
      <p className="font-sans text-[0.7rem] uppercase tracking-[0.22em] text-champagne">
        Tours · Gold-dot authoring
      </p>
      <h1 className="mt-3 font-display text-3xl font-normal tracking-[0.04em] text-paper sm:text-4xl">
        RING AUTHORING
      </h1>
      <p className="mt-3 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/60">
        Pick a tour to keyframe its gold flight rings. Opens the 360 in author
        mode — hit Play, scrub to where an amenity appears, click it, and Save to
        site.
      </p>

      <div className="mt-8">
        <NewTour existingSlugs={TOURS.map((t) => t.slug)} />
      </div>

      <div className="mt-6 flex flex-col gap-2.5">
        {TOURS.map((t) => (
          <Link
            key={t.slug}
            href={`/studio/tours/${t.slug}`}
            className="flex items-center justify-between gap-4 rounded-lg border border-paper/15 p-4 transition-colors hover:border-champagne/50 hover:bg-champagne/[0.04]"
          >
            <div className="min-w-0">
              <p className="font-display text-base uppercase tracking-[0.1em] text-paper">
                {t.title}
              </p>
              <p className="mt-0.5 font-sans text-xs text-paper/50">
                {t.location ? `${t.location} · ` : ""}
                {t.chapters.length} chapter{t.chapters.length === 1 ? "" : "s"} ·{" "}
                {t.panos.length} pano{t.panos.length === 1 ? "" : "s"}
                {t.hidden ? " · hidden" : ""}
              </p>
            </div>
            <span className="shrink-0 font-sans text-[0.7rem] uppercase tracking-[0.16em] text-champagne">
              Author ›
            </span>
          </Link>
        ))}
      </div>
    </Container>
  );
}
