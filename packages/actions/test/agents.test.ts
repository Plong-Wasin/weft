import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, activities, users, workspaceMembers, projectMembers, runs, jobs, workspaces, type Database } from "@weft/db";
import { createAgentActions, createApiTokenActions, createAutopilotSettingActions, createCommentActions, createMemberActions, createModuleActions, createProjectActions, createRuntimeActions, createSkillActions, createWorkItemActions, createRunActions, createTriggerActions, fireEventTriggers, fireScheduleTrigger, startRun } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const agentInput = { name: "Triage bot", instructions: "Triage new work items.", model: "default" };

test.concurrent("an Agent's Autopilot switch requires workspace permission and is returned by Agent actions", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, workspace } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await expect(agents.updateAgent.handler({ userId: admin.id }, { agentId: agent.id, autopilot: true })).rejects.toMatchObject({ status: 400 });
    await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    expect(await agents.updateAgent.handler({ userId: admin.id }, { agentId: agent.id, autopilot: true })).toMatchObject({ autopilot: true });
    expect(await agents.getAgent.handler({ userId: admin.id }, { agentId: agent.id })).toMatchObject({ autopilot: true });
    await createAutopilotSettingActions(transaction).setAutopilotSetting.handler({ userId: admin.id }, { workspaceId: workspace.id, allowAutopilot: false });
    expect((await agents.getAgent.handler({ userId: admin.id }, { agentId: agent.id })).autopilot).toBe(false);
  });
});

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const stranger = await createMemberFactory(transaction, (await createWorkspaceFactory(transaction)).id, "Admin");
  const projects = createProjectActions(transaction);
  const alpha = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
  const beta = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Beta", key: "BET", visibility: "public" });
  for (const project of [alpha, beta]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  return { workspace, admin, member, guest, stranger, alpha, beta, projects, agents: createAgentActions(transaction), work: createWorkItemActions(transaction) };
}

test.concurrent("Admin creates, edits, lists and gets an Agent; the Agent is a Member-role bot user", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, workspace } = await setup(transaction);
    const created = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput, maxToolCalls: 10, monthlyTokenBudget: 5000 });
    expect(created).toMatchObject({ name: "Triage bot", instructions: "Triage new work items.", model: "default", enabled: true, allProjects: false, projectIds: [], maxToolCalls: 10, monthlyTokenBudget: 5000 });
    const [bot] = await transaction.select().from(users).where(eq(users.id, created.userId));
    expect(bot).toMatchObject({ name: "Triage bot", isAgent: true });
    const [membership] = await transaction.select().from(workspaceMembers).where(eq(workspaceMembers.userId, created.userId));
    expect(membership).toMatchObject({ workspaceId: workspace.id, role: "Member" });
    const updated = await agents.updateAgent.handler({ userId: admin.id }, { agentId: created.id, name: "Renamed", instructions: "New.", maxTokens: 1000 });
    expect(updated).toMatchObject({ name: "Renamed", instructions: "New.", maxTokens: 1000, maxToolCalls: 10 });
    expect((await transaction.select().from(users).where(eq(users.id, created.userId)))[0]!.name).toBe("Renamed");
    expect((await agents.listAgents.handler({ userId: admin.id }, { workspaceId: workspace.id })).map((agent) => agent.id)).toEqual([created.id]);
    expect(await agents.getAgent.handler({ userId: admin.id }, { agentId: created.id })).toMatchObject({ id: created.id, name: "Renamed" });
  });
});

test.concurrent("Agent extra action grants default off, are configurable by an Admin, and record the change", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, workspace } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    expect(agent).toMatchObject({ allowProjectActions: false, allowMemberActions: false, allowFeatureActions: false, allowExportActions: false });
    const updated = await agents.updateAgent.handler({ userId: admin.id }, { agentId: agent.id, allowProjectActions: true, allowFeatureActions: true });
    expect(updated).toMatchObject({ allowProjectActions: true, allowMemberActions: false, allowFeatureActions: true, allowExportActions: false });
    const [entry] = await transaction.select().from(activities).where(eq(activities.entityId, agent.id)).then((rows) => rows.filter((row) => row.field === "action_grants"));
    expect(entry).toMatchObject({ entityType: "agent", field: "action_grants", actorId: admin.id, oldValue: { allowProjectActions: false, allowFeatureActions: false }, newValue: { allowProjectActions: true, allowFeatureActions: true } });
  });
});

