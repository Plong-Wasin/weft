import { expect, test } from "bun:test";
import { containsRuntimeSecret } from "../src/runtime-secret-comments";

test("Runtime secret detection catches literal and supported encoded forms without returning the value", () => {
  const secrets = ["ordinary-value-92", "another/value+secret"];
  for (const output of [
    "printed ordinary-value-92 in a log",
    `encoded ${Buffer.from(secrets[0]!).toString("base64")}`,
    `url ${Buffer.from(secrets[1]!).toString("base64url")}`,
    `hex ${Buffer.from(secrets[0]!).toString("hex")}`,
  ]) {
    expect(containsRuntimeSecret(output, secrets)).toBe(true);
  }
  expect(containsRuntimeSecret("PATH=/bin and MODE=production", ["ordinary-value-92"])).toBe(false);
});

test("a late transcript append cannot outlive a terminal Run's cleanup", async () => {
  const { createDatabase, runs, runMessages } = await import("@weft/db");
  const { createWorkspaceFactory, createMemberFactory } = await import("../../db/src/test-helpers");
  const { createRuntimeDispatchActions } = await import("../src/runtime-dispatch");
  const { createProjectActions } = await import("../src/projects");
  const { eq, sql } = await import("drizzle-orm");
  const { db, client } = createDatabase();
  try {
    const workspace = await createWorkspaceFactory(db);
    const owner = await createMemberFactory(db, workspace.id, "Member");
    const project = await createProjectActions(db).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Late output", key: "LATE", visibility: "private" });
    const [run] = await db.insert(runs).values({ workspaceId: workspace.id, projectId: project.id, originatorId: owner.id, status: "running" }).returning();
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    const finish = db.transaction(async (tx) => {
      await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, run!.id)).for("update");
      locked();
      await unblock;
      await tx.update(runs).set({ status: "completed", runtimeEnvironmentSecrets: null }).where(eq(runs.id, run!.id));
    });
    await acquired;
    const append = createRuntimeDispatchActions(db).appendMessages(run!.id, [{ seq: 1, type: "response", output: "sensitive late output" }]).then(() => false, (error) => error.status === 409);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await db.execute(sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and (query like '%"run_messages"%' or (query like '%"runs"%' and query ilike '%for update%'))`)).length > 0;
      if (!waiting) await Bun.sleep(20);
    }
    release();
    await finish;
    expect(waiting).toBe(true);
    expect(await append).toBe(true);
    expect(await db.select().from(runMessages).where(eq(runMessages.runId, run!.id))).toHaveLength(0);
  } finally { await client.end(); }
});
