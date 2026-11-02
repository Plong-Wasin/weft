import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, users, workspaceMembers, type Database } from "@weft/db";
import { createAgentActions, createCommentActions, createMemberActions, createModuleActions, createProjectActions, createSkillActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const agentInput = { name: "Triage bot", instructions: "Triage new work items.", model: "default" };

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
    expect(created).toMatchObject({ maxToolCalls: 25, timeoutSeconds: 600, monthlyTokenBudget: null });
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