test.concurrent("Agent administration changes for access, Runtime, Trigger, Skill and Autopilot record their actor", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace, alpha } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await agents.setAgentAccess.handler({ userId: admin.id }, { agentId: agent.id, userIds: [admin.id, member.id] });
    const skillActions = createSkillActions(transaction);
    const skill = await skillActions.createSkill.handler({ userId: admin.id }, { workspaceId: workspace.id, scope: "workspace", name: "audit-check", description: "Audit", instructions: "Do audit" });
    await skillActions.updateSkill.handler({ userId: admin.id }, { skillId: skill.id, description: "Updated" });
    await agents.setAgentSkills.handler({ userId: admin.id }, { agentId: agent.id, skillIds: [skill.id] });
    const trigger = await createTriggerActions(transaction).createTrigger.handler({ userId: admin.id }, { agentId: agent.id, projectId: alpha.id, eventType: "work_item_created" });
    await createTriggerActions(transaction).pauseTrigger.handler({ userId: admin.id }, { triggerId: trigger.id, paused: true });
    const { id: tokenId } = await createApiTokenActions(transaction).createApiToken.handler({ userId: admin.id }, { name: "audit daemon" });
    const offered = await createRuntimeActions(transaction).registerDaemon.handler({ userId: admin.id, apiTokenId: tokenId }, { hostname: "audit-host", version: "1", agentClis: ["codex"] });
    const runtime = offered.runtimes[0]!;
    await createRuntimeActions(transaction).shareRuntime.handler({ userId: admin.id }, { runtimeId: runtime.id });
    await createAutopilotSettingActions(transaction).setAutopilotSetting.handler({ userId: admin.id }, { workspaceId: workspace.id, allowAutopilot: true });
    const entries = await transaction.select({ entityType: activities.entityType, actorId: activities.actorId }).from(activities);
    for (const entityType of ["agent", "runtime", "trigger", "skill", "workspace"]) expect(entries.some((entry) => entry.entityType === entityType && entry.actorId === admin.id)).toBe(true);
  });
});

test.concurrent("Admin manages project event triggers and work item creation queues one Run", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace, alpha, work } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [alpha.id] });
    const actions = createTriggerActions(transaction);
    const trigger = await actions.createTrigger.handler({ userId: admin.id }, { agentId: agent.id, projectId: alpha.id, eventType: "work_item_created" });
    expect(await actions.listTriggers.handler({ userId: admin.id }, { agentId: agent.id })).toHaveLength(1);
    const item = await work.createWorkItem.handler({ userId: admin.id }, { projectId: alpha.id, title: "Triggered" });
    const [run] = await transaction.select().from((await import("@weft/db")).runs).where(eq((await import("@weft/db")).runs.workItemId, item.id));
    expect(run).toMatchObject({ agentId: agent.id, originatorId: admin.id, status: "queued" });
    await actions.pauseTrigger.handler({ userId: admin.id }, { triggerId: trigger.id, paused: true });
    await actions.updateTrigger.handler({ userId: admin.id }, { triggerId: trigger.id, eventType: "work_item_updated" });
    expect(await actions.deleteTrigger.handler({ userId: admin.id }, { triggerId: trigger.id })).toEqual({ deleted: true });
  });
});

