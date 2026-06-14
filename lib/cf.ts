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

/** The Worker bindings + vars this app reads. All optional so the site still
 *  builds and renders (from baked data) before the backend is provisioned. */
export type AppEnv = {
  /** D1 content database. Bound as "DB" in wrangler.jsonc. */
  DB?: D1Database;
  /** e.g. "yourteam.cloudflareaccess.com". Set (with ACCESS_AUD) to turn ON
   *  in-Worker Access JWT verification on top of the edge Access policy. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
  /** Optional comma-separated email allowlist enforced in the Worker. */
  AUTHOR_ALLOWLIST?: string;
};
