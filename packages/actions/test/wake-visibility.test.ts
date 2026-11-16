import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, runs, workspaces, type Database } from "@weft/db";
import { createAgentActions, createCommentActions, createProjectActions, createRunActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** A workspace with an Admin, a Member who starts the chain, a Guest on the same public project, and two server Agents (coder, reviewer). */
async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Member" });
  const agents = createAgentActions(transaction);
  const coder = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Coder", instructions: "", model: "default" });
  const reviewer = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Reviewer", instructions: "", model: "default" });
  for (const agent of [coder, reviewer]) await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  await agents.setAgentAccess.handler({ userId: admin.id }, { agentId: coder.id, userIds: [admin.id, member.id] });
  await agents.setAgentAccess.handler({ userId: admin.id }, { agentId: reviewer.id, userIds: [admin.id, member.id] });
  const work = createWorkItemActions(transaction);
  const comments = createCommentActions(transaction);
  const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Feature" });
  return { workspace, admin, member, guest, project, agents, coder, reviewer, work, comments, runActions: createRunActions(transaction), item };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Turns the Can wake Agents switch on for an Agent, as an Admin does. */
async function allowWaking(s: Setup, agentId: string) {
  await s.agents.updateAgent.handler({ userId: s.admin.id }, { agentId, canWakeAgents: true });
}

/** The context of a change an Agent makes inside its Run: the Run and the Originator of its chain. */
function asAgent(s: Setup, runId: string, agentUserId: string, originatorId = s.member.id) {
  return { userId: agentUserId, source: "agent" as const, agent: { agentUserId, runId, originatorId, autopilot: true } };
}

/** Inserts a Run an Agent executes on the work item, as the server records it before the Agent acts. */
async function insertRun(transaction: Database, s: Setup, agentId: string, values: { originatorId?: string; depth?: number; wokenByRunId?: string | null; status?: string } = {}) {
  const [row] = await transaction.insert(runs).values({
    workspaceId: s.workspace.id, projectId: s.project.id, workItemId: s.item.id, agentId, originatorId: values.originatorId ?? s.member.id,
    status: values.status ?? "running", depth: values.depth ?? 0, wokenByRunId: values.wokenByRunId ?? null,
  }).returning();
  return row!;
}

/** The timeline entry of a Run that started, found by the Run it names. */
const startedEntry = (rows: Array<{ field: string; newValue: unknown }>, runId: string) => rows.find((row) => row.field === "run_started" && (row.newValue as { runId?: string }).runId === runId);

/** The Activity rows of a work item, as the timeline reads them. */
const timelineOf = (s: Setup, viewerId: string, itemId = s.item.id) => s.work.listWorkItemActivities.handler({ userId: viewerId }, { workItemId: itemId });

test("the Runs list shows the Run that woke a Run, its Agent and its depth, and a Run a person started shows neither", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await allowWaking(s, s.coder.id);
    const coderRun = await insertRun(transaction, s, s.coder.id, { status: "completed" });
    await s.work.updateWorkItem.handler(asAgent(s, coderRun.id, s.coder.userId), { workItemId: s.item.id, assigneeIds: [s.reviewer.userId] });
    const personRun = await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: s.item.id, assigneeIds: [s.coder.userId] });
    expect(personRun.assigneeIds).toEqual([s.coder.userId]);
    const listed = await s.runActions.listRuns.handler({ userId: s.admin.id }, { workItemId: s.item.id });
    const woken = listed.find((run) => run.agentId === s.reviewer.id);
    expect(woken).toMatchObject({ wokenBy: { runId: coderRun.id, agentName: "Coder", depth: 1 } });
    const started = listed.find((run) => run.agentId === s.coder.id && run.id !== coderRun.id);
    expect(started).toMatchObject({ wokenBy: null });
  });
});

