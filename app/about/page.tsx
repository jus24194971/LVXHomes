import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Reveal } from "@/components/ui/reveal";
import { Section } from "@/components/ui/section";

export const metadata: Metadata = {
  title: "About",
  alternates: { canonical: "/about" },
  description:
    "LVX is the FPV craft of one Arizona pilot — Part 107 certified. LVX is Latin for light, the only thing a camera ever really records.",
};

const TRUST = [
  { label: "FAA Part 107", detail: "Certified commercial drone pilot" },
  { label: "Licensed Pilot", detail: "FAA Part 61 · manned aircraft" },
  { label: "Insured", detail: "Liability coverage" }, // TODO: confirm coverage
  { label: "Arizona based", detail: "Phoenix · Mesa · Scottsdale" },
];

export default function AboutPage() {
  return (
    <>
      <Section spacing="normal" className="pt-20 sm:pt-28">
        <Container>
          <Reveal className="max-w-2xl">
            <Eyebrow>About</Eyebrow>
            <h1 className="mt-6 font-display text-4xl font-normal leading-[1.1] tracking-[0.04em] text-ink sm:text-5xl">
              ONE PILOT.
              <br />
              ONE PERSPECTIVE.
            </h1>
            <p className="mt-7 font-serif text-2xl font-light italic leading-relaxed text-espresso sm:text-[1.7rem]">
              LVX is Latin for light — the only thing a camera ever really
              records.
            </p>
          </Reveal>

          <div className="mt-16 grid gap-12 md:grid-cols-[5fr_7fr] md:items-start">
            {/* Portrait */}
            <Reveal>
              <div className="relative aspect-[4/5] overflow-hidden border border-sand">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/justin.jpg"
                  alt="Justin, founder and pilot of LVX Homes, in front of a vintage TWA Constellation at night"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
            </Reveal>

            <Reveal delay={90} className="flex flex-col gap-6 font-sans text-base font-light leading-relaxed text-espresso md:pt-2">
              <p>
                LVX is just me — Justin, the guy behind the sticks. I&apos;ve
                spent two decades in tech, the last stretch of it around cameras
                and drones in public safety — flying search-and-rescue, mapping
                the damage after a storm, the kind of work where the footage
                actually mattered. Flying&apos;s in my blood, too: I&apos;m a
                licensed pilot. Somewhere in there it clicked that the same craft
                that finds someone in floodwater can make a home look the way it
                deserves.
              </p>
              <p>
                FPV flying isn&apos;t the slow, gimbaled orbit you&apos;ve seen a
                hundred times. It&apos;s hand-flown — no autopilot — threading
                doorways and diving over balconies in real time. That&apos;s the
                whole point: it&apos;s how I reach the angles a buyer never gets on
                foot — over the pool, through the great room, up the stairs and
                out across the grounds.
              </p>
              <p>
                The name&apos;s a reminder of the job. Light is the only thing a
                camera actually records — everything else is just where you
                point it. I find the light in a house, and I move through it.
              </p>
              <p>
                So if you&apos;ve got a home worth filming,{" "}
                <a
                  href="/contact"
                  className="text-champagne-dk underline-offset-4 transition-colors hover:underline"
                >
                  reach out
                </a>
                . Let&apos;s find a date, and I&apos;ll put it in the best light
                it&apos;s ever seen — I think you&apos;ll be glad you did.
              </p>
            </Reveal>
          </div>
        </Container>
      </Section>

      {/* Trust signals */}
      <Section tone="sand" spacing="normal">
        <Container>
          <div className="grid gap-px overflow-hidden border border-paper/0 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST.map((t, i) => (
              <Reveal key={t.label} delay={i * 80} className="bg-sand px-2 py-4 text-center">
                <p className="font-display text-sm uppercase tracking-[0.18em] text-champagne-dk">
                  {t.label}
                </p>
                <p className="mt-2 font-sans text-sm text-espresso/80">
                  {t.detail}
                </p>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      {/* CTA */}
      <Section tone="ink" spacing="normal">
        <Container className="text-center">
          <Reveal>
            <h2 className="mx-auto max-w-2xl font-serif text-3xl font-light italic leading-tight text-paper sm:text-4xl">
              Let&apos;s film your next listing.
            </h2>
            <div className="mt-10 flex justify-center">
              <Button href="/contact" variant="light">
                Inquire
              </Button>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
