import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, runs, workspaces, type Database } from "@weft/db";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions, createTriggerActions, createWorkItemActions, handleAgentRunJob, type RunModel, type RunModelRequest } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** A workspace with an Admin, a Member, a coder Agent (can wake) and a reviewer Agent that owns a parent work item with two sub-items. */
async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const agents = createAgentActions(transaction);
  const coder = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Coder", instructions: "", model: "default" });
  const owner = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Owner", instructions: "Summarise.", model: "default" });
  const stranger = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Stranger", instructions: "", model: "default" });
  for (const agent of [coder, owner, stranger]) {
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await agents.setAgentAccess.handler({ userId: admin.id }, { agentId: agent.id, userIds: [admin.id, member.id] });
  }
  const work = createWorkItemActions(transaction);
  const triggers = createTriggerActions(transaction);
  const parent = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Ship the login" });
  const first = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Build the form", parentId: parent.id });
  const second = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Wire the API", parentId: parent.id });
  const states = await work.listStates.handler({ userId: member.id }, { projectId: project.id });
  const state = (group: string) => states.find((s) => s.group === group)!.id;
  return { workspace, admin, member, project, agents, coder, owner, stranger, work, triggers, parent, first, second, state };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** The Agent that owns the parent, with a sub-items closed Trigger. Assigning it as the parent's assignee queues an assignment Run, which is finished here so only Trigger Runs remain. */
async function ownParent(s: Setup, transaction: Database) {
  await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: s.parent.id, assigneeIds: [s.owner.userId] });
  await transaction.update(runs).set({ status: "completed", finishedAt: new Date() }).where(eq(runs.workItemId, s.parent.id));
  return s.triggers.createTrigger.handler({ userId: s.admin.id }, { agentId: s.owner.id, projectId: s.project.id, eventType: "sub_items_closed" });
}
const triggerRuns = (transaction: Database, triggerId: string) => transaction.select().from(runs).where(eq(runs.triggerId, triggerId));
const close = (s: Setup, itemId: string, group: "completed" | "cancelled", actor = s.member.id) => s.work.updateWorkItem.handler({ userId: actor }, { workItemId: itemId, stateId: s.state(group) });
const reopen = (s: Setup, itemId: string) => s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: itemId, stateId: s.state("started") });
const finishAll = (transaction: Database, itemId: string) => transaction.update(runs).set({ status: "completed", finishedAt: new Date() }).where(eq(runs.workItemId, itemId));

function answering(text: string) {
  const requests: RunModelRequest[] = [];
  const model: RunModel = { async step(request) { requests.push(JSON.parse(JSON.stringify(request))); return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } };
  return { model, requests };
}

test("the sub-items closed event can be created, edited into and listed on a Trigger", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const created = await s.triggers.createTrigger.handler({ userId: s.admin.id }, { agentId: s.owner.id, projectId: s.project.id, eventType: "state_changed" });
    const edited = await s.triggers.updateTrigger.handler({ userId: s.admin.id }, { triggerId: created.id, eventType: "sub_items_closed" });
    expect(edited).toMatchObject({ eventType: "sub_items_closed", schedule: null });
    expect(await s.triggers.listTriggers.handler({ userId: s.admin.id }, { agentId: s.owner.id })).toEqual([expect.objectContaining({ id: created.id, eventType: "sub_items_closed" })]);
    const direct = await s.triggers.createTrigger.handler({ userId: s.admin.id }, { agentId: s.coder.id, projectId: s.project.id, eventType: "sub_items_closed" });
    expect(direct.eventType).toBe("sub_items_closed");
  });
});

test("closing the last sub-item as Done wakes the parent's assignee Agent; closing a non-last sub-item does not", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    await close(s, s.first.id, "completed");
    expect(await triggerRuns(transaction, trigger.id)).toEqual([]);
    await close(s, s.second.id, "completed");
    expect(await triggerRuns(transaction, trigger.id)).toEqual([expect.objectContaining({ agentId: s.owner.id, workItemId: s.parent.id, status: "queued", depth: 0, originatorId: s.member.id })]);
  });
});