test("the timeline lists a started Run with the Run and depth that woke it, and a person's started Run with none", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await allowWaking(s, s.coder.id);
    const coderRun = await insertRun(transaction, s, s.coder.id, { status: "completed" });
    await s.work.updateWorkItem.handler(asAgent(s, coderRun.id, s.coder.userId), { workItemId: s.item.id, assigneeIds: [s.reviewer.userId] });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: s.item.id, assigneeIds: [s.coder.userId] });
    const rows = await timelineOf(s, s.member.id);
    const reviewerRun = (await transaction.select().from(runs).where(and(eq(runs.agentId, s.reviewer.id), eq(runs.workItemId, s.item.id))))[0]!;
    expect(startedEntry(rows, reviewerRun.id)).toMatchObject({ wokenBy: { runId: coderRun.id, agentName: "Coder", depth: 1 } });
    const personRun = (await transaction.select().from(runs).where(and(eq(runs.agentId, s.coder.id), eq(runs.workItemId, s.item.id), eq(runs.status, "queued"))))[0]!;
    expect(startedEntry(rows, personRun.id)).toMatchObject({ wokenBy: null });
  });
});

test("the timeline lists a request that waits for a busy Agent as a waiting entry", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await allowWaking(s, s.coder.id);
    const coderRun = await insertRun(transaction, s, s.coder.id, { status: "completed" });
    const busy = await insertRun(transaction, s, s.reviewer.id, { status: "running" });
    const updated = await s.work.updateWorkItem.handler(asAgent(s, coderRun.id, s.coder.userId), { workItemId: s.item.id, assigneeIds: [s.reviewer.userId] });
    expect(updated.wakeOutcomes).toEqual([expect.objectContaining({ agentId: s.reviewer.id, status: "waiting" })]);
    const rows = await timelineOf(s, s.member.id);
    expect(rows.find((row) => row.field === "run_waiting")).toMatchObject({ newValue: { status: "waiting", agentName: "Reviewer", runId: expect.any(String) }, runId: null });
    expect(busy.id).toBeTruthy();
  });
});

test("the timeline lists a person's comment that steers an active Run as a steered entry", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const active = await insertRun(transaction, s, s.reviewer.id, { status: "running" });
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: s.reviewer.userId, label: "Reviewer" } }, { type: "text", text: " also check Safari." }] }] };
    const created = await s.comments.createComment.handler({ userId: s.member.id }, { workItemId: s.item.id, body: doc });
    expect(created.wakeOutcomes[0]).toMatchObject({ status: "steered", runId: active.id });
    const rows = await timelineOf(s, s.member.id);
    expect(rows.find((row) => row.field === "run_steered")).toMatchObject({ newValue: { agentName: "Reviewer", runId: active.id } });
  });
});

test("the timeline lists each skipped wake with its reason: switch off, depth limit, no Agent access and over budget", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const itemFor = async (title: string) => (await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title })).id;
    // Switch off: the coder's Can wake Agents switch is still off (the default).
    const switchedOffItem = await itemFor("Switch off");
    const switchedOff = await insertRun(transaction, s, s.coder.id, { status: "completed" });
    await transaction.update(runs).set({ workItemId: switchedOffItem }).where(eq(runs.id, switchedOff.id));
    await s.work.updateWorkItem.handler(asAgent(s, switchedOff.id, s.coder.userId), { workItemId: switchedOffItem, assigneeIds: [s.reviewer.userId] });
    // Depth limit: a chain already at depth 6 cannot make a seventh step.
    await allowWaking(s, s.coder.id);
    const depthItem = await itemFor("Depth");
    const deep = await insertRun(transaction, s, s.coder.id, { depth: 6, status: "completed" });
    await transaction.update(runs).set({ workItemId: depthItem }).where(eq(runs.id, deep.id));
    await s.work.updateWorkItem.handler(asAgent(s, deep.id, s.coder.userId), { workItemId: depthItem, assigneeIds: [s.reviewer.userId] });
    // No Agent access: the Originator may not use the reviewer.
    await s.agents.setAgentAccess.handler({ userId: s.admin.id }, { agentId: s.reviewer.id, userIds: [s.admin.id] });
    const accessItem = await itemFor("Access");
    const noAccess = await insertRun(transaction, s, s.coder.id, { status: "completed" });
    await transaction.update(runs).set({ workItemId: accessItem }).where(eq(runs.id, noAccess.id));
    await s.work.updateWorkItem.handler(asAgent(s, noAccess.id, s.coder.userId), { workItemId: accessItem, assigneeIds: [s.reviewer.userId] });
    // Over budget: the reviewer has spent its monthly token budget.
    await s.agents.setAgentAccess.handler({ userId: s.admin.id }, { agentId: s.reviewer.id, userIds: [s.admin.id, s.member.id] });
    await s.agents.updateAgent.handler({ userId: s.admin.id }, { agentId: s.reviewer.id, monthlyTokenBudget: 10 });
    await insertRun(transaction, s, s.reviewer.id, { status: "completed" });
    await transaction.update(runs).set({ inputTokens: 50, outputTokens: 0 }).where(eq(runs.agentId, s.reviewer.id));
    const budgetItem = await itemFor("Budget");
    const overBudget = await insertRun(transaction, s, s.coder.id, { status: "completed" });
    await transaction.update(runs).set({ workItemId: budgetItem }).where(eq(runs.id, overBudget.id));
    await s.work.updateWorkItem.handler(asAgent(s, overBudget.id, s.coder.userId), { workItemId: budgetItem, assigneeIds: [s.reviewer.userId] });
    const reasonsOf = async (itemId: string) => (await timelineOf(s, s.member.id, itemId)).filter((row) => row.field === "wake_skipped").map((row) => (row.newValue as { reason: string }).reason);
    expect(await reasonsOf(switchedOffItem)).toEqual(["switch_off"]);
    expect(await reasonsOf(depthItem)).toEqual(["depth_limit"]);
    expect(await reasonsOf(accessItem)).toEqual(["no_agent_access"]);
    expect(await reasonsOf(budgetItem)).toEqual(["over_budget"]);
  });
});

