import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, comments, createDatabase, daemons, runs, runtimes, workspaces } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createApiTokenActions, createRuntimeActions, createRuntimeDispatchActions, sweepRuntimeRuns } from "../src";
import { createAgentActions, createMemberActions, createProjectActions, createWorkItemActions } from "../src";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("a Daemon registers one private Runtime per detected CLI and workspace", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Member");
    const actions = createRuntimeActions(tx);
    const { id: tokenId } = await createApiTokenActions(tx).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const daemon = await actions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1.0", agentClis: ["claude", "codex"] });
    expect(daemon.runtimes).toHaveLength(2);
    expect(daemon.runtimes.map((runtime) => runtime.agentCli).sort()).toEqual(["claude", "codex"]);
    expect(daemon.runtimes.every((runtime) => runtime.ownerId === owner.id && !runtime.shared && runtime.online)).toBe(true);
    expect((await actions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1.0", agentClis: ["claude", "codex"] })).runtimes.map((r) => r.id)).toEqual(daemon.runtimes.map((r) => r.id));
  });
});

test.concurrent("members see their private and shared Runtimes, but private Runtimes stay hidden", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Member");
    const { id: tokenId } = await createApiTokenActions(tx).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const actions = createRuntimeActions(tx);
    const { runtimes } = await actions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1.0", agentClis: ["claude", "codex"] });
    const mine = await actions.listRuntimes.handler({ userId: owner.id }, { workspaceId: workspace.id });
    expect(mine).toHaveLength(2);
    expect(await actions.listRuntimes.handler({ userId: admin.id }, { workspaceId: workspace.id })).toEqual([]);
    await actions.shareRuntime.handler({ userId: owner.id }, { runtimeId: runtimes[0]!.id });
    expect(await actions.listRuntimes.handler({ userId: admin.id }, { workspaceId: workspace.id })).toMatchObject([{ id: runtimes[0]!.id, shared: true, ownerId: owner.id }]);
    await expect(actions.unshareRuntime.handler({ userId: admin.id }, { runtimeId: runtimes[0]!.id })).rejects.toMatchObject({ status: 403 });
    await actions.unshareRuntime.handler({ userId: owner.id }, { runtimeId: runtimes[0]!.id });
    expect(await actions.listRuntimes.handler({ userId: admin.id }, { workspaceId: workspace.id })).toEqual([]);
  });
});

test.concurrent("Runtime presence expires after 150 seconds and the Daemon heartbeat restores it", async () => {
  await withRollback(db, async (tx) => {
    let current = new Date("2026-11-03T00:00:00.000Z");
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Member");
    const { id: tokenId } = await createApiTokenActions(tx).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const actions = createRuntimeActions(tx, () => current);
    const { daemonId } = await actions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    expect((await actions.listRuntimes.handler({ userId: owner.id }, { workspaceId: workspace.id }))[0]!.online).toBe(true);
    current = new Date(current.getTime() + 150_001);
    expect((await actions.listRuntimes.handler({ userId: owner.id }, { workspaceId: workspace.id }))[0]!.online).toBe(false);
    await actions.heartbeat({ userId: owner.id }, daemonId);
    expect((await actions.listRuntimes.handler({ userId: owner.id }, { workspaceId: workspace.id }))[0]!.online).toBe(true);
  });
});

