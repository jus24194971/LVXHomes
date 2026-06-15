import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/ui/container";
import { TOURS } from "@/data/tours";

export const metadata: Metadata = { title: "Dashboard" };

const TILES = [
  { href: "/studio/projects", glyph: "▤", title: "Projects", desc: "A folder per shoot — upload everything, process to a tour." },
  { href: "/studio/tours", glyph: "◎", title: "Tours & Rings", desc: "Keyframe the gold flight rings on each 360 tour." },
  { href: "/studio/plan", glyph: "▦", title: "Floorplans", desc: "Draw and edit the schematic plans + dot paths." },
  { href: "/studio/pins", glyph: "⌖", title: "Pins", desc: "Map where rooms live on flat (non-360) films." },
  { href: "/studio/process", glyph: "⬡", title: "Process", desc: "Upload a free-flight 360 → cloud VSLAM floor plan." },
  { href: "/studio/render", glyph: "❖", title: "Render", desc: "Transcode + prep captures for delivery." },
];

export default function StudioHome() {
  return (
    <Container className="max-w-[1400px] py-10 sm:py-14">
      <p className="font-sans text-[0.7rem] uppercase tracking-[0.22em] text-champagne">
        LVX Labs · Back office
      </p>
      <h1 className="mt-3 font-display text-3xl font-normal tracking-[0.04em] text-paper sm:text-4xl">
        STUDIO
      </h1>
      <p className="mt-3 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/60">
        Everything authoring lives here. Edits save straight to the live site
        behind Zero Trust; reads fall back to the baked data until you save.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="group rounded-lg border border-paper/15 bg-paper/[0.02] p-5 transition-colors hover:border-champagne/50 hover:bg-champagne/[0.04]"
          >
            <span className="text-2xl text-champagne" aria-hidden>
              {t.glyph}
            </span>
            <p className="mt-3 font-display text-base uppercase tracking-[0.12em] text-paper">
              {t.title}
            </p>
            <p className="mt-1.5 font-sans text-xs leading-relaxed text-paper/55">
              {t.desc}
            </p>
          </Link>
        ))}
      </div>

      <div className="mt-12">
        <p className="font-sans text-[0.7rem] uppercase tracking-[0.2em] text-paper/40">
          Jump to a tour
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {TOURS.map((t) => (
            <Link
              key={t.slug}
              href={`/studio/tours/${t.slug}`}
              className="rounded-full border border-paper/20 px-3 py-1.5 font-sans text-xs tracking-wide text-paper/70 transition-colors hover:border-champagne hover:text-champagne"
            >
              {t.title}
              {t.hidden ? <span className="text-paper/35"> · hidden</span> : null}
            </Link>
          ))}
        </div>
      </div>
    </Container>
  );
}
