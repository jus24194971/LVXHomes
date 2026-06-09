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
            {/* Portrait — TODO: swap for a real headshot / on-set still via next/image */}
            <Reveal>
              <div className="relative aspect-[4/5] overflow-hidden border border-sand">
                <div
                  aria-hidden
                  className="absolute inset-0"
                  style={{
                    background:
                      "radial-gradient(120% 90% at 50% 10%, rgba(58,48,38,0.85), rgba(33,28,22,1) 80%)",
                  }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-paper/70">
                  <span className="font-display text-3xl tracking-[0.2em]">
                    LVX
                  </span>
                  <span className="font-sans text-[0.625rem] uppercase tracking-[0.22em] text-paper/40">
                    Portrait — TODO
                  </span>
                </div>
              </div>
            </Reveal>

            <Reveal delay={90} className="flex flex-col gap-6 font-sans text-base font-light leading-relaxed text-espresso md:pt-2">
              <p>
                LVX is just me — Justin, the guy behind the sticks. I&apos;ve
                spent years putting demanding tech in front of demanding people;
                the drone&apos;s the newest tool, and easily the most fun.
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
            </Reveal>
          </div>
        </Container>
      </Section>

      {/* Trust signals */}
      <Section tone="sand" spacing="normal">
        <Container>
          <div className="grid gap-px overflow-hidden border border-paper/0 sm:grid-cols-3">
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
