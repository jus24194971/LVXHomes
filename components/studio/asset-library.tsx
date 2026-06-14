"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAssets,
  renameAsset,
  archiveAsset,
  deleteAsset,
  uploadFilm,
  uploadR2,
  type Asset,
  type AssetKind,
} from "@/lib/library-client";
import { cn } from "@/lib/utils";

const TABS: { key: AssetKind | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "film", label: "Films" },
  { key: "video360", label: "360 Video" },
  { key: "pano", label: "Panos" },
];

const KIND_LABEL: Record<AssetKind, string> = {
  film: "Film",
  video360: "360",
  pano: "Pano",
};
const KIND_GLYPH: Record<AssetKind, string> = {
  film: "▶",
  video360: "◎",
  pano: "⬡",
};

type Uploading = { tmpId: string; name: string; kind: AssetKind; pct: number; error?: string };

export function AssetLibrary({
  pick,
  lockKind,
}: {
  /** Picker mode: clicking a ready asset calls this instead of showing manage actions. */
  pick?: (a: Asset) => void;
  /** Restrict to a single kind (hides tabs). */
  lockKind?: AssetKind;
} = {}) {
  const [tab, setTab] = useState<AssetKind | "all">(lockKind ?? "all");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const fileInputs = useRef<Record<AssetKind, HTMLInputElement | null>>({
    film: null,
    video360: null,
    pano: null,
  });

  const load = useCallback(async () => {
    setErr("");
    try {
      setAssets(await fetchAssets(tab === "all" ? undefined : tab));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load library");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Poll while anything is still processing.
  useEffect(() => {
    if (!assets.some((a) => a.status === "processing")) return;
    const t = setInterval(() => void load(), 6000);
    return () => clearInterval(t);
  }, [assets, load]);

  const startUpload = async (file: File, kind: AssetKind) => {
    const tmpId = `${file.name}-${file.size}-${uploads.length}`;
    setUploads((u) => [...u, { tmpId, name: file.name, kind, pct: 0 }]);
    const onP = (pct: number) =>
      setUploads((u) => u.map((x) => (x.tmpId === tmpId ? { ...x, pct } : x)));
    const title = file.name.replace(/\.[^.]+$/, "");
    try {
      if (kind === "film") await uploadFilm(file, title, onP);
      else await uploadR2(file, title, kind, onP);
      setUploads((u) => u.filter((x) => x.tmpId !== tmpId));
      await load();
    } catch (e) {
      setUploads((u) =>
        u.map((x) =>
          x.tmpId === tmpId
            ? { ...x, error: e instanceof Error ? e.message : "Upload failed" }
            : x,
        ),
      );
    }
  };

  const onFile = (kind: AssetKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    files.forEach((f) => void startUpload(f, kind));
  };

  const uploadKinds: AssetKind[] = lockKind ? [lockKind] : ["film", "video360", "pano"];
  const UPLOAD_LABEL: Record<AssetKind, string> = {
    film: "+ Film",
    video360: "+ 360 video",
    pano: "+ Pano",
  };

  const pill =
    "shrink-0 rounded-full px-3 py-1.5 font-sans text-[0.72rem] uppercase tracking-[0.14em] transition-colors";

  return (
    <div>
      {/* hidden inputs */}
      {(["film", "video360", "pano"] as AssetKind[]).map((k) => (
        <input
          key={k}
          ref={(el) => {
            fileInputs.current[k] = el;
          }}
          type="file"
          accept={k === "pano" ? "image/*" : "video/*"}
          multiple
          className="hidden"
          onChange={onFile(k)}
        />
      ))}

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {!lockKind &&
          TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                pill,
                tab === t.key
                  ? "bg-champagne/15 text-champagne"
                  : "text-paper/55 hover:text-paper",
              )}
            >
              {t.label}
            </button>
          ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {uploadKinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => fileInputs.current[k]?.click()}
              className={cn(pill, "border border-champagne/50 text-champagne hover:bg-champagne/10")}
            >
              {UPLOAD_LABEL[k]}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load()}
            className={cn(pill, "border border-paper/25 text-paper/60 hover:text-paper")}
          >
            ↻
          </button>
        </div>
      </div>

      <p className="mt-2 font-sans text-[0.68rem] leading-relaxed text-paper/35">
        Films go to Stream (auto-transcoded). 360 video + panos go to R2. Stream
        uploads over ~200 MB are more reliable from the Stream dashboard — they’ll
        appear here automatically.
      </p>

      {err && <p className="mt-3 font-sans text-xs text-red-400">{err}</p>}

      {/* uploads in progress */}
      {uploads.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {uploads.map((u) => (
            <div
              key={u.tmpId}
              className="rounded-lg border border-paper/15 bg-paper/[0.02] p-3"
            >
              <div className="flex items-center justify-between gap-3 font-sans text-xs text-paper/70">
                <span className="min-w-0 truncate">
                  <span className="text-champagne">{KIND_LABEL[u.kind]}</span> · {u.name}
                </span>
                <span className="tabular-nums text-paper/50">
                  {u.error ? "failed" : u.pct < 100 ? `${u.pct}%` : "finishing…"}
                </span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-paper/10">
                <div
                  className={cn("h-full transition-[width]", u.error ? "bg-red-400" : "bg-champagne")}
                  style={{ width: `${u.error ? 100 : u.pct}%` }}
                />
              </div>
              {u.error && (
                <p className="mt-1.5 font-sans text-[0.68rem] text-red-400">
                  {u.error}{" "}
                  <button
                    type="button"
                    onClick={() => setUploads((x) => x.filter((y) => y.tmpId !== u.tmpId))}
                    className="underline hover:text-red-300"
                  >
                    dismiss
                  </button>
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* grid */}
      {loading ? (
        <p className="mt-8 font-sans text-sm text-paper/40">Loading library…</p>
      ) : assets.length === 0 ? (
        <p className="mt-8 font-sans text-sm text-paper/40">
          Nothing here yet — upload a {lockKind ? KIND_LABEL[lockKind].toLowerCase() : "video"} to begin.
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              pick={pick}
              onChange={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetCard({
  asset,
  pick,
  onChange,
}: {
  asset: Asset;
  pick?: (a: Asset) => void;
  onChange: () => Promise<void> | void;
}) {
  const [title, setTitle] = useState(asset.title);
  const [busy, setBusy] = useState(false);
  const ready = asset.status === "ready";

  const commitTitle = async () => {
    if (title.trim() === asset.title || !title.trim()) {
      setTitle(asset.title);
      return;
    }
    try {
      await renameAsset(asset.id, title.trim());
    } catch {
      setTitle(asset.title);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      await archiveAsset(asset.id, true);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete “${asset.title}” permanently? This removes the media too.`)) return;
    setBusy(true);
    try {
      await deleteAsset(asset.id);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const status =
    asset.status === "ready"
      ? { label: "Ready", cls: "text-champagne" }
      : asset.status === "processing"
        ? { label: "Processing…", cls: "text-amber-400" }
        : asset.status === "uploading"
          ? { label: "Uploading…", cls: "text-sky-400" }
          : { label: "Error", cls: "text-red-400" };

  const selectable = Boolean(pick) && ready;

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-paper/15 bg-paper/[0.02]",
        selectable && "cursor-pointer transition-colors hover:border-champagne/60 hover:bg-champagne/[0.05]",
      )}
      onClick={selectable ? () => pick!(asset) : undefined}
    >
      <div className="relative aspect-video bg-ink">
        {asset.thumb_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={asset.thumb_url}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-3xl text-paper/20">
            {KIND_GLYPH[asset.kind]}
          </div>
        )}
        <span className="absolute left-2 top-2 rounded bg-ink/80 px-1.5 py-0.5 font-sans text-[0.6rem] uppercase tracking-[0.12em] text-paper/70 backdrop-blur">
          {KIND_LABEL[asset.kind]}
        </span>
        {selectable && (
          <span className="absolute inset-0 flex items-center justify-center bg-ink/0 font-sans text-[0.7rem] uppercase tracking-[0.18em] text-champagne opacity-0 transition-opacity hover:bg-ink/40 hover:opacity-100">
            Select
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        {pick ? (
          <p className="truncate font-sans text-sm text-paper" title={asset.title}>
            {asset.title}
          </p>
        ) : (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="w-full rounded bg-transparent font-sans text-sm text-paper outline-none focus:bg-ink/60 focus:px-1"
          />
        )}
        <div className="mt-auto flex items-center justify-between">
          <span className={cn("font-sans text-[0.65rem] tracking-wide", status.cls)}>
            {status.label}
          </span>
          {!pick && (
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={archive}
                disabled={busy}
                className="font-sans text-[0.65rem] uppercase tracking-[0.12em] text-paper/40 hover:text-paper/80 disabled:opacity-40"
              >
                Archive
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                aria-label="Delete"
                className="text-paper/40 transition-colors hover:text-red-400 disabled:opacity-40"
              >
                ✕
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