test.concurrent("an online Runtime claims its queued Run as dispatched and returns a scoped Run token", async () => {
  await withRollback(db, async (tx) => {
    let now = new Date("2026-11-03T00:00:00.000Z");
    const workspace = await createWorkspaceFactory(tx);
    await tx.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const { id: tokenId } = await createApiTokenActions(tx).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const registry = createRuntimeActions(tx);
    const registered = await registry.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    const runtime = registered.runtimes[0]!;
    await registry.shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
    const project = await createProjectActions(tx).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
    const member = await createMemberFactory(tx, workspace.id, "Member");
    await createProjectActions(tx).addProjectMember.handler({ userId: owner.id }, { projectId: project.id, userId: member.id, role: "Member" });
    const agent = await createAgentActions(tx).createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Bot", instructions: "Do the work", model: "default" });
    await createAgentActions(tx).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await createAgentActions(tx).updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId: runtime.id, cliModel: "opus" });
    const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Runtime work", assigneeIds: [agent.userId] });
    const dispatch = createRuntimeDispatchActions(tx, () => now);
    const claimed = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ status: "dispatched", instructions: "Do the work", model: "opus" });
    expect(claimed[0]!.request).toContain("Runtime work");
    expect(claimed[0]!.token).toStartWith("weft_run_");
    expect(await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, claimed[0]!.runId))).toEqual([{ status: "dispatched" }]);
    expect(await dispatch.authenticateRunToken(claimed[0]!.token)).toMatchObject({ userId: member.id, runId: claimed[0]!.runId });
    now = new Date(now.getTime() + 300_001);
    await sweepRuntimeRuns(tx, () => now);
    expect(await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, claimed[0]!.runId))).toEqual([{ status: "queued" }]);
    const [reclaimed] = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    expect(reclaimed?.runId).toBe(claimed[0]!.runId);
    await dispatch.startRun(claimed[0]!.runId, runtime.id);
    await createWorkItemActions(tx).updateWorkItem.handler({ userId: member.id, source: "agent", agent: { agentUserId: agent.userId, runId: claimed[0]!.runId, originatorId: member.id, autopilot: true } }, { workItemId: item.id, title: "Updated by Runtime" });
    expect(await tx.select({ source: activities.source }).from(activities).where(eq(activities.runId, claimed[0]!.runId))).toMatchObject([{ source: "agent_autopilot" }]);
    await dispatch.finishRun(claimed[0]!.runId, { status: "completed", finalOutput: "Finished the requested work." });
    expect(await dispatch.authenticateRunToken(claimed[0]!.token)).toBeNull();
    expect(await tx.select({ runId: comments.runId }).from(comments).where(eq(comments.runId, claimed[0]!.runId))).toHaveLength(1);

    const retryItem = await createWorkItemActions(tx).createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Retry timed out work", assigneeIds: [agent.userId] });
    const [retryRun] = await tx.select().from(runs).where(eq(runs.workItemId, retryItem.id));
    const [toTimeout] = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    await dispatch.startRun(toTimeout!.runId, runtime.id);
    now = new Date(now.getTime() + 9_000_000);
    await tx.update(daemons).set({ lastHeartbeatAt: now }).where(eq(daemons.id, registered.daemonId));
    await sweepRuntimeRuns(tx, () => now);
    expect(await tx.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, retryRun!.id))).toEqual([{ status: "failed", failureReason: "timeout" }]);
    expect(await tx.select({ status: runs.status, attempt: runs.attempt, rerunOfId: runs.rerunOfId }).from(runs).where(eq(runs.rerunOfId, retryRun!.id))).toEqual([{ status: "queued", attempt: 1, rerunOfId: retryRun!.id }]);

    const offlineItem = await createWorkItemActions(tx).createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Retry offline work", assigneeIds: [agent.userId] });
    const [offlineRun] = await tx.select().from(runs).where(eq(runs.workItemId, offlineItem.id));
    const toLoseHeartbeat = (await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20)).find((run) => run.runId === offlineRun!.id);
    expect(toLoseHeartbeat).toBeDefined();
    await dispatch.startRun(toLoseHeartbeat!.runId, runtime.id);
    now = new Date(now.getTime() + 150_001);
    await tx.update(daemons).set({ lastHeartbeatAt: new Date(now.getTime() - 150_001) }).where(eq(daemons.id, registered.daemonId));
    await sweepRuntimeRuns(tx, () => now);
    expect(await tx.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, offlineRun!.id))).toEqual([{ status: "failed", failureReason: "runtime_offline" }]);
    expect(await tx.select({ status: runs.status, attempt: runs.attempt }).from(runs).where(eq(runs.rerunOfId, offlineRun!.id))).toEqual([{ status: "queued", attempt: 1 }]);
  });
});

