"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Container } from "@/components/ui/container";

type Role = "video" | "still" | "telemetry" | "other";
type ProjectFile = {
  id: string;
  role: Role;
  filename: string | null;
  bytes: number | null;
  r2_key: string;
};
type Project = { id: string; slug: string; title: string; status: string };
type Job = { id: string; status: string; error: string | null };

const ROLE_LABEL: Record<Role, string> = {
  video: "360 video",
  still: "Stills",
  telemetry: "Positioning data",
  other: "Other",
};
const ROLE_ORDER: Role[] = ["video", "still", "telemetry", "other"];

const fmtBytes = (b: number | null) =>
  b == null ? "" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`;

export default function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/studio/api/projects/${slug}`, { credentials: "same-origin" });
    if (r.ok) {
      const d = (await r.json()) as { project: Project; files: ProjectFile[] };
      setProject(d.project);
      setFiles(d.files ?? []);
    }
  }, [slug]);
  useEffect(() => {
    void load();
  }, [load]);

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setErr(null);
    for (const file of Array.from(list)) {
      setUploading(file.name);
      try {
        const init = (await fetch(`/studio/api/projects/${slug}/upload`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type || undefined }),
        }).then((r) => r.json())) as { putUrl?: string; error?: string };
        if (!init.putUrl) throw new Error(init.error || "presign failed");
        const put = await fetch(init.putUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });
        if (!put.ok) throw new Error(`upload failed (${put.status})`);
      } catch (e) {
        setErr(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
      }
    }
    setUploading(null);
    void load();
  }

  function poll(id: string) {
    const t = setInterval(async () => {
      try {
        const d = (await fetch(`/studio/api/vslam/status?id=${id}`, {
          credentials: "same-origin",
        }).then((r) => r.json())) as { job: Job | null };
        if (d.job) {
          setJob(d.job);
          if (d.job.status === "ready" || d.job.status === "failed") {
            clearInterval(t);
            void load();
          }
        }
      } catch {
        /* keep polling */
      }
    }, 4000);
  }

  async function process() {
    setErr(null);
    const res = await fetch(`/studio/api/projects/${slug}/process`, {
      method: "POST",
      credentials: "same-origin",
    });
    const d = (await res.json()) as { jobId?: string; error?: string };
    if (!res.ok || !d.jobId) {
      setErr(d.error || "Couldn't start processing");
      return;
    }
    setJob({ id: d.jobId, status: "processing", error: null });
    poll(d.jobId);
  }

  // --- missing-files alerts (your "alert on missing files" for a 360 upload) ---
  const hasVideo = files.some((f) => f.role === "video");
  const hasTelem = files.some((f) => f.role === "telemetry");
  const hasStill = files.some((f) => f.role === "still");
  const alerts: { tone: "warn" | "info" | "note"; text: string }[] = [];
  if (!hasVideo)
    alerts.push({ tone: "info", text: "Add a 360 video — it's what gets processed into the map + floor." });
  if (hasVideo && !hasTelem)
    alerts.push({
      tone: "warn",
      text: "No positioning data (.SRT) for this video. Without it the GPS map and flight path can't be built, and VSLAM runs scale-free — add the drone's .SRT.",
    });
  if (hasVideo && !hasStill)
    alerts.push({ tone: "note", text: "No stills uploaded — 360 detail points will fall back to video frames." });

  const toneCls: Record<string, string> = {
    warn: "border-amber-400/40 bg-amber-400/[0.06] text-amber-200/90",
    info: "border-champagne/40 bg-champagne/[0.05] text-champagne",
    note: "border-paper/15 bg-paper/[0.02] text-paper/55",
  };

  const busy = job?.status === "processing";

  return (
    <Container className="max-w-3xl py-10 sm:py-14">
      <Link
        href="/studio/projects"
        className="font-sans text-xs uppercase tracking-[0.18em] text-paper/45 hover:text-champagne"
      >
        ← Projects
      </Link>

      <div className="mt-3 flex items-baseline justify-between gap-4">
        <h1 className="font-display text-3xl font-normal tracking-[0.04em] text-paper sm:text-4xl">
          {project?.title ?? slug}
        </h1>
        <span className="font-sans text-[0.7rem] uppercase tracking-[0.18em] text-paper/45">
          {project?.status ?? "…"}
        </span>
      </div>

      {alerts.length > 0 && (
        <div className="mt-6 space-y-2">
          {alerts.map((al, i) => (
            <div
              key={i}
              className={"rounded-md border px-4 py-2.5 font-sans text-xs leading-relaxed " + toneCls[al.tone]}
            >
              {al.text}
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 rounded-lg border border-paper/15 bg-paper/[0.02] p-6">
        <label className="block">
          <span className="font-sans text-xs uppercase tracking-[0.16em] text-paper/70">
            Upload files
          </span>
          <input
            type="file"
            multiple
            disabled={!!uploading}
            onChange={(e) => onFiles(e.target.files)}
            className="mt-2 block w-full font-sans text-sm text-paper/80 file:mr-4 file:rounded-full file:border file:border-paper/25 file:bg-transparent file:px-4 file:py-1.5 file:font-sans file:text-xs file:uppercase file:tracking-wide file:text-champagne hover:file:border-champagne disabled:opacity-50"
          />
          <span className="mt-1.5 block font-sans text-xs text-paper/40">
            360 video, stills, and the .SRT / GPS positioning data — drop them all in.
          </span>
        </label>
        {uploading ? (
          <p className="mt-3 font-sans text-xs text-champagne">Uploading {uploading}…</p>
        ) : null}
        {err ? <p className="mt-3 font-sans text-xs text-red-300/90">{err}</p> : null}

        {files.length > 0 && (
          <div className="mt-5 space-y-4 border-t border-paper/10 pt-5">
            {ROLE_ORDER.filter((role) => files.some((f) => f.role === role)).map((role) => (
              <div key={role}>
                <p className="font-sans text-[0.7rem] uppercase tracking-[0.18em] text-paper/40">
                  {ROLE_LABEL[role]}
                </p>
                <ul className="mt-1.5 space-y-1">
                  {files
                    .filter((f) => f.role === role)
                    .map((f) => (
                      <li key={f.id} className="flex justify-between font-sans text-sm text-paper/75">
                        <span className="truncate">{f.filename}</span>
                        <span className="ml-3 shrink-0 text-paper/35">{fmtBytes(f.bytes)}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={process}
          disabled={!hasVideo || busy}
          className="rounded-full border border-champagne/60 bg-champagne/[0.06] px-5 py-2 font-sans text-xs uppercase tracking-[0.16em] text-champagne transition-colors hover:bg-champagne/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Processing…" : "Process in cloud"}
        </button>
        <Link
          href={`/studio/plan?tour=${slug}`}
          className="rounded-full border border-paper/30 px-4 py-1.5 font-sans text-xs uppercase tracking-[0.16em] text-paper/70 transition-colors hover:border-champagne hover:text-champagne"
        >
          Edit floorplan →
        </Link>
      </div>
      {job ? (
        <p
          className={
            "mt-3 font-sans text-xs " +
            (job.status === "failed" ? "text-red-300/90" : "text-paper/55")
          }
        >
          {job.status === "processing"
            ? "Cloud VSLAM running — a few minutes."
            : job.status === "ready"
              ? "Floor saved as the live plan for this project."
              : job.status === "failed"
                ? `Failed: ${job.error ?? "unknown error"}`
                : job.status}
        </p>
      ) : null}
    </Container>
  );
}
