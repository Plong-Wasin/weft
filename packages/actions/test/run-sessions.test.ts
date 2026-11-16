import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { agents, createDatabase, runs, workItems, workItemStates, workspaces, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createApiTokenActions, createRuntimeActions, createRuntimeDispatchActions, handleAgentRunJob, queueRunsForAssignees, type RunModel, type RunModelRequest, type RunModelResponse } from "../src";
import { createAgentActions, createProjectActions, createRunActions, createWorkItemActions } from "../src";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** One workspace with an Admin, a shared Claude Runtime and an Agent on it that may work in one project. */
async function setup(tx: Database) {
  const workspace = await createWorkspaceFactory(tx);
  await tx.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const owner = await createMemberFactory(tx, workspace.id, "Admin");
  const { id: tokenId } = await createApiTokenActions(tx).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
  const runtimeActions = createRuntimeActions(tx);
  const registered = await runtimeActions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] });
  for (const runtime of registered.runtimes) await runtimeActions.shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
  const claude = registered.runtimes.find((runtime) => runtime.agentCli === "claude")!;
  const codex = registered.runtimes.find((runtime) => runtime.agentCli === "codex")!;
  const agentActions = createAgentActions(tx);
  const agent = await agentActions.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Coder", model: "default", runtimeId: claude.id });
  const project = await createProjectActions(tx).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Sessions", key: "SES", visibility: "private" });
  await agentActions.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
  const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Round trip", assigneeIds: [agent.userId] });
  const daemonId = registered.daemonId;
  const dispatch = createRuntimeDispatchActions(tx);
  /** Queues the next Run of the Agent on the work item, the way a new assignment does. */
  const queueNext = () => queueRunsForAssignees(tx, { originatorId: owner.id, project: { id: project.id, workspaceId: workspace.id }, workItemId: item.id, assigneeUserIds: [agent.userId] });
  const latestRun = async () => (await tx.select().from(runs).where(eq(runs.workItemId, item.id)).orderBy(runs.createdAt)).at(-1)!;
  /** Claims the queued Run, starts it and finishes it with the given outcome; returns the claim payload. */
  const runOnce = async (outcome: { status: "completed" | "failed"; finalOutput: string; failureReason?: string; sessionId?: string }, runtimeId = claude.id) => {
    const [claimed] = await dispatch.claimRuns({ userId: owner.id, daemonId }, 20).then((rows) => rows.filter((row) => row.workItemId === item.id));
    await dispatch.startRun(claimed!.runId, runtimeId);
    await dispatch.finishRun(claimed!.runId, { status: outcome.status, finalOutput: outcome.finalOutput, failureReason: outcome.failureReason, session: outcome.sessionId ? { id: outcome.sessionId, mode: "new", reason: "first" } : undefined });
    return claimed!;
  };
  return { workspace, owner, agent, item, claude, codex, daemonId, dispatch, queueNext, latestRun, runOnce, runs: createRunActions(tx), tx };
}

test.concurrent("a Run resumes the Session of the previous completed Run in the same folder", async () => {
  await withRollback(db, async (tx) => {
    const ctx = await setup(tx);
    const first = await ctx.runOnce({ status: "completed", finalOutput: "round one", sessionId: "sess-1" });
    expect(first.session).toMatchObject({ resumeSessionId: null, reason: "first" });
    await ctx.queueNext();
    const second = await ctx.runOnce({ status: "completed", finalOutput: "round two" });
    expect(second.session).toMatchObject({ folder: first.session!.folder, resumeSessionId: "sess-1", reason: "resumed" });
    const row = await ctx.latestRun();
    expect(row.sessionFolder).toBe(first.session!.folder);
    expect(row.cliSessionId).toBeNull();
  });
});

test.concurrent("a Run after a failed Run starts a new Session but keeps the folder", async () => {
  await withRollback(db, async (tx) => {
    const ctx = await setup(tx);
    const first = await ctx.runOnce({ status: "failed", finalOutput: "boom", failureReason: "cli_exit", sessionId: "sess-1" });
    await ctx.queueNext();
    const second = await ctx.runOnce({ status: "completed", finalOutput: "again" });
    expect(second.session).toMatchObject({ folder: first.session!.folder, resumeSessionId: null, reason: "previous_failed" });
  });
});

test.concurrent("a stale Run, one whose worker went silent, also gives the next Run a new Session", async () => {
  await withRollback(db, async (tx) => {
    const ctx = await setup(tx);
    const first = await ctx.runOnce({ status: "completed", finalOutput: "one", sessionId: "sess-1" });
    const [staleRun] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.workItemId, ctx.item.id));
    await tx.update(runs).set({ status: "stale", failureReason: "runtime_offline" }).where(eq(runs.id, staleRun!.id));
    await ctx.queueNext();
    const second = await ctx.runOnce({ status: "completed", finalOutput: "again" });
    expect(second.session).toMatchObject({ folder: first.session!.folder, resumeSessionId: null, reason: "previous_failed" });
  });
});

test.concurrent("a completed Run that reported no Session id gives the next Run a new Session", async () => {
  await withRollback(db, async (tx) => {
    const ctx = await setup(tx);
    await ctx.runOnce({ status: "completed", finalOutput: "no id" });
    await ctx.queueNext();
    const second = await ctx.runOnce({ status: "completed", finalOutput: "again" });
    expect(second.session).toMatchObject({ resumeSessionId: null, reason: "no_session_id" });
  });
});

