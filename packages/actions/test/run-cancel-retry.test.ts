import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { agents, comments, confirmations, createDatabase, jobs, runs, type Database } from "@weft/db";
import {
  createAgentActions, createConfirmationStore, createProjectActions, createRunActions, createWorkItemActions, handleAgentRunJob, startRun, RunModelNetworkError,
  type RunModel, type RunModelRequest, type RunModelResponse,
} from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

type Step = Partial<RunModelResponse> | (() => Promise<RunModelResponse>);
function scriptedModel(steps: Step[]) {
  const requests: RunModelRequest[] = [];
  const model: RunModel = {
    async step(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      const next = steps[requests.length - 1];
      if (!next) throw new Error("script exhausted");
      if (typeof next === "function") return next();
      return { text: null, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...next };
    },
  };
  return { model, requests };
}
const call = (name: string, input: unknown, id: string = crypto.randomUUID()) => ({ id, name, input });

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const other = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
  for (const user of [member, other]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: "Member" });
  const agentActions = createAgentActions(transaction);
  const agent = await agentActions.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", instructions: "Be brief.", model: "default" });
  await agentActions.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const work = createWorkItemActions(transaction);
  const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Fix the login" });
  await work.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
  const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
  return { workspace, admin, member, other, project, agent, work, item, run: run!, actions: createRunActions(transaction), store: createConfirmationStore(transaction) };
}

const reload = async (transaction: Database, runId: string) => (await transaction.select().from(runs).where(eq(runs.id, runId)))[0]!;
const allRuns = (transaction: Database, itemId: string) => transaction.select().from(runs).where(eq(runs.workItemId, itemId)).orderBy(runs.createdAt, runs.id);
const rename = (id: string) => call("update_work_item", { workItemId: id, title: "Fix the login page" }, "w1");
const agentRunJobs = async (transaction: Database, runId: string) => (await transaction.select().from(jobs)).filter((job) => job.type === "agent_run" && (job.payload as { runId: string }).runId === runId);

test.concurrent("cancelling a queued Run cancels it and ends the work item's active Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.actions.cancelRun.handler({ userId: s.member.id }, { runId: s.run.id });
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "cancelled" });
    expect((await reload(transaction, s.run.id)).finishedAt).not.toBeNull();
    // The cancelled Run never starts, even when its job is offered.
    const { model, requests } = scriptedModel([{ text: "hi" }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model });
    expect(requests).toHaveLength(0);
  });
});

test.concurrent("cancelling a waiting Run withdraws its pending Confirmation, so it can no longer be approved", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { model } = scriptedModel([{ text: "Renaming.", toolCalls: [rename(s.item.id)] }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model });
    const [card] = await transaction.select().from(confirmations).where(eq(confirmations.runId, s.run.id));
    expect(card!.status).toBe("pending");

    await s.actions.cancelRun.handler({ userId: s.member.id }, { runId: s.run.id });
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "cancelled" });
    expect((await transaction.select().from(confirmations).where(eq(confirmations.id, card!.id)))[0]!.status).not.toBe("pending");
    expect(await s.store.confirm(s.member.id, card!.id)).toMatchObject({ status: "already_resolved" });
    const item = await s.work.getWorkItem.handler({ userId: s.member.id }, { workspaceId: s.workspace.id, displayId: "ALP-1" });
    expect(item.title).toBe("Fix the login");
    // No job resumes it.
    const { model: again, requests } = scriptedModel([{ text: "hi" }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: again });
    expect(requests).toHaveLength(0);
  });
});

test.concurrent("cancelling a running Run stops it before its next step and posts no reply", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const cancelDuringStep = scriptedModel([async () => {
      await s.actions.cancelRun.handler({ userId: s.member.id }, { runId: s.run.id });
      expect((await reload(transaction, s.run.id)).status).toBe("stopping");
      return { text: "Too late.", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
    }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: cancelDuringStep.model });
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "cancelled" });
    expect(await transaction.select().from(comments).where(eq(comments.workItemId, s.item.id))).toHaveLength(0);
  });
});

test.concurrent("only the Originator or an admin can cancel or rerun", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await expect(s.actions.cancelRun.handler({ userId: s.other.id }, { runId: s.run.id })).rejects.toMatchObject({ status: 403 });
    expect((await reload(transaction, s.run.id)).status).toBe("queued");
    await s.actions.cancelRun.handler({ userId: s.admin.id }, { runId: s.run.id });
    expect((await reload(transaction, s.run.id)).status).toBe("cancelled");
    await expect(s.actions.rerunRun.handler({ userId: s.other.id }, { runId: s.run.id })).rejects.toMatchObject({ status: 403 });
    expect(await allRuns(transaction, s.item.id)).toHaveLength(1);
    await s.actions.rerunRun.handler({ userId: s.admin.id }, { runId: s.run.id });
    expect(await allRuns(transaction, s.item.id)).toHaveLength(2);
  });
});

