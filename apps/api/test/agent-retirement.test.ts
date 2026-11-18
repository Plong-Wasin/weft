import { afterAll, expect, test } from "bun:test";
import { activities, commentMentions, comments, createDatabase, runs, workspaceMembers, type Database } from "@weft/db";
import { eq } from "drizzle-orm";
import { createAgentActions, createApiTokenActions, createProjectActions, createWorkItemActions } from "@weft/actions";
import { createMemberFactory, withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const app = createApp(undefined, transaction);
  const post = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async () => {
    const response = await post("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    return { cookie, id: me.user.id };
  };
  const admin = await signUp();
  const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `ret-${crypto.randomUUID()}` }, admin.cookie)).json() as { id: string };
  const project = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Retire", key: `RT${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
  const agents = createAgentActions(transaction);
  const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Triage bot", instructions: "Triage.", model: "default" });
  await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Existing work" });
  const deleteAgent = (cookie: string) => post("/actions/delete_agent", { agentId: agent.id }, cookie);
  const counts = async (cookie: string) => (await post("/actions/get_agent_content_counts", { agentId: agent.id }, cookie)).json() as Promise<{ blocked: boolean; counts: Record<string, number> }>;
  // Agent-authored rows are written straight into the transaction: the tests need the state, not the write paths.
  const writeComment = async (deletedAt: Date | null = null) => (await transaction.insert(comments).values({
    workspaceId: workspace.id, projectId: project.id, workItemId: item.id, authorId: agent.userId, deletedAt,
    body: { type: "doc", content: [] }, bodyMarkdown: "Triaged.", bodyText: "Triaged.",
  }).returning({ id: comments.id }))[0]!;
  return { app, post, admin, workspace, project, agent, item, transaction, agents, deleteAgent, counts, writeComment };
}

test.concurrent("deleting an Agent with a live comment is refused with counts and the advice to disable", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, agent, deleteAgent, writeComment, counts } = await setup(transaction);
    await writeComment();
    const refusal = await deleteAgent(admin.cookie);
    expect(refusal.status).toBe(409);
    const body = await refusal.json() as { error: string; code: string; details: { counts: Record<string, number>; advice: string } };
    expect(body).toMatchObject({ code: "agent_has_content", details: { advice: "disable", counts: { comments: 1, deletedComments: 0 } } });
    expect(body.error).toContain("Disable it instead");
    expect(await counts(admin.cookie)).toMatchObject({ blocked: true, counts: { comments: 1 } });
    expect(await transaction.select().from(comments).where(eq(comments.authorId, agent.userId))).toHaveLength(1);
  });
});

test.concurrent("deleting an Agent with a soft-deleted comment is refused and counts it as deleted", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, deleteAgent, writeComment } = await setup(transaction);
    await writeComment(new Date());
    const refusal = await deleteAgent(admin.cookie);
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toMatchObject({ code: "agent_has_content", details: { counts: { comments: 0, deletedComments: 1 } } });
  });
});

test.concurrent("deleting an Agent that created a work item is refused, and the item's parts are counted", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, project, agent, deleteAgent } = await setup(transaction);
    await createWorkItemActions(transaction).createWorkItem.handler({ userId: agent.userId }, { projectId: project.id, title: "Created by the bot" });
    const refusal = await deleteAgent(admin.cookie);
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toMatchObject({ code: "agent_has_content", details: { counts: { workItems: 1 } } });
  });
});

test.concurrent("deleting an Agent that is the actor of an activity row is refused", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, workspace, project, agent, item, deleteAgent } = await setup(transaction);
    await transaction.insert(activities).values({ workspaceId: workspace.id, projectId: project.id, entityType: "work_item", entityId: item.id, field: "title", oldValue: "a", newValue: "b", actorId: agent.userId, source: "ui" });
    const refusal = await deleteAgent(admin.cookie);
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toMatchObject({ code: "agent_has_content", details: { counts: { activities: 1 } } });
  });
});

test.concurrent("deleting an Agent that started a Run by waking another Agent is refused", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, workspace, project, agent, item, deleteAgent } = await setup(transaction);
    await transaction.insert(runs).values({ workspaceId: workspace.id, projectId: project.id, workItemId: item.id, agentId: agent.id, originatorId: agent.userId, status: "completed" });
    const refusal = await deleteAgent(admin.cookie);
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toMatchObject({ code: "agent_has_content", details: { counts: { runs: 1 } } });
  });
});

test.concurrent("deleting an Agent with only an assignment, a mention, memberships and access rows still works", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, workspace, project, agent, item, deleteAgent, counts, post } = await setup(transaction);
    await createWorkItemActions(transaction).createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Assigned to the bot", assigneeIds: [agent.userId] });
    const [mentioning] = await transaction.insert(comments).values({ workspaceId: workspace.id, projectId: project.id, workItemId: item.id, authorId: admin.id, body: { type: "doc", content: [] }, bodyMarkdown: `@${agent.name}`, bodyText: "mention" }).returning({ id: comments.id });
    await transaction.insert(commentMentions).values({ commentId: mentioning!.id, userId: agent.userId });
    expect(await counts(admin.cookie)).toMatchObject({ blocked: false });
    const deleted = await deleteAgent(admin.cookie);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(await post("/actions/list_agents", { workspaceId: workspace.id }, admin.cookie).then((response) => response.json())).toEqual([]);
  });
});

test.concurrent("a non-admin is still refused deleting an Agent, and the refusal is not the content refusal", async () => {
  await withRollback(db, async (transaction) => {
    const { app, workspace, agent } = await setup(transaction);
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const token = await createApiTokenActions(transaction).createApiToken.handler({ userId: member.id }, { name: "member" });
    const asMember = await app.handle(new Request("http://localhost/actions/delete_agent", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token.token}` }, body: JSON.stringify({ agentId: agent.id }),
    }));
    expect(asMember.status).toBe(403);
    expect(await asMember.json()).not.toMatchObject({ code: "agent_has_content" });
    expect(await transaction.select().from(workspaceMembers).where(eq(workspaceMembers.userId, member.id))).toHaveLength(1);
  });
});

test.concurrent("the counts the settings page reads are the same counts the refusal carries", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, agent, writeComment, deleteAgent, counts, project } = await setup(transaction);
    await writeComment();
    await writeComment(new Date());
    await createWorkItemActions(transaction).createWorkItem.handler({ userId: agent.userId }, { projectId: project.id, title: "Bot item" });
    const page = await counts(admin.cookie);
    const refusal = await (await deleteAgent(admin.cookie)).json() as { details: { counts: Record<string, number> } };
    expect(page.counts).toEqual(refusal.details.counts);
    expect(page.counts).toMatchObject({ comments: 1, deletedComments: 1, workItems: 1 });
  });
});

test.concurrent("disabling an Agent keeps its comments and work items unchanged, and it can be enabled again", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, agent, writeComment, deleteAgent, counts, post, project } = await setup(transaction);
    await writeComment();
    await createWorkItemActions(transaction).createWorkItem.handler({ userId: agent.userId }, { projectId: project.id, title: "Bot item" });
    const before = await counts(admin.cookie);
    expect((await post("/actions/disable_agent", { agentId: agent.id }, admin.cookie)).status).toBe(200);
    expect(await counts(admin.cookie)).toEqual(before);
    expect(await transaction.select().from(comments).where(eq(comments.authorId, agent.userId))).toHaveLength(1);
    expect((await post("/actions/enable_agent", { agentId: agent.id }, admin.cookie)).status).toBe(200);
    expect(await counts(admin.cookie)).toEqual(before);
    expect((await deleteAgent(admin.cookie)).status).toBe(409);
  });
});
