import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Reveal } from "@/components/ui/reveal";
import { Section } from "@/components/ui/section";
import { ADDONS, PACKAGES, PROCESS } from "@/data/packages";
import { TAGLINES } from "@/data/site";

export const metadata: Metadata = {
  title: "Services",
  alternates: { canonical: "/services" },
  description:
    "Three ways to film a listing — Signature, Showcase, and Estate. A cinematic flythrough that shows a home from angles a walkthrough can't, delivered in 48 hours.",
};

export default function ServicesPage() {
  return (
    <>
      {/* Header */}
      <Section spacing="tight" className="pt-20 sm:pt-28">
        <Container narrow className="text-center">
          <Reveal>
            <Eyebrow>Services</Eyebrow>
            <h1 className="mt-6 font-display text-4xl font-normal leading-[1.1] tracking-[0.04em] text-ink sm:text-5xl">
              THE WORK, THREE WAYS
            </h1>
            <p className="mx-auto mt-7 max-w-xl font-serif text-xl font-light italic leading-relaxed text-espresso sm:text-2xl">
              One film, scaled to the home. What changes between them is reach,
              finish, and how much of the grounds we cover — never the idea:
              show the home the way a buyer can&apos;t see it on foot.
            </p>
          </Reveal>
        </Container>
      </Section>

      {/* Pricing tiers */}
      <Section spacing="tight" className="pb-8">
        <Container>
          <div className="grid gap-px overflow-hidden border border-sand bg-sand md:grid-cols-3">
            {PACKAGES.map((pkg, i) => (
              <Reveal
                key={pkg.name}
                delay={i * 90}
                className={
                  pkg.featured
                    ? "relative flex flex-col bg-card p-9 sm:p-10"
                    : "relative flex flex-col bg-paper p-9 sm:p-10"
                }
              >
                {pkg.featured && (
                  <span className="absolute right-0 top-0 bg-champagne px-3 py-1.5 font-sans text-[0.625rem] uppercase tracking-[0.2em] text-ink">
                    Most chosen
                  </span>
                )}
                <h2 className="font-display text-xl tracking-[0.14em] text-ink">
                  {pkg.name.toUpperCase()}
                </h2>
                <p className="mt-4 min-h-[3.5rem] font-serif text-lg leading-snug text-espresso">
                  {pkg.tagline}
                </p>

                <div className="mt-6 flex items-baseline gap-2">
                  <span className="font-serif text-4xl text-ink">
                    ${pkg.price.toLocaleString("en-US")}
                  </span>
                  <span className="font-sans text-sm text-taupe">
                    {pkg.unit}
                  </span>
                </div>
                <p className="mt-1 font-sans text-xs uppercase tracking-[0.16em] text-champagne-dk">
                  Founding-client rate
                  {/* TODO: confirm pricing against the flyer */}
                </p>

                <ul className="mt-8 flex flex-col gap-3 border-t border-sand pt-8">
                  {pkg.features.map((f) => (
                    <li
                      key={f}
                      className="flex gap-3 font-sans text-sm leading-relaxed text-espresso/85"
                    >
                      <span aria-hidden className="mt-2 h-px w-3 shrink-0 bg-champagne" />
                      {f}
                    </li>
                  ))}
                </ul>

                <div className="mt-9 pt-2">
                  <Button
                    href="/contact"
                    variant={pkg.featured ? "solid" : "outline"}
                    className="w-full"
                  >
                    Inquire
                  </Button>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal>
            <p className="mt-8 text-center font-sans text-sm text-taupe">
              Introductory pricing for our founding partners. Travel within
              Phoenix, Mesa, and Scottsdale is included.
              {/* TODO: confirm travel policy */}
            </p>
          </Reveal>
        </Container>
      </Section>

      {/* Add-ons */}
      <Section tone="sand" spacing="normal">
        <Container>
          <Reveal className="text-center">
            <Eyebrow>Add-ons</Eyebrow>
            <h2 className="mt-5 font-display text-2xl font-normal tracking-[0.04em] text-ink sm:text-3xl">
              FINISH THE PACKAGE
            </h2>
          </Reveal>
          <div className="mx-auto mt-12 grid max-w-3xl grid-cols-1 gap-px overflow-hidden border border-paper/0 sm:grid-cols-2">
            {ADDONS.map((a, i) => (
              <Reveal
                key={a.name}
                delay={i * 70}
                className="flex items-baseline justify-between gap-6 border-b border-sand/70 bg-sand px-2 py-5"
              >
                <span className="font-serif text-lg text-ink">{a.name}</span>
                <span className="font-sans text-sm tracking-wide text-champagne-dk">
                  +${a.price}
                </span>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      {/* Process */}
      <Section spacing="normal">
        <Container>
          <Reveal className="text-center">
            <Eyebrow>How It Works</Eyebrow>
            <h2 className="mt-5 font-display text-2xl font-normal tracking-[0.04em] text-ink sm:text-3xl">
              FOUR STEPS
            </h2>
          </Reveal>
          <div className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {PROCESS.map((p, i) => (
              <Reveal key={p.step} delay={i * 80} className="text-center sm:text-left">
                <span className="font-display text-2xl text-champagne-dk">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-4 font-serif text-xl text-ink">{p.step}</h3>
                <p className="mt-2 font-sans text-sm leading-relaxed text-espresso/80">
                  {p.detail}
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
              {TAGLINES.winTheListing}
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