test.concurrent("a Run on another Runtime starts a new Session and a new folder", async () => {
  await withRollback(db, async (tx) => {
    const ctx = await setup(tx);
    const first = await ctx.runOnce({ status: "completed", finalOutput: "one", sessionId: "sess-1" });
    await tx.update(agents).set({ runtimeId: ctx.codex.id }).where(eq(agents.id, ctx.agent.id));
    await ctx.queueNext();
    const second = await ctx.runOnce({ status: "completed", finalOutput: "two" }, ctx.codex.id);
    expect(second.session).toMatchObject({ resumeSessionId: null, reason: "runtime_changed" });
    expect(second.session!.folder).not.toBe(first.session!.folder);
  });
});

test.concurrent("a rerun as new never resumes, even when the failed Run left a Session id", async () => {
  await withRollback(db, async (tx) => {
    const ctx = await setup(tx);
    await ctx.runOnce({ status: "failed", finalOutput: "boom", failureReason: "cli_exit", sessionId: "sess-1" });
    const failed = await ctx.latestRun();
    const rerun = await ctx.runs.rerunRun.handler({ userId: ctx.owner.id }, { runId: failed.id, newSession: true });
    expect(rerun.sessionMode).toBeNull();
    const claimed = await ctx.dispatch.claimRuns({ userId: ctx.owner.id, daemonId: ctx.daemonId }, 20).then((rows) => rows.find((row) => row.runId === rerun.id)!);
    expect(claimed.session).toMatchObject({ resumeSessionId: null, reason: "rerun_as_new" });
  });
});

test.concurrent("the Run page says whether the Run resumed a Session or started a new one", async () => {
  await withRollback(db, async (tx) => {
    const ctx = await setup(tx);
    await ctx.runOnce({ status: "completed", finalOutput: "one", sessionId: "sess-1" });
    await ctx.queueNext();
    const [claimed] = await ctx.dispatch.claimRuns({ userId: ctx.owner.id, daemonId: ctx.daemonId }, 20).then((rows) => rows.filter((row) => row.workItemId === ctx.item.id));
    await ctx.dispatch.startRun(claimed!.runId, ctx.claude.id, { mode: "resumed", reason: "resumed" });
    expect(await ctx.runs.getRun.handler({ userId: ctx.owner.id }, { runId: claimed!.runId })).toMatchObject({ sessionMode: "resumed", sessionReason: "resumed" });
  });
});

test.concurrent("a Run without a work item gets no folder and no Session to resume", async () => {
  await withRollback(db, async (tx) => {
    const ctx = await setup(tx);
    await tx.insert(runs).values({ workspaceId: ctx.workspace.id, projectId: (await tx.select({ projectId: runs.projectId }).from(runs).where(eq(runs.workItemId, ctx.item.id)))[0]!.projectId, agentId: ctx.agent.id, originatorId: ctx.owner.id, status: "queued" });
    const [claimed] = await ctx.dispatch.claimRuns({ userId: ctx.owner.id, daemonId: ctx.daemonId }, 20).then((rows) => rows.filter((row) => row.workItemId === null));
    expect(claimed!.session).toBeNull();
  });
});

test.concurrent("the Daemon is told to remove a Session folder once its work item is Done or Cancelled, and not before", async () => {
  await withRollback(db, async (tx) => {
    const ctx = await setup(tx);
    const first = await ctx.runOnce({ status: "completed", finalOutput: "one", sessionId: "sess-1" });
    const folder = first.session!.folder;
    expect(await ctx.dispatch.retiredSessionFolders(ctx.daemonId, [folder])).toEqual([]);
    const [item] = await tx.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, ctx.item.id));
    const [done] = await tx.select({ id: workItemStates.id }).from(workItemStates).where(and(eq(workItemStates.projectId, item!.projectId), eq(workItemStates.group, "completed")));
    await tx.update(workItems).set({ stateId: done!.id }).where(eq(workItems.id, ctx.item.id));
    expect(await ctx.dispatch.retiredSessionFolders(ctx.daemonId, [folder, "00000000-0000-4000-8000-000000000000"])).toEqual([folder]);
  });
});

/** A scripted fake provider that records every request it was given; the same shape the Run execution tests use. */
function scriptedModel(steps: Array<Partial<RunModelResponse>>) {
  const requests: RunModelRequest[] = [];
  const model: RunModel = {
    async step(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      const next = steps[requests.length - 1];
      if (!next) throw new Error("script exhausted");
      return { text: null, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...next };
    },
  };
  return { model, requests };
}

test.concurrent("a Run on the Weft server starts fresh and never reads an earlier Run's transcript", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const project = await createProjectActions(tx).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Server", key: "SRV", visibility: "private" });
    const agentActions = createAgentActions(tx);
    const agent = await agentActions.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Server Bot", instructions: "Be brief.", model: "default" });
    await agentActions.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Server task", assigneeIds: [agent.userId] });
    const [first] = await tx.select().from(runs).where(eq(runs.workItemId, item.id));
    await handleAgentRunJob(tx, { runId: first!.id }, { model: scriptedModel([{ text: "FIRST-ROUND-ANSWER" }]).model });
    await queueRunsForAssignees(tx, { originatorId: admin.id, project: { id: project.id, workspaceId: workspace.id }, workItemId: item.id, assigneeUserIds: [agent.userId] });
    const second = (await tx.select().from(runs).where(eq(runs.workItemId, item.id))).find((row) => row.id !== first!.id)!;
    const secondModel = scriptedModel([{ text: "SECOND-ROUND-ANSWER" }]);
    await handleAgentRunJob(tx, { runId: second.id }, { model: secondModel.model });
    expect(secondModel.requests).toHaveLength(1);
    expect(JSON.stringify(secondModel.requests)).not.toContain("FIRST-ROUND-ANSWER");
    const [row] = await tx.select().from(runs).where(eq(runs.id, second.id));
    expect(row).toMatchObject({ status: "completed", sessionFolder: null, sessionMode: null, cliSessionId: null });
  });
});