test("closing the last sub-item as Cancelled wakes the parent's assignee Agent too, and a mix of Done and Cancelled counts as closed", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    await close(s, s.first.id, "completed");
    await close(s, s.second.id, "cancelled");
    expect(await triggerRuns(transaction, trigger.id)).toEqual([expect.objectContaining({ agentId: s.owner.id, workItemId: s.parent.id, status: "queued" })]);
  });
});

test("moving the last sub-item on the board into Done wakes the parent's assignee Agent", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    await s.work.moveWorkItem.handler({ userId: s.member.id }, { workItemId: s.first.id, stateId: s.state("completed") });
    await s.work.moveWorkItem.handler({ userId: s.member.id }, { workItemId: s.second.id, stateId: s.state("completed") });
    expect(await triggerRuns(transaction, trigger.id)).toHaveLength(1);
  });
});

test("an Agent that is not an assignee of the parent is not woken, though it has the Trigger", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const owned = await ownParent(s, transaction);
    const stray = await s.triggers.createTrigger.handler({ userId: s.admin.id }, { agentId: s.stranger.id, projectId: s.project.id, eventType: "sub_items_closed" });
    await close(s, s.first.id, "completed");
    await close(s, s.second.id, "completed");
    expect(await triggerRuns(transaction, stray.id)).toEqual([]);
    expect(await transaction.select().from(runs).where(eq(runs.agentId, s.stranger.id))).toEqual([]);
    expect(await triggerRuns(transaction, owned.id)).toHaveLength(1);
  });
});

test("a parent with no sub-items never fires it, and a sub-item with no parent closing wakes nobody", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    const lonely = await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title: "No children", assigneeIds: [s.owner.userId] });
    await finishAll(transaction, lonely.id);
    await close(s, lonely.id, "completed");
    await reopen(s, lonely.id);
    await close(s, lonely.id, "cancelled");
    expect(await triggerRuns(transaction, trigger.id)).toEqual([]);
  });
});

test("a sub-item that is re-opened and re-closed fires it again only when it is the last open one", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    await close(s, s.first.id, "completed");
    await close(s, s.second.id, "completed");
    expect(await triggerRuns(transaction, trigger.id)).toHaveLength(1);
    await finishAll(transaction, s.parent.id);
    // Both open again, then one closes while the other is still open: no new Run.
    await reopen(s, s.first.id);
    await reopen(s, s.second.id);
    await close(s, s.first.id, "completed");
    expect(await triggerRuns(transaction, trigger.id)).toHaveLength(1);
    // The other one closes last: it fires again.
    await close(s, s.second.id, "completed");
    expect(await triggerRuns(transaction, trigger.id)).toHaveLength(2);
  });
});

test("a move from Done to Cancelled, both closed, is not a close and fires nothing", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    await close(s, s.first.id, "completed");
    await close(s, s.second.id, "completed");
    await finishAll(transaction, s.parent.id);
    await close(s, s.second.id, "cancelled");
    expect(await triggerRuns(transaction, trigger.id)).toHaveLength(1);
  });
});

test("when an Agent closes the last sub-item, the woken Run is a chain step: depth +1, the chain's Originator and a link to the waking Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    await s.agents.updateAgent.handler({ userId: s.admin.id }, { agentId: s.coder.id, canWakeAgents: true });
    await close(s, s.first.id, "completed");
    const [coderRun] = await transaction.insert(runs).values({ workspaceId: s.workspace.id, projectId: s.project.id, workItemId: s.second.id, agentId: s.coder.id, originatorId: s.member.id, status: "running", depth: 2 }).returning();
    await s.work.updateWorkItem.handler({ userId: s.coder.userId, source: "agent", agent: { agentUserId: s.coder.userId, runId: coderRun!.id, originatorId: s.member.id, autopilot: true } }, { workItemId: s.second.id, stateId: s.state("completed") });
    expect(await triggerRuns(transaction, trigger.id)).toEqual([expect.objectContaining({ agentId: s.owner.id, workItemId: s.parent.id, status: "queued", depth: 3, wokenByRunId: coderRun!.id, originatorId: s.member.id })]);
  });
});

