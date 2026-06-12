import type { Metadata } from "next";
import { TourViewer } from "@/components/tour/viewer";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Section } from "@/components/ui/section";

/**
 * Engine test page for the LVX 360 flight viewer. Not linked from the site and
 * excluded from indexing — replace the synthetic clip with real Avata footage
 * when it arrives, then this graduates into /tours/[slug].
 */

export const metadata: Metadata = {
  title: "The 360 Flight — Engine Test",
  robots: { index: false, follow: false },
};

export default function TourTestPage() {
  return (
    <Section dark spacing="normal" className="min-h-dvh pt-24 sm:pt-28">
      <Container>
        <Eyebrow className="text-champagne">LVX Labs · Engine Test</Eyebrow>
        <h1 className="mt-5 font-display text-3xl font-normal leading-tight tracking-[0.04em] text-paper sm:text-5xl">
          THE 360 FLIGHT
        </h1>
        <p className="mt-5 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/70">
          A synthetic test sphere until the Avata footage lands. Tap to start,
          then drag to look anywhere — scroll or pinch to zoom, arrow keys work
          too. On a phone, hit <span className="text-champagne">Motion</span>{" "}
          and steer by moving the phone. &ldquo;FRONT&rdquo; should sit dead
          ahead when the flight starts.
        </p>

        <div className="mt-10 overflow-hidden border border-paper/15">
          <TourViewer
            src="/tours/lvx-360-test.mp4"
            className="aspect-[4/5] w-full sm:aspect-video"
          />
        </div>

        <p className="mt-6 font-sans text-xs uppercase tracking-[0.16em] text-paper/40">
          Engine check: smooth drag · inertia · zoom · motion · the moving test
          card proves video playback
        </p>
      </Container>
    </Section>
  );
}
