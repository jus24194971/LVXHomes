import type { Metadata } from "next";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Reveal } from "@/components/ui/reveal";
import { Section } from "@/components/ui/section";
import { WorkGrid } from "@/components/work/work-grid";
import { PROJECTS } from "@/data/projects";

export const metadata: Metadata = {
  title: "Work",
  alternates: { canonical: "/work" },
  description:
    "Recent aerial films — each home from angles a walkthrough can't reach, across Phoenix, Mesa, Scottsdale, and Paradise Valley.",
};

export default function WorkPage() {
  return (
    <Section spacing="normal" className="pt-20 sm:pt-28">
      <Container>
        <Reveal className="text-center">
          <Eyebrow>Work</Eyebrow>
          <h1 className="mt-6 font-display text-4xl font-normal tracking-[0.04em] text-ink sm:text-5xl">
            SELECTED FILMS
          </h1>
          <p className="mx-auto mt-7 max-w-xl font-serif text-xl font-light italic text-espresso">
            Every home, from angles you can&apos;t walk to.
          </p>
        </Reveal>
        <div className="mt-16">
          <WorkGrid projects={PROJECTS} />
        </div>
      </Container>
    </Section>
  );
}