test("when an Agent with the switch off closes the last sub-item, no Run starts and the skip is on the parent's timeline", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    await close(s, s.first.id, "completed");
    const [coderRun] = await transaction.insert(runs).values({ workspaceId: s.workspace.id, projectId: s.project.id, workItemId: s.second.id, agentId: s.coder.id, originatorId: s.member.id, status: "running" }).returning();
    const updated = await s.work.updateWorkItem.handler({ userId: s.coder.userId, source: "agent", agent: { agentUserId: s.coder.userId, runId: coderRun!.id, originatorId: s.member.id, autopilot: true } }, { workItemId: s.second.id, stateId: s.state("completed") });
    expect(updated.stateId).toBe(s.state("completed"));
    expect(await triggerRuns(transaction, trigger.id)).toEqual([]);
    const skips = await transaction.select().from(activities).where(and(eq(activities.entityType, "work_item"), eq(activities.entityId, s.parent.id), eq(activities.field, "wake_skipped")));
    expect(skips).toEqual([expect.objectContaining({ newValue: expect.objectContaining({ reason: "switch_off", agentId: s.owner.id }) })]);
  });
});

test("a person without Agent access to the parent's Agent closing the last sub-item wakes nobody", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    await s.agents.setAgentAccess.handler({ userId: s.admin.id }, { agentId: s.owner.id, userIds: [s.admin.id] });
    await close(s, s.first.id, "completed");
    await close(s, s.second.id, "completed");
    expect(await triggerRuns(transaction, trigger.id)).toEqual([]);
  });
});

test("the woken server Run's prompt names the parent and every sub-item that closed, with how each closed", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const trigger = await ownParent(s, transaction);
    await close(s, s.first.id, "completed");
    await close(s, s.second.id, "cancelled");
    const [run] = await triggerRuns(transaction, trigger.id);
    const { model, requests } = answering("Summary.");
    await handleAgentRunJob(transaction, { runId: run!.id }, { model });
    const prompt = JSON.stringify(requests[0]!.messages);
    expect(prompt).toContain("All sub-items of this work item are now closed");
    expect(prompt).toContain("ALP-1");
    expect(prompt).toContain("Ship the login");
    expect(prompt).toContain("Build the form");
    expect(prompt).toContain("Wire the API");
    expect(prompt).toMatch(/ALP-2[^]*Done|Build the form[^]*Done/);
    expect(prompt).toContain("Cancelled");
  });
});

test("the woken Runtime Run's request names the parent and the closed sub-items", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const { id: tokenId } = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const registered = await createRuntimeActions(transaction).registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    const runtime = registered.runtimes[0]!;
    await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
    await createProjectActions(transaction).addProjectMember.handler({ userId: owner.id }, { projectId: project.id, userId: member.id, role: "Member" });
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Bot", instructions: "Summarise", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await agents.updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId: runtime.id });
    await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [owner.id, member.id] });
    const work = createWorkItemActions(transaction);
    const parent = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Ship the login", assigneeIds: [agent.userId] });
    await transaction.update(runs).set({ status: "completed", finishedAt: new Date() }).where(eq(runs.workItemId, parent.id));
    const child = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Build the form", parentId: parent.id });
    await createTriggerActions(transaction).createTrigger.handler({ userId: owner.id }, { agentId: agent.id, projectId: project.id, eventType: "sub_items_closed" });
    const states = await work.listStates.handler({ userId: member.id }, { projectId: project.id });
    await work.updateWorkItem.handler({ userId: member.id }, { workItemId: child.id, stateId: states.find((state) => state.group === "completed")!.id });
    const [claimed] = await createRuntimeDispatchActions(transaction).claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    expect(claimed!.request).toContain("All sub-items of this work item are now closed");
    expect(claimed!.request).toContain("Build the form");
    expect(claimed!.request).toContain("Done");
  });
});
