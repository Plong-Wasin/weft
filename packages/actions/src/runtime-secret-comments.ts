import { eq, sql } from "drizzle-orm";
import { runMessages, type Database } from "@weft/db";
import { openSecret } from "./integration-secrets";

/** Detects secret values in output and the common exact encodings an Agent may print. This is not protection from arbitrary transformations. */
export function containsRuntimeSecret(output: string, values: string[]): boolean {
  const compact = output.replace(/\s+/g, "");
  return values.some((value) => {
    if (!value) return false;
    const encodings = [value, Buffer.from(value, "utf8").toString("base64"), Buffer.from(value, "utf8").toString("base64url"), Buffer.from(value, "utf8").toString("hex")];
    return encodings.some((encoded, index) => encoded.length >= (index === 0 ? 1 : 4) && (output.includes(encoded) || compact.includes(encoded)));
  });
}

/** Scans JSON-shaped action input without serializing strings (JSON.stringify escapes quotes, slashes, and line breaks). */
export function containsRuntimeSecretValue(input: unknown, values: string[]): boolean {
  const visited = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value === "string") return containsRuntimeSecret(value, values);
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    visited.add(value);
    if (Array.isArray(value)) return value.some(visit);
    return Object.entries(value).some(([key, child]) => containsRuntimeSecret(key, values) || visit(child));
  };
  return visit(input);
}

/** Serializes action writes and terminal Run cleanup so a secret snapshot cannot disappear between inspection and persistence. */
export async function lockRuntimeRun(database: Pick<Database, "execute">, runId: string) {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext('runtime-run-secret-write'), hashtext(${runId}))`);
}

/** Redacts exact supported secret representations before Run transcript output reaches a reader. */
export function redactRuntimeSecrets<T>(input: T, values: string[]): T {
  if (!values.length) return input;
  const encodings = values.flatMap((value) => value ? [value, Buffer.from(value, "utf8").toString("base64"), Buffer.from(value, "utf8").toString("base64url"), Buffer.from(value, "utf8").toString("hex")] : []).filter((encoded) => encoded.length >= 4 || values.includes(encoded));
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return encodings.reduce((text, encoded) => text.replaceAll(encoded, "[redacted Runtime secret]"), value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [redact(key), redact(nested)]));
    return value;
  };
  return redact(input) as T;
}

/** Redacts stored Run transcript fields before the terminal Run secret snapshot is cleared. */
export async function redactRunMessages(database: Database, runId: string, secrets: string[]) {
  if (secrets.length === 0) return;
  const rows = await database.select({ id: runMessages.id, input: runMessages.input, output: runMessages.output, toolName: runMessages.toolName }).from(runMessages).where(eq(runMessages.runId, runId));
  for (const row of rows) await database.update(runMessages).set({ input: redactRuntimeSecrets(row.input, secrets), output: redactRuntimeSecrets(row.output, secrets), toolName: row.toolName ? redactRuntimeSecrets(row.toolName, secrets) : null }).where(eq(runMessages.id, row.id));
}

/** Scrubs the transcript before a terminal Run clears its encrypted snapshot. If it cannot be opened, remove transcript content rather than expose it later. */
export async function scrubRunMessages(database: Database, runId: string, sealedSecrets: string | null) {
  if (!sealedSecrets) return;
  let secrets: string[];
  try {
    secrets = Object.values(JSON.parse(openSecret(sealedSecrets)) as Record<string, string>);
  } catch {
    await database.update(runMessages).set({ input: null, output: null, toolName: null }).where(eq(runMessages.runId, runId));
    return;
  }
  await redactRunMessages(database, runId, secrets);
}
