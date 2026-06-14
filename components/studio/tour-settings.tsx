"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Tour } from "@/data/tours";
import { saveDoc } from "@/lib/author-client";
import { AssetPicker } from "@/components/studio/asset-picker";
import type { Asset } from "@/lib/library-client";
import { SITE } from "@/data/site";
import { cn } from "@/lib/utils";

const fileOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url.split("/").pop() || url;
  }
};
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** Tour metadata + asset assignment, saved to the live tour doc. Ring keyframes
 *  are edited in the viewer above; this panel owns everything else. */
export function TourSettings({ tour: initial }: { tour: Tour }) {
  const router = useRouter();
  const [tour, setTour] = useState<Tour>(initial);
  const [picking, setPicking] = useState<null | "video" | "pano">(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState<"link" | "iframe" | null>(null);

  const videoSrc = tour.chapters[0]?.video?.src ?? "";

  const setVideo = (url: string) =>
    setTour((t) => ({
      ...t,
      chapters: t.chapters.length
        ? t.chapters.map((c, i) => (i === 0 ? { ...c, video: { ...c.video, src: url } } : c))
        : [{ id: "flight", label: "The Flight", video: { src: url }, startYaw: 180, hotspots: [] }],
    }));

  const addPano = (a: Asset) => {
    if (!a.url) return;
    const base = slugify(a.title) || `pano-${tour.panos.length + 1}`;
    const taken = new Set(tour.panos.map((p) => p.id));
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    setTour((t) => ({ ...t, panos: [...t.panos, { id, label: a.title || "Pano", src: a.url as string }] }));
  };
  const removePano = (id: string) =>
    setTour((t) => ({ ...t, panos: t.panos.filter((p) => p.id !== id) }));
  const renamePano = (id: string, label: string) =>
    setTour((t) => ({ ...t, panos: t.panos.map((p) => (p.id === id ? { ...p, label } : p)) }));

  const save = async () => {
    setState("saving");
    setMsg("");
    try {
      await saveDoc("tour", tour.slug, tour);
      setState("saved");
      setTimeout(() => setState("idle"), 2000);
      router.refresh();
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : "Save failed");
    }
  };

  const embedUrl = `${SITE.url}/embed/${tour.slug}`;
  const iframeSnippet =
    `<div style="position:relative;width:100%;padding-bottom:56.25%">\n` +
    `  <iframe src="${embedUrl}" style="position:absolute;inset:0;width:100%;height:100%;border:0"\n` +
    `    allow="fullscreen; gyroscope; accelerometer" allowfullscreen loading="lazy"\n` +
    `    title="${tour.title} — 360 Tour"></iframe>\n` +
    `</div>`;
  const copy = async (text: string, key: "link" | "iframe") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const field =
    "w-full rounded border border-paper/20 bg-ink/60 px-3 py-2 font-sans text-sm text-paper outline-none focus:border-champagne";

  return (
    <section className="mt-8 rounded-lg border border-paper/15 bg-paper/[0.02] p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-display text-[0.7rem] uppercase tracking-[0.2em] text-champagne">
          Tour settings
        </p>
        <span className="font-mono text-[0.65rem] text-paper/35">/{tour.slug}</span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[0.65rem] uppercase tracking-[0.14em] text-paper/50">Title</span>
          <input
            className={field}
            value={tour.title}
            onChange={(e) => setTour((t) => ({ ...t, title: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[0.65rem] uppercase tracking-[0.14em] text-paper/50">Location</span>
          <input
            className={field}
            value={tour.location ?? ""}
            onChange={(e) => setTour((t) => ({ ...t, location: e.target.value || undefined }))}
          />
        </label>
      </div>

      {/* flight video */}
      <div className="mt-4">
        <span className="font-sans text-[0.65rem] uppercase tracking-[0.14em] text-paper/50">
          Flight video (360)
        </span>
        <div className="mt-1.5 flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-paper/70" title={videoSrc}>
            {videoSrc ? fileOf(videoSrc) : "— none —"}
          </span>
          <button
            type="button"
            onClick={() => setPicking("video")}
            className="shrink-0 rounded border border-champagne/50 px-3 py-1.5 font-sans text-[0.7rem] uppercase tracking-[0.14em] text-champagne hover:bg-champagne/10"
          >
            {videoSrc ? "Change" : "Choose"}
          </button>
        </div>
      </div>

      {/* panos */}
      <div className="mt-5">
        <div className="flex items-center justify-between">
          <span className="font-sans text-[0.65rem] uppercase tracking-[0.14em] text-paper/50">
            Panos ({tour.panos.length})
          </span>
          <button
            type="button"
            onClick={() => setPicking("pano")}
            className="rounded border border-paper/25 px-2.5 py-1 font-sans text-[0.7rem] uppercase tracking-[0.12em] text-paper/70 hover:border-champagne hover:text-champagne"
          >
            + Add pano
          </button>
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {tour.panos.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded border border-paper/15 p-2">
              <input
                value={p.label}
                onChange={(e) => renamePano(p.id, e.target.value)}
                className="min-w-0 flex-1 bg-transparent font-sans text-sm text-paper outline-none"
              />
              <span className="font-mono text-[0.62rem] text-paper/35">{p.id}</span>
              <button
                type="button"
                onClick={() => removePano(p.id)}
                aria-label="Remove pano"
                className="text-paper/40 hover:text-red-400"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* footer */}
      <div className="mt-5 flex items-center gap-4 border-t border-paper/10 pt-4">
        <label className="flex items-center gap-2 font-sans text-xs text-paper/60">
          <input
            type="checkbox"
            checked={tour.hidden ?? false}
            onChange={(e) => setTour((t) => ({ ...t, hidden: e.target.checked }))}
            className="accent-champagne"
          />
          Hidden (unlisted)
        </label>
        <div className="ml-auto flex items-center gap-3">
          {state === "error" && <span className="font-sans text-xs text-red-400">{msg}</span>}
          <button
            type="button"
            onClick={save}
            disabled={state === "saving"}
            className={cn(
              "rounded border border-champagne bg-champagne/90 px-4 py-2 font-sans text-xs font-semibold uppercase tracking-[0.14em] text-ink transition-colors hover:bg-champagne disabled:opacity-40",
            )}
          >
            {state === "saving" ? "Saving…" : state === "saved" ? "Saved ✓" : "Save settings"}
          </button>
        </div>
      </div>

      {/* share & embed */}
      <div className="mt-5 border-t border-paper/10 pt-4">
        <p className="font-display text-[0.7rem] uppercase tracking-[0.2em] text-champagne">
          Share &amp; embed
        </p>
        <p className="mt-1.5 font-sans text-[0.7rem] leading-relaxed text-paper/45">
          Give an agent the link (works as an MLS virtual-tour URL) or the iframe
          to drop on their own listing page — the tour plays in their page, no
          redirect to your site.
        </p>

        <label className="mt-3 block">
          <span className="font-sans text-[0.62rem] uppercase tracking-[0.14em] text-paper/50">
            Direct link
          </span>
          <div className="mt-1 flex gap-2">
            <input
              readOnly
              value={embedUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded border border-paper/20 bg-ink/60 px-2 py-1.5 font-mono text-xs text-paper/80 outline-none"
            />
            <button
              type="button"
              onClick={() => copy(embedUrl, "link")}
              className="shrink-0 rounded border border-champagne/50 px-3 py-1.5 font-sans text-[0.7rem] uppercase tracking-[0.12em] text-champagne hover:bg-champagne/10"
            >
              {copied === "link" ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </label>

        <div className="mt-3">
          <span className="font-sans text-[0.62rem] uppercase tracking-[0.14em] text-paper/50">
            Embed code (responsive)
          </span>
          <textarea
            readOnly
            rows={4}
            value={iframeSnippet}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-1 w-full rounded border border-paper/20 bg-ink/60 p-2 font-mono text-[0.68rem] leading-relaxed text-paper/80 outline-none"
          />
          <div className="mt-1.5 flex items-center gap-4">
            <button
              type="button"
              onClick={() => copy(iframeSnippet, "iframe")}
              className="rounded border border-champagne/50 px-3 py-1.5 font-sans text-[0.7rem] uppercase tracking-[0.12em] text-champagne hover:bg-champagne/10"
            >
              {copied === "iframe" ? "Copied ✓" : "Copy embed code"}
            </button>
            <a
              href={embedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-sans text-[0.7rem] uppercase tracking-[0.12em] text-paper/50 transition-colors hover:text-champagne"
            >
              Preview ↗
            </a>
          </div>
        </div>
      </div>

      {picking === "video" && (
        <AssetPicker
          kind="video360"
          title="Choose the flight video"
          onPick={(a) => a.url && setVideo(a.url)}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === "pano" && (
        <AssetPicker
          kind="pano"
          title="Add a pano"
          onPick={addPano}
          onClose={() => setPicking(null)}
        />
      )}
    </section>
  );
}
