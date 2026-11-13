import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, createDatabase, jobs, projectMembers, runs, workspaces, type Database } from "@weft/db";
import { createAgentActions, createJobHandlers, createProjectActions, createRunActions, createCommentActions, createWorkItemActions, createTriggerActions, queueRunsForAssignees, runNextJob, startRun, createAutopilotSettingActions } from "../src";
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
  return { workspace, admin, member, guest, project, projects, agents, agent, comments: createCommentActions(transaction), work: createWorkItemActions(transaction), runActions: createRunActions(transaction) };
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

test.concurrent("workspace Admin configures hourly Run caps and reaching either cap refuses a new Run clearly", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const limits = createAutopilotSettingActions(transaction);
    expect(await limits.setRuntimeRunLimits.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, runsPerPersonPerHour: 1, runsPerAgentPerHour: 30 })).toEqual({ runsPerPersonPerHour: 1, runsPerAgentPerHour: 30 });
    const first = await newItem(s, "First Run");
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: first.id, assigneeIds: [s.agent.userId] });
    const second = await newItem(s, "Over the hourly cap");
    await expect(s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: second.id, assigneeIds: [s.agent.userId] })).rejects.toMatchObject({ status: 429, message: "Run limit reached: 1 Runs per person per hour. Try again later." });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, second.id))).toHaveLength(0);
    await expect(limits.setRuntimeRunLimits.handler({ userId: s.member.id }, { workspaceId: s.workspace.id, runsPerPersonPerHour: 3, runsPerAgentPerHour: 3 })).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("hourly Agent Run cap applies across different Originators", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await createAutopilotSettingActions(transaction).setRuntimeRunLimits.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, runsPerPersonPerHour: 30, runsPerAgentPerHour: 1 });
    const first = await newItem(s, "First Agent Run");
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: first.id, assigneeIds: [s.agent.userId] });
    const second = await newItem(s, "Second Originator");
    await expect(s.work.updateWorkItem.handler({ userId: s.admin.id }, { workItemId: second.id, assigneeIds: [s.agent.userId] })).rejects.toMatchObject({ status: 429, message: "Run limit reached: 1 Runs per Agent per hour. Try again later." });
  });
});

test.concurrent("creating a work item already assigned to an Agent queues a Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title: "Born assigned", assigneeIds: [s.agent.userId] });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(1);
  });
});

test.concurrent("assigning another Agent while a Run is active queues one Run per Agent and work item", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await s.agents.createAgent.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Bot 2", instructions: "", model: "default" });
    await s.agents.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: other.id, allProjects: true, projectIds: [] });
    const item = await newItem(s);
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [] });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId, other.userId] });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(2);
    // Once the Run is finished, a new assignment may queue another.
    await transaction.update(runs).set({ status: "completed" }).where(eq(runs.workItemId, item.id));
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [] });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(3);
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

test.concurrent("disabling or deleting the Agent cancels queued Runs and stops running ones", async () => {
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
    expect((await transaction.select().from(runs).where(eq(runs.workItemId, b.id)))[0]!.status).toBe("stopping");
    expect((await transaction.select({ entityId: activities.entityId }).from(activities).where(eq(activities.field, "run_revoked"))).map((row) => row.entityId).sort()).toEqual([a.id, b.id].sort());

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

const mention = (userId: string, label = "Bot") => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: userId, label } }, { type: "text", text: " please look" }] }] });

test.concurrent("Autopilot assignments and mentions do not start Agent Runs or fire Triggers, while a person's assignment still does", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    const triggerActions = createTriggerActions(transaction);
    const triggers = [];
    for (const eventType of ["work_item_created", "work_item_updated", "assignee_changed", "comment_added"] as const) {
      triggers.push(await triggerActions.createTrigger.handler({ userId: s.admin.id }, { agentId: s.agent.id, projectId: s.project.id, eventType }));
    }

    await s.work.updateWorkItem.handler({ userId: s.member.id, source: "ai_autopilot" }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    await s.comments.createComment.handler({ userId: s.member.id, source: "ai_autopilot" }, { workItemId: item.id, body: mention(s.agent.userId) });
    const created = await s.work.createWorkItem.handler({ userId: s.member.id, source: "ai_autopilot" }, { projectId: s.project.id, title: "Autopilot created", assigneeIds: [s.agent.userId] });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, created.id))).toHaveLength(0);
    expect(await transaction.select().from(runs).where(eq(runs.projectId, s.project.id))).toHaveLength(0);

    for (const trigger of triggers) await triggerActions.deleteTrigger.handler({ userId: s.admin.id }, { triggerId: trigger.id });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [] });
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    const personRuns = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    expect(personRuns).toHaveLength(1);
    expect(personRuns[0]).toMatchObject({ status: "queued", originatorId: s.member.id, agentId: s.agent.id, triggerId: null });
  });
});

