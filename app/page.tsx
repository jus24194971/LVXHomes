import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Reveal } from "@/components/ui/reveal";
import { Section } from "@/components/ui/section";
import { StreamHero, StreamPlayer } from "@/components/stream/player";
import { FEATURED } from "@/data/projects";
import { PACKAGES } from "@/data/packages";
import { TESTIMONIALS } from "@/data/testimonials";
import { HERO_STREAM_UID, streamConfigured } from "@/lib/stream";
import { SITE, TAGLINES } from "@/data/site";
import { JsonLd } from "@/components/seo/json-ld";

const DIFFERENCE = [
  {
    title: "Angles you can't walk",
    body: "Over the pool, through the great room, up the stair and out across the grounds — the home from vantage points a person on foot never reaches.",
  },
  {
    title: "The layout, understood",
    body: "Not a flat gallery, not a fifty-minute walkthrough — a short film that makes the true shape and flow of a home read in seconds.",
  },
  {
    title: "Made to stop the scroll",
    body: "Cut for how listings actually travel — vertical for social, wide for the portals, a glimpse that pulls a buyer in instead of talking over the house.",
  },
];

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const localBusiness = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "@id": `${SITE.url}/#business`,
  name: SITE.name,
  description: SITE.description,
  url: SITE.url,
  image: `${SITE.url}/opengraph-image`,
  email: SITE.email,
  areaServed: SITE.serviceAreas.map((city) => ({ "@type": "City", name: city })),
  sameAs: [
    SITE.social.instagram.url,
    SITE.social.youtube.url,
    SITE.social.tiktok.url,
  ],
  knowsAbout: "Real estate aerial videography, FPV drone cinematography",
};

