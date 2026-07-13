/**
 * Tiny browser client for the Zero-Trust author API (/api/author/*). The
 * in-browser studios use this to load/save their docs straight to the live
 * site instead of copy-pasting JSON into the repo. Requests are same-origin so
 * the Cloudflare Access session cookie rides along and the edge policy
 * authorizes the call.
 */

export type AuthorKind = "tour" | "plan" | "pinset" | "measure";

export type RevisionMeta = {
  id: number;
  created_at: number;
  created_by: string | null;
};

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j?.error) return j.error;
  } catch {
    /* response wasn't JSON */
  }
  return `Request failed (${res.status})`;
}

const base = (kind: AuthorKind, id: string) =>
  `/api/author/${kind}/${encodeURIComponent(id)}`;

export async function loadDoc<T>(kind: AuthorKind, id: string): Promise<T | null> {
  const res = await fetch(base(kind, id), { credentials: "same-origin" });
  if (!res.ok) throw new Error(await errorText(res));
  const { doc } = (await res.json()) as { doc: T | null };
  return doc ?? null;
}

export async function saveDoc(
  kind: AuthorKind,
  id: string,
  doc: unknown,
): Promise<void> {
  const res = await fetch(base(kind, id), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(await errorText(res));
}

export async function listRevisions(
  kind: AuthorKind,
  id: string,
): Promise<RevisionMeta[]> {
  const res = await fetch(`${base(kind, id)}/revisions`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(await errorText(res));
  const { revisions } = (await res.json()) as { revisions: RevisionMeta[] };
  return revisions ?? [];
}

export async function restoreRevision<T>(
  kind: AuthorKind,
  id: string,
  revisionId: number,
): Promise<T | null> {
  const res = await fetch(`${base(kind, id)}/revisions`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revisionId }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const { doc } = (await res.json()) as { doc: T | null };
  return doc ?? null;
}
