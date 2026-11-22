import { afterAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createDatabase, runs, workspaces } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory } from "../../db/src/test-helpers";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions } from "../src";

const { client, db } = createDatabase();
const { client: monitorClient, db: monitorDb } = createDatabase();
afterAll(async () => { await Promise.all([client.end(), monitorClient.end()]); });

async function waitForLock(queryPattern: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await monitorDb.execute(sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike ${`%${queryPattern}%`}`);
    if (rows.length) return true;
    await Bun.sleep(20);
  }
  return false;
}

test("claim and unshare acquire Runtime before Run locks (regresses the former deadlock deterministically)", async () => {
  const workspace = await createWorkspaceFactory(db);
  await db.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const owner = await createMemberFactory(db, workspace.id, "Admin");
  const token = await createApiTokenActions(db).createApiToken.handler({ userId: owner.id }, { name: "runtime" });
  const runtimeActions = createRuntimeActions(db);
  const registered = await runtimeActions.registerDaemon.handler({ userId: owner.id, apiTokenId: token.id }, { hostname: "lock-order", version: "1", agentClis: ["codex"] });
  const runtime = registered.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
  const project = await createProjectActions(db).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Lock order", key: `LO${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
  const agent = await createAgentActions(db).createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Lock order Agent", model: "default", runtimeId: runtime.id });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
  const item = await createWorkItemActions(db).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Pending before unshare", assigneeIds: [agent.userId] });
  const [run] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.workItemId, item.id), eq(runs.status, "queued")));
  expect(run).toBeDefined();

  let release!: () => void;
  let held!: () => void;
  const releaseGate = new Promise<void>((resolve) => { release = resolve; });
  const holdReady = new Promise<void>((resolve) => { held = resolve; });
  const runLock = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('runtime-run-secret-write'), hashtext(${run!.id}))`);
    held();
    await releaseGate;
  });
  let unshareResult: Promise<{ ok: true } | { error: unknown }> | undefined;
  let claimResult: Promise<unknown[] | { error: unknown }> | undefined;
  try {
    await holdReady;
    unshareResult = runtimeActions.unshareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id }).then(() => ({ ok: true as const }), (error) => ({ error }));
    // The real unshare handler now holds the Runtime row and waits for this Run's secret-write lock before revoking it.
    const unshareWaiting = await waitForLock("pg_advisory_xact_lock(hashtext('runtime-run-secret-write')");
    expect(unshareWaiting).toBe(true);
    claimResult = createRuntimeDispatchActions(db).claimRuns({ userId: owner.id, daemonId: registered.daemonId }).then((rows) => rows, (error) => ({ error }));
    // With the old ordering claim waited for this Runtime after locking the queued Run; unshare then waited for that Run.
    // With Runtime-first ordering, claim waits here without owning any Run row, letting unshare finish after the gate opens.
    const claimWaiting = await waitForLock('"runtimes"."id"');
    expect(claimWaiting).toBe(true);
    release();
    await runLock;
    const [unshared, claimed] = await Promise.all([unshareResult, claimResult]);
    expect(unshared).toEqual({ ok: true });
    expect(claimed).toEqual([]);
    expect(await db.select({ status: runs.status }).from(runs).where(eq(runs.id, run!.id))).toEqual([{ status: "failed" }]);
  } finally {
    release();
    await runLock.catch(() => undefined);
    if (unshareResult) await unshareResult;
    if (claimResult) await claimResult;
    await db.delete((await import("@weft/db")).workspaces).where(eq((await import("@weft/db")).workspaces.id, workspace.id));
  }
});
