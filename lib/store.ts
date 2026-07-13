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

export type Kind = "tour" | "plan" | "pinset" | "measure";
export const KINDS: Kind[] = ["tour", "plan", "pinset", "measure"];

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

/** All live plan slugs (D1 "plan" rows) — so the editor can list cloud-delivered plans,
 *  not just the baked ones. Most-recently-updated first. */
export async function listPlanSlugs(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const res = await db
    .prepare("SELECT id FROM doc WHERE kind = 'plan' ORDER BY updated_at DESC")
    .all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}

/** Generic load used by the author API — live row or baked fallback, or null. */
export async function getDocLive(kind: Kind, id: string): Promise<unknown> {
  if (kind === "tour") return (await getTourLive(id)) ?? null;
  if (kind === "plan") return (await getPlanLive(id)) ?? null;
  if (kind === "measure") return await readRow("measure", id); // no baked fallback — generated in the Studio
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

// ---------- media library (assets) ----------

export type AssetKind = "film" | "video360" | "pano";
export type AssetStatus = "uploading" | "processing" | "ready" | "error";

export type Asset = {
  id: string;
  kind: AssetKind;
  title: string;
  status: AssetStatus;
  stream_uid: string | null;
  r2_key: string | null;
  content_type: string | null;
  bytes: number | null;
  thumb_url: string | null;
  archived: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
};

export async function listAssets(
  opts: { kind?: AssetKind; includeArchived?: boolean } = {},
): Promise<Asset[]> {
  const db = await getDb();
  if (!db) return [];
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includeArchived) clauses.push("archived = 0");
  if (opts.kind) {
    clauses.push("kind = ?");
    binds.push(opts.kind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const res = await db
    .prepare(`SELECT * FROM asset ${where} ORDER BY created_at DESC LIMIT 500`)
    .bind(...binds)
    .all<Asset>();
  return res.results ?? [];
}

export async function getAsset(id: string): Promise<Asset | null> {
  const db = await getDb();
  if (!db) return null;
  return db.prepare("SELECT * FROM asset WHERE id = ?").bind(id).first<Asset>();
}

export async function createAsset(a: {
  id: string;
  kind: AssetKind;
  title: string;
  status: AssetStatus;
  stream_uid?: string | null;
  r2_key?: string | null;
  content_type?: string | null;
  bytes?: number | null;
  thumb_url?: string | null;
  created_by?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO asset (id, kind, title, status, stream_uid, r2_key, content_type, bytes, thumb_url, archived, created_at, updated_at, created_by) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    )
    .bind(
      a.id,
      a.kind,
      a.title,
      a.status,
      a.stream_uid ?? null,
      a.r2_key ?? null,
      a.content_type ?? null,
      a.bytes ?? null,
      a.thumb_url ?? null,
      now,
      now,
      a.created_by ?? null,
    )
    .run();
}

const ASSET_PATCH_COLS = [
  "title",
  "status",
  "stream_uid",
  "r2_key",
  "content_type",
  "bytes",
  "thumb_url",
  "archived",
] as const;
type AssetPatch = Partial<Pick<Asset, (typeof ASSET_PATCH_COLS)[number]>>;

export async function updateAsset(id: string, patch: AssetPatch): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of ASSET_PATCH_COLS) {
    const v = patch[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  binds.push(Date.now());
  binds.push(id);
  await db
    .prepare(`UPDATE asset SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

export async function deleteAssetRow(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  await db.prepare("DELETE FROM asset WHERE id = ?").bind(id).run();
}

// ---------- embed grants (permission to embed) ----------

export type EmbedKind = "tour" | "film";

export type EmbedGrant = {
  id: string;
  kind: EmbedKind;
  ref: string;
  branded: number;
  label: string | null;
  revoked: number;
  created_at: number;
  created_by: string | null;
};

export async function createGrant(g: {
  id: string;
  kind: EmbedKind;
  ref: string;
  branded: boolean;
  label?: string | null;
  created_by?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  await db
    .prepare(
      "INSERT INTO embed_grant (id, kind, ref, branded, label, revoked, created_at, created_by) " +
        "VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(
      g.id,
      g.kind,
      g.ref,
      g.branded ? 1 : 0,
      g.label ?? null,
      Date.now(),
      g.created_by ?? null,
    )
    .run();
}

export async function getGrant(id: string): Promise<EmbedGrant | null> {
  const db = await getDb();
  if (!db) return null;
  return db.prepare("SELECT * FROM embed_grant WHERE id = ?").bind(id).first<EmbedGrant>();
}

export async function listGrants(
  kind?: EmbedKind,
  ref?: string,
): Promise<EmbedGrant[]> {
  const db = await getDb();
  if (!db) return [];
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (kind) {
    clauses.push("kind = ?");
    binds.push(kind);
  }
  if (ref) {
    clauses.push("ref = ?");
    binds.push(ref);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const res = await db
    .prepare(`SELECT * FROM embed_grant ${where} ORDER BY created_at DESC LIMIT 500`)
    .bind(...binds)
    .all<EmbedGrant>();
  return res.results ?? [];
}

export async function setGrantRevoked(id: string, revoked: boolean): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  await db
    .prepare("UPDATE embed_grant SET revoked = ? WHERE id = ?")
    .bind(revoked ? 1 : 0, id)
    .run();
}

export async function deleteGrant(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  await db.prepare("DELETE FROM embed_grant WHERE id = ?").bind(id).run();
}

// ---------- VSLAM jobs (cloud video → floor plan) ----------

export type VslamStatus = "queued" | "processing" | "ready" | "failed";

export type VslamJob = {
  id: string;
  slug: string;
  r2_key: string;
  status: VslamStatus;
  scale: number | null;
  plan_key: string | null;
  base_key: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
};

export async function createVslamJob(j: {
  id: string;
  slug: string;
  r2_key: string;
  status?: VslamStatus;
  scale?: number | null;
  created_by?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO vslam_job (id, slug, r2_key, status, scale, plan_key, base_key, error, created_at, updated_at, created_by) " +
        "VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)",
    )
    .bind(
      j.id,
      j.slug,
      j.r2_key,
      j.status ?? "queued",
      j.scale ?? null,
      now,
      now,
      j.created_by ?? null,
    )
    .run();
}

export async function getVslamJob(id: string): Promise<VslamJob | null> {
  const db = await getDb();
  if (!db) return null;
  return db.prepare("SELECT * FROM vslam_job WHERE id = ?").bind(id).first<VslamJob>();
}

export async function latestVslamJobForSlug(slug: string): Promise<VslamJob | null> {
  const db = await getDb();
  if (!db) return null;
  return db
    .prepare("SELECT * FROM vslam_job WHERE slug = ? ORDER BY created_at DESC LIMIT 1")
    .bind(slug)
    .first<VslamJob>();
}

export async function listVslamJobs(limit = 50): Promise<VslamJob[]> {
  const db = await getDb();
  if (!db) return [];
  const res = await db
    .prepare("SELECT * FROM vslam_job ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<VslamJob>();
  return res.results ?? [];
}

const VSLAM_PATCH_COLS = ["status", "scale", "plan_key", "base_key", "error"] as const;
type VslamPatch = Partial<Pick<VslamJob, (typeof VSLAM_PATCH_COLS)[number]>>;

export async function updateVslamJob(id: string, patch: VslamPatch): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of VSLAM_PATCH_COLS) {
    const v = patch[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  binds.push(Date.now());
  binds.push(id);
  await db
    .prepare(`UPDATE vslam_job SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

// ---------- capture projects (the workflow folder) ----------

export type ProjectStatus = "draft" | "processing" | "review" | "published";
// video = processable equirect/standard clip · still = image for the stitch ·
// hero = designated room pano → tour zoom-point · telemetry = SRT/GPS ·
// proxy = .lrf/.lrv low-res (preview only) · raw = .osv/.insv (needs vendor stitch first)
export type ProjectFileRole =
  | "video" | "nadir" | "still" | "hero" | "telemetry" | "proxy" | "raw" | "other";

export type Project = {
  id: string;
  slug: string;
  title: string;
  status: ProjectStatus;
  tour_slug: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
};

export type ProjectFile = {
  id: string;
  project_id: string;
  role: ProjectFileRole;
  r2_key: string;
  filename: string | null;
  content_type: string | null;
  bytes: number | null;
  created_at: number;
  created_by: string | null;
};

export async function createProject(p: {
  id: string;
  slug: string;
  title: string;
  created_by?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO project (id, slug, title, status, tour_slug, notes, created_at, updated_at, created_by) " +
        "VALUES (?, ?, ?, 'draft', ?, NULL, ?, ?, ?)",
    )
    .bind(p.id, p.slug, p.title, p.slug, now, now, p.created_by ?? null)
    .run();
}

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const db = await getDb();
  if (!db) return null;
  return db.prepare("SELECT * FROM project WHERE slug = ?").bind(slug).first<Project>();
}

export async function listProjects(): Promise<Project[]> {
  const db = await getDb();
  if (!db) return [];
  const res = await db
    .prepare("SELECT * FROM project ORDER BY created_at DESC LIMIT 200")
    .all<Project>();
  return res.results ?? [];
}

const PROJECT_PATCH_COLS = ["title", "status", "tour_slug", "notes"] as const;
type ProjectPatch = Partial<Pick<Project, (typeof PROJECT_PATCH_COLS)[number]>>;

export async function updateProject(id: string, patch: ProjectPatch): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of PROJECT_PATCH_COLS) {
    const v = patch[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  binds.push(Date.now());
  binds.push(id);
  await db
    .prepare(`UPDATE project SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

export async function addProjectFile(f: {
  id: string;
  project_id: string;
  role: ProjectFileRole;
  r2_key: string;
  filename?: string | null;
  content_type?: string | null;
  bytes?: number | null;
  created_by?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  await db
    .prepare(
      "INSERT INTO project_file (id, project_id, role, r2_key, filename, content_type, bytes, created_at, created_by) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      f.id,
      f.project_id,
      f.role,
      f.r2_key,
      f.filename ?? null,
      f.content_type ?? null,
      f.bytes ?? null,
      Date.now(),
      f.created_by ?? null,
    )
    .run();
}

export async function listProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const db = await getDb();
  if (!db) return [];
  const res = await db
    .prepare("SELECT * FROM project_file WHERE project_id = ? ORDER BY created_at ASC")
    .bind(projectId)
    .all<ProjectFile>();
  return res.results ?? [];
}

export async function deleteProjectFile(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  await db.prepare("DELETE FROM project_file WHERE id = ?").bind(id).run();
}

/** Re-tag a file's role — e.g. promote a pano to `hero` (a tour zoom-point). */
export async function setProjectFileRole(id: string, role: ProjectFileRole): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("D1 binding 'DB' is not available");
  await db.prepare("UPDATE project_file SET role = ? WHERE id = ?").bind(role, id).run();
}
