import { afterAll, expect, test } from "bun:test";
import { createDatabase, workItems, type Database } from "@weft/db";
import { eq } from "drizzle-orm";
import { createProjectActions, createViewActions, createWorkItemActions } from "../src";
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
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const second = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Web", key: "WEB", visibility: "public" });
  for (const user of [member, other]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  return { admin, member, other, guest, project, second, views: createViewActions(transaction), work: createWorkItemActions(transaction) };
}
const status = (call: Promise<unknown>) => call.then(() => 200, (error: { status: number }) => error.status);

test.concurrent("a View stores PQL, layout, group by, order by and visible properties and returns them exactly", async () => {
  await withRollback(db, async (transaction) => {
    const { views, member, project } = await setup(transaction);
    const input = { projectId: project.id, name: "Urgent", description: "Hot items", query: "priority = urgent", layout: "spreadsheet" as const, groupBy: "priority" as const, orderBy: "dueDate" as const, orderDirection: "desc" as const, properties: ["state", "id", "assignee"], access: "private" as const };
    const created = await views.createView.handler({ userId: member.id }, input);
    expect(created).toMatchObject({ ...input, ownerId: member.id });
    expect(await views.getView.handler({ userId: member.id }, { viewId: created.id })).toMatchObject(input);
    const plain = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Plain" });
    expect(plain).toMatchObject({ query: "", layout: "list", groupBy: "state", orderBy: "manual", orderDirection: "asc", access: "public", ownerId: member.id });
    expect(plain.properties).toEqual(["id", "state", "priority", "assignee", "labels", "dates", "cycle", "modules"]);
    const grouped = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "By creator", groupBy: "creator" });
    expect(grouped.groupBy).toBe("creator");
    expect((await views.getView.handler({ userId: member.id }, { viewId: grouped.id })).groupBy).toBe("creator");
  });
});

test.concurrent("a View accepts and stores the Calendar layout", async () => {
  await withRollback(db, async (transaction) => {
    const { views, member, project } = await setup(transaction);
    const created = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Calendar", layout: "calendar", groupBy: "none", properties: [], access: "private" });
    expect(created).toMatchObject({ layout: "calendar", groupBy: "none" });
  });
});

test.concurrent("create validates PQL, layout, properties and name", async () => {
  await withRollback(db, async (transaction) => {
    const { views, member, project } = await setup(transaction);
    const bad = (extra: Record<string, unknown>) => status(views.createView.handler({ userId: member.id }, { projectId: project.id, name: "X", ...extra } as never));
    expect(await bad({ query: "priority = banana" })).toBe(400);
    expect(await bad({ query: "nonsense ===" })).toBe(400);
    expect(await bad({ properties: ["state", "bogus"] })).toBe(400);
    expect(await bad({ properties: ["state", "state"] })).toBe(400);
    expect(await bad({ name: "   " })).toBe(400);
    expect(await bad({ query: "priority = high ORDER BY dueDate" })).toBe(200);
    expect(await bad({ groupBy: "creator" })).toBe(200);
    expect(await bad({ groupBy: "bad-group" })).toBe(400);
  });
});

test.concurrent("a Member and a project Admin create Views; a Guest cannot", async () => {
  await withRollback(db, async (transaction) => {
    const { views, member, admin, guest, project } = await setup(transaction);
    expect(await status(views.createView.handler({ userId: member.id }, { projectId: project.id, name: "A" }))).toBe(200);
    expect(await status(views.createView.handler({ userId: admin.id }, { projectId: project.id, name: "B" }))).toBe(200);
    expect(await status(views.createView.handler({ userId: guest.id }, { projectId: project.id, name: "C" }))).toBe(403);
  });
});

