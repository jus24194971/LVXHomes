import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TourViewer } from "@/components/tour/viewer";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Section } from "@/components/ui/section";
import { getPlan } from "@/data/plans";
import { getTour, TOURS } from "@/data/tours";

export function generateStaticParams() {
  return TOURS.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tour = getTour(slug);
  if (!tour) return { title: "Tours" };
  return {
    title: `${tour.title} — The 360 Flight`,
    description: `Fly ${tour.title} yourself — an interactive 360 flight by LVX Homes. Look anywhere, step into the rooms.`,
    ...(tour.hidden ? { robots: { index: false, follow: false } } : {}),
    alternates: { canonical: `/tours/${slug}` },
  };
}

export default async function TourPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tour = getTour(slug);
  if (!tour) notFound();

  return (
    <Section dark spacing="normal" className="min-h-dvh pt-24 sm:pt-28">
      <Container>
        <Eyebrow className="text-champagne">
          The 360 Flight{tour.location ? ` · ${tour.location}` : ""}
        </Eyebrow>
        <h1 className="mt-5 font-display text-3xl font-normal leading-tight tracking-[0.04em] text-paper sm:text-5xl">
          {tour.title.toUpperCase()}
        </h1>
        <p className="mt-5 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/70">
          This one&apos;s yours to fly. Drag to look anywhere — pinch or scroll
          to zoom. When a gold ring appears, tap it to step off the flight and
          stand in that room; resume whenever you&apos;re ready. On a phone, hit{" "}
          <span className="text-champagne">Motion</span> and steer by moving
          the phone.
        </p>

        <div className="mt-10 overflow-hidden border border-paper/15">
          <TourViewer
            tour={tour}
            plan={getPlan(tour.slug)}
            className="aspect-[4/5] w-full sm:aspect-video"
          />
        </div>

        <p className="mt-6 font-sans text-xs uppercase tracking-[0.16em] text-paper/40">
          An LVX original — filmed by hand, flown by you
        </p>
      </Container>
    </Section>
  );
}
