import { afterAll, expect, test } from "bun:test";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { createDatabase, jobs, runs, users, workspaces, type Database } from "@weft/db";
import { createAgentActions, createCommentActions, createProjectActions, createTriggerActions, createWorkItemActions, fireScheduleTrigger } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database, options: { monthlyTokenBudget?: number | null } = {}) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const agents = createAgentActions(transaction);
  const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", instructions: "", model: "default", monthlyTokenBudget: options.monthlyTokenBudget ?? null });
  await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const work = createWorkItemActions(transaction);
  const comments = createCommentActions(transaction);
  const newItem = (title = "Item") => work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title });
  return { workspace, admin, member, project, agents, agent, work, comments, newItem };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const mention = (userId: string, label = "Bot") => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: userId, label } }, { type: "text", text: " please look" }] }] });

const activeStatuses = ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"];

test("assigning an Agent returns a started Wake outcome for the Run it queued", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await s.newItem();
    const updated = await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    expect(updated.wakeOutcomes).toEqual([expect.objectContaining({ agentId: s.agent.id, userId: s.agent.userId, agentName: "Bot", status: "started", reason: null, runId: run!.id })]);
    expect(run).toMatchObject({ status: "queued" });
  });
});

test("creating a work item already assigned to an Agent returns a started Wake outcome", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const created = await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title: "Born assigned", assigneeIds: [s.agent.userId] });
    const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, created.id));
    expect(created.wakeOutcomes).toEqual([expect.objectContaining({ agentId: s.agent.id, status: "started", reason: null, runId: run!.id })]);
  });
});

test("mentioning an Agent returns a started Wake outcome, and a second mention while its Run is active waits in one Follow-up Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await s.newItem();
    const first = await s.comments.createComment.handler({ userId: s.member.id }, { workItemId: item.id, body: mention(s.agent.userId) });
    const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    expect(first.wakeOutcomes).toEqual([expect.objectContaining({ agentId: s.agent.id, status: "started", reason: null, runId: run!.id })]);
    // The Admin asks, not the person whose Run is active: a mention of the same person would steer that Run instead (steer-run.test.ts).
    const second = await s.comments.createComment.handler({ userId: s.admin.id }, { workItemId: item.id, body: mention(s.agent.userId) });
    expect(second.wakeOutcomes).toEqual([expect.objectContaining({ agentId: s.agent.id, status: "waiting", reason: null, runId: expect.any(String) })]);
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(2);
  });
});

test("an Agent over its monthly budget is skipped with over_budget, the assignment is still saved and the person is notified", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, { monthlyTokenBudget: 100 });
    const earlier = await s.newItem("Spent");
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: earlier.id, assigneeIds: [s.agent.userId] });
    await transaction.update(runs).set({ status: "completed", inputTokens: 150, outputTokens: 0 }).where(eq(runs.workItemId, earlier.id));
    const item = await s.newItem("Over budget");
    const updated = await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    expect(updated.assigneeIds).toEqual([s.agent.userId]);
    expect(updated.wakeOutcomes).toEqual([expect.objectContaining({ agentId: s.agent.id, status: "skipped", reason: "over_budget", runId: null })]);
    const [skipped] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    expect(skipped).toMatchObject({ status: "skipped", failureReason: "budget_exceeded", originatorId: s.member.id });
    const queued = (await transaction.select().from(jobs)).filter((job) => job.type === "notify" && (job.payload as { kind?: string; workItemId?: string; recipientIds?: string[] }).kind === "run_skipped" && (job.payload as { workItemId?: string }).workItemId === item.id);
    expect(queued).toHaveLength(1);
    expect((queued[0]!.payload as { recipientIds: string[] }).recipientIds).toEqual([s.member.id]);
  });
});

test("a person without Agent access still gets the existing error, and no Run is queued", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.agents.setAgentAccess.handler({ userId: s.admin.id }, { agentId: s.agent.id, userIds: [s.admin.id] });
    const item = await s.newItem();
    await expect(s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] })).rejects.toMatchObject({
      status: 403, message: "You do not have Agent access to Bot. Ask its owner or an Admin to grant access.",
    });
    await expect(s.comments.createComment.handler({ userId: s.member.id }, { workItemId: item.id, body: mention(s.agent.userId) })).rejects.toMatchObject({ status: 403 });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
  });
});

test("an Agent's own assignment or mention returns skipped switch_off, queues no Run, and its action still succeeds", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await s.newItem();
    const updated = await s.work.updateWorkItem.handler({ userId: s.member.id, source: "agent" }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    expect(updated.assigneeIds).toEqual([s.agent.userId]);
    expect(updated.wakeOutcomes).toEqual([expect.objectContaining({ agentId: s.agent.id, status: "skipped", reason: "switch_off", runId: null })]);
    const comment = await s.comments.createComment.handler({ userId: s.member.id, source: "agent" }, { workItemId: item.id, body: mention(s.agent.userId) });
    expect(comment.wakeOutcomes).toEqual([expect.objectContaining({ agentId: s.agent.id, status: "skipped", reason: "switch_off" })]);
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
  });
});

