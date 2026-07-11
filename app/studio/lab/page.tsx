import type { Metadata } from "next";
import { IngestLab } from "@/components/studio/ingest-lab";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Section } from "@/components/ui/section";

/**
 * LVX Labs — experimental tools that aren't part of the client-facing product
 * yet. First resident: scene ingest (photo -> detected furniture with real
 * dimensions), the measurement layer behind the "Make It Their Own" concept.
 */

export const metadata: Metadata = {
  title: "Lab",
  robots: { index: false, follow: false },
};

export default function LabPage() {
  return (
    <Section dark spacing="normal" className="min-h-dvh pt-24 sm:pt-28">
      <Container className="max-w-5xl">
        <Eyebrow className="text-champagne">LVX Labs · Experimental</Eyebrow>
        <h1 className="mt-5 font-display text-3xl font-normal leading-tight tracking-[0.04em] text-paper sm:text-4xl">
          SCENE INGEST
        </h1>
        <p className="mt-4 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/70">
          Photograph a room and every piece of furniture comes back detected,
          measured in real inches, and confidence-scored. Best results: stand
          square to the item&apos;s long side, keep the floor in frame, shoot
          from 6&ndash;10 ft. The first request after idle wakes a GPU
          (~a minute); after that it&apos;s seconds.
        </p>
        <div className="mt-8">
          <IngestLab />
        </div>
      </Container>
    </Section>
  );
}
