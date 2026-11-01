import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { builtinViewId, createCommentActions, createProjectActions, createViewActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const other = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const open = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const secret = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: secret.id, userId: member.id, role: "Member" });
  for (const user of [member, other]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: open.id, userId: user.id, role: "Member" });
  const work = createWorkItemActions(transaction);
  return { workspace, admin, member, other, guest, open, secret, views: createViewActions(transaction), work, comments: createCommentActions(transaction) };
}
const status = (call: Promise<unknown>) => call.then(() => 200, (error: { status: number }) => error.status);
const titles = (rows: Array<{ title: string }>) => rows.map((row) => row.title).sort();

test.concurrent("workspace work items never include a private project the caller is not in", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, other, guest, open, secret, work } = await setup(transaction);
    await work.createWorkItem.handler({ userId: admin.id }, { projectId: open.id, title: "Public one" });
    await work.createWorkItem.handler({ userId: admin.id }, { projectId: secret.id, title: "Hidden one" });
    const list = async (userId: string, extra: Record<string, unknown> = {}) => titles(await work.listWorkspaceWorkItems.handler({ userId }, { workspaceId: workspace.id, ...extra }));
    expect(await list(admin.id)).toEqual(["Hidden one", "Public one"]);
    expect(await list(member.id)).toEqual(["Hidden one", "Public one"]);
    expect(await list(other.id)).toEqual(["Public one"]);
    expect(await list(guest.id)).toEqual(["Public one"]);
    // A PQL filter and every built-in view stay inside the same boundary.
    expect(await list(other.id, { query: "priority = none" })).toEqual(["Public one"]);
    for (const builtin of ["all", "assigned", "created", "subscribed"]) expect(await list(other.id, { builtin })).not.toContain("Hidden one");
  });
});

test.concurrent("a user outside the workspace gets nothing from workspace views", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, views, work } = await setup(transaction);
    const second = await createWorkspaceFactory(transaction);
    const stranger = await createMemberFactory(transaction, second.id, "Admin");
    expect(await status(work.listWorkspaceWorkItems.handler({ userId: stranger.id }, { workspaceId: workspace.id }))).toBe(403);
    expect(await status(views.listWorkspaceViews.handler({ userId: stranger.id }, { workspaceId: workspace.id }))).toBe(403);
    expect(await status(views.createWorkspaceView.handler({ userId: stranger.id }, { workspaceId: workspace.id, name: "X" }))).toBe(403);
  });
});

test.concurrent("built-in views: all, assigned, created, subscribed select the right work items", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, other, open, work, comments } = await setup(transaction);
    await work.createWorkItem.handler({ userId: member.id }, { projectId: open.id, title: "Mine created" });
    await work.createWorkItem.handler({ userId: admin.id }, { projectId: open.id, title: "Assigned to me", assigneeIds: [member.id] });
    const watched = await work.createWorkItem.handler({ userId: admin.id }, { projectId: open.id, title: "I commented" });
    await work.createWorkItem.handler({ userId: admin.id }, { projectId: open.id, title: "Unrelated" });
    await comments.createComment.handler({ userId: member.id }, { workItemId: watched.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } } as never);
    const list = async (userId: string, builtin: string) => titles(await work.listWorkspaceWorkItems.handler({ userId }, { workspaceId: workspace.id, builtin: builtin as "all" }));
    expect(await list(member.id, "all")).toEqual(["Assigned to me", "I commented", "Mine created", "Unrelated"]);
    expect(await list(member.id, "assigned")).toEqual(["Assigned to me"]);
    expect(await list(member.id, "created")).toEqual(["Mine created"]);
    expect(await list(member.id, "subscribed")).toEqual(["Assigned to me", "I commented", "Mine created"]);
    expect(await list(other.id, "subscribed")).toEqual([]);
  });
});