async function runtimeScenario(tx: Parameters<Parameters<typeof withRollback>[1]>[0], role: "Member" | "Admin" = "Member") {
  const workspace = await createWorkspaceFactory(tx);
  await tx.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const owner = await createMemberFactory(tx, workspace.id, role);
  const { id: tokenId } = await createApiTokenActions(tx).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
  const registry = createRuntimeActions(tx);
  const registered = await registry.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
  const runtime = registered.runtimes[0]!;
  await registry.shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
  const project = await createProjectActions(tx).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
  const agents = createAgentActions(tx);
  const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", instructions: "Do the work", model: "default" });
  await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  await agents.updateAgent.handler({ userId: admin.id }, { agentId: agent.id, runtimeId: runtime.id });
  const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Work", assigneeIds: [agent.userId] });
  return { workspace, admin, owner, registered, runtime, agent, agents, item, project };
}

test.concurrent("a removed member's Runtime stops receiving Runs and is unshared, and a Guest cannot share one", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, admin, owner, registered, runtime } = await runtimeScenario(tx);
    await createMemberActions(tx).removeMember.handler({ userId: admin.id }, { workspaceId: workspace.id, userId: owner.id });
    expect(await createRuntimeDispatchActions(tx).claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20)).toEqual([]);
    expect((await tx.select({ shared: runtimes.shared }).from(runtimes).where(eq(runtimes.id, runtime.id)))[0]!.shared).toBe(false);
    const guest = await createMemberFactory(tx, workspace.id, "Guest");
    const { id: guestToken } = await createApiTokenActions(tx).createApiToken.handler({ userId: guest.id }, { name: "daemon" });
    const guestRegistration = await createRuntimeActions(tx).registerDaemon.handler({ userId: guest.id, apiTokenId: guestToken }, { hostname: "guest", version: "1", agentClis: ["codex"] });
    await expect(createRuntimeActions(tx).shareRuntime.handler({ userId: guest.id }, { runtimeId: guestRegistration.runtimes.find((entry) => entry.workspaceId === workspace.id)!.id })).rejects.toThrow();
  });
});

test.concurrent("a cancelled Run whose Daemon went silent is settled as cancelled by the sweeper and its token stops working", async () => {
  await withRollback(db, async (tx) => {
    let now = new Date("2026-11-03T00:00:00.000Z");
    const { owner, registered, runtime, item } = await runtimeScenario(tx);
    const dispatch = createRuntimeDispatchActions(tx, () => now);
    const [claimed] = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    await dispatch.startRun(claimed!.runId, runtime.id);
    await tx.update(daemons).set({ lastHeartbeatAt: now }).where(eq(daemons.id, registered.daemonId));
    await tx.update(runs).set({ status: "stopping" }).where(eq(runs.id, claimed!.runId));
    expect(await dispatch.authenticateRunToken(claimed!.token)).toBeNull();
    now = new Date(now.getTime() + 151_000);
    await sweepRuntimeRuns(tx, () => now);
    expect((await tx.select({ status: runs.status }).from(runs).where(eq(runs.workItemId, item.id)))[0]!.status).toBe("cancelled");
  });
});

test.concurrent("the claim carries the work item, project, workspace and attached Skills the agent needs", async () => {
  await withRollback(db, async (tx) => {
    const { owner, registered, item, project, workspace } = await runtimeScenario(tx);
    const [claimed] = await createRuntimeDispatchActions(tx).claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    expect(claimed).toMatchObject({ workItemId: item.id, projectId: project.id, workspaceId: workspace.id, workItemDisplayId: `ALP-${item.sequence}`, skills: [] });
  });
});

test.concurrent("unbinding an Agent from its Runtime turns its Autopilot off", async () => {
  await withRollback(db, async (tx) => {
    const { admin, agent, agents } = await runtimeScenario(tx);
    expect((await agents.getAgent.handler({ userId: admin.id }, { agentId: agent.id })).autopilot).toBe(true);
    await agents.updateAgent.handler({ userId: admin.id }, { agentId: agent.id, runtimeId: null });
    expect((await agents.getAgent.handler({ userId: admin.id }, { agentId: agent.id })).autopilot).toBe(false);
  });
});