test("the Activity of a skipped wake over budget is recorded on the work item, not only as a skipped Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await allowWaking(s, s.coder.id);
    await s.agents.updateAgent.handler({ userId: s.admin.id }, { agentId: s.reviewer.id, monthlyTokenBudget: 10 });
    await insertRun(transaction, s, s.reviewer.id, { status: "completed" });
    await transaction.update(runs).set({ inputTokens: 50, outputTokens: 0 }).where(eq(runs.agentId, s.reviewer.id));
    const coderRun = await insertRun(transaction, s, s.coder.id, { status: "completed" });
    await s.work.updateWorkItem.handler(asAgent(s, coderRun.id, s.coder.userId), { workItemId: s.item.id, assigneeIds: [s.reviewer.userId] });
    const logged = await transaction.select().from(activities).where(and(eq(activities.entityId, s.item.id), eq(activities.field, "wake_skipped")));
    expect(logged).toEqual([expect.objectContaining({ newValue: expect.objectContaining({ reason: "over_budget" }) })]);
  });
});

test("a Guest who may read the timeline sees a woken Run without a link to the Run that woke it, and cannot list Runs", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await allowWaking(s, s.coder.id);
    const coderRun = await insertRun(transaction, s, s.coder.id, { status: "completed" });
    await s.work.updateWorkItem.handler(asAgent(s, coderRun.id, s.coder.userId), { workItemId: s.item.id, assigneeIds: [s.reviewer.userId] });
    const reviewerRun = (await transaction.select().from(runs).where(and(eq(runs.agentId, s.reviewer.id), eq(runs.workItemId, s.item.id))))[0]!;
    const member = startedEntry(await timelineOf(s, s.member.id), reviewerRun.id);
    expect(member).toMatchObject({ wokenBy: { runId: coderRun.id, agentName: "Coder", depth: 1 } });
    const guest = startedEntry(await timelineOf(s, s.guest.id), reviewerRun.id);
    expect(guest).toMatchObject({ wokenBy: { runId: null, agentName: "Coder", depth: 1 } });
    await expect(s.runActions.listRuns.handler({ userId: s.guest.id }, { workItemId: s.item.id })).rejects.toThrow("Forbidden");
  });
});

test("an interface string exists in English and Thai for each new timeline entry and skip reason", async () => {
  const { en } = await import("../../shared/src/en");
  const { th } = await import("../../shared/src/th");
  for (const key of ["workItems.activity.run_started", "workItems.activity.run_steered", "workItems.activity.wake_skipped.switch_off", "workItems.activity.wake_skipped.over_budget", "runs.wokenBy", "runs.wokenByDepth"]) {
    expect(typeof (en as Record<string, unknown>)[key]).toBe("string");
    expect(typeof (th as Record<string, unknown>)[key]).toBe("string");
  }
});
