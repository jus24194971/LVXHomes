import type { Metadata } from "next";
import { PlanEditor } from "@/components/studio/plan-editor";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Section } from "@/components/ui/section";

/**
 * LVX Floorplan Studio — internal authoring tool. Unlinked + noindex.
 * Draw or trace a plan, link zones to flight chapters / panos, export JSON
 * into data/plans.ts.
 */

export const metadata: Metadata = {
  title: "Floorplan Studio",
  robots: { index: false, follow: false },
};

export default function PlanStudioPage() {
  return (
    <Section dark spacing="normal" className="min-h-dvh pt-24 sm:pt-28">
      <Container className="max-w-7xl">
        <Eyebrow className="text-champagne">LVX Labs · Studio</Eyebrow>
        <h1 className="mt-5 font-display text-3xl font-normal leading-tight tracking-[0.04em] text-paper sm:text-4xl">
          FLOORPLAN STUDIO
        </h1>
        <p className="mt-4 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/70">
          Draw zones, trace over a reference image, link rooms to flight
          chapters and 360 panos, then export the JSON into{" "}
          <code className="text-champagne">data/plans.ts</code>. Floors and
          grounds are both first-class sheets.
        </p>
        <div className="mt-8">
          <PlanEditor />
        </div>
      </Container>
    </Section>
  );
}