export default function HomePage() {
  const hasVideo = streamConfigured();

  return (
    <>
      <JsonLd data={localBusiness} />

      {/* 1 — Hero */}
      <section className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-ink text-paper">
        <StreamHero uid={HERO_STREAM_UID} />
        {/* Scrim only over the film; the no-video crest stays warm and open. */}
        {hasVideo && (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, rgba(33,28,22,0.5) 0%, rgba(33,28,22,0.25) 40%, rgba(33,28,22,0.7) 100%)",
            }}
          />
        )}
        <Container className="relative text-center">
          {!hasVideo && (
            <div className="mb-10 flex flex-col items-center">
              <span
                className="font-display text-5xl leading-none tracking-[0.18em] text-champagne sm:text-6xl"
                style={{ paddingLeft: "0.18em" }}
              >
                LVX
              </span>
              <span aria-hidden className="mt-6 h-px w-20 bg-champagne/70" />
              <Eyebrow className="mt-6 text-champagne/90">
                Luxury Real Estate Cinematography · Arizona
              </Eyebrow>
            </div>
          )}
          <h1 className="mx-auto max-w-3xl font-display text-4xl font-normal leading-[1.1] tracking-[0.04em] text-paper sm:text-6xl">
            WIN THE LISTING
            <br />
            BEFORE YOU LIST IT
          </h1>
          {hasVideo && (
            <p className="mx-auto mt-7 max-w-xl font-serif text-xl italic text-paper/85 sm:text-2xl">
              {TAGLINES.becomesCinema}
            </p>
          )}
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

      {/* 2 — Intro statement */}
      <Section spacing="loose">
        <Container narrow className="text-center">
          <Reveal>
            <Eyebrow>What LVX Is</Eyebrow>
            <p className="mt-7 font-serif text-2xl font-light leading-relaxed text-espresso sm:text-[1.95rem] sm:leading-[1.5]">
              LVX films a home the way you can&apos;t see it on foot — over the
              water, through the great room, up the stair and out across the
              grounds. In one short film a buyer grasps how a home actually
              lives, and wants to be standing in it. Not a gallery, not a
              fifty-minute tour.
            </p>
          </Reveal>
        </Container>
      </Section>

      {/* 3 — The difference */}
      <Section tone="sand" spacing="normal">
        <Container>
          <Reveal>
            <Eyebrow>The Difference</Eyebrow>
            <h2 className="mt-5 max-w-2xl font-display text-3xl font-normal leading-tight tracking-[0.03em] text-ink sm:text-4xl">
              BEYOND PHOTOS. BEYOND THE TOUR.
            </h2>
          </Reveal>
          <div className="mt-14 grid gap-px overflow-hidden border border-sand bg-sand sm:grid-cols-3">
            {DIFFERENCE.map((d, i) => (
              <Reveal
                key={d.title}
                delay={i * 90}
                className="bg-paper p-8 sm:p-10"
              >
                <span className="font-display text-sm tracking-[0.2em] text-champagne-dk">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-5 font-serif text-2xl text-ink">{d.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-espresso/80">
                  {d.body}
                </p>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      {/* 4 — Featured work */}
      <Section dark spacing="loose">
        <Container>
          <Reveal className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <Eyebrow className="text-champagne">Selected Work</Eyebrow>
              <h2 className="mt-5 font-display text-3xl font-normal tracking-[0.03em] sm:text-4xl">
                RECENT FILMS
              </h2>
            </div>
            <Link
              href="/work"
              className="font-sans text-[0.8125rem] uppercase tracking-[0.18em] text-paper/70 transition-colors hover:text-champagne"
            >
              View all work →
            </Link>
          </Reveal>

          <div className="mt-12 grid gap-8 md:grid-cols-2 lg:grid-cols-3">
            {FEATURED.map((p, i) => (
              <Reveal key={p.slug} delay={i * 90}>
                <Link href={`/work/${p.slug}`} className="group block">
                  <StreamPlayer uid={p.streamUid} title={p.title} />
                  <div className="mt-5 flex items-baseline justify-between gap-4">
                    <h3 className="font-serif text-xl text-paper">
                      {p.neighborhood}
                    </h3>
                    <span className="font-sans text-xs uppercase tracking-[0.16em] text-champagne">
                      {p.priceTier}
                    </span>
                  </div>
                  <p className="mt-1 font-sans text-sm text-paper/55">
                    {p.address}
                  </p>
                </Link>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      {/* 5 — Packages teaser */}
      <Section spacing="normal">
        <Container>
          <Reveal className="text-center">
            <Eyebrow>The Work, Three Ways</Eyebrow>
            <h2 className="mt-5 font-display text-3xl font-normal tracking-[0.03em] text-ink sm:text-4xl">
              PACKAGES
            </h2>
          </Reveal>
          <div className="mt-12 grid gap-px overflow-hidden border border-sand bg-sand md:grid-cols-3">
            {PACKAGES.map((pkg, i) => (
              <Reveal
                key={pkg.name}
                delay={i * 90}
                className="flex flex-col bg-card p-8 sm:p-10"
              >
                <h3 className="font-display text-xl tracking-[0.14em] text-ink">
                  {pkg.name.toUpperCase()}
                </h3>
                <p className="mt-4 font-serif text-lg leading-snug text-espresso">
                  {pkg.tagline}
                </p>
                <p className="mt-6 font-sans text-sm text-taupe">
                  From{" "}
                  <span className="text-champagne-dk">${pkg.price}</span>{" "}
                  {pkg.unit}
                </p>
              </Reveal>
            ))}
          </div>
          <div className="mt-10 flex justify-center">
            <Button href="/services" variant="outline">
              See what&apos;s included
            </Button>
          </div>
        </Container>
      </Section>

      {/* 6 — Testimonials */}
      <Section tone="card" spacing="loose">
        <Container narrow>
          <Reveal className="text-center">
            <Eyebrow>From the Agents</Eyebrow>
          </Reveal>
          <div className="mt-12 flex flex-col gap-14">
            {TESTIMONIALS.map((t, i) => (
              <Reveal key={i} delay={i * 80} className="text-center">
                <blockquote className="font-serif text-2xl font-light italic leading-relaxed text-ink sm:text-3xl sm:leading-[1.45]">
                  “{t.quote}”
                </blockquote>
                <footer className="mt-6">
                  <p className="font-sans text-sm uppercase tracking-[0.16em] text-espresso">
                    {t.agent}
                  </p>
                  <p className="mt-1 font-sans text-sm text-taupe">
                    {t.brokerage} · {t.price} listing
                  </p>
                </footer>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      {/* 7 — CTA band */}
      <Section tone="ink" spacing="normal">
        <Container className="text-center">
          <Reveal>
            <h2 className="mx-auto max-w-2xl font-serif text-3xl font-light italic leading-tight text-paper sm:text-5xl sm:leading-[1.15]">
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
