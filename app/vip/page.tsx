import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Reveal } from "@/components/ui/reveal";
import { Section } from "@/components/ui/section";
import { StreamHero } from "@/components/stream/player";
import { PACKAGES_BY_NAME } from "@/data/packages";
import { TAGLINES } from "@/data/site";
import { HERO_STREAM_UID } from "@/lib/stream";

export const metadata: Metadata = {
  title: "VIP — The Estate Film",
  alternates: { canonical: "/vip" },
  description:
    "For $1M–$2M+ listings. The Estate film, by application — the most cinematic marketing an Arizona luxury agent can hand a seller.",
};

export default function VipPage() {
  const estate = PACKAGES_BY_NAME.Estate;

  return (
    <>
      {/* Hero */}
      <section className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-ink text-paper">
        <StreamHero uid={HERO_STREAM_UID} />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(20,16,12,0.6) 0%, rgba(20,16,12,0.35) 40%, rgba(20,16,12,0.8) 100%)",
          }}
        />
        <Container className="relative text-center">
          <Eyebrow className="text-champagne">
            By Application · Select Listings
          </Eyebrow>
          <h1 className="mx-auto mt-6 max-w-3xl font-display text-4xl font-normal leading-[1.1] tracking-[0.05em] sm:text-6xl">
            THE ESTATE FILM
          </h1>
          <p className="mx-auto mt-7 max-w-xl font-serif text-xl font-light italic text-paper/85 sm:text-2xl">
            {TAGLINES.deserveMore}
          </p>
          <div className="mt-10 flex justify-center">
            <Button href="/contact" variant="light">
              Inquire
            </Button>
          </div>
        </Container>
        <div aria-hidden className="absolute bottom-8 left-1/2 -translate-x-1/2">
          <span className="block h-10 w-px bg-paper/30" />
        </div>
      </section>

      {/* Statement */}
      <Section tone="ink" spacing="loose">
        <Container narrow className="text-center">
          <Reveal>
            <p className="font-serif text-2xl font-light italic leading-relaxed text-paper/85 sm:text-[1.95rem] sm:leading-[1.5]">
              A handful of homes each year carry their own gravity. The Estate
              film is reserved for them — the listings where the marketing has to
              be as considered as the architecture.
            </p>
          </Reveal>
        </Container>
      </Section>

      {/* Estate package */}
      <Section tone="espresso" spacing="normal">
        <Container narrow>
          <Reveal className="text-center">
            <Eyebrow className="text-champagne">The Estate Package</Eyebrow>
            <div className="mt-6 flex items-baseline justify-center gap-2">
              <span className="font-serif text-5xl text-paper">
                ${estate.price.toLocaleString("en-US")}
              </span>
              <span className="font-sans text-sm text-paper/60">
                {estate.unit}
              </span>
            </div>
            <p className="mt-2 font-sans text-xs uppercase tracking-[0.18em] text-champagne">
              Founding-client rate {/* TODO: confirm pricing */}
            </p>
          </Reveal>

          <ul className="mx-auto mt-12 flex max-w-md flex-col gap-4 border-t border-paper/15 pt-10">
            {estate.features.map((f, i) => (
              <Reveal
                key={f}
                delay={i * 60}
                className="flex gap-3 font-sans text-base font-light leading-relaxed text-paper/85"
              >
                <span aria-hidden className="mt-2.5 h-px w-4 shrink-0 bg-champagne" />
                {f}
              </Reveal>
            ))}
          </ul>

          <Reveal className="mt-14 text-center">
            <Button href="/contact" variant="light">
              Begin an inquiry
            </Button>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
