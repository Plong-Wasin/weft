import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, comments, createDatabase, runs } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createApiTokenActions, createRuntimeActions, createRuntimeDispatchActions } from "../src";
import { createAgentActions, createProjectActions, createWorkItemActions } from "../src";

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
    const workspace = await createWorkspaceFactory(tx);
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
    const dispatch = createRuntimeDispatchActions(tx);
    const claimed = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ status: "dispatched", instructions: "Do the work", model: "opus" });
    expect(claimed[0]!.request).toContain("Runtime work");
    expect(claimed[0]!.token).toStartWith("weft_run_");
    expect(await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, claimed[0]!.runId))).toEqual([{ status: "dispatched" }]);
    expect(await dispatch.authenticateRunToken(claimed[0]!.token)).toMatchObject({ userId: member.id, runId: claimed[0]!.runId });
    await dispatch.startRun(claimed[0]!.runId, runtime.id);
    await createWorkItemActions(tx).updateWorkItem.handler({ userId: member.id, source: "agent", agent: { agentUserId: agent.userId, runId: claimed[0]!.runId, originatorId: member.id, autopilot: true } }, { workItemId: item.id, title: "Updated by Runtime" });
    expect(await tx.select({ source: activities.source }).from(activities).where(eq(activities.runId, claimed[0]!.runId))).toMatchObject([{ source: "agent_autopilot" }]);
    await dispatch.finishRun(claimed[0]!.runId, { status: "completed", finalOutput: "Finished the requested work." });
    expect(await dispatch.authenticateRunToken(claimed[0]!.token)).toBeNull();
    expect(await tx.select({ runId: comments.runId }).from(comments).where(eq(comments.runId, claimed[0]!.runId))).toHaveLength(1);
  });
});