test.concurrent("schedule triggers queue one work-item-free Run after downtime and advance to the next future occurrence", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, workspace, alpha } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [alpha.id] });
    const actions = createTriggerActions(transaction);
    await expect(actions.createTrigger.handler({ userId: admin.id }, { agentId: agent.id, projectId: alpha.id, schedule: "cron", expression: "99 * * * *" })).rejects.toThrow("Cron minute must be between 0 and 59");
    const trigger = await actions.createTrigger.handler({ userId: admin.id }, { agentId: agent.id, projectId: alpha.id, schedule: "daily" });
    const [dueJob] = await transaction.select().from(jobs).where(eq(jobs.type, "schedule_trigger"));
    expect(dueJob).toMatchObject({ runAt: trigger.nextRunAt, status: "pending", payload: { triggerId: trigger.id } });
    const due = new Date(trigger.nextRunAt!.getTime() + 5 * 24 * 60 * 60 * 1000);
    await fireScheduleTrigger(transaction, { triggerId: trigger.id, now: due });
    const scheduledRuns = await transaction.select().from(runs).where(eq(runs.triggerId, trigger.id));
    expect(scheduledRuns).toHaveLength(1);
    expect(scheduledRuns[0]).toMatchObject({ workItemId: null, originatorId: admin.id, projectId: alpha.id });
    const [advanced] = await transaction.select().from((await import("@weft/db")).triggers).where(eq((await import("@weft/db")).triggers.id, trigger.id));
    expect(advanced.nextRunAt!.getTime()).toBeGreaterThan(due.getTime());
    await fireScheduleTrigger(transaction, { triggerId: trigger.id, now: due });
    expect(await transaction.select().from(runs).where(eq(runs.triggerId, trigger.id))).toHaveLength(1);
    const scheduled = scheduledRuns[0]!;
    const runActions = createRunActions(transaction);
    expect((await runActions.getRun.handler({ userId: admin.id }, { runId: scheduled.id })).workItemId).toBeNull();
    expect((await runActions.getRunTranscript.handler({ userId: admin.id }, { runId: scheduled.id })).steps).toEqual([]);
    await runActions.cancelRun.handler({ userId: admin.id }, { runId: scheduled.id });
    const rerun = await runActions.rerunRun.handler({ userId: admin.id }, { runId: scheduled.id });
    expect(rerun).toMatchObject({ workItemId: null, status: "queued", rerunOfId: scheduled.id });
  });
});

test.concurrent("each event queues a Run, Agent actors are ignored, and revoked creators cannot queue", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace, alpha, work } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [alpha.id] });
    const events = ["work_item_created", "work_item_updated", "state_changed", "assignee_changed", "comment_added"] as const;
    const ids: string[] = [];
    for (const [index, eventType] of events.entries()) {
      const trigger = await createTriggerActions(transaction).createTrigger.handler({ userId: admin.id }, { agentId: agent.id, projectId: alpha.id, eventType });
      const item = await work.createWorkItem.handler({ userId: admin.id }, { projectId: alpha.id, title: `Event ${index}` });
      ids.push(item.id);
      await fireEventTriggers(transaction, { eventType, projectId: alpha.id, workItemId: item.id, actorId: admin.id });
      expect(trigger.paused).toBe(false);
    }
    const queued = await transaction.select().from(runs).where(eq(runs.agentId, agent.id));
    expect(queued.length).toBeGreaterThanOrEqual(5);
    const beforeAgentWrite = queued.length;
    await fireEventTriggers(transaction, { eventType: "work_item_updated", projectId: alpha.id, workItemId: ids[0]!, actorId: agent.userId });
    expect((await transaction.select().from(runs).where(eq(runs.agentId, agent.id))).length).toBe(beforeAgentWrite);
    const last = await work.createWorkItem.handler({ userId: agent.userId, source: "agent" }, { projectId: alpha.id, title: "Access revoked" });
    await transaction.update(workspaceMembers).set({ role: "Member" }).where(eq(workspaceMembers.userId, admin.id));
    await transaction.delete(projectMembers).where(eq(projectMembers.userId, admin.id));
    const countBeforeRevokedCreator = (await transaction.select().from(runs).where(eq(runs.agentId, agent.id))).length;
    await fireEventTriggers(transaction, { eventType: "comment_added", projectId: alpha.id, workItemId: last.id, actorId: member.id });
    expect((await transaction.select().from(runs).where(eq(runs.agentId, agent.id))).length).toBe(countBeforeRevokedCreator);
  });
});