test("an event Trigger fired by a person's change starts one Run, and a second change while it is active waits in one Follow-up Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await createTriggerActions(transaction).createTrigger.handler({ userId: s.admin.id }, { agentId: s.agent.id, projectId: s.project.id, eventType: "work_item_updated" });
    const item = await s.newItem();
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, title: "Renamed once" });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, title: "Renamed twice" });
    const rows = await transaction.select().from(runs).where(eq(runs.workItemId, item.id)).orderBy(runs.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "queued", triggerId: trigger.id, originatorId: s.admin.id, depth: 0, wokenByRunId: null });
    expect(rows[1]).toMatchObject({ status: "follow_up", triggerId: trigger.id, originatorId: s.admin.id, depth: 0, wokenByRunId: null });
  });
});

test("an event Trigger over the Agent's monthly budget records a skipped Run instead of a queued one", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, { monthlyTokenBudget: 10 });
    await createTriggerActions(transaction).createTrigger.handler({ userId: s.admin.id }, { agentId: s.agent.id, projectId: s.project.id, eventType: "work_item_updated" });
    const spent = await s.newItem("Spent");
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: spent.id, assigneeIds: [s.agent.userId] });
    await transaction.update(runs).set({ status: "completed", inputTokens: 50 }).where(eq(runs.workItemId, spent.id));
    const item = await s.newItem("Triggered over budget");
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, title: "Renamed" });
    const [row] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    expect(row).toMatchObject({ status: "skipped", failureReason: "budget_exceeded" });
  });
});

test("a Run started by a person's assignment or a schedule has depth 0 and no waking Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await s.newItem();
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    const [assigned] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    expect(assigned).toMatchObject({ depth: 0, wokenByRunId: null });
    const trigger = await createTriggerActions(transaction).createTrigger.handler({ userId: s.admin.id }, { agentId: s.agent.id, projectId: s.project.id, schedule: "daily" });
    const due = new Date(trigger.nextRunAt!.getTime() + 2 * 24 * 60 * 60 * 1000);
    await fireScheduleTrigger(transaction, { triggerId: trigger.id, now: due });
    const [scheduled] = await transaction.select().from(runs).where(eq(runs.triggerId, trigger.id));
    expect(scheduled).toMatchObject({ workItemId: null, depth: 0, wokenByRunId: null });
  });
});

test("the unique index refuses a second active Run for one Agent and work item, and allows one once the first has finished", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await s.newItem();
    const row = { workspaceId: s.workspace.id, projectId: s.project.id, workItemId: item.id, agentId: s.agent.id, originatorId: s.member.id };
    await transaction.insert(runs).values({ ...row, status: "running" });
    await expect(transaction.transaction(async (savepoint) => { await savepoint.insert(runs).values({ ...row, status: "queued" }); })).rejects.toThrow();
    await transaction.insert(runs).values({ ...row, status: "failed" });
    await transaction.update(runs).set({ status: "completed" }).where(and(eq(runs.workItemId, item.id), eq(runs.status, "running")));
    await transaction.insert(runs).values({ ...row, status: "queued" });
    expect(await transaction.select().from(runs).where(and(eq(runs.workItemId, item.id), inArray(runs.status, activeStatuses)))).toHaveLength(1);
  });
});

// Real commits, not a rolled-back transaction: two requests really race on the database. The test database is private to this run.
// Two requests, not more: the test pool holds three connections and each request needs a second one for its reads.
test.serial("concurrent mentions of one Agent on one work item commit exactly one active Run", async () => {
  const s = await setup(db);
  const item = await s.newItem("Raced");
  try {
    const results = await Promise.all(Array.from({ length: 2 }, () => s.comments.createComment.handler({ userId: s.member.id }, { workItemId: item.id, body: mention(s.agent.userId) })));
    const outcomes = results.flatMap((comment) => comment.wakeOutcomes.map((outcome) => `${outcome.status}:${outcome.reason ?? "-"}`)).sort();
    expect(outcomes).toEqual(["started:-", "waiting:-"]);
    const active = await db.select().from(runs).where(and(eq(runs.workItemId, item.id), inArray(runs.status, activeStatuses)));
    expect(active).toHaveLength(1);
  } finally {
    // Leave nothing behind: other tests in the shared run count and drain the jobs table. Jobs carry the work item or the Run in their payload.
    const itemRuns = await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, s.project.id));
    await db.delete(jobs).where(or(sql`${jobs.payload}::text like ${`%${item.id}%`}`, inArray(jobs.dedupeKey, itemRuns.map((run) => `agent_run:${run.id}`))));
    await db.delete(workspaces).where(eq(workspaces.id, s.workspace.id));
    await db.delete(users).where(inArray(users.id, [s.admin.id, s.member.id, s.agent.userId]));
  }
}, 30_000);
