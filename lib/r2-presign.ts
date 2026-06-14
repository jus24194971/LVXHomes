import { AwsClient } from "aws4fetch";
import type { AppEnv } from "@/lib/cf";

/**
 * Presigned R2 uploads. The browser PUTs bytes straight to R2 using a
 * short-lived signed URL the Worker mints — large videos never stream through
 * the Worker. Requires R2 S3 API credentials (set as secrets); the R2 binding
 * can't presign.
 */

export function r2UploadConfigured(env: AppEnv): boolean {
  return Boolean(
    env.CF_ACCOUNT_ID &&
      env.R2_BUCKET &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY,
  );
}

/** Presign a PUT. Only `host` is signed, so the browser may send its own
 *  Content-Type (R2 stores and later serves it). */
export async function presignR2Put(
  env: AppEnv,
  key: string,
  expiresSeconds = 3600,
): Promise<string> {
  if (!r2UploadConfigured(env)) {
    throw new Error("R2 upload credentials are not configured");
  }
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    service: "s3",
    region: "auto",
  });
  const url = new URL(
    `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`,
  );
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const signed = await client.sign(url.toString(), {
    method: "PUT",
    aws: { signQuery: true },
  });
  return signed.url;
}

/** The public URL an uploaded R2 object serves from (media.lvxhomes.com/<key>). */
export function r2PublicUrl(env: AppEnv, key: string): string {
  const host = env.R2_PUBLIC_HOST ?? `${env.R2_BUCKET ?? "media"}.r2.dev`;
  return `https://${host}/${key}`;
}
