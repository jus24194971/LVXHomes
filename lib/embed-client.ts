import type { EmbedGrant, EmbedKind } from "@/lib/store";

/** Browser client for the embed-grant API (/studio/api/embeds). */

export type { EmbedGrant, EmbedKind };

const BASE = "/studio/api/embeds";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const e = (await res.json()) as { error?: string };
      if (e?.error) msg = e.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function listGrants(
  kind: EmbedKind,
  ref: string,
): Promise<EmbedGrant[]> {
  const p = new URLSearchParams({ kind, ref });
  const { grants } = await j<{ grants: EmbedGrant[] }>(
    await fetch(`${BASE}?${p.toString()}`, { credentials: "same-origin" }),
  );
  return grants ?? [];
}

export async function createGrant(input: {
  kind: EmbedKind;
  ref: string;
  branded: boolean;
  label?: string;
}): Promise<EmbedGrant> {
  const { grant } = await j<{ grant: EmbedGrant }>(
    await fetch(BASE, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return grant;
}

export async function revokeGrant(id: string, revoked: boolean): Promise<EmbedGrant> {
  const { grant } = await j<{ grant: EmbedGrant }>(
    await fetch(`${BASE}/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revoked }),
    }),
  );
  return grant;
}

export async function deleteGrant(id: string): Promise<void> {
  await j(await fetch(`${BASE}/${id}`, { method: "DELETE", credentials: "same-origin" }));
}
