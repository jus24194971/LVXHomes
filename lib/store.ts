import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AppEnv, D1Database } from "@/lib/cf";
import { TOURS, type Tour } from "@/data/tours";
import { PLANS, type Plan } from "@/data/plans";
import { VIDEO_PINS, type VideoPinSet } from "@/data/video-pins";

/**
 * Content store. The live source of truth is D1; the baked arrays in
 * data/*.ts are the seed + fallback. A read returns the saved D1 row if one
 * exists, otherwise the baked entity — so the site renders fine before the
 * backend is provisioned, and the very first Save persists the baked doc.
 */

export type Kind = "tour" | "plan" | "pinset";
export const KINDS: Kind[] = ["tour", "plan", "pinset"];

async function getDb(): Promise<D1Database | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return (env as unknown as AppEnv).DB ?? null;
  } catch {
    // e.g. `next dev` without the Cloudflare binding proxy — fall back to baked.
    return null;
  }
}

async function readRow<T>(kind: Kind, id: string): Promise<T | null> {
  const db = await getDb();
  if (!db) return null;
  const row = await db
    .prepare("SELECT body FROM doc WHERE kind = ? AND id = ?")
    .bind(kind, id)
    .first<{ body: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.body) as T;
  } catch {
    return null;
  }
}

const bakedTour = (slug: string) => TOURS.find((t) => t.slug === slug);
const bakedPlan = (slug: string) => PLANS.find((p) => p.tourSlug === slug);
const bakedPinSet = (uid: string) => VIDEO_PINS.find((s) => s.uid === uid);

export async function getTourLive(slug: string): Promise<Tour | undefined> {
  return (await readRow<Tour>("tour", slug)) ?? bakedTour(slug);
}

export async function getPlanLive(tourSlug: string): Promise<Plan | undefined> {
  return (await readRow<Plan>("plan", tourSlug)) ?? bakedPlan(tourSlug);
}

export async function getPinSetLive(uid: string): Promise<VideoPinSet | undefined> {
  return (await readRow<VideoPinSet>("pinset", uid)) ?? bakedPinSet(uid);
}

/** Generic load used by the author API — live row or baked fallback, or null. */
export async function getDocLive(kind: Kind, id: string): Promise<unknown> {
  if (kind === "tour") return (await getTourLive(id)) ?? null;
  if (kind === "plan") return (await getPlanLive(id)) ?? null;
  return (await getPinSetLive(id)) ?? null;
}

/** Upsert the live doc and append a revision, atomically. */
export async function putDoc(
  kind: Kind,
  id: string,
  body: unknown,
  who: string | null,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  const json = JSON.stringify(body);
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO doc (kind, id, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body, " +
          "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      )
      .bind(kind, id, json, now, who),
    db
      .prepare(
        "INSERT INTO revision (kind, doc_id, body, created_at, created_by) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .bind(kind, id, json, now, who),
  ]);
}

export type RevisionMeta = {
  id: number;
  created_at: number;
  created_by: string | null;
};

export async function listRevisions(
  kind: Kind,
  id: string,
  limit = 20,
): Promise<RevisionMeta[]> {
  const db = await getDb();
  if (!db) return [];
  const res = await db
    .prepare(
      "SELECT id, created_at, created_by FROM revision " +
        "WHERE kind = ? AND doc_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(kind, id, limit)
    .all<RevisionMeta>();
  return res.results ?? [];
}

/** Restore a prior revision: copy its body back into the live doc. Stays
 *  append-only (the restore itself is logged as a new revision). */
export async function restoreRevision(
  kind: Kind,
  id: string,
  revisionId: number,
  who: string | null,
): Promise<unknown | null> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  const row = await db
    .prepare("SELECT body FROM revision WHERE id = ? AND kind = ? AND doc_id = ?")
    .bind(revisionId, kind, id)
    .first<{ body: string }>();
  if (!row) return null;
  const body = JSON.parse(row.body);
  await putDoc(kind, id, body, who);
  return body;
}
