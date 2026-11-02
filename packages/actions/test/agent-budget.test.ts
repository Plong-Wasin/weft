import { afterAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase, jobs, runs, type Database } from "@weft/db";
import { createAgentActions, createJobHandlers, createNotificationActions, createProjectActions, createWorkItemActions, handleAgentRunJob, monthStart, type RunModel } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** A scripted fake provider: answers once, reporting the given token usage. */
const answering = (inputTokens: number, outputTokens: number): RunModel => ({ step: async () => ({ text: "Done.", toolCalls: [], usage: { inputTokens, outputTokens } }) });

async function setup(transaction: Database, monthlyTokenBudget: number | null) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const agentActions = createAgentActions(transaction);
  const agent = await agentActions.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", model: "default", monthlyTokenBudget });
  await agentActions.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const work = createWorkItemActions(transaction);
  const assign = async (title: string) => {
    const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title });
    await work.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
    const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    return run!;
  };
  return { workspace, admin, member, agentActions, agent, assign };
}

const reload = async (transaction: Database, runId: string) => (await transaction.select().from(runs).where(eq(runs.id, runId)))[0]!;
const lastMonth = () => new Date(monthStart().getTime() - 24 * 3600 * 1000);

test.concurrent("usage accumulates per Agent per calendar month from Run token counts and admins see it against the budget", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, 1000);
    const first = await s.assign("One");
    await handleAgentRunJob(transaction, { runId: first.id }, { model: answering(100, 50) });
    const second = await s.assign("Two");
    await handleAgentRunJob(transaction, { runId: second.id }, { model: answering(20, 10) });
    // A Run from last month does not count toward this month.
    const old = await s.assign("Old");
    await transaction.update(runs).set({ status: "completed", inputTokens: 400, outputTokens: 400, createdAt: lastMonth() }).where(eq(runs.id, old.id));

    const seen = await s.agentActions.getAgent.handler({ userId: s.admin.id }, { agentId: s.agent.id });
    expect(seen).toMatchObject({ monthlyTokenBudget: 1000, monthlyTokensUsed: 180 });
    const listed = await s.agentActions.listAgents.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id });
    expect(listed[0]!.monthlyTokensUsed).toBe(180);
  });
});

test.concurrent("over budget, a new Run is skipped and the requester is notified", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, 100);
    const first = await s.assign("One");
    await handleAgentRunJob(transaction, { runId: first.id }, { model: answering(60, 40) });
    expect((await reload(transaction, first.id)).status).toBe("completed");

    const skipped = await s.assign("Two");
    expect(skipped).toMatchObject({ status: "skipped", failureReason: "budget_exceeded" });
    expect(skipped.finishedAt).not.toBeNull();
    // No job runs it, and starting it by hand changes nothing.
    expect(await transaction.select().from(jobs).where(sql`${jobs.type} = 'agent_run' and ${jobs.payload}->>'runId' = ${skipped.id}`)).toHaveLength(0);
    await handleAgentRunJob(transaction, { runId: skipped.id }, { model: answering(1, 1) });
    expect((await reload(transaction, skipped.id)).status).toBe("skipped");

    const handlers = createJobHandlers();
    for (const job of await transaction.select().from(jobs).where(eq(jobs.type, "notify"))) await handlers.notify!(transaction, job.payload, { id: job.id, type: "notify" });
    const inbox = await createNotificationActions(transaction).listNotifications.handler({ userId: s.member.id }, { workspaceId: s.workspace.id });
    const notice = inbox.notifications.find((entry) => entry.kind === "run_skipped");
    expect(notice).toMatchObject({ actorId: s.agent.userId, displayId: "ALP-2" });
  });
});

test.concurrent("a queued Run that starts after the budget is used up is skipped", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, 100);
    const queued = await s.assign("Queued");
    await transaction.insert(runs).values({ workspaceId: s.workspace.id, projectId: queued.projectId, workItemId: queued.workItemId, agentId: s.agent.id, originatorId: s.member.id, status: "completed", inputTokens: 100, outputTokens: 0, createdAt: new Date(Date.now() - 1000) }).onConflictDoNothing();
    await handleAgentRunJob(transaction, { runId: queued.id }, { model: answering(1, 1) });
    expect(await reload(transaction, queued.id)).toMatchObject({ status: "skipped", failureReason: "budget_exceeded" });
  });
});

test.concurrent("a running Run that crosses the budget fails with budget_exceeded", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, 100);
    const run = await s.assign("Big");
    await handleAgentRunJob(transaction, { runId: run.id }, { model: answering(80, 40) });
    expect(await reload(transaction, run.id)).toMatchObject({ status: "failed", failureReason: "budget_exceeded", inputTokens: 80, outputTokens: 40 });
  });
});

test.concurrent("the budget resets at the start of the next month", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, 100);
    const first = await s.assign("One");
    await handleAgentRunJob(transaction, { runId: first.id }, { model: answering(60, 40) });
    // The month rolls over: that Run now belongs to the previous month.
    await transaction.update(runs).set({ createdAt: lastMonth() }).where(eq(runs.id, first.id));
    expect((await s.agentActions.getAgent.handler({ userId: s.admin.id }, { agentId: s.agent.id })).monthlyTokensUsed).toBe(0);

    const next = await s.assign("Two");
    expect(next.status).toBe("queued");
    await handleAgentRunJob(transaction, { runId: next.id }, { model: answering(10, 10) });
    expect((await reload(transaction, next.id)).status).toBe("completed");
  });
});

test.concurrent("an Agent without a budget is never skipped", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    const first = await s.assign("One");
    await handleAgentRunJob(transaction, { runId: first.id }, { model: answering(100000, 100000) });
    expect((await reload(transaction, first.id)).status).toBe("completed");
    expect((await s.assign("Two")).status).toBe("queued");
  });
});