test.concurrent("Admins attach and detach any number of Workspace Skills from an Agent", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, guest, workspace } = await setup(transaction);
    const skillActions = createSkillActions(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    const skill1 = await skillActions.createSkill.handler({ userId: admin.id }, { workspaceId: workspace.id, scope: "workspace", name: "one", description: "One", instructions: "One" });
    const skill2 = await skillActions.createSkill.handler({ userId: admin.id }, { workspaceId: workspace.id, scope: "workspace", name: "two", description: "Two", instructions: "Two" });
    const personal = await skillActions.createSkill.handler({ userId: admin.id }, { workspaceId: workspace.id, scope: "personal", name: "private", description: "Private", instructions: "Private" });
    const attached = await agents.setAgentSkills.handler({ userId: admin.id }, { agentId: agent.id, skillIds: [skill1.id, skill2.id] });
    expect(attached.skills).toEqual([{ id: skill1.id, name: "one", description: "One" }, { id: skill2.id, name: "two", description: "Two" }]);
    expect(await skillActions.listSkillAgents.handler({ userId: admin.id }, { skillId: skill1.id })).toEqual([{ id: agent.id, name: agent.name }]);
    for (const user of [member, guest]) await expect(agents.setAgentSkills.handler({ userId: user.id }, { agentId: agent.id, skillIds: [] })).rejects.toMatchObject({ status: 403 });
    await expect(agents.setAgentSkills.handler({ userId: admin.id }, { agentId: agent.id, skillIds: [personal.id] })).rejects.toMatchObject({ status: 400 });
    expect((await agents.setAgentSkills.handler({ userId: admin.id }, { agentId: agent.id, skillIds: [skill2.id] })).skills).toEqual([{ id: skill2.id, name: "two", description: "Two" }]);
    await skillActions.deleteSkill.handler({ userId: admin.id }, { skillId: skill2.id });
    expect((await agents.getAgent.handler({ userId: admin.id }, { agentId: agent.id })).skills).toEqual([]);
  });
});

test.concurrent("limits are capped at system ceilings and must be positive", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, workspace } = await setup(transaction);
    await expect(agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput, maxToolCalls: 100000 })).rejects.toMatchObject({ status: 400 });
    await expect(agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput, timeoutSeconds: 0 })).rejects.toMatchObject({ status: 400 });
    const created = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    expect(created).toMatchObject({ maxToolCalls: 25, timeoutSeconds: 1800, monthlyTokenBudget: null });
  });
});

