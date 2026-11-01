import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { jobs, type Database } from "@weft/db";

export type JobHandler = (db: Database, payload: any, job: { id: string; type: string }) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

export interface EnqueueInput {
  type: string;
  payload?: unknown;
  runAt?: Date;
  maxAttempts?: number;
  /** While a pending or running job holds this key, another enqueue with it is skipped. */
  dedupeKey?: string;
}

/** Inserts a job and returns its id, or null when an open job already holds the dedupe key. Pass a transaction to enqueue atomically with a write. */
export async function enqueueJob(database: Database, input: EnqueueInput): Promise<string | null> {
  const [row] = await database.insert(jobs).values({
    type: input.type, payload: input.payload ?? {}, runAt: input.runAt ?? sql`now()`, maxAttempts: input.maxAttempts ?? 3, dedupeKey: input.dedupeKey ?? null,
  }).onConflictDoNothing().returning({ id: jobs.id });
  return row?.id ?? null;
}

export interface RunOptions {
  now?: () => Date;
  /** Base of the exponential retry delay: attempt n waits `retryDelayMs * 2^(n-1)`. */
  retryDelayMs?: number;
  /** A running job locked longer ago than this is treated as abandoned by a crashed worker. */
  lockTimeoutMs?: number;
}

export type RunResult =
  | { status: "idle" }
  | { status: "succeeded" | "retrying" | "failed"; jobId: string; type: string };

/**
 * Claims one runnable job of a handled type with FOR UPDATE SKIP LOCKED, runs it, and records the outcome.
 * The claim commits before the handler runs, so a long job holds no row lock.
 */
export async function runNextJob(database: Database, handlers: JobHandlers, options: RunOptions = {}): Promise<RunResult> {
  const now = (options.now ?? (() => new Date()))();
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const staleBefore = new Date(now.getTime() - (options.lockTimeoutMs ?? 5 * 60_000));
  const types = Object.keys(handlers);
  if (types.length === 0) return { status: "idle" };

  const claimed = await database.transaction(async (transaction) => {
    const database = transaction as unknown as Database;
    const [candidate] = await database.select().from(jobs)
      .where(and(inArray(jobs.type, types), or(
        and(eq(jobs.status, "pending"), lte(jobs.runAt, now)),
        and(eq(jobs.status, "running"), lte(jobs.lockedAt, staleBefore)),
      )))
      .orderBy(jobs.runAt, jobs.createdAt).limit(1).for("update", { skipLocked: true });
    if (!candidate) return null;
    const [row] = await database.update(jobs).set({ status: "running", attempts: candidate.attempts + 1, lockedAt: now }).where(eq(jobs.id, candidate.id)).returning();
    return row!;
  });
  if (!claimed) return { status: "idle" };

  try {
    await handlers[claimed.type]!(database, claimed.payload, { id: claimed.id, type: claimed.type });
    await database.update(jobs).set({ status: "succeeded", lockedAt: null, lastError: null, finishedAt: now }).where(eq(jobs.id, claimed.id));
    return { status: "succeeded", jobId: claimed.id, type: claimed.type };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claimed.attempts >= claimed.maxAttempts) {
      await database.update(jobs).set({ status: "failed", lockedAt: null, lastError: message, finishedAt: now }).where(eq(jobs.id, claimed.id));
      return { status: "failed", jobId: claimed.id, type: claimed.type };
    }
    const runAt = new Date(now.getTime() + retryDelayMs * 2 ** (claimed.attempts - 1));
    await database.update(jobs).set({ status: "pending", lockedAt: null, lastError: message, runAt }).where(eq(jobs.id, claimed.id));
    return { status: "retrying", jobId: claimed.id, type: claimed.type };
  }
}
