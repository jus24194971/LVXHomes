import type { Asset as StoreAsset, AssetKind } from "@/lib/store";

/** Browser client for the Studio media library API (/studio/api/*). */

export type { AssetKind };
/** A library asset = the DB row plus a derived public/playable URL. */
export type Asset = StoreAsset & { url?: string };

const BASE = "/studio/api";

async function jsonOrThrow<T = unknown>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function fetchAssets(
  kind?: AssetKind,
  opts: { archived?: boolean; sync?: boolean } = {},
): Promise<Asset[]> {
  const p = new URLSearchParams();
  if (kind) p.set("kind", kind);
  if (opts.archived) p.set("archived", "1");
  if (opts.sync === false) p.set("sync", "0");
  const { assets } = await jsonOrThrow<{ assets: Asset[] }>(
    await fetch(`${BASE}/assets?${p.toString()}`, { credentials: "same-origin" }),
  );
  return assets ?? [];
}

export async function renameAsset(id: string, title: string): Promise<Asset> {
  const { asset } = await jsonOrThrow<{ asset: Asset }>(
    await fetch(`${BASE}/assets/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
  return asset;
}

export async function archiveAsset(id: string, archived = true): Promise<Asset> {
  const { asset } = await jsonOrThrow<{ asset: Asset }>(
    await fetch(`${BASE}/assets/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    }),
  );
  return asset;
}

export async function deleteAsset(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`${BASE}/assets/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    }),
  );
}

export type UploadProgress = (pct: number) => void;

/** Stream film: mint direct upload → POST the file → mark complete. */
export async function uploadFilm(
  file: File,
  title: string,
  onProgress?: UploadProgress,
): Promise<Asset> {
  const init = await jsonOrThrow<{ assetId: string; uploadURL: string }>(
    await fetch(`${BASE}/uploads/stream`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
  await xhrUpload(init.uploadURL, file, "POST", true, onProgress);
  const { asset } = await jsonOrThrow<{ asset: Asset }>(
    await fetch(`${BASE}/assets/${init.assetId}/complete`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bytes: file.size }),
    }),
  );
  return asset;
}

/** R2 (360 video or pano): mint presigned PUT → PUT the file → mark complete. */
export async function uploadR2(
  file: File,
  title: string,
  kind: "video360" | "pano",
  onProgress?: UploadProgress,
): Promise<Asset> {
  const init = await jsonOrThrow<{ assetId: string; putUrl: string }>(
    await fetch(`${BASE}/uploads/r2`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        kind,
        filename: file.name,
        contentType: file.type || undefined,
      }),
    }),
  );
  await xhrUpload(
    init.putUrl,
    file,
    "PUT",
    false,
    onProgress,
    file.type || "application/octet-stream",
  );
  const { asset } = await jsonOrThrow<{ asset: Asset }>(
    await fetch(`${BASE}/assets/${init.assetId}/complete`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bytes: file.size }),
    }),
  );
  return asset;
}

/** XHR (not fetch) so we get upload progress events. */
function xhrUpload(
  url: string,
  file: File,
  method: "POST" | "PUT",
  asForm: boolean,
  onProgress?: UploadProgress,
  contentType?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (!asForm && contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Upload network error"));
    if (asForm) {
      const fd = new FormData();
      fd.append("file", file);
      xhr.send(fd);
    } else {
      xhr.send(file);
    }
  });
}
