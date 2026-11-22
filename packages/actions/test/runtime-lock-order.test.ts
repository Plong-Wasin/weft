import { afterAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { agents as agentRows, createDatabase, jobs, runs, workspaces } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory } from "../../db/src/test-helpers";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions, withAgentRunProjectAuthorization } from "../src";

const { client, db } = createDatabase();
const { client: monitorClient, db: monitorDb } = createDatabase();
const { client: rebindClient, db: rebindDb } = createDatabase();
afterAll(async () => { await Promise.all([client.end(), monitorClient.end(), rebindClient.end()]); });

async function waitForLock(queryPattern: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await monitorDb.execute(sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike ${`%${queryPattern}%`}`);
    if (rows.length) return true;
    await Bun.sleep(20);
  }
  return false;
}

test.serial("claim and unshare acquire Runtime before Run locks (regresses the former deadlock deterministically)", async () => {
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

test.serial("a Run-token read holds Originator Project rights stable until its protected read finishes", async () => {
  const workspace = await createWorkspaceFactory(db);
  await db.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const admin = await createMemberFactory(db, workspace.id, "Admin");
  const owner = await createMemberFactory(db, workspace.id, "Member");
  const originator = await createMemberFactory(db, workspace.id, "Member");
  const projectActions = createProjectActions(db);
  const project = await projectActions.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Run read boundary", key: `RB${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
  for (const userId of [owner.id, originator.id]) await projectActions.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId, role: "Member" });
  const token = await createApiTokenActions(db).createApiToken.handler({ userId: owner.id }, { name: "runtime" });
  const runtimeActions = createRuntimeActions(db);
  const registered = await runtimeActions.registerDaemon.handler({ userId: owner.id, apiTokenId: token.id }, { hostname: "read-boundary", version: "1", agentClis: ["codex"] });
  const runtime = registered.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
  const agents = createAgentActions(db);
  const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Read boundary Agent", model: "default", runtimeId: runtime.id });
  await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
  await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [originator.id] });
  const item = await createWorkItemActions(db).createWorkItem.handler({ userId: originator.id }, { projectId: project.id, title: "Protected Run read", assigneeIds: [agent.userId] });
  const [claimed] = await createRuntimeDispatchActions(db).claimRuns({ userId: owner.id, daemonId: registered.daemonId });
  expect(claimed?.status).toBe("dispatched");

  let release!: () => void;
  let readStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const read = withAgentRunProjectAuthorization(db, claimed!.runId, async (state) => {
    readStarted();
    await gate;
    return state;
  });
  let revoke: Promise<unknown> | undefined;
  try {
    await started;
    revoke = projectActions.removeProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: originator.id });
    const revocationWaiting = await waitForLock('"project_members"');
    expect(revocationWaiting).toBe(true);
    release();
    const [readState] = await Promise.all([read, revoke]);
    expect(readState).toMatchObject({ active: true, allowed: true });
    const afterRevocation = await withAgentRunProjectAuthorization(db, claimed!.runId, async (state) => state.allowed);
    expect(afterRevocation).toBe(false);

    await projectActions.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: originator.id, role: "Member" });
    let releaseOwnerRead!: () => void;
    let ownerReadStarted!: () => void;
    const ownerReadGate = new Promise<void>((resolve) => { releaseOwnerRead = resolve; });
    const ownerReadReady = new Promise<void>((resolve) => { ownerReadStarted = resolve; });
    const ownerRead = withAgentRunProjectAuthorization(db, claimed!.runId, async (state) => {
      ownerReadStarted();
      await ownerReadGate;
      return state;
    });
    let revokeOwner: Promise<unknown> | undefined;
    try {
      await ownerReadReady;
      revokeOwner = projectActions.removeProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: owner.id });
      expect(await waitForLock('"project_members"')).toBe(true);
      releaseOwnerRead();
      const [ownerReadState] = await Promise.all([ownerRead, revokeOwner]);
      expect(ownerReadState).toMatchObject({ active: true, allowed: true });
      expect(await withAgentRunProjectAuthorization(db, claimed!.runId, async (state) => state.allowed)).toBe(false);
    } finally {
      releaseOwnerRead();
      await ownerRead.catch(() => undefined);
      if (revokeOwner) await revokeOwner.catch(() => undefined);
    }
    expect(item.id).toBeTruthy();
  } finally {
    release();
    await read.catch(() => undefined);
    if (revoke) await revoke.catch(() => undefined);
    await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
  }
});

