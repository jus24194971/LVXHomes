import type { Metadata } from "next";
import { Container } from "@/components/ui/container";
import { EmbedManager } from "@/components/studio/embed-manager";
import { TOURS } from "@/data/tours";
import { getTourLive, listTourSlugs } from "@/lib/store";

export const metadata: Metadata = { title: "Embeds" };
export const dynamic = "force-dynamic";

/** One place to see and issue every embed code. Each tour (baked or
 *  cloud-published) gets its EmbedManager — create branded/unbranded codes,
 *  label them per agent/brokerage, revoke any time. Film embeds live on the
 *  Library's film cards. */
export default async function StudioEmbeds() {
  const liveSlugs = await listTourSlugs();
  const slugs = [
    ...liveSlugs,
    ...TOURS.map((t) => t.slug).filter((s) => !liveSlugs.includes(s)),
  ];
  const tours = (
    await Promise.all(
      slugs.map(async (s) => {
        const t = await getTourLive(s);
        return t ? { slug: s, title: t.title, location: t.location } : null;
      }),
    )
  ).filter((t): t is NonNullable<typeof t> => Boolean(t));

  return (
    <Container className="max-w-[1100px] py-10 sm:py-14">
      <p className="font-sans text-[0.7rem] uppercase tracking-[0.22em] text-champagne">
        Embeds · Permission-gated distribution
      </p>
      <h1 className="mt-3 font-display text-3xl font-normal tracking-[0.04em] text-paper sm:text-4xl">
        EMBED CODES
      </h1>
      <p className="mt-3 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/60">
        Every tour&apos;s embed grants in one place. Issue branded or unbranded
        codes, label them for the agent or brokerage they&apos;re going to, and
        revoke them the moment a listing closes — revoked iframes degrade
        gracefully wherever they were pasted. Film embeds are issued from their
        Library cards.
      </p>

      <div className="mt-10 flex flex-col gap-10">
        {tours.map((t) => (
          <section key={t.slug} className="rounded-lg border border-paper/15 p-5">
            <h2 className="font-display text-lg uppercase tracking-[0.1em] text-paper">
              {t.title}
            </h2>
            <p className="mt-0.5 font-sans text-xs text-paper/50">
              {t.location ? `${t.location} · ` : ""}
              /tours/{t.slug}
            </p>
            <div className="mt-4">
              <EmbedManager kind="tour" refId={t.slug} title={t.title} />
            </div>
          </section>
        ))}
      </div>
    </Container>
  );
}