test.concurrent("a workspace View spans projects, orders and filters work items, and its filter is validated", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, member, open, secret, views, work } = await setup(transaction);
    await work.createWorkItem.handler({ userId: member.id }, { projectId: open.id, title: "Urgent open", priority: "urgent" });
    await work.createWorkItem.handler({ userId: member.id }, { projectId: secret.id, title: "Urgent secret", priority: "urgent" });
    await work.createWorkItem.handler({ userId: member.id }, { projectId: secret.id, title: "Low secret", priority: "low" });
    const view = await views.createWorkspaceView.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Urgent everywhere", query: "priority = urgent" });
    expect(view).toMatchObject({ scope: "workspace", projectId: null, workspaceId: workspace.id, layout: "spreadsheet", ownerId: member.id });
    const rows = await work.listWorkspaceWorkItems.handler({ userId: member.id }, { workspaceId: workspace.id, query: view.query, sort: "title" });
    expect(rows.map((row) => [row.displayId, row.projectKey])).toEqual([["MOB-1", "MOB"], ["SEC-1", "SEC"]]);
    expect(await status(views.createWorkspaceView.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Bad", query: "nonsense ===" }))).toBe(400);
    expect(await status(views.createWorkspaceView.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Bad", layout: "gantt" as never }))).toBe(400);
  });
});

test.concurrent("workspace Views follow the same access rules as project Views", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, other, guest, open, views } = await setup(transaction);
    expect(await status(views.createWorkspaceView.handler({ userId: guest.id }, { workspaceId: workspace.id, name: "G" }))).toBe(403);
    const shared = await views.createWorkspaceView.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Shared" });
    const secret = await views.createWorkspaceView.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Secret", access: "private" });
    const names = async (userId: string) => (await views.listWorkspaceViews.handler({ userId }, { workspaceId: workspace.id })).views.map((view) => view.name);
    expect(await names(member.id)).toEqual(["Shared", "Secret"]);
    for (const user of [other, admin, guest]) expect(await names(user.id)).toEqual(["Shared"]);
    for (const user of [other, admin, guest]) expect(await status(views.getView.handler({ userId: user.id }, { viewId: secret.id }))).toBe(404);
    expect((await views.getView.handler({ userId: guest.id }, { viewId: shared.id })).id).toBe(shared.id);
    expect(await status(views.updateView.handler({ userId: other.id }, { viewId: shared.id, name: "Hijack" }))).toBe(403);
    expect(await status(views.updateView.handler({ userId: guest.id }, { viewId: shared.id, name: "Hijack" }))).toBe(403);
    expect(await status(views.deleteView.handler({ userId: other.id }, { viewId: shared.id }))).toBe(403);
    expect((await views.updateView.handler({ userId: admin.id }, { viewId: shared.id, name: "By admin" })).name).toBe("By admin");
    await views.deleteView.handler({ userId: member.id }, { viewId: shared.id });
    expect(await names(admin.id)).toEqual([]);
    // A workspace View is not a project View.
    expect(await views.listViews.handler({ userId: admin.id }, { projectId: open.id })).toEqual([]);
  });
});

test.concurrent("the four built-in views are listed first and cannot be changed or deleted", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, views } = await setup(transaction);
    const listed = await views.listWorkspaceViews.handler({ userId: member.id }, { workspaceId: workspace.id });
    expect(listed.builtin.map((entry) => entry.kind)).toEqual(["all", "assigned", "created", "subscribed"]);
    for (const entry of listed.builtin) {
      expect(entry.id).toBe(builtinViewId(entry.kind as "all"));
      for (const user of [admin, member]) {
        expect(await status(views.deleteView.handler({ userId: user.id }, { viewId: entry.id }))).toBe(400);
        expect(await status(views.updateView.handler({ userId: user.id }, { viewId: entry.id, name: "x" }))).toBe(400);
      }
    }
    expect((await views.listWorkspaceViews.handler({ userId: member.id }, { workspaceId: workspace.id })).builtin).toHaveLength(4);
  });
});
