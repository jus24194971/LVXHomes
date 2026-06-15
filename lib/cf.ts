/**
 * Minimal, dependency-free Cloudflare binding types — only the surface this app
 * actually touches. This avoids pulling in @cloudflare/workers-types or running
 * `wrangler types` (cf-typegen) during CI, which the build script doesn't do.
 *
 * If you later `npm i -D @cloudflare/workers-types` and run `npm run cf-typegen`,
 * you can delete this file and import the generated `CloudflareEnv` instead.
 */

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

/** Minimal R2 bucket binding surface — just what asset management touches. */
export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: Record<string, unknown>): Promise<{ objects: { key: string }[] }>;
}

/** The Worker bindings + vars this app reads. All optional so the site still
 *  builds and renders (from baked data) before the backend is provisioned. */
export type AppEnv = {
  /** D1 content database. Bound as "DB" in wrangler.jsonc. */
  DB?: D1Database;
  /** R2 media bucket (lvx-media). Bound as "MEDIA". Used to delete objects. */
  MEDIA?: R2Bucket;
  /** e.g. "yourteam.cloudflareaccess.com". Set (with ACCESS_AUD) to turn ON
   *  in-Worker Access JWT verification on top of the edge Access policy. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
  /** Optional comma-separated email allowlist enforced in the Worker. */
  AUTHOR_ALLOWLIST?: string;

  // --- Media library (Stream + R2 uploads) ---
  /** Cloudflare account id (not secret). */
  CF_ACCOUNT_ID?: string;
  /** Cloudflare API token with Stream:Edit (secret). */
  CF_API_TOKEN?: string;
  /** R2 bucket name, e.g. "lvx-media". */
  R2_BUCKET?: string;
  /** Public host serving the bucket, e.g. "media.lvxhomes.com". */
  R2_PUBLIC_HOST?: string;
  /** R2 S3 API access key id (secret) — for presigned upload URLs. */
  R2_ACCESS_KEY_ID?: string;
  /** R2 S3 API secret access key (secret). */
  R2_SECRET_ACCESS_KEY?: string;

  // --- Cloud VSLAM (Modal) ---
  /** Modal `submit` web-endpoint URL that kicks off cloud processing.
   *  Set after `modal deploy`. */
  MODAL_SUBMIT_URL?: string;
  /** Shared secret used both ways: Worker→Modal (job auth) and Modal→Worker
   *  (callback auth). Must equal LVX_CALLBACK_TOKEN in the Modal secret. */
  VSLAM_CALLBACK_TOKEN?: string;
};