test.concurrent("only the owner or an Admin updates and deletes a public View; another Member is refused", async () => {
  await withRollback(db, async (transaction) => {
    const { views, member, other, admin, project } = await setup(transaction);
    const view = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Mine" });
    expect(await status(views.updateView.handler({ userId: other.id }, { viewId: view.id, name: "Hijack" }))).toBe(403);
    expect(await status(views.deleteView.handler({ userId: other.id }, { viewId: view.id }))).toBe(403);
    const renamed = await views.updateView.handler({ userId: member.id }, { viewId: view.id, name: "Renamed", query: "priority = high", layout: "board", groupBy: "assignee", orderBy: "title", orderDirection: "desc", properties: ["id"], access: "private", description: "d" });
    expect(renamed).toMatchObject({ name: "Renamed", query: "priority = high", layout: "board", groupBy: "assignee", orderBy: "title", orderDirection: "desc", properties: ["id"], access: "private", description: "d" });
    const adminView = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Shared" });
    expect((await views.updateView.handler({ userId: admin.id }, { viewId: adminView.id, name: "By admin" })).name).toBe("By admin");
    await views.deleteView.handler({ userId: admin.id }, { viewId: adminView.id });
    expect(await status(views.getView.handler({ userId: member.id }, { viewId: adminView.id }))).toBe(404);
    await views.deleteView.handler({ userId: member.id }, { viewId: view.id });
    expect(await views.listViews.handler({ userId: member.id }, { projectId: project.id })).toEqual([]);
  });
});

test.concurrent("a private View is hidden from every other user, Admin included, in list, get, update and delete", async () => {
  await withRollback(db, async (transaction) => {
    const { views, member, other, admin, guest, project } = await setup(transaction);
    const secret = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Secret", access: "private" });
    const open = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Open" });
    expect((await views.listViews.handler({ userId: member.id }, { projectId: project.id })).map((view) => view.name)).toEqual(["Secret", "Open"]);
    for (const user of [other, admin, guest]) {
      expect((await views.listViews.handler({ userId: user.id }, { projectId: project.id })).map((view) => view.name)).toEqual(["Open"]);
      expect(await status(views.getView.handler({ userId: user.id }, { viewId: secret.id }))).toBe(404);
      expect(await status(views.updateView.handler({ userId: user.id }, { viewId: secret.id, name: "x" }))).toBeGreaterThanOrEqual(403);
      expect(await status(views.deleteView.handler({ userId: user.id }, { viewId: secret.id }))).toBeGreaterThanOrEqual(403);
    }
    // Making it public shows it; making an Open view private hides it again.
    await views.updateView.handler({ userId: member.id }, { viewId: secret.id, access: "public" });
    expect((await views.listViews.handler({ userId: other.id }, { projectId: project.id })).length).toBe(2);
    await views.updateView.handler({ userId: member.id }, { viewId: open.id, access: "private" });
    expect(await status(views.getView.handler({ userId: other.id }, { viewId: open.id }))).toBe(404);
  });
});

test.concurrent("a Guest reads public Views but cannot change anything", async () => {
  await withRollback(db, async (transaction) => {
    const { views, member, guest, project } = await setup(transaction);
    const view = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Open" });
    expect((await views.listViews.handler({ userId: guest.id }, { projectId: project.id })).map((row) => row.id)).toEqual([view.id]);
    expect((await views.getView.handler({ userId: guest.id }, { viewId: view.id })).id).toBe(view.id);
    expect(await status(views.updateView.handler({ userId: guest.id }, { viewId: view.id, name: "x" }))).toBe(403);
    expect(await status(views.deleteView.handler({ userId: guest.id }, { viewId: view.id }))).toBe(403);
  });
});

test.concurrent("Views are scoped to their project and a View never changes work items", async () => {
  await withRollback(db, async (transaction) => {
    const { views, member, project, second, work, admin } = await setup(transaction);
    const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Keep me", priority: "urgent" });
    const view = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Urgent", query: "priority = urgent" });
    expect(await views.listViews.handler({ userId: admin.id }, { projectId: second.id })).toEqual([]);
    await views.updateView.handler({ userId: member.id }, { viewId: view.id, query: "priority = low" });
    await views.deleteView.handler({ userId: member.id }, { viewId: view.id });
    const [row] = await transaction.select().from(workItems).where(eq(workItems.id, item.id));
    expect(row).toMatchObject({ title: "Keep me", priority: "urgent" });
    expect(Object.keys(view)).not.toContain("workItemIds");
  });
});
