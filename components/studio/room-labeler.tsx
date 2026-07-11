"use client";

import { useState } from "react";

/** Lab: tap-to-label any render. Drop a dot on each room, name it, copy the
 *  JSON out (normalized coords, so labels survive any resize of the image).
 *  The human half of the registration loop: room identity is owner knowledge. */

type Dot = { x: number; y: number; label: string };

const DEFAULT_IMG = "https://media.lvxhomes.com/ortho/apartment-1112_splat.jpg";

export function RoomLabeler() {
  const [imgUrl, setImgUrl] = useState(DEFAULT_IMG);
  const [dots, setDots] = useState<Dot[]>([]);
  const [copied, setCopied] = useState(false);

  const addDot = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const label = window.prompt("Room / area name (blank to cancel):");
    if (!label) return;
    setDots((d) => [...d, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, label }]);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify({ image: imgUrl, dots }, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={imgUrl}
          onChange={(e) => { setImgUrl(e.target.value); setDots([]); }}
          className="w-full max-w-xl rounded border border-paper/20 bg-transparent px-3 py-2 font-sans text-xs text-paper/80"
          placeholder="image URL to label"
        />
        <button
          type="button"
          onClick={copy}
          disabled={dots.length === 0}
          className="rounded-full border border-champagne/60 px-5 py-2 font-sans text-[0.7rem] uppercase tracking-[0.16em] text-champagne hover:bg-champagne/10 disabled:opacity-40"
        >
          {copied ? "Copied ✓" : `Copy JSON (${dots.length})`}
        </button>
        <button
          type="button"
          onClick={() => setDots([])}
          disabled={dots.length === 0}
          className="rounded-full border border-paper/30 px-5 py-2 font-sans text-[0.7rem] uppercase tracking-[0.16em] text-paper/60 hover:text-paper disabled:opacity-40"
        >
          Clear
        </button>
      </div>
      <p className="mt-3 font-sans text-xs text-paper/50">
        Tap the center of each room → name it. Tap a dot to remove it. Copy JSON and paste it to Claude.
      </p>

      <div className="relative mt-4 inline-block cursor-crosshair select-none" onClick={addDot}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imgUrl} alt="render to label" className="block max-w-full" draggable={false} />
        {dots.map((d, i) => (
          <button
            key={i}
            type="button"
            onClick={(e) => { e.stopPropagation(); setDots((ds) => ds.filter((_, j) => j !== i)); }}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${d.x * 100}%`, top: `${d.y * 100}%` }}
            title="tap to remove"
          >
            <span className="block h-4 w-4 rounded-full border-2 border-ink bg-champagne shadow" />
            <span className="absolute left-5 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-ink/90 px-2 py-0.5 font-sans text-xs text-champagne">
              {d.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
