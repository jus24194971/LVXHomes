"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listGrants,
  createGrant,
  revokeGrant,
  deleteGrant,
  type EmbedGrant,
  type EmbedKind,
} from "@/lib/embed-client";
import { SITE } from "@/data/site";
import { cn } from "@/lib/utils";

/**
 * Issue + manage embed codes for one tour or film. Each code is a permission to
 * embed (branded or not) that can be revoked. The player has no toggle — branding
 * is decided here, server-side, per code.
 */
export function EmbedManager({
  kind,
  refId,
  title,
}: {
  kind: EmbedKind;
  refId: string;
  title: string;
}) {
  const [grants, setGrants] = useState<EmbedGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [branded, setBranded] = useState(true);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr("");
    try {
      setGrants(await listGrants(kind, refId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load embed codes");
    } finally {
      setLoading(false);
    }
  }, [kind, refId]);

  useEffect(() => {
    void load();
  }, [load]);

  const snippet = (id: string) =>
    `<div style="position:relative;width:100%;padding-bottom:56.25%">\n` +
    `  <iframe src="${SITE.url}/embed/${id}" style="position:absolute;inset:0;width:100%;height:100%;border:0"\n` +
    `    allow="fullscreen; gyroscope; accelerometer" allowfullscreen loading="lazy"\n` +
    `    title="${title}"></iframe>\n</div>`;

  const create = async () => {
    setCreating(true);
    setErr("");
    try {
      await createGrant({ kind, ref: refId, branded, label: label.trim() || undefined });
      setLabel("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create the code");
    } finally {
      setCreating(false);
    }
  };

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(snippet(id));
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const toggleRevoke = async (g: EmbedGrant) => {
    try {
      await revokeGrant(g.id, g.revoked !== 1);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    }
  };

  const remove = async (g: EmbedGrant) => {
    if (!confirm("Delete this embed code? Any site using it stops working immediately.")) return;
    try {
      await deleteGrant(g.id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div>
      <p className="font-display text-[0.7rem] uppercase tracking-[0.2em] text-champagne">
        Distribute · embed codes
      </p>
      <p className="mt-1.5 font-sans text-[0.7rem] leading-relaxed text-paper/45">
        Each code is a permission to embed — an agent needs one from you. Pick with
        or without the LVX logo, label it for whoever you&apos;re giving it to, and
        revoke anytime. The link also works as an MLS virtual-tour URL.
      </p>

      {/* create */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-paper/15 bg-paper/[0.02] p-3">
        <div className="flex rounded-full border border-paper/20 p-0.5">
          {[
            { v: true, l: "With logo" },
            { v: false, l: "No logo" },
          ].map((o) => (
            <button
              key={String(o.v)}
              type="button"
              onClick={() => setBranded(o.v)}
              className={cn(
                "rounded-full px-3 py-1 font-sans text-[0.68rem] uppercase tracking-[0.12em] transition-colors",
                branded === o.v ? "bg-champagne text-ink" : "text-paper/60 hover:text-paper",
              )}
            >
              {o.l}
            </button>
          ))}
        </div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional) — e.g. Jane · Coldwell Banker"
          className="min-w-[10rem] flex-1 rounded border border-paper/20 bg-ink/60 px-2.5 py-1.5 font-sans text-xs text-paper outline-none focus:border-champagne"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating}
          className="rounded border border-champagne bg-champagne/90 px-3 py-1.5 font-sans text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-ink transition-colors hover:bg-champagne disabled:opacity-40"
        >
          {creating ? "Creating…" : "Create code"}
        </button>
      </div>

      {err && <p className="mt-2 font-sans text-xs text-red-400">{err}</p>}

      {/* list */}
      <div className="mt-3 flex flex-col gap-2">
        {loading ? (
          <p className="font-sans text-xs text-paper/40">Loading…</p>
        ) : grants.length === 0 ? (
          <p className="font-sans text-xs text-paper/40">
            No embed codes yet — create one to let an agent embed this.
          </p>
        ) : (
          grants.map((g) => (
            <div
              key={g.id}
              className={cn(
                "rounded-lg border p-3",
                g.revoked ? "border-paper/10 opacity-55" : "border-paper/15",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 font-sans text-[0.6rem] uppercase tracking-[0.1em]",
                    g.branded
                      ? "bg-champagne/15 text-champagne"
                      : "border border-paper/30 text-paper/60",
                  )}
                >
                  {g.branded ? "Logo" : "Unbranded"}
                </span>
                <span className="min-w-0 flex-1 truncate font-sans text-sm text-paper/85">
                  {g.label || <span className="text-paper/40">Untitled</span>}
                </span>
                {g.revoked === 1 && (
                  <span className="font-sans text-[0.62rem] uppercase tracking-[0.12em] text-red-400/80">
                    Revoked
                  </span>
                )}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={`${SITE.url}/embed/${g.id}`}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded border border-paper/15 bg-ink/60 px-2 py-1 font-mono text-[0.7rem] text-paper/70 outline-none"
                />
                <button
                  type="button"
                  onClick={() => void copy(g.id)}
                  className="shrink-0 rounded border border-champagne/50 px-2.5 py-1 font-sans text-[0.65rem] uppercase tracking-[0.1em] text-champagne transition-colors hover:bg-champagne/10"
                >
                  {copied === g.id ? "Copied ✓" : "Copy code"}
                </button>
              </div>

              <div className="mt-2 flex items-center gap-4">
                <a
                  href={`${SITE.url}/embed/${g.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-sans text-[0.65rem] uppercase tracking-[0.1em] text-paper/45 transition-colors hover:text-champagne"
                >
                  Preview ↗
                </a>
                <button
                  type="button"
                  onClick={() => void toggleRevoke(g)}
                  className="font-sans text-[0.65rem] uppercase tracking-[0.1em] text-paper/50 transition-colors hover:text-champagne"
                >
                  {g.revoked === 1 ? "Restore" : "Revoke"}
                </button>
                <button
                  type="button"
                  onClick={() => void remove(g)}
                  className="ml-auto font-sans text-[0.65rem] uppercase tracking-[0.1em] text-paper/40 transition-colors hover:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
