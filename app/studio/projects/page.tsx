"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Container } from "@/components/ui/container";

type Project = {
  id: string;
  slug: string;
  title: string;
  status: string;
  created_at: number;
};

const STATUS_TONE: Record<string, string> = {
  draft: "text-paper/45",
  processing: "text-champagne",
  review: "text-champagne",
  published: "text-emerald-300/80",
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/studio/api/projects", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => {});
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!title.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/studio/api/projects", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const d = (await res.json()) as { project?: { slug: string }; error?: string };
      if (!res.ok || !d.project) throw new Error(d.error || "Couldn't create the project");
      router.push(`/studio/projects/${d.project.slug}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "failed");
      setBusy(false);
    }
  }

  return (
    <Container className="max-w-4xl py-10 sm:py-14">
      <p className="font-sans text-[0.7rem] uppercase tracking-[0.22em] text-champagne">
        LVX Labs · Capture
      </p>
      <h1 className="mt-3 font-display text-3xl font-normal tracking-[0.04em] text-paper sm:text-4xl">
        PROJECTS
      </h1>
      <p className="mt-3 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/60">
        One folder per shoot. Upload everything — 360 video, stills, and the
        positioning data — then process it into a map, floor plan, and tour.
      </p>

      <form
        onSubmit={create}
        className="mt-8 flex flex-wrap items-end gap-3 rounded-lg border border-paper/15 bg-paper/[0.02] p-5"
      >
        <label className="flex-1 min-w-[220px]">
          <span className="font-sans text-xs uppercase tracking-[0.16em] text-paper/70">
            New project
          </span>
          <input
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. 4678 E Palais Place"
            className="mt-2 block w-full rounded-md border border-paper/20 bg-paper/[0.03] px-3 py-2 font-sans text-sm text-paper placeholder:text-paper/30 focus:border-champagne focus:outline-none disabled:opacity-50"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded-full border border-champagne/60 bg-champagne/[0.06] px-5 py-2 font-sans text-xs uppercase tracking-[0.16em] text-champagne transition-colors hover:bg-champagne/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create"}
        </button>
        {err ? <p className="w-full font-sans text-xs text-red-300/90">{err}</p> : null}
      </form>

      <div className="mt-8 space-y-2">
        {projects.length === 0 ? (
          <p className="font-sans text-sm text-paper/40">No projects yet.</p>
        ) : (
          projects.map((p) => (
            <Link
              key={p.id}
              href={`/studio/projects/${p.slug}`}
              className="flex items-center justify-between rounded-lg border border-paper/15 bg-paper/[0.02] px-5 py-4 transition-colors hover:border-champagne/40 hover:bg-champagne/[0.03]"
            >
              <span>
                <span className="font-display text-base tracking-[0.04em] text-paper">
                  {p.title}
                </span>
                <span className="ml-2 font-sans text-xs text-paper/35">{p.slug}</span>
              </span>
              <span
                className={
                  "font-sans text-[0.7rem] uppercase tracking-[0.18em] " +
                  (STATUS_TONE[p.status] ?? "text-paper/45")
                }
              >
                {p.status}
              </span>
            </Link>
          ))
        )}
      </div>
    </Container>
  );
}