test.concurrent("a person's mention of an Agent queues a Run with that person as Originator and the comment as request", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    const comment = await s.comments.createComment.handler({ userId: s.member.id }, { workItemId: item.id, body: mention(s.agent.userId) });
    const rows = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", agentId: s.agent.id, originatorId: s.member.id, commentId: comment.id });
    const queued = (await transaction.select().from(jobs)).filter((job) => job.type === "agent_run" && (job.payload as { runId: string }).runId === rows[0]!.id);
    expect(queued).toHaveLength(1);
  });
});

test.concurrent("editing a comment to add an Agent mention queues a Run; a second mention while active queues none", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    const comment = await s.comments.createComment.handler({ userId: s.member.id }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] } });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
    await s.comments.updateComment.handler({ userId: s.member.id }, { commentId: comment.id, body: mention(s.agent.userId) });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(1);
    await s.comments.createComment.handler({ userId: s.member.id }, { workItemId: item.id, body: mention(s.agent.userId) });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(1);
  });
});

test.concurrent("a mention queues nothing for a Guest, a disabled Agent, or an Agent not opened to the project", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    // A Guest cannot comment at all, so no Run can come from them.
    await expect(s.comments.createComment.handler({ userId: s.guest.id }, { workItemId: item.id, body: mention(s.agent.userId) })).rejects.toMatchObject({ status: 403 });
    // Disabled Agent cannot be mentioned.
    await s.agents.disableAgent.handler({ userId: s.admin.id }, { agentId: s.agent.id });
    await expect(s.comments.createComment.handler({ userId: s.member.id }, { workItemId: item.id, body: mention(s.agent.userId) })).rejects.toMatchObject({ status: 400 });
    await s.agents.enableAgent.handler({ userId: s.admin.id }, { agentId: s.agent.id });
    // An Agent closed to this project: the public project lets the mention through, but no Run starts.
    await s.projects.updateProject.handler({ userId: s.admin.id }, { projectId: s.project.id, visibility: "public" });
    await s.agents.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: s.agent.id, allProjects: false, projectIds: [] });
    await s.comments.createComment.handler({ userId: s.member.id }, { workItemId: item.id, body: mention(s.agent.userId) });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
  });
});

test.concurrent("an Originator who cannot write in the project gets no Run from a mention", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s);
    await queueRunsForAssignees(transaction, { originatorId: s.guest.id, project: { id: s.project.id, workspaceId: s.workspace.id }, workItemId: item.id, assigneeUserIds: [s.agent.userId], commentId: crypto.randomUUID() });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
  });
});

test.concurrent("an Agent's comment that mentions an Agent queues nothing", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await s.agents.createAgent.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Bot 2", instructions: "", model: "default" });
    await s.agents.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: other.id, allProjects: true, projectIds: [] });
    const item = await newItem(s);
    await s.comments.createComment.handler({ userId: s.agent.userId }, { workItemId: item.id, body: mention(other.userId, "Bot 2") });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
  });
});

test.concurrent("a change made by an Agent triggers no Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await s.agents.createAgent.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Bot 2", instructions: "", model: "default" });
    await s.agents.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: other.id, allProjects: true, projectIds: [] });
    const item = await newItem(s);
    await s.work.updateWorkItem.handler({ userId: s.agent.userId }, { workItemId: item.id, assigneeIds: [other.userId] });
    const created = await s.work.createWorkItem.handler({ userId: s.agent.userId }, { projectId: s.project.id, title: "From bot", assigneeIds: [other.userId] });
    expect(await transaction.select().from(runs).where(eq(runs.projectId, s.project.id))).toHaveLength(0);
    expect(created.id).toBeTruthy();
  });
});

test.concurrent("a change made by an Agent's Run, even a confirmed one run as the Originator, queues no Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await s.agents.createAgent.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Bot 2", instructions: "", model: "default" });
    await s.agents.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: other.id, allProjects: true, projectIds: [] });
    const item = await newItem(s);
    const first = await newItem(s, "Assigned");
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: first.id, assigneeIds: [s.agent.userId] });
    const [ownRun] = await transaction.select().from(runs).where(eq(runs.workItemId, first.id));
    const attribution = { agentUserId: s.agent.userId, runId: ownRun!.id, originatorId: s.member.id };
    // The confirmation path runs the action as the Originator with source "agent".
    await s.work.updateWorkItem.handler({ userId: s.member.id, source: "agent", agent: attribution }, { workItemId: item.id, assigneeIds: [other.userId] });
    await s.comments.createComment.handler({ userId: s.member.id, source: "agent", agent: attribution }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: other.userId } }] }] } });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, item.id))).toHaveLength(0);
  });
});

test.concurrent("a server Run records the model id the worker really calls, not the Agent's label", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const item = await newItem(s, "Model id");
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [s.agent.userId] });
    const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    expect(await startRun(transaction, run!.id, "gpt-real")).toBe("started");
    expect((await transaction.select().from(runs).where(eq(runs.id, run!.id)))[0]!.model).toBe("gpt-real");
  });
});
