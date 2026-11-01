import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createDatabase, jobs } from "@weft/db";
import { enqueueJob, runNextJob } from "../src";
import { withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const uniqueType = () => `test-${crypto.randomUUID()}`;

test.concurrent("a job runs to completion and is marked succeeded", async () => {
  await withRollback(db, async (transaction) => {
    const type = uniqueType();
    const seen: unknown[] = [];
    const id = await enqueueJob(transaction, { type, payload: { n: 1 } });
    const result = await runNextJob(transaction, { [type]: async (_db, payload) => { seen.push(payload); } });
    expect(result).toEqual({ status: "succeeded", jobId: id!, type });
    expect(seen).toEqual([{ n: 1 }]);
    const [row] = await transaction.select().from(jobs).where(eq(jobs.id, id!));
    expect(row!.status).toBe("succeeded");
    expect(row!.attempts).toBe(1);
    expect(row!.finishedAt).not.toBeNull();
    expect(await runNextJob(transaction, { [type]: async () => {} })).toEqual({ status: "idle" });
  });
});

test.concurrent("a failing job is retried with backoff, then marked failed with its error", async () => {
  await withRollback(db, async (transaction) => {
    const type = uniqueType();
    const id = await enqueueJob(transaction, { type, payload: {}, maxAttempts: 2 });
    const handlers = { [type]: async () => { throw new Error("boom"); } };
    const t0 = new Date();
    expect(await runNextJob(transaction, handlers, { now: () => t0, retryDelayMs: 1000 })).toMatchObject({ status: "retrying", jobId: id });
    let [row] = await transaction.select().from(jobs).where(eq(jobs.id, id!));
    expect(row!.status).toBe("pending");
    expect(row!.lastError).toContain("boom");
    // Backoff: not runnable before its retry time.
    expect(await runNextJob(transaction, handlers, { now: () => t0, retryDelayMs: 1000 })).toEqual({ status: "idle" });
    const later = new Date(t0.getTime() + 60_000);
    expect(await runNextJob(transaction, handlers, { now: () => later, retryDelayMs: 1000 })).toMatchObject({ status: "failed", jobId: id });
    [row] = await transaction.select().from(jobs).where(eq(jobs.id, id!));
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(2);
    expect(row!.lastError).toContain("boom");
    expect(await runNextJob(transaction, handlers, { now: () => later })).toEqual({ status: "idle" });
  });
});

test.concurrent("a job with no registered handler type is left untouched", async () => {
  await withRollback(db, async (transaction) => {
    const type = uniqueType();
    const id = await enqueueJob(transaction, { type, payload: {} });
    expect(await runNextJob(transaction, { [uniqueType()]: async () => {} })).toEqual({ status: "idle" });
    const [row] = await transaction.select().from(jobs).where(eq(jobs.id, id!));
    expect(row!.status).toBe("pending");
  });
});

test.concurrent("an open job with the same dedupe key is not enqueued twice", async () => {
  await withRollback(db, async (transaction) => {
    const type = uniqueType();
    const first = await enqueueJob(transaction, { type, payload: {}, dedupeKey: type });
    expect(first).not.toBeNull();
    expect(await enqueueJob(transaction, { type, payload: {}, dedupeKey: type })).toBeNull();
    await runNextJob(transaction, { [type]: async () => {} });
    expect(await enqueueJob(transaction, { type, payload: {}, dedupeKey: type })).not.toBeNull();
  });
});

test.concurrent("a crashed worker's stale running job is picked up again", async () => {
  await withRollback(db, async (transaction) => {
    const type = uniqueType();
    const id = await enqueueJob(transaction, { type, payload: {} });
    const t0 = new Date();
    await transaction.update(jobs).set({ status: "running", attempts: 1, lockedAt: t0 }).where(eq(jobs.id, id!));
    const handlers = { [type]: async () => {} };
    expect(await runNextJob(transaction, handlers, { now: () => t0, lockTimeoutMs: 60_000 })).toEqual({ status: "idle" });
    const later = new Date(t0.getTime() + 120_000);
    expect(await runNextJob(transaction, handlers, { now: () => later, lockTimeoutMs: 60_000 })).toMatchObject({ status: "succeeded", jobId: id });
  });
});

test("concurrent workers never run the same job twice (SKIP LOCKED)", async () => {
  const type = uniqueType();
  const ran: string[] = [];
  const ids: string[] = [];
  try {
    for (let i = 0; i < 6; i++) ids.push((await enqueueJob(db, { type, payload: { i } }))!);
    const handlers = { [type]: async (_db: unknown, payload: unknown) => { ran.push(String((payload as { i: number }).i)); await Bun.sleep(30); } };
    await Promise.all(Array.from({ length: 4 }, async () => { while ((await runNextJob(db, handlers)).status !== "idle"); }));
    expect(ran.sort()).toEqual(["0", "1", "2", "3", "4", "5"]);
    const rows = await db.select().from(jobs).where(inArray(jobs.id, ids));
    expect(rows.every((row) => row.status === "succeeded" && row.attempts === 1)).toBe(true);
  } finally {
    await db.delete(jobs).where(eq(jobs.type, type));
  }
});