test.concurrent("an Agent can bind only to a shared Runtime in its workspace, and bound Runs count against its monthly budget", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace, alpha, work } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput, monthlyTokenBudget: 1 });
    const runtimes = createRuntimeActions(transaction);
    const { id: tokenId } = await createApiTokenActions(transaction).createApiToken.handler({ userId: member.id }, { name: "daemon" });
    const { runtimes: offered } = await runtimes.registerDaemon.handler({ userId: member.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    const runtimeId = offered[0]!.id;
    await expect(agents.updateAgent.handler({ userId: admin.id }, { agentId: agent.id, runtimeId })).rejects.toMatchObject({ status: 400 });
    const foreignWorkspace = await createWorkspaceFactory(transaction);
    const foreignOwner = await createMemberFactory(transaction, foreignWorkspace.id, "Member");
    const { id: foreignToken } = await createApiTokenActions(transaction).createApiToken.handler({ userId: foreignOwner.id }, { name: "foreign daemon" });
    const foreignRuntimes = await runtimes.registerDaemon.handler({ userId: foreignOwner.id, apiTokenId: foreignToken }, { hostname: "other", version: "1", agentClis: ["claude"] });
    await runtimes.shareRuntime.handler({ userId: foreignOwner.id }, { runtimeId: foreignRuntimes.runtimes[0]!.id });
    await expect(agents.updateAgent.handler({ userId: admin.id }, { agentId: agent.id, runtimeId: foreignRuntimes.runtimes[0]!.id })).rejects.toMatchObject({ status: 400 });
    await runtimes.shareRuntime.handler({ userId: member.id }, { runtimeId });
    const bound = await agents.updateAgent.handler({ userId: admin.id }, { agentId: agent.id, runtimeId, cliModel: "opus", maxConcurrentRuns: 6 });
    expect(bound).toMatchObject({ runtimeId, runtimeShared: true, runtimeOnline: true, cliModel: "opus", maxConcurrentRuns: 6, autopilot: true });
    await runtimes.unshareRuntime.handler({ userId: member.id }, { runtimeId });
    expect((await agents.getAgent.handler({ userId: admin.id }, { agentId: agent.id })).runtimeId).toBe(runtimeId);
    // A Code-capable Agent is private to its Runtime owner, who must grant this Admin access before assignment.
    await agents.setAgentAccess.handler({ userId: member.id }, { agentId: agent.id, userIds: [admin.id] });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [alpha.id] });
    const prior = await work.createWorkItem.handler({ userId: admin.id }, { projectId: alpha.id, title: "Prior usage" });
    await transaction.insert(runs).values({ workspaceId: workspace.id, projectId: alpha.id, workItemId: prior.id, agentId: agent.id, originatorId: admin.id, status: "completed", inputTokens: 2, finishedAt: new Date() });
    const item = await work.createWorkItem.handler({ userId: admin.id }, { projectId: alpha.id, title: "Runtime-bound", assigneeIds: [agent.userId] });
    const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    // The 2 tokens of the prior Run already exceed the budget of 1, so the bound Run is refused like a server Run.
    expect(run).toMatchObject({ status: "skipped", failureReason: "budget_exceeded" });
    expect(await startRun(transaction, run!.id)).toBe("gone");
  });
});

test.concurrent("a Member, a Guest and an outsider cannot configure Agents", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, guest, stranger, workspace, alpha } = await setup(transaction);
    const created = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    for (const user of [member, guest, stranger]) {
      const context = { userId: user.id };
      const calls = [
        () => agents.createAgent.handler(context, { workspaceId: workspace.id, ...agentInput }),
        () => agents.updateAgent.handler(context, { agentId: created.id, name: "x" }),
        () => agents.enableAgent.handler(context, { agentId: created.id }),
        () => agents.disableAgent.handler(context, { agentId: created.id }),
        () => agents.deleteAgent.handler(context, { agentId: created.id }),
        () => agents.listAgents.handler(context, { workspaceId: workspace.id }),
        () => agents.getAgent.handler(context, { agentId: created.id }),
        () => agents.setAgentProjectAccess.handler(context, { agentId: created.id, allProjects: false, projectIds: [alpha.id] }),
      ];
      const results: Array<number | undefined> = [];
      // Sequential: parallel calls would interleave on the one rollback transaction.
      for (const call of calls) results.push(await call().then(() => 200, (error: { status: number }) => error.status));
      expect(results).toEqual(Array(8).fill(403));
    }
    expect(await transaction.select().from(users).where(eq(users.id, created.userId))).toHaveLength(1);
  });
});

test.concurrent("opening a project adds the Agent as a project member; closing it removes it", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, workspace, alpha, beta, projects } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    const members = async (projectId: string) => (await projects.listProjectMembers.handler({ userId: admin.id }, { projectId })).filter((row) => row.userId === agent.userId);
    expect(await members(alpha.id)).toEqual([]);
    const opened = await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [alpha.id] });
    expect(opened).toMatchObject({ allProjects: false, projectIds: [alpha.id] });
    expect(await members(alpha.id)).toMatchObject([{ role: "Member", name: "Triage bot" }]);
    expect(await members(beta.id)).toEqual([]);
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [beta.id] });
    expect(await members(alpha.id)).toEqual([]);
    expect(await members(beta.id)).toHaveLength(1);
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    expect(await members(alpha.id)).toHaveLength(1);
    expect(await members(beta.id)).toHaveLength(1);
    // A project created later is opened to an all-projects Agent.
    const gamma = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Gamma", key: "GAM", visibility: "public" });
    expect(await members(gamma.id)).toHaveLength(1);
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [] });
    for (const project of [alpha, beta, gamma]) expect(await members(project.id)).toEqual([]);
  });
});

