import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DollhouseViewer } from "@/components/tour/dollhouse-viewer";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Section } from "@/components/ui/section";
import { getTourLive } from "@/lib/store";

export const dynamic = "force-dynamic";

const splatUrl = (slug: string) =>
  `https://media.lvxhomes.com/tours/${slug}/dollhouse.splat?v=8`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tour = await getTourLive(slug);
  if (!tour) return { title: "Tours" };
  return {
    title: `${tour.title} — 3D Dollhouse`,
    description: `Orbit ${tour.title} in full 3D — the whole home, reconstructed from flight.`,
    robots: { index: false, follow: false },
  };
}

export default async function DollhousePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tour = await getTourLive(slug);
  if (!tour) notFound();
  // Only tours with a published dollhouse asset get this page.
  const head = await fetch(splatUrl(slug), { method: "HEAD" }).catch(() => null);
  if (!head?.ok) notFound();

  return (
    <Section dark spacing="normal" className="min-h-dvh pt-24 sm:pt-28">
      <Container>
        <Eyebrow className="text-champagne">
          The 3D Dollhouse{tour.location ? ` · ${tour.location}` : ""}
        </Eyebrow>
        <h1 className="mt-5 font-display text-3xl font-normal leading-tight tracking-[0.04em] text-paper sm:text-5xl">
          {tour.title.toUpperCase()}
        </h1>
        <p className="mt-5 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/70">
          The whole home in your hands — reconstructed in 3D from the flight
          itself, ceilings lifted away. Drag to orbit, scroll or pinch to zoom,
          right-drag to pan.{" "}
          <Link
            href={`/tours/${slug}`}
            className="text-champagne underline-offset-4 hover:underline"
          >
            Fly the 360 tour
          </Link>{" "}
          when you&apos;re ready to step inside.
        </p>

        <div className="mt-10 overflow-hidden border border-paper/15">
          <div className="aspect-[4/5] max-h-[calc(100svh-7rem)] w-full sm:aspect-video">
            <DollhouseViewer splatUrl={splatUrl(slug)} />
          </div>
        </div>

        <p className="mt-6 font-sans text-xs uppercase tracking-[0.16em] text-paper/40">
          An LVX original — every wall measured, every room flown
        </p>
      </Container>
    </Section>
  );
}
