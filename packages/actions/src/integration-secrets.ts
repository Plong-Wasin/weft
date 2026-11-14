import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { requireProductionSecret } from "@weft/db";

/**
 * Webhook secrets must be read back to check signatures, so they are stored sealed (AES-256-GCM) rather than hashed.
 * The key comes from BETTER_AUTH_SECRET: changing that value makes every stored webhook secret unreadable, so
 * the admin must create a new integration after rotating it (see docs/integrations/github-gitlab.md).
 */
function sealingKey(env: Record<string, string | undefined> = Bun.env) {
  const material = requireProductionSecret("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET, "development-secret-change-before-deploy-32-chars", { minLength: 32, env });
  return createHash("sha256").update(`work-item-integrations:${material}`).digest();
}

export function sealSecret(plain: string, env?: Record<string, string | undefined>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(env), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function openSecret(sealed: string, env?: Record<string, string | undefined>): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unrecognised sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", sealingKey(env), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
