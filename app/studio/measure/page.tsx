"use client";

import { useEffect, useState } from "react";
import { Container } from "@/components/ui/container";
import { MeasureSheet } from "@/components/studio/measure-sheet";

/**
 * /studio/measure — the laser measurement sheet. Pick a property whose
 * floorplan has been delivered; the sheet turns its walls into fillable
 * dimension lines (see components/studio/measure-sheet.tsx).
 */
export default function MeasurePage() {
  const [slugs, setSlugs] = useState<string[]>([]);
  const [slug, setSlug] = useState<string>("");

  useEffect(() => {
    // ?slug= deep link (read directly — avoids a Suspense boundary for useSearchParams)
    const q = new URLSearchParams(window.location.search).get("slug");
    if (q) setSlug(q);
    fetch("/studio/api/plans", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { slugs: [] }))
      .then((d: { slugs?: string[] }) => setSlugs(d.slugs ?? []))
      .catch(() => {});
  }, []);

  return (
    <Container className="max-w-6xl py-8 sm:py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-3xl font-normal tracking-[0.04em] text-paper">
          Measure
        </h1>
        <label className="flex items-center gap-2 font-sans text-xs text-paper/60">
          <span className="uppercase tracking-[0.16em]">Property</span>
          <select
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="rounded-md border border-paper/25 bg-ink px-2 py-1.5 text-sm text-paper/85 focus:border-champagne focus:outline-none"
          >
            <option value="">— pick a delivered plan —</option>
            {slugs.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 font-sans text-xs leading-relaxed text-paper/45">
        Every wall, diagonal, and curve the capture wants lasered, as tappable dimension
        lines. Values save live with the raw reading, decimal feet, and timestamp — and
        show their delta against the capture&apos;s locked prediction as you go.
      </p>
      <div className="mt-6">
        {slug ? (
          <MeasureSheet slug={slug} />
        ) : (
          <p className="font-sans text-sm text-paper/50">
            Pick a property above. A plan appears here after its capture is processed
            (Projects → Process in cloud).
          </p>
        )}
      </div>
    </Container>
  );
}
