import { createHmac } from "node:crypto";
import { requireProductionSecret } from "@weft/db";

/** Image types served inline. Everything else (SVG and HTML included) is download-only. */
export const inlineImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const defaultMaxAssetBytes = 5 * 1024 * 1024;

export function maxAssetBytes(env: Record<string, string | undefined> = Bun.env) {
  const parsed = Number(env.ASSET_MAX_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultMaxAssetBytes;
}

export interface PresignedPost { url: string; fields: Record<string, string> }
export interface PresignedGet { url: string }

/** Object storage seam. The S3 implementation is used in production; tests use an in-memory one. */
export interface AssetStorage {
  presignPost(input: { key: string; contentType: string; maxBytes: number; expiresInSeconds?: number }): Promise<PresignedPost> | PresignedPost;
  /** Size in bytes of the stored object, or null when it does not exist. */
  head(key: string): Promise<{ size: number } | null>;
  remove(key: string): Promise<void>;
  /** Creates an independent object with the source bytes at a new key. */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  presignGet(input: { key: string; filename: string; contentType: string; inline: boolean; expiresInSeconds?: number }): Promise<PresignedGet> | PresignedGet;
}

export interface S3Settings {
  endpoint: string;
  /** Endpoint the browser talks to; defaults to `endpoint`. */
  publicEndpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function s3SettingsFromEnv(env: Record<string, string | undefined> = Bun.env): S3Settings {
  const endpoint = env.S3_ENDPOINT ?? "http://localhost:9000";
  return {
    endpoint, publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? endpoint, bucket: env.S3_BUCKET ?? "weft-assets", region: env.S3_REGION ?? "us-east-1",
    accessKeyId: env.S3_ACCESS_KEY ?? "weft", secretAccessKey: requireProductionSecret("S3_SECRET_KEY", env.S3_SECRET_KEY, "weft-secret", { env }),
  };
}

const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
const stamp = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");

/** SigV4 browser-based POST policy (path-style). `content-length-range` makes the storage server itself reject oversize bodies. */
export function signPostPolicy(settings: S3Settings, input: { key: string; contentType: string; maxBytes: number; expiresInSeconds?: number }, now = new Date()): PresignedPost {
  const amzDate = stamp(now);
  const day = amzDate.slice(0, 8);
  const credential = `${settings.accessKeyId}/${day}/${settings.region}/s3/aws4_request`;
  const policy = {
    expiration: new Date(now.getTime() + (input.expiresInSeconds ?? 600) * 1000).toISOString(),
    conditions: [
      { bucket: settings.bucket }, { key: input.key }, { "Content-Type": input.contentType },
      ["content-length-range", 1, input.maxBytes],
      { "x-amz-algorithm": "AWS4-HMAC-SHA256" }, { "x-amz-credential": credential }, { "x-amz-date": amzDate },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(policy)).toString("base64");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${settings.secretAccessKey}`, day), settings.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(encoded).digest("hex");
  return {
    url: `${(settings.publicEndpoint ?? settings.endpoint).replace(/\/$/, "")}/${settings.bucket}`,
    fields: {
      key: input.key, "Content-Type": input.contentType, policy: encoded, "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": credential, "x-amz-date": amzDate, "x-amz-signature": signature,
    },
  };
}

export function createS3Storage(settings: S3Settings = s3SettingsFromEnv()): AssetStorage {
  const client = (endpoint: string) => new Bun.S3Client({ endpoint, bucket: settings.bucket, region: settings.region, accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey });
  const internal = client(settings.endpoint);
  const external = client(settings.publicEndpoint ?? settings.endpoint);
  return {
    presignPost: (input) => signPostPolicy(settings, input),
    head: async (key) => {
      try { return { size: (await internal.file(key).stat()).size }; } catch (error) {
        if ((error as { code?: string }).code === "NoSuchKey" || (error as { code?: string }).code === "NotFound") return null;
        throw error;
      }
    },
    remove: async (key) => { await internal.file(key).delete(); },
    copy: async (sourceKey, destinationKey) => {
      const source = internal.file(sourceKey);
      const bytes = await source.arrayBuffer();
      await internal.file(destinationKey).write(bytes);
    },
    presignGet: ({ key, filename, contentType, inline, expiresInSeconds }) => ({
      url: external.file(key).presign({
        method: "GET", expiresIn: expiresInSeconds ?? 300, type: inline ? contentType : "application/octet-stream",
        contentDisposition: contentDisposition(inline ? "inline" : "attachment", filename),
      }),
    }),
  };
}

export function contentDisposition(kind: "inline" | "attachment", filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\;]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

