import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, webLinks, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createProjectActions, createWebLinkActions, createWorkItemActions } from "../src";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(tx: Database) {
  const workspace = await createWorkspaceFactory(tx); const admin = await createMemberFactory(tx, workspace.id, "Admin"); const member = await createMemberFactory(tx, workspace.id, "Member"); const guest = await createMemberFactory(tx, workspace.id, "Guest");
  const projects = createProjectActions(tx); const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Web", key: "WEB", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" }); await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  const workItem = await createWorkItemActions(tx).createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Item" });
  return { admin, member, guest, workItem, actions: createWebLinkActions(tx) };
}

test.concurrent("Web Link update and delete are refused once the work item is deleted", async () => withRollback(db, async (tx) => {
  const s = await setup(tx); const context = { userId: s.member.id };
  const created = await s.actions.createWebLink.handler(context, { workItemId: s.workItem.id, url: "https://example.com" });
  await createWorkItemActions(tx).deleteWorkItem.handler(context, { workItemId: s.workItem.id });
  await expect(s.actions.updateWebLink.handler(context, { webLinkId: created.id, title: "x" })).rejects.toMatchObject({ status: 404 });
  await expect(s.actions.deleteWebLink.handler(context, { webLinkId: created.id })).rejects.toMatchObject({ status: 404 });
}));

test.concurrent("Web Link stores a URL without surrounding whitespace", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.actions.createWebLink.handler({ userId: s.member.id }, { workItemId: s.workItem.id, url: "  https://example.com/a  " });
  expect(created.url).toBe("https://example.com/a");
}));

test.concurrent("Web Link CRUD validates URLs, enforces access and logs every change", async () => withRollback(db, async (tx) => {
  const s = await setup(tx); const context = { userId: s.member.id, source: "ai" as const, chatId: "00000000-0000-4000-8000-000000000001" };
  await expect(s.actions.createWebLink.handler(context, { workItemId: s.workItem.id, url: "javascript:alert(1)" })).rejects.toMatchObject({ status: 400 });
  await expect(s.actions.createWebLink.handler({ userId: s.guest.id }, { workItemId: s.workItem.id, url: "https://example.com" })).rejects.toMatchObject({ status: 403 });
  const created = await s.actions.createWebLink.handler(context, { workItemId: s.workItem.id, url: "https://example.com/a", title: "Example" });
  expect(await s.actions.listWebLinks.handler({ userId: s.guest.id }, { workItemId: s.workItem.id })).toMatchObject([{ id: created.id, title: "Example" }]);
  await s.actions.updateWebLink.handler(context, { webLinkId: created.id, title: "Updated" });
  await expect(s.actions.updateWebLink.handler(context, { webLinkId: created.id, url: "ftp://example.com" })).rejects.toMatchObject({ status: 400 });
  await s.actions.deleteWebLink.handler(context, { webLinkId: created.id });
  expect(await s.actions.listWebLinks.handler(context, { workItemId: s.workItem.id })).toEqual([]);
  const log = await tx.select().from(activities).where(and(eq(activities.entityId, s.workItem.id), eq(activities.entityType, "work_item")));
  expect(log.filter((row) => row.field.startsWith("web_link_")).map((row) => [row.field, row.source, row.chatId])).toEqual([["web_link_added", "ai", "00000000-0000-4000-8000-000000000001"], ["web_link_updated", "ai", "00000000-0000-4000-8000-000000000001"], ["web_link_removed", "ai", "00000000-0000-4000-8000-000000000001"]]);
  expect(await tx.select().from(webLinks)).toHaveLength(0);
}));
