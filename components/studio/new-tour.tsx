"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Tour } from "@/data/tours";
import { saveDoc } from "@/lib/author-client";
import { AssetPicker } from "@/components/studio/asset-picker";
import type { Asset } from "@/lib/library-client";
import { cn } from "@/lib/utils";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** Create a new (hidden) tour from a title + a 360 flight video, then jump
 *  straight into ring authoring. */
export function NewTour({ existingSlugs }: { existingSlugs: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [video, setVideo] = useState<Asset | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const slug = slugify(title);
  const taken = existingSlugs.includes(slug);
  const ready = Boolean(title.trim() && video?.url && slug && !taken);

  const create = async () => {
    if (!ready || !video?.url) return;
    setBusy(true);
    setErr("");
    const tour: Tour = {
      slug,
      title: title.trim(),
      chapters: [
        { id: "flight", label: "The Flight", video: { src: video.url }, startYaw: 180, hotspots: [] },
      ],
      panos: [],
      hidden: true,
    };
    try {
      await saveDoc("tour", slug, tour);
      router.push(`/studio/tours/${slug}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-champagne/50 px-4 py-2 font-sans text-xs uppercase tracking-[0.16em] text-champagne transition-colors hover:bg-champagne/10"
      >
        + New tour
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-champagne/30 bg-paper/[0.03] p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
          <span className="font-sans text-[0.65rem] uppercase tracking-[0.14em] text-paper/50">Title</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. The Vista Estate"
            className="rounded border border-paper/20 bg-ink/60 px-3 py-2 font-sans text-sm text-paper outline-none focus:border-champagne"
          />
        </label>
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="rounded border border-paper/25 px-3 py-2 font-sans text-xs uppercase tracking-[0.14em] text-paper/75 hover:border-champagne hover:text-champagne"
        >
          {video ? `Video: ${video.title}` : "Choose flight video"}
        </button>
        <button
          type="button"
          onClick={create}
          disabled={!ready || busy}
          className={cn(
            "rounded border border-champagne bg-champagne/90 px-4 py-2 font-sans text-xs font-semibold uppercase tracking-[0.14em] text-ink transition-colors hover:bg-champagne disabled:opacity-40",
          )}
        >
          {busy ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="font-sans text-xs uppercase tracking-[0.14em] text-paper/40 hover:text-paper"
        >
          Cancel
        </button>
      </div>
      <p className="mt-2 font-sans text-[0.68rem] text-paper/40">
        {taken
          ? `A tour “/${slug}” already exists — pick a different title.`
          : slug
            ? `Creates /studio/tours/${slug} (hidden).`
            : "Give it a title to generate its URL."}
      </p>
      {err && <p className="mt-1 font-sans text-xs text-red-400">{err}</p>}

      {picking && (
        <AssetPicker
          kind="video360"
          title="Choose the flight video"
          onPick={(a) => setVideo(a)}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
