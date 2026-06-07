import Link from "next/link";
import { StreamPlayer } from "@/components/stream/player";
import { Reveal } from "@/components/ui/reveal";
import type { Project } from "@/data/projects";

/** Portfolio film grid. (No filter for v1 — it's a short, curated set.) */
export function WorkGrid({ projects }: { projects: Project[] }) {
  return (
    <div className="grid gap-x-8 gap-y-14 sm:grid-cols-2">
      {projects.map((p, i) => (
        <Reveal key={p.slug} delay={(i % 2) * 90}>
          <Link href={`/work/${p.slug}`} className="group block">
            <StreamPlayer uid={p.streamUid} title={p.title} />
            <h2 className="mt-5 font-serif text-xl text-ink">{p.title}</h2>
            {p.summary && (
              <p className="mt-1 font-sans text-sm text-taupe">{p.summary}</p>
            )}
          </Link>
        </Reveal>
      ))}
    </div>
  );
}