test.serial("rebinding serializes with a pending Run start and revokes the old Runtime's Run", async () => {
  const workspace = await createWorkspaceFactory(db);
  await db.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const admin = await createMemberFactory(db, workspace.id, "Admin");
  const owner = await createMemberFactory(db, workspace.id, "Member");
  const requester = await createMemberFactory(db, workspace.id, "Member");
  const token = await createApiTokenActions(db).createApiToken.handler({ userId: owner.id }, { name: "runtime" });
  const runtimeActions = createRuntimeActions(db);
  const registered = await runtimeActions.registerDaemon.handler({ userId: owner.id, apiTokenId: token.id }, { hostname: "rebind-order", version: "1", agentClis: ["claude", "codex"] });
  const oldRuntime = registered.runtimes.find((runtime) => runtime.agentCli === "claude")!;
  const newRuntime = registered.runtimes.find((runtime) => runtime.agentCli === "codex")!;
  await runtimeActions.shareRuntime.handler({ userId: owner.id }, { runtimeId: oldRuntime.id });
  await runtimeActions.shareRuntime.handler({ userId: owner.id }, { runtimeId: newRuntime.id });
  const projects = createProjectActions(db);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Rebind race", key: `RR${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: owner.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: requester.id, role: "Member" });
  const agents = createAgentActions(db);
  const rebindAgents = createAgentActions(rebindDb);
  const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Rebound Agent", model: "default", runtimeId: oldRuntime.id });
  await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
  await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [owner.id, admin.id, requester.id] });
  const item = await createWorkItemActions(db).createWorkItem.handler({ userId: requester.id }, { projectId: project.id, title: "Run before move", assigneeIds: [agent.userId] });
  const [claimed] = await createRuntimeDispatchActions(db).claimRuns({ userId: owner.id, daemonId: registered.daemonId });
  expect(claimed?.status).toBe("dispatched");
  await db.insert(runs).values({ workspaceId: workspace.id, projectId: project.id, workItemId: item.id, agentId: agent.id, originatorId: requester.id, status: "follow_up", followUpSince: new Date() });

  let release!: () => void;
  let held!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holdReady = new Promise<void>((resolve) => { held = resolve; });
  const runLock = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('runtime-run-secret-write'), hashtext(${claimed!.runId}))`);
    held();
    await gate;
  });
  let rebind: Promise<unknown> | undefined;
  let start: Promise<{ ok: true } | { error: unknown }> | undefined;
  try {
    await holdReady;
    rebind = rebindAgents.updateAgent.handler({ userId: admin.id }, { agentId: agent.id, runtimeId: newRuntime.id }).then((result) => result, (error) => ({ error }));
    const rebindWaiting = await waitForLock("pg_advisory_xact_lock(hashtext('runtime-run-secret-write')");
    expect(rebindWaiting).toBe(true);
    start = createRuntimeDispatchActions(db).startRun(claimed!.runId, oldRuntime.id).then(() => ({ ok: true as const }), (error) => ({ error }));
    // Rebinding owns the old Runtime row while it revokes Runs, so startRun cannot turn a stale claim into active work.
    const startWaiting = await waitForLock('"runtimes"."id"');
    expect(startWaiting).toBe(true);
    release();
    await runLock;
    const [rebound, started] = await Promise.all([rebind, start]);
    expect(rebound).toMatchObject({ runtimeId: newRuntime.id });
    expect(started).toMatchObject({ error: expect.objectContaining({ status: 409 }) });
    expect(await db.select({ status: runs.status, runtimeId: runs.runtimeId, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, claimed!.runId)))
      .toEqual([{ status: "failed", runtimeId: oldRuntime.id, failureReason: "Agent was rebound to another Runtime" }]);
    expect((await db.select({ runtimeId: agentRows.runtimeId, memberOwned: agentRows.memberOwned }).from(agentRows).where(eq(agentRows.id, agent.id)))[0]).toMatchObject({ runtimeId: newRuntime.id, memberOwned: false });
    const chainRows = await db.select({ id: runs.id, status: runs.status }).from(runs).where(eq(runs.workItemId, item.id));
    expect(chainRows.map((row) => row.status).sort()).toEqual(["failed", "queued"]);
    const notificationJobs = await db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.type, "notify"));
    expect(notificationJobs.some(({ payload }) => payload && typeof payload === "object" && "detail" in payload && payload.detail === "runtime_rebound" && "recipientIds" in payload && Array.isArray(payload.recipientIds) && payload.recipientIds.includes(requester.id))).toBe(true);
    // Clear the queued follow-up from this race fixture before setting up a separate already-started process.
    await db.update(runs).set({ status: "failed", failureReason: "test_fixture_complete" }).where(and(eq(runs.workItemId, item.id), eq(runs.status, "queued")));

    const alreadyRunning = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Already running Agent", model: "default", runtimeId: oldRuntime.id });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: alreadyRunning.id, allProjects: false, projectIds: [project.id] });
    await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: alreadyRunning.id, userIds: [owner.id, admin.id, requester.id] });
    const runningItem = await createWorkItemActions(db).createWorkItem.handler({ userId: requester.id }, { projectId: project.id, title: "Already running before move", assigneeIds: [alreadyRunning.userId] });
    const dispatch = createRuntimeDispatchActions(db);
    const [runningClaim] = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId });
    expect(runningClaim?.workItemId).toBe(runningItem.id);
    await dispatch.startRun(runningClaim!.runId, oldRuntime.id);
    await agents.updateAgent.handler({ userId: admin.id }, { agentId: alreadyRunning.id, runtimeId: newRuntime.id });
    expect((await db.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, runningClaim!.runId)))[0])
      .toEqual({ status: "stopping", failureReason: "Agent was rebound to another Runtime" });
    expect(await dispatch.authenticateRunToken(runningClaim!.token)).toBeNull();

    const claimRaceAgent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Claim race Agent", model: "default", runtimeId: oldRuntime.id });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: claimRaceAgent.id, allProjects: false, projectIds: [project.id] });
    await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: claimRaceAgent.id, userIds: [owner.id, admin.id, requester.id] });
    const claimRaceItem = await createWorkItemActions(db).createWorkItem.handler({ userId: requester.id }, { projectId: project.id, title: "Queued during move", assigneeIds: [claimRaceAgent.userId] });
    const [claimRaceRun] = await db.select({ id: runs.id }).from(runs).where(eq(runs.workItemId, claimRaceItem.id));
    let releaseClaimGate!: () => void;
    let claimLocked!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaimGate = resolve; });
    const claimHoldReady = new Promise<void>((resolve) => { claimLocked = resolve; });
    const claimHold = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'runtime-claims:' + registered.daemonId}, 0))`);
      claimLocked();
      await claimGate;
    });
    let racedClaim: Promise<Array<{ runId: string; runtimeId: string }> | { error: unknown }> | undefined;
    let claimRebind: Promise<unknown> | undefined;
    try {
      await claimHoldReady;
      racedClaim = createRuntimeDispatchActions(db).claimRuns({ userId: owner.id, daemonId: registered.daemonId }).then((rows) => rows, (error) => ({ error }));
      const waitingOnClaimLock = await waitForLock("hashtextextended($1, 0)");
      expect(waitingOnClaimLock).toBe(true);
      claimRebind = rebindAgents.updateAgent.handler({ userId: admin.id }, { agentId: claimRaceAgent.id, runtimeId: newRuntime.id });
      await claimRebind;
      releaseClaimGate();
      await claimHold;
      const claimResult = await racedClaim;
      if (Array.isArray(claimResult)) {
        const claimedRaceRun = claimResult.find((row) => row.runId === claimRaceRun!.id);
        if (claimedRaceRun) expect(claimedRaceRun.runtimeId).toBe(newRuntime.id);
      } else throw claimResult.error;
      const [finalRaceRun] = await db.select({ status: runs.status, runtimeId: runs.runtimeId }).from(runs).where(eq(runs.id, claimRaceRun!.id));
      expect(finalRaceRun?.status === "queued" || finalRaceRun?.runtimeId === newRuntime.id).toBe(true);
    } finally {
      releaseClaimGate();
      await claimHold.catch(() => undefined);
      if (claimRebind) await claimRebind.catch(() => undefined);
      if (racedClaim) await racedClaim.catch(() => undefined);
    }
  } finally {
    release();
    await runLock.catch(() => undefined);
    if (rebind) await rebind.catch(() => undefined);
    if (start) await start.catch(() => undefined);
    await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
  }
});
