"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { StreamPlayer } from "@/components/stream/player";
import { Reveal } from "@/components/ui/reveal";
import type { Project } from "@/data/projects";
import { cn } from "@/lib/utils";

/**
 * Portfolio grid with an optional tier filter (client-side). Server renders the
 * full list for SEO; the filter is a progressive enhancement on top.
 */
export function WorkGrid({ projects }: { projects: Project[] }) {
  const filters = useMemo(
    () => ["All", ...Array.from(new Set(projects.map((p) => p.tier)))],
    [projects],
  );
  const [active, setActive] = useState("All");
  const shown =
    active === "All" ? projects : projects.filter((p) => p.tier === active);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setActive(f)}
            className={cn(
              "relative pb-1 font-sans text-xs uppercase tracking-[0.18em] transition-colors",
              active === f ? "text-ink" : "text-taupe hover:text-espresso",
            )}
          >
            {f}
            {active === f && (
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-px h-px bg-champagne"
              />
            )}
          </button>
        ))}
      </div>

      <div className="mt-14 grid gap-x-8 gap-y-14 md:grid-cols-2 lg:grid-cols-3">
        {shown.map((p, i) => (
          <Reveal key={p.slug} delay={(i % 3) * 90}>
            <Link href={`/work/${p.slug}`} className="group block">
              <StreamPlayer uid={p.streamUid} title={p.title} />
              <div className="mt-5 flex items-baseline justify-between gap-4">
                <h2 className="font-serif text-xl text-ink">{p.neighborhood}</h2>
                <span className="font-sans text-xs uppercase tracking-[0.16em] text-champagne-dk">
                  {p.priceTier}
                </span>
              </div>
              <p className="mt-1 font-sans text-sm text-taupe">{p.address}</p>
            </Link>
          </Reveal>
        ))}
      </div>
    </div>
  );
}
