import type { Metadata } from "next";
import { PinStudio } from "@/components/studio/pin-studio";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Section } from "@/components/ui/section";

/**
 * Pin Studio — map where rooms live on a real flat film by dropping tracking
 * keyframes. Backstage tool: unlinked + noindex. Exports JSON for
 * data/video-pins.ts, which the public film overlay can later consume.
 */

export const metadata: Metadata = {
  title: "Pin Studio",
  robots: { index: false, follow: false },
};

export default function PinStudioPage() {
  return (
    <Section dark spacing="normal" className="min-h-dvh pt-24 sm:pt-28">
      <Container className="max-w-7xl">
        <Eyebrow className="text-champagne">LVX Labs · Pins</Eyebrow>
        <h1 className="mt-5 font-display text-3xl font-normal leading-tight tracking-[0.04em] text-paper sm:text-4xl">
          PIN STUDIO
        </h1>
        <p className="mt-4 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/70">
          Map where rooms live on a real film — no 360 needed. Pick a film, add a
          pin, then scrub and click the room a few times to drop keyframes; the
          pin tracks the room as the drone moves. Copy the JSON when you&apos;re done.
        </p>
        <div className="mt-8">
          <PinStudio />
        </div>
      </Container>
    </Section>
  );
}