test.concurrent("a project from another workspace cannot be opened to an Agent", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, workspace, stranger, projects } = await setup(transaction);
    const foreign = await projects.createProject.handler({ userId: stranger.id }, { workspaceId: (await transaction.select().from(workspaceMembers).where(eq(workspaceMembers.userId, stranger.id)))[0]!.workspaceId, name: "Far", key: "FAR", visibility: "public" });
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await expect(agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [foreign.id] })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("an enabled Agent is an assignee and mention candidate but never a lead or admin", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace, alpha, work, projects } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [alpha.id] });
    const comments = createCommentActions(transaction);
    const mentionable = await comments.listMentionableMembers.handler({ userId: member.id }, { projectId: alpha.id });
    expect(mentionable.map((row) => row.userId)).toContain(agent.userId);
    expect(mentionable.find((row) => row.userId === agent.userId)).toMatchObject({ hasAccess: true, accessReason: null });
    expect((await projects.listProjectMembers.handler({ userId: member.id }, { projectId: alpha.id })).find((row) => row.userId === agent.userId)).toMatchObject({ isAgent: true });
    const people = await createMemberActions(transaction).listMembers.handler({ userId: member.id }, { workspaceId: workspace.id });
    expect(people.find((row) => row.userId === agent.userId)).toMatchObject({ isAgent: true, role: "Member" });
    expect(people.find((row) => row.userId === member.id)).toMatchObject({ isAgent: false });

    const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: alpha.id, title: "Do it", assigneeIds: [agent.userId] });
    expect(item.assigneeIds).toEqual([agent.userId]);

    // Never admin: workspace and project.
    await expect(createMemberActions(transaction).changeMemberRole.handler({ userId: admin.id }, { workspaceId: workspace.id, userId: agent.userId, role: "Admin" })).rejects.toMatchObject({ status: 400 });
    await expect(projects.addProjectMember.handler({ userId: admin.id }, { projectId: alpha.id, userId: agent.userId, role: "Admin" })).rejects.toMatchObject({ status: 400 });
    await expect(projects.changeProjectMemberRole.handler({ userId: admin.id }, { projectId: alpha.id, userId: agent.userId, role: "Admin" })).rejects.toMatchObject({ status: 400 });
    // Never a lead.
    const modules = createModuleActions(transaction);
    await expect(modules.createModule.handler({ userId: member.id }, { projectId: alpha.id, name: "Auth", leadId: agent.userId })).rejects.toMatchObject({ status: 400 });
    const module = await modules.createModule.handler({ userId: member.id }, { projectId: alpha.id, name: "Auth" });
    await expect(modules.updateModule.handler({ userId: member.id }, { moduleId: module.id, leadId: agent.userId })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("assignee and @mention pickers explain Agent access and expose unavailable Agents", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace, alpha, projects } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [alpha.id] });
    await agents.setAgentAccess.handler({ userId: admin.id }, { agentId: agent.id, userIds: [admin.id] });
    const assignee = (await projects.listProjectMembers.handler({ userId: member.id }, { projectId: alpha.id })).find((person) => person.userId === agent.userId);
    expect(assignee).toMatchObject({ isAgent: true, hasAccess: false, accessReason: "needs permission from a workspace Admin", accessAsk: "admin", accessOwnerName: null });
    const mention = (await createCommentActions(transaction).listMentionableMembers.handler({ userId: member.id }, { projectId: alpha.id })).find((person) => person.userId === agent.userId);
    expect(mention).toMatchObject({ isAgent: true, hasAccess: false, accessReason: "needs permission from a workspace Admin", accessAsk: "admin", accessOwnerName: null });
  });
});

