import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, jobs, projectMembers, runs, type Database } from "@weft/db";
import { createAgentActions, createJobHandlers, createProjectActions, createRunActions, createWorkItemActions, queueRunsForAssignees, runNextJob, startRun } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  const agents = createAgentActions(transaction);
  const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", instructions: "", model: "default" });
  await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  return { workspace, admin, member, guest, project, projects, agents, agent, work: createWorkItemActions(transaction), runActions: createRunActions(transaction) };
}

const newItem = (s: Awaited<ReturnType<typeof setup>>, title = "Item") => s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title });

test.concurrent("assigning an Agent queues one Run naming the Originator and enqueues a job", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    const rows = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", agentId: s.agent.id, originatorId: s.member.id, projectId: s.project.id, inputTokens: 0, outputTokens: 0 });
    const queued = (await transaction.select().from(jobs)).filter((job) => job.type === "agent_run" && (job.payload as { runId: string }).runId === rows[0]!.id);
    expect(queued).toHaveLength(1);
  });
});

test.concurrent("creating a work item already assigned to an Agent queues a Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title: "Born assigned", assigneeIds: [s.agent.userId] });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(1);
  });
});

test.concurrent("assigning an Agent again while a Run is active creates no second active Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await s.agents.createAgent.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Bot 2", instructions: "", model: "default" });
    await s.agents.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: other.id, allProjects: true, projectIds: [] });
    const item = await newItem(s);
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [] });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId, other.userId] });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(1);
    // Once the Run is finished, a new assignment may queue another.
    await transaction.update(runs).set({ status: "completed" }).where(eq(runs.workItemId, item.id));
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [] });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(2);
  });
});

test.concurrent("an Originator without project access causes no Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    // The Originator loses the project right after the assignment would pass its own check: simulate with a Guest-level Originator.
    await transaction.update(projectMembers).set({ role: "Guest" }).where(eq(projectMembers.userId, s.member.id));
    await expect(s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] })).rejects.toMatchObject({ status: 403 });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
    // Assigning an ordinary person queues no Run either.
    await s.work.updateWorkItem.handler({ userId: s.admin.id }, { workItemId: item.id, assigneeIds: [s.admin.id] });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
  });
});

test.concurrent("an Originator who cannot write in the project gets no Run (queueRun refuses)", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    await queueRunsForAssignees(transaction, { originatorId: s.guest.id, project: { id: s.project.id, workspaceId: s.workspace.id }, workItemId: item.id, assigneeUserIds: [s.agent.userId] });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
  });
});

test.concurrent("disabling or deleting the Agent cancels its queued Runs but not running ones", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const a = await newItem(s, "A");
    const b = await newItem(s, "B");
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: a.id, assigneeIds: [s.agent.userId] });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: b.id, assigneeIds: [s.agent.userId] });
    await transaction.update(runs).set({ status: "running" }).where(eq(runs.workItemId, b.id));
    await s.agents.disableAgent.handler({ userId: s.admin.id }, { agentId: s.agent.id });
    const [first] = await transaction.select().from(runs).where(eq(runs.workItemId, a.id));
    expect(first!.status).toBe("cancelled");
    expect(first!.finishedAt).not.toBeNull();
    expect((await transaction.select().from(runs).where(eq(runs.workItemId, b.id)))[0]!.status).toBe("running");

    await s.agents.enableAgent.handler({ userId: s.admin.id }, { agentId: s.agent.id });
    const c = await newItem(s, "C");
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: c.id, assigneeIds: [s.agent.userId] });
    await s.agents.deleteAgent.handler({ userId: s.admin.id }, { agentId: s.agent.id });
    const [third] = await transaction.select().from(runs).where(eq(runs.workItemId, c.id));
    expect(third).toMatchObject({ status: "cancelled", agentId: null });
  });
});

test.concurrent("a cancelled queued Run is not started by its job", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    await s.agents.disableAgent.handler({ userId: s.admin.id }, { agentId: s.agent.id });
    const handlers = createJobHandlers();
    // Drain agent_run jobs; none may move the cancelled Run.
    for (let i = 0; i < 50; i += 1) if ((await runNextJob(transaction, { agent_run: handlers.agent_run! })).status === "idle") break;
    expect((await transaction.select().from(runs).where(eq(runs.workItemId, item.id)))[0]!.status).toBe("cancelled");
  });
});

test.concurrent("an Agent runs at most 2 Runs at once; the third waits", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const ids: string[] = [];
    for (const title of ["1", "2", "3"]) {
      const item = await newItem(s, title);
      await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
      ids.push((await transaction.select().from(runs).where(eq(runs.workItemId, item.id)))[0]!.id);
    }
    expect(await startRun(transaction, ids[0]!)).toBe("started");
    expect(await startRun(transaction, ids[1]!)).toBe("started");
    expect(await startRun(transaction, ids[2]!)).toBe("waiting");
    expect((await transaction.select().from(runs).where(eq(runs.id, ids[2]!)))[0]!.status).toBe("queued");
    await transaction.update(runs).set({ status: "completed" }).where(eq(runs.id, ids[0]!));
    expect(await startRun(transaction, ids[2]!)).toBe("started");
    expect((await transaction.select().from(runs).where(eq(runs.id, ids[2]!)))[0]).toMatchObject({ status: "running" });
  });
});

test.concurrent("a member lists a work item's Runs and reads one; a Guest and an outsider are refused", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    const listed = await s.runActions.listRuns.handler({ userId: s.member.id }, { workItemId: item.id });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ workItemId: item.id, agentId: s.agent.id, originatorId: s.member.id, status: "queued" });
    expect(await s.runActions.getRun.handler({ userId: s.admin.id }, { runId: listed[0]!.id })).toMatchObject({ id: listed[0]!.id, status: "queued" });
    const outsider = await createMemberFactory(transaction, s.workspace.id, "Member");
    for (const user of [s.guest, outsider]) {
      await expect(s.runActions.listRuns.handler({ userId: user.id }, { workItemId: item.id })).rejects.toMatchObject({ status: expect.any(Number) });
      await expect(s.runActions.getRun.handler({ userId: user.id }, { runId: listed[0]!.id })).rejects.toMatchObject({ status: expect.any(Number) });
    }
    await expect(s.runActions.listRuns.handler({ userId: s.guest.id }, { workItemId: item.id })).rejects.toMatchObject({ status: 403 });
    await expect(s.runActions.getRun.handler({ userId: s.member.id }, { runId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
  });
});