test.concurrent("rerun of a failed or cancelled Run creates a new linked Run for the same Originator and queues it", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await expect(s.actions.rerunRun.handler({ userId: s.member.id }, { runId: s.run.id })).rejects.toMatchObject({ status: 409 });
    await transaction.update(runs).set({ status: "failed", failureReason: "model_error", finishedAt: new Date() }).where(eq(runs.id, s.run.id));
    const created = await s.actions.rerunRun.handler({ userId: s.member.id }, { runId: s.run.id });
    expect(created).toMatchObject({ status: "queued", rerunOfId: s.run.id, originatorId: s.member.id, agentId: s.agent.id, workItemId: s.item.id });
    expect(await agentRunJobs(transaction, created.id)).toHaveLength(1);
    // The new Run is active, so a second rerun of the old one conflicts.
    await expect(s.actions.rerunRun.handler({ userId: s.member.id }, { runId: s.run.id })).rejects.toMatchObject({ status: 409 });
    await s.actions.cancelRun.handler({ userId: s.member.id }, { runId: created.id });
    const again = await s.actions.rerunRun.handler({ userId: s.member.id }, { runId: created.id });
    expect(again.rerunOfId).toBe(created.id);
  });
});

test.concurrent("a worker crash leaves the Run stale and retries it automatically at most twice", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    let current = s.run.id;
    for (const attempt of [1, 2]) {
      expect(await startRun(transaction, current)).toBe("started");
      await transaction.update(runs).set({ startedAt: new Date(Date.now() - 3_600_000) }).where(eq(runs.id, current));
      // The worker died: the job queue offers the abandoned job again while the Run still says `running`.
      await handleAgentRunJob(transaction, { runId: current }, { model: scriptedModel([]).model });
      expect(await reload(transaction, current)).toMatchObject({ status: "stale" });
      const rows = await allRuns(transaction, s.item.id);
      const next = rows.find((row) => row.rerunOfId === current)!;
      expect(next).toMatchObject({ status: "queued", attempt, originatorId: s.member.id });
      expect(await agentRunJobs(transaction, next.id)).toHaveLength(1);
      current = next.id;
    }
    expect(await startRun(transaction, current)).toBe("started");
    await transaction.update(runs).set({ startedAt: new Date(Date.now() - 3_600_000) }).where(eq(runs.id, current));
    await handleAgentRunJob(transaction, { runId: current }, { model: scriptedModel([]).model });
    expect(await reload(transaction, current)).toMatchObject({ status: "stale" });
    expect(await allRuns(transaction, s.item.id)).toHaveLength(3);
  });
});

test.concurrent("a provider network error retries automatically at most twice; the last one fails for good", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const offline: Step = async () => { throw new RunModelNetworkError("fetch failed"); };
    let current = s.run.id;
    for (const attempt of [1, 2]) {
      await handleAgentRunJob(transaction, { runId: current }, { model: scriptedModel([offline]).model });
      expect(await reload(transaction, current)).toMatchObject({ status: "failed", failureReason: "network_error" });
      const next = (await allRuns(transaction, s.item.id)).find((row) => row.rerunOfId === current)!;
      expect(next).toMatchObject({ status: "queued", attempt });
      current = next.id;
    }
    await handleAgentRunJob(transaction, { runId: current }, { model: scriptedModel([offline]).model });
    expect(await reload(transaction, current)).toMatchObject({ status: "failed", failureReason: "network_error" });
    expect(await allRuns(transaction, s.item.id)).toHaveLength(3);
  });
});

test.concurrent("a model error, a limit hit and a refused action cause no automatic retry", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: scriptedModel([() => Promise.reject(new Error("model exploded"))]).model });
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "failed", failureReason: "model_error" });
    expect(await allRuns(transaction, s.item.id)).toHaveLength(1);

    // A limit hit.
    const limited = await s.actions.rerunRun.handler({ userId: s.member.id }, { runId: s.run.id });
    await transaction.update(agents).set({ maxToolCalls: 1 }).where(eq(agents.id, s.agent.id));
    const read = call("get_work_item", { workspaceId: s.workspace.id, displayId: "ALP-1" });
    await handleAgentRunJob(transaction, { runId: limited.id }, { model: scriptedModel([{ toolCalls: [read, { ...read, id: "second" }] }]).model });
    expect(await reload(transaction, limited.id)).toMatchObject({ status: "failed", failureReason: "tool_call_limit" });
    expect(await allRuns(transaction, s.item.id)).toHaveLength(2);

    // A refused action: the Originator rejects the proposed Write.
    const third = await s.actions.rerunRun.handler({ userId: s.member.id }, { runId: limited.id });
    await handleAgentRunJob(transaction, { runId: third.id }, { model: scriptedModel([{ toolCalls: [rename(s.item.id)] }]).model });
    const [card] = await transaction.select().from(confirmations).where(and(eq(confirmations.runId, third.id)));
    await s.store.reject(s.member.id, card!.id);
    await handleAgentRunJob(transaction, { runId: third.id }, { model: scriptedModel([{ text: "Understood." }]).model });
    expect(await reload(transaction, third.id)).toMatchObject({ status: "completed" });
    expect(await allRuns(transaction, s.item.id)).toHaveLength(3);
  });
});

test.concurrent("a Run that looks abandoned while still inside its time limit is not made stale yet", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    expect(await startRun(transaction, s.run.id)).toBe("started");
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: scriptedModel([]).model });
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "running" });
    expect(await allRuns(transaction, s.item.id)).toHaveLength(1);
  });
});