test.concurrent("a non-admin Runtime owner can list and change access to their Code-capable Agent", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace } = await setup(transaction);
    const tokens = createApiTokenActions(transaction);
    const token = await tokens.createApiToken.handler({ userId: member.id }, { name: "Runtime owner" });
    const runtimes = createRuntimeActions(transaction);
    const registered = await runtimes.registerDaemon.handler({ userId: member.id, apiTokenId: token.id }, { hostname: "member-runtime", version: "1", agentClis: ["codex"] });
    const runtime = registered.runtimes[0]!;
    await runtimes.shareRuntime.handler({ userId: member.id }, { runtimeId: runtime.id });
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput, runtimeId: runtime.id });
    expect(await agents.listManageableAgentAccess.handler({ userId: member.id }, { workspaceId: workspace.id })).toMatchObject([{ id: agent.id, accessUserIds: [member.id] }]);
    await agents.setAgentAccess.handler({ userId: member.id }, { agentId: agent.id, userIds: [member.id, admin.id] });
    expect((await agents.getAgent.handler({ userId: admin.id }, { agentId: agent.id })).accessUserIds.sort()).toEqual([admin.id, member.id].sort());
  });
});

test.concurrent("Agents you can ask lists every enabled Agent with its owner and whether the viewer may use it; it is read-only", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace } = await setup(transaction);
    const runtimes = createRuntimeActions(transaction);
    const token = await createApiTokenActions(transaction).createApiToken.handler({ userId: member.id }, { name: "Owner runtime" });
    const registered = await runtimes.registerDaemon.handler({ userId: member.id, apiTokenId: token.id }, { hostname: "owner-runtime", version: "1", agentClis: ["codex"] });
    await runtimes.shareRuntime.handler({ userId: member.id }, { runtimeId: registered.runtimes[0]!.id });
    const codeAgent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput, runtimeId: registered.runtimes[0]!.id });
    const serverAgent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput, name: "Server helper" });
    await agents.setAgentAccess.handler({ userId: member.id }, { agentId: codeAgent.id, userIds: [member.id] });
    await agents.setAgentAccess.handler({ userId: admin.id }, { agentId: serverAgent.id, userIds: [admin.id] });
    const viewerList = await agents.listAgentsForViewer.handler({ userId: admin.id }, { workspaceId: workspace.id });
    expect(viewerList.find((row) => row.id === codeAgent.id)).toEqual({ id: codeAgent.id, name: codeAgent.name, codeCapable: true, ownerName: member.name, hasAccess: false });
    expect(viewerList.find((row) => row.id === serverAgent.id)).toEqual({ id: serverAgent.id, name: "Server helper", codeCapable: false, ownerName: null, hasAccess: true });
    const ownerList = await agents.listAgentsForViewer.handler({ userId: member.id }, { workspaceId: workspace.id });
    expect(ownerList.find((row) => row.id === codeAgent.id)).toMatchObject({ hasAccess: true, ownerName: member.name });
    expect(ownerList.find((row) => row.id === serverAgent.id)).toMatchObject({ hasAccess: false });
    // Disabled Agents drop out, as they do in pickers.
    await agents.disableAgent.handler({ userId: admin.id }, { agentId: serverAgent.id });
    expect((await agents.listAgentsForViewer.handler({ userId: member.id }, { workspaceId: workspace.id })).map((row) => row.id)).toEqual([codeAgent.id]);
  });
});

