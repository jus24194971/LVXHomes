"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** One detected item from the Modal scene-ingest endpoint. */
type IngestItem = {
  label: string;
  score: number;
  box: number[];
  dims_in: [number, number, number];
  z_mean_m: number;
  conf: string[];
  why: string[];
  prior_flag: string;
  suggest: string | null;
};

type IngestResult = {
  items: IngestItem[];
  camera_height_in: number;
  fpx: number;
  overlay_b64: string;
};

const inches = (v: number) => {
  const ft = Math.floor(v / 12);
  const rem = Math.round(v - ft * 12);
  return ft > 0 ? `${ft}'${rem}"` : `${Math.round(v * 10) / 10}"`;
};

const confPill = (c: string) =>
  cn(
    "rounded-full px-2 py-0.5 text-[0.6rem] uppercase tracking-[0.12em]",
    c === "high" && "bg-emerald-400/15 text-emerald-300",
    c === "medium" && "bg-amber-400/15 text-amber-300",
    c === "low" && "bg-red-400/15 text-red-300",
  );

export function IngestLab() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const analyze = async (file: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setFileName(file.name);
    try {
      const res = await fetch("/studio/api/ingest", {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      const data = (await res.json()) as IngestResult & { error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? `ingest failed (${res.status})`);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void analyze(f);
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="rounded-full border border-champagne/60 px-6 py-2.5 font-sans text-[0.75rem] uppercase tracking-[0.18em] text-champagne transition-colors hover:bg-champagne/10 disabled:opacity-40"
        >
          {busy ? "Analyzing…" : "Photograph / upload a room"}
        </button>
        {busy && (
          <span className="font-sans text-xs text-paper/50">
            {fileName} — cold GPU start can take ~a minute; warm runs are seconds.
          </span>
        )}
        {error && (
          <span className="font-sans text-xs text-red-400">
            {error} — if this was a cold start timeout, try again.
          </span>
        )}
      </div>

      {result && (
        <div className="mt-8 grid gap-8 lg:grid-cols-[3fr_2fr]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.overlay_b64}
            alt="Detected furniture with dimensions"
            className="w-full border border-paper/15"
          />
          <div>
            <p className="font-sans text-xs uppercase tracking-[0.16em] text-paper/40">
              camera height {inches(result.camera_height_in)} · fx {result.fpx}px
            </p>
            <ul className="mt-4 space-y-4">
              {result.items.map((it, i) => (
                <li key={i} className="border-b border-paper/10 pb-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-sans text-sm capitalize text-paper">{it.label}</span>
                    <span className="font-sans text-sm tabular-nums text-champagne">
                      {inches(it.dims_in[0])} × {inches(it.dims_in[1])} × {inches(it.dims_in[2])}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {it.conf.map((c, k) => (
                      <span key={k} className={confPill(c)}>
                        {k === 0 ? "len" : "wid"} {c}
                      </span>
                    ))}
                    <span className="font-sans text-[0.65rem] text-paper/40">
                      {it.z_mean_m}m away
                    </span>
                  </div>
                  {it.suggest && (
                    <p className="mt-1.5 font-sans text-xs leading-relaxed text-amber-300/80">
                      → {it.suggest}
                    </p>
                  )}
                  {it.prior_flag && (
                    <p className="mt-1 font-sans text-[0.65rem] text-paper/40">{it.prior_flag}</p>
                  )}
                </li>
              ))}
              {result.items.length === 0 && (
                <li className="font-sans text-sm text-paper/50">
                  No furniture detected — try a wider shot with the floor in frame.
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
