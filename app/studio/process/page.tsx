"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Container } from "@/components/ui/container";
import { TOURS } from "@/data/tours";
import { uploadR2 } from "@/lib/library-client";

type Phase = "idle" | "uploading" | "starting" | "processing" | "ready" | "failed";

type Job = {
  id: string;
  slug: string;
  status: "queued" | "processing" | "ready" | "failed";
  plan_key: string | null;
  base_key: string | null;
  error: string | null;
};

const STEPS: { key: Phase; label: string }[] = [
  { key: "uploading", label: "Upload to R2" },
  { key: "processing", label: "VSLAM + floor (cloud)" },
  { key: "ready", label: "Plan saved" },
];

export default function ProcessPage() {
  const [file, setFile] = useState<File | null>(null);
  const [slug, setSlug] = useState("");
  const [scale, setScale] = useState("1");
  const [phase, setPhase] = useState<Phase>("idle");
  const [pct, setPct] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll status while a job is in flight.
  useEffect(() => {
    if (!jobId) return;
    const stop = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    const tick = async () => {
      try {
        const res = await fetch(`/studio/api/vslam/status?id=${jobId}`, {
          credentials: "same-origin",
        });
        const data = (await res.json()) as { job: Job | null };
        if (data.job) {
          setJob(data.job);
          if (data.job.status === "ready") {
            setPhase("ready");
            stop();
          } else if (data.job.status === "failed") {
            setErr(data.job.error || "Processing failed.");
            setPhase("failed");
            stop();
          }
        }
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    pollRef.current = setInterval(() => void tick(), 4000);
    return stop;
  }, [jobId]);

  const busy = phase === "uploading" || phase === "starting" || phase === "processing";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!file) return setErr("Choose a 360 video first.");
    const s = slug.trim();
    if (!s) return setErr("Enter the tour slug this floor belongs to.");
    try {
      setPhase("uploading");
      setPct(0);
      const asset = await uploadR2(file, file.name, "video360", setPct);
      if (!asset.r2_key) throw new Error("Upload finished but no R2 key came back.");
      setPhase("starting");
      const res = await fetch("/studio/api/vslam/start", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: s, r2_key: asset.r2_key, scale: Number(scale) || 1 }),
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) throw new Error(data.error || "Could not start the job.");
      setJobId(data.jobId);
      setPhase("processing");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Something went wrong.");
      setPhase("failed");
    }
  }

  function reset() {
    setFile(null);
    setSlug("");
    setScale("1");
    setPhase("idle");
    setPct(0);
    setJobId(null);
    setJob(null);
    setErr(null);
  }

  const stepState = (k: Phase): "done" | "active" | "todo" => {
    const order: Phase[] = ["uploading", "processing", "ready"];
    const cur =
      phase === "starting" ? "uploading" : phase === "failed" ? "uploading" : phase;
    const ci = order.indexOf(cur as Phase);
    const ki = order.indexOf(k);
    if (phase === "ready") return "done";
    if (ki < ci) return "done";
    if (ki === ci && busy) return "active";
    return "todo";
  };

  return (
    <Container className="max-w-3xl py-10 sm:py-14">
      <p className="font-sans text-[0.7rem] uppercase tracking-[0.22em] text-champagne">
        LVX Labs · Cloud pipeline
      </p>
      <h1 className="mt-3 font-display text-3xl font-normal tracking-[0.04em] text-paper sm:text-4xl">
        PROCESS
      </h1>
      <p className="mt-3 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/60">
        Drop a free-flight 360 video and it&apos;s processed in the cloud — VSLAM
        reconstructs the interior, the top-down floor base is built, and the plan
        saves straight to the live site for that tour. No local GPU.
      </p>

      <form
        onSubmit={onSubmit}
        className="mt-10 space-y-6 rounded-lg border border-paper/15 bg-paper/[0.02] p-6"
      >
        <label className="block">
          <span className="font-sans text-xs uppercase tracking-[0.16em] text-paper/70">
            360 video
          </span>
          <input
            type="file"
            accept="video/*"
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-2 block w-full font-sans text-sm text-paper/80 file:mr-4 file:rounded-full file:border file:border-paper/25 file:bg-transparent file:px-4 file:py-1.5 file:font-sans file:text-xs file:uppercase file:tracking-wide file:text-champagne hover:file:border-champagne disabled:opacity-50"
          />
          {file ? (
            <span className="mt-1.5 block font-sans text-xs text-paper/45">
              {file.name} · {(file.size / 1e6).toFixed(0)} MB
            </span>
          ) : null}
        </label>

        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block">
            <span className="font-sans text-xs uppercase tracking-[0.16em] text-paper/70">
              Tour slug
            </span>
            <input
              list="tour-slugs"
              value={slug}
              disabled={busy}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="apartment-1112"
              className="mt-2 block w-full rounded-md border border-paper/20 bg-paper/[0.03] px-3 py-2 font-sans text-sm text-paper placeholder:text-paper/30 focus:border-champagne focus:outline-none disabled:opacity-50"
            />
            <datalist id="tour-slugs">
              {TOURS.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.title}
                </option>
              ))}
            </datalist>
            <span className="mt-1.5 block font-sans text-xs text-paper/45">
              The floor binds to this tour&apos;s plan.
            </span>
          </label>

          <label className="block">
            <span className="font-sans text-xs uppercase tracking-[0.16em] text-paper/70">
              Scale <span className="text-paper/35">(m/unit)</span>
            </span>
            <input
              type="number"
              step="any"
              min="0"
              value={scale}
              disabled={busy}
              onChange={(e) => setScale(e.target.value)}
              className="mt-2 block w-full rounded-md border border-paper/20 bg-paper/[0.03] px-3 py-2 font-sans text-sm text-paper focus:border-champagne focus:outline-none disabled:opacity-50"
            />
            <span className="mt-1.5 block font-sans text-xs text-paper/45">
              Leave 1 to just see the shape; calibrate later in the editor.
            </span>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-full border border-champagne/60 bg-champagne/[0.06] px-5 py-2 font-sans text-xs uppercase tracking-[0.16em] text-champagne transition-colors hover:bg-champagne/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Working…" : "Process in cloud"}
          </button>
          {(phase === "ready" || phase === "failed") && (
            <button
              type="button"
              onClick={reset}
              className="font-sans text-xs uppercase tracking-[0.16em] text-paper/50 hover:text-paper"
            >
              New run
            </button>
          )}
        </div>

        {phase === "uploading" && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-paper/10">
            <div
              className="h-full bg-champagne transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        {err ? (
          <p className="font-sans text-xs leading-relaxed text-red-300/90">{err}</p>
        ) : null}
      </form>

      {(busy || phase === "ready") && (
        <div className="mt-6 rounded-lg border border-paper/15 bg-paper/[0.02] p-6">
          <ol className="space-y-3">
            {STEPS.map((st) => {
              const s = stepState(st.key);
              return (
                <li key={st.key} className="flex items-center gap-3">
                  <span
                    className={
                      "flex h-5 w-5 items-center justify-center rounded-full border text-[0.6rem] " +
                      (s === "done"
                        ? "border-champagne bg-champagne/20 text-champagne"
                        : s === "active"
                          ? "border-champagne text-champagne"
                          : "border-paper/25 text-paper/30")
                    }
                    aria-hidden
                  >
                    {s === "done" ? "✓" : s === "active" ? "•" : ""}
                  </span>
                  <span
                    className={
                      "font-sans text-sm " +
                      (s === "todo" ? "text-paper/40" : "text-paper/80")
                    }
                  >
                    {st.label}
                    {st.key === "processing" && s === "active" ? (
                      <span className="text-paper/40"> · a few minutes</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>

          {phase === "ready" && job ? (
            <div className="mt-5 border-t border-paper/10 pt-5">
              <p className="font-sans text-sm text-paper/80">
                Floor saved as the live plan for{" "}
                <span className="text-champagne">{job.slug}</span>.
              </p>
              <Link
                href="/studio/plan"
                className="mt-3 inline-block rounded-full border border-champagne/60 px-4 py-1.5 font-sans text-xs uppercase tracking-[0.16em] text-champagne hover:bg-champagne/[0.1]"
              >
                Open in Floorplan Studio →
              </Link>
            </div>
          ) : null}
        </div>
      )}
    </Container>
  );
}