test.concurrent("an Agent cannot be assigned in a project it is not open to", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace, alpha, beta, work } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [alpha.id] });
    await expect(work.createWorkItem.handler({ userId: member.id }, { projectId: beta.id, title: "x", assigneeIds: [agent.userId] })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("disabling an Agent hides it from new assignments and mentions; enabling restores it", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace, alpha, work, projects } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const assigned = await work.createWorkItem.handler({ userId: member.id }, { projectId: alpha.id, title: "Already", assigneeIds: [agent.userId] });
    expect(await agents.disableAgent.handler({ userId: admin.id }, { agentId: agent.id })).toMatchObject({ enabled: false });
    expect(await transaction.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.agentId, agent.id))).toMatchObject([{ status: "cancelled", failureReason: "Agent was disabled" }]);
    expect((await transaction.select({ field: activities.field, actorId: activities.actorId }).from(activities).where(eq(activities.entityId, agent.id))).some((row) => row.field === "enabled" && row.actorId === admin.id)).toBe(true);
    const comments = createCommentActions(transaction);
    expect((await comments.listMentionableMembers.handler({ userId: member.id }, { projectId: alpha.id })).map((row) => row.userId)).not.toContain(agent.userId);
    expect((await projects.listProjectMembers.handler({ userId: member.id }, { projectId: alpha.id })).map((row) => row.userId)).not.toContain(agent.userId);
    expect((await createMemberActions(transaction).listMembers.handler({ userId: member.id }, { workspaceId: workspace.id })).map((row) => row.userId)).not.toContain(agent.userId);
    await expect(work.createWorkItem.handler({ userId: member.id }, { projectId: alpha.id, title: "New", assigneeIds: [agent.userId] })).rejects.toMatchObject({ status: 400 });
    // An existing assignment can still be removed.
    expect((await work.updateWorkItem.handler({ userId: member.id }, { workItemId: assigned.id, assigneeIds: [] })).assigneeIds).toEqual([]);
    // Disabled Agent is still listed for the Admin.
    expect(await agents.listAgents.handler({ userId: admin.id }, { workspaceId: workspace.id })).toMatchObject([{ enabled: false }]);
    expect(await agents.enableAgent.handler({ userId: admin.id }, { agentId: agent.id })).toMatchObject({ enabled: true });
    expect((await work.createWorkItem.handler({ userId: member.id }, { projectId: alpha.id, title: "Again", assigneeIds: [agent.userId] })).assigneeIds).toEqual([agent.userId]);
  });
});

test.concurrent("deleting an Agent removes the bot user, its memberships and its assignments", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, member, workspace, alpha, work, projects } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: alpha.id, title: "Assigned", assigneeIds: [agent.userId] });
    expect(await agents.deleteAgent.handler({ userId: admin.id }, { agentId: agent.id })).toEqual({ deleted: true });
    expect(await transaction.select().from(users).where(eq(users.id, agent.userId))).toEqual([]);
    expect(await transaction.select().from(workspaceMembers).where(eq(workspaceMembers.userId, agent.userId))).toEqual([]);
    expect((await projects.listProjectMembers.handler({ userId: admin.id }, { projectId: alpha.id })).map((row) => row.userId)).not.toContain(agent.userId);
    expect((await work.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: item.displayId })).assigneeIds).toEqual([]);
    expect(await agents.listAgents.handler({ userId: admin.id }, { workspaceId: workspace.id })).toEqual([]);
    await expect(agents.getAgent.handler({ userId: admin.id }, { agentId: agent.id })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("an Agent's bot user is not removed or re-roled through the member Actions", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, workspace } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await expect(createMemberActions(transaction).removeMember.handler({ userId: admin.id }, { workspaceId: workspace.id, userId: agent.userId })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("assigning an Agent's agent id names the user id to use; a non-member assignee names the fix", async () => {
  await withRollback(db, async (transaction) => {
    const { agents, admin, workspace, alpha, work } = await setup(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, ...agentInput });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const byAgentId = work.createWorkItem.handler({ userId: admin.id }, { projectId: alpha.id, title: "agent id", assigneeIds: [agent.id] });
    await expect(byAgentId).rejects.toMatchObject({ status: 400 });
    await expect(byAgentId).rejects.toThrow(`pass assigneeIds with ${agent.userId}`);
    const stranger = crypto.randomUUID();
    const byStranger = work.createWorkItem.handler({ userId: admin.id }, { projectId: alpha.id, title: "stranger", assigneeIds: [stranger] });
    await expect(byStranger).rejects.toThrow("Assignees must be project members");
    await expect(byStranger).rejects.toThrow(`add_project_member first: ${stranger}`);
  });
});
