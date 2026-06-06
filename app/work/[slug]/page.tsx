import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StreamPlayer } from "@/components/stream/player";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Section } from "@/components/ui/section";
import { getProject, PROJECTS } from "@/data/projects";
import { CF_STREAM_CUSTOMER_CODE, streamPoster } from "@/lib/stream";
import { JsonLd } from "@/components/seo/json-ld";

export function generateStaticParams() {
  return PROJECTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const p = getProject(slug);
  if (!p) return { title: "Work" };
  return {
    title: p.title,
    description: `A cinematic aerial film of a ${p.neighborhood}, Arizona listing by LVX Homes — the home from angles you can't walk to.`,
    alternates: { canonical: `/work/${slug}` },
  };
}

export default async function WorkDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) notFound();

  const i = PROJECTS.findIndex((p) => p.slug === slug);
  const len = PROJECTS.length;
  const prev = PROJECTS[(i - 1 + len) % len];
  const next = PROJECTS[(i + 1) % len];

  const residence = [
    project.beds ? `${project.beds} bd` : null,
    project.baths ? `${project.baths} ba` : null,
    project.sqft ? `${project.sqft.toLocaleString("en-US")} sqft` : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  const meta: { label: string; value: string }[] = [
    { label: "Residence", value: residence || "—" },
    { label: "Neighborhood", value: project.neighborhood },
    { label: "Price", value: project.price },
    { label: "Listing agent", value: project.agent },
    { label: "Brokerage", value: project.brokerage },
    { label: "Package", value: project.tier },
  ];

  const videoSchema = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: project.title,
    description: `A cinematic aerial film of a ${project.neighborhood}, Arizona listing by LVX Homes.`,
    thumbnailUrl: [streamPoster(project.streamUid)],
    uploadDate: "2026-01-01", // TODO: real per-film upload date
    embedUrl: `https://customer-${CF_STREAM_CUSTOMER_CODE || "PLACEHOLDER"}.cloudflarestream.com/${project.streamUid}/iframe`,
  };

  return (
    <>
      <JsonLd data={videoSchema} />
      <Section spacing="tight" className="pt-20 sm:pt-24">
        <Container>
          <Link
            href="/work"
            className="font-sans text-xs uppercase tracking-[0.18em] text-taupe transition-colors hover:text-champagne-dk"
          >
            ← All work
          </Link>
          <div className="mt-8">
            <Eyebrow>
              {project.tier} · {project.neighborhood}
            </Eyebrow>
            <h1 className="mt-5 font-display text-3xl font-normal leading-tight tracking-[0.03em] text-ink sm:text-5xl">
              {project.title}
            </h1>
            <p className="mt-4 font-sans text-sm text-taupe">{project.address}</p>
          </div>
        </Container>
      </Section>

      {/* Player on a dark band so the film reads cinematically */}
      <Section dark spacing="tight">
        <Container>
          <StreamPlayer uid={project.streamUid} title={project.title} />
        </Container>
      </Section>

      <Section spacing="normal">
        <Container narrow>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-8 border-y border-sand py-10 sm:grid-cols-3">
            {meta.map((m) => (
              <div key={m.label}>
                <dt className="font-sans text-[0.625rem] uppercase tracking-[0.22em] text-taupe">
                  {m.label}
                </dt>
                <dd className="mt-2 font-serif text-lg text-ink">{m.value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-12">
            <Eyebrow>On the Shoot</Eyebrow>
            <p className="mt-5 font-serif text-2xl font-light leading-relaxed text-espresso sm:text-[1.7rem] sm:leading-[1.5]">
              {project.note}
            </p>
          </div>
        </Container>
      </Section>

      {/* Prev / next */}
      <Section tone="sand" spacing="tight">
        <Container>
          <nav
            aria-label="More work"
            className="flex items-center justify-between gap-4 font-sans text-xs uppercase tracking-[0.16em]"
          >
            <Link
              href={`/work/${prev.slug}`}
              className="text-espresso transition-colors hover:text-champagne-dk"
            >
              ← {prev.neighborhood}
            </Link>
            <Link
              href="/work"
              className="text-taupe transition-colors hover:text-champagne-dk"
            >
              All
            </Link>
            <Link
              href={`/work/${next.slug}`}
              className="text-espresso transition-colors hover:text-champagne-dk"
            >
              {next.neighborhood} →
            </Link>
          </nav>
        </Container>
      </Section>
    </>
  );
}
