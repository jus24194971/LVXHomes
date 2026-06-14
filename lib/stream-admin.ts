import type { AppEnv } from "@/lib/cf";

/**
 * Cloudflare Stream admin calls (server-side, with the CF_API_TOKEN secret).
 * Used to mint direct-creator upload URLs, list the account's videos so the
 * Library shows films already on Stream, and poll processing status.
 */

const API = "https://api.cloudflare.com/client/v4";

function headers(env: AppEnv) {
  return {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export function streamConfigured(env: AppEnv): boolean {
  return Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN);
}

export type StreamVideo = {
  uid: string;
  readyToStream: boolean;
  status?: { state?: string; pctComplete?: string };
  thumbnail?: string;
  preview?: string;
  duration?: number;
  size?: number;
  created?: string;
  meta?: Record<string, string>;
};

type CfResp<T> = { success: boolean; result?: T; errors?: unknown };

/** Mint a one-time direct-creator upload URL. The browser POSTs the file to it. */
export async function createDirectUpload(
  env: AppEnv,
  opts: { maxDurationSeconds?: number; name?: string } = {},
): Promise<{ uploadURL: string; uid: string }> {
  const body: Record<string, unknown> = {
    maxDurationSeconds: opts.maxDurationSeconds ?? 7200,
  };
  if (opts.name) body.meta = { name: opts.name };
  const res = await fetch(
    `${API}/accounts/${env.CF_ACCOUNT_ID}/stream/direct_upload`,
    { method: "POST", headers: headers(env), body: JSON.stringify(body) },
  );
  const json = (await res.json()) as CfResp<{ uploadURL: string; uid: string }>;
  if (!res.ok || !json.success || !json.result) {
    throw new Error(`Stream direct_upload failed: ${JSON.stringify(json.errors ?? res.status)}`);
  }
  return json.result;
}

export async function getStreamVideo(
  env: AppEnv,
  uid: string,
): Promise<StreamVideo | null> {
  const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}/stream/${uid}`, {
    headers: headers(env),
  });
  const json = (await res.json()) as CfResp<StreamVideo>;
  if (!res.ok || !json.success || !json.result) return null;
  return json.result;
}

export async function listStreamVideos(env: AppEnv): Promise<StreamVideo[]> {
  const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}/stream?limit=200`, {
    headers: headers(env),
  });
  const json = (await res.json()) as CfResp<StreamVideo[]>;
  if (!res.ok || !json.success || !json.result) return [];
  return json.result;
}

export async function deleteStreamVideo(env: AppEnv, uid: string): Promise<void> {
  await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}/stream/${uid}`, {
    method: "DELETE",
    headers: headers(env),
  });
}
