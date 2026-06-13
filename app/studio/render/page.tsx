import type { Metadata } from "next";
import { FlightRenderer } from "@/components/studio/flight-renderer";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Section } from "@/components/ui/section";

/**
 * Dev-only synthetic flight renderer. Run scripts/render-receiver.cjs, then
 * open /studio/render?go=1 — frames stream to the receiver and ffmpeg
 * assembles the demo flight. Unlinked + noindex; harmless if deployed.
 */

export const metadata: Metadata = {
  title: "Flight Renderer",
  robots: { index: false, follow: false },
};

export default function RenderPage() {
  return (
    <Section dark spacing="normal" className="min-h-dvh pt-24 sm:pt-28">
      <Container className="max-w-7xl">
        <Eyebrow className="text-champagne">LVX Labs · Renderer</Eyebrow>
        <h1 className="mt-5 font-display text-3xl font-normal leading-tight tracking-[0.04em] text-paper sm:text-4xl">
          SYNTHETIC FLIGHT RENDERER
        </h1>
        <p className="mt-4 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/70">
          Renders the 3D demo house to equirectangular frames along the flight
          spline. Requires the local frame receiver; add{" "}
          <code className="text-champagne">?go=1</code> to start.
        </p>
        <div className="mt-8">
          <FlightRenderer />
        </div>
      </Container>
    </Section>
  );
}
