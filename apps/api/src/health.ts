import { sql } from "drizzle-orm";
import { createS3Storage } from "@weft/actions";
import type { Database } from "@weft/db";

/** A dependency probe. It throws when the dependency cannot be used; the message is never sent to callers. */
export interface HealthProbes {
  database: () => Promise<void>;
  storage: () => Promise<void>;
}

export type DependencyStatus = "ok" | "unreachable";
export type Readiness = { status: "ok" | "unavailable"; checks: Record<keyof HealthProbes, DependencyStatus> };

const probeTimeoutMs = 2_000;

/** Real probes: one query to Postgres, and a metadata request for a key that does not exist (not found means the bucket answered). */
export function defaultHealthProbes(db: Database): HealthProbes {
  return {
    database: async () => { await db.execute(sql`select 1`); },
    storage: async () => { await createS3Storage().head("health/readiness-probe"); },
  };
}

async function within(task: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), probeTimeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every probe. A failing probe shows as `unreachable`; the error text stays out of the result so no connection string or key can leak. */
export async function readiness(probes: HealthProbes): Promise<Readiness> {
  const names = Object.keys(probes) as (keyof HealthProbes)[];
  const results = await Promise.all(names.map(async (name) => {
    try { await within(probes[name]()); return [name, "ok"] as const; } catch { return [name, "unreachable"] as const; }
  }));
  const checks = Object.fromEntries(results) as Record<keyof HealthProbes, DependencyStatus>;
  const ok = results.every(([, status]) => status === "ok");
  return { status: ok ? "ok" : "unavailable", checks };
}
