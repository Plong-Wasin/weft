import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, users, type Database } from "@weft/db";
import { createCommentActions, createProjectActions, createSearchActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const items = createWorkItemActions(transaction);
  const search = createSearchActions(transaction);
  const project = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const create = (title: string, description?: string, projectId = project.id, userId = member.id) =>
    items.createWorkItem.handler({ userId }, { projectId, title, ...(description ? { description: doc(description) } : {}) });
  const find = (userId: string, query: string) =>
    search.searchWorkItems.handler({ userId }, { workspaceId: workspace.id, query }).then((rows) => rows.map((row) => row.title));
  return { workspace, admin, member, guest, projects, items, project, create, find, search };
}

test.concurrent("finds work items by title and description text in English", async () => {
  await withRollback(db, async (transaction) => {
    const { member, create, find } = await setup(transaction);
    await create("Fix login redirect");
    await create("Checkout", "The payment form crashes on submit");
    await create("Unrelated");
    expect(await find(member.id, "login")).toEqual(["Fix login redirect"]);
    expect(await find(member.id, "payment crashes")).toEqual(["Checkout"]);
    expect(await find(member.id, "LOGIN")).toEqual(["Fix login redirect"]);
    expect(await find(member.id, "nothing-like-this")).toEqual([]);
  });
});

test.concurrent("search does not scan unindexed comment text", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const item = await env.create("No searchable title match");
    const recipient = await createMemberFactory(transaction, env.workspace.id, "Member");
    await env.projects.addProjectMember.handler({ userId: env.admin.id }, { projectId: env.project.id, userId: recipient.id, role: "Member" });
    await transaction.update(users).set({ name: "Reviewer" }).where(eq(users.id, recipient.id));
    await createCommentActions(transaction).createComment.handler({ userId: env.member.id }, { workItemId: item.id, bodyMarkdown: `- Escalate to @{${recipient.id}}` });
    const results = await env.search.searchWorkItems.handler({ userId: env.member.id }, { workspaceId: env.workspace.id, query: "Escalate Reviewer" });
    expect(results).toEqual([]);
  });
});

test.concurrent("finds Thai text by substring in title and description", async () => {
  await withRollback(db, async (transaction) => {
    const { member, create, find } = await setup(transaction);
    await create("แก้ไขหน้าเข้าสู่ระบบ");
    await create("ชำระเงิน", "ปุ่มจ่ายเงินไม่ทำงานบนมือถือ");
    await create("อย่างอื่น");
    expect(await find(member.id, "เข้าสู่ระบบ")).toEqual(["แก้ไขหน้าเข้าสู่ระบบ"]);
    expect(await find(member.id, "จ่ายเงิน")).toEqual(["ชำระเงิน"]);
    expect(await find(member.id, "ไม่ทำงาน")).toEqual(["ชำระเงิน"]);
  });
});

test.concurrent("description search includes list text, mention labels, and colored text after Markdown storage", async () => {
  await withRollback(db, async (transaction) => {
    const { member, items, project, find } = await setup(transaction);
    await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Rich description", descriptionMarkdown: "- searchable-listphrase\n\n@{Visible person|member-123}\n\n<span style=\"color:red\">searchable-colorphrase</span>" });
    expect(await find(member.id, "listphrase")).toEqual(["Rich description"]);
    expect(await find(member.id, "Visible person")).toEqual(["Rich description"]);
    expect(await find(member.id, "colorphrase")).toEqual(["Rich description"]);
  });
});

test.concurrent("a query with LIKE wildcards matches literally", async () => {
  await withRollback(db, async (transaction) => {
    const { member, create, find } = await setup(transaction);
    await create("Discount 50% off");
    await create("Discount 500 off");
    expect(await find(member.id, "50%")).toEqual(["Discount 50% off"]);
    expect(await find(member.id, "_")).toEqual([]);
  });
});

test.concurrent("display ID search is case-insensitive, returns the item first, and resolves old key aliases", async () => {
  await withRollback(db, async (transaction) => {
    const { member, create, find, projects, project, search, workspace } = await setup(transaction);
    await create("First");
    await create("Mentions MOB-1 in the title");
    expect(await find(member.id, "mob-1")).toEqual(["First", "Mentions MOB-1 in the title"]);
    await projects.renameProjectKey.handler({ userId: member.id }, { projectId: project.id, key: "APP" });
    const byAlias = await search.searchWorkItems.handler({ userId: member.id }, { workspaceId: workspace.id, query: "MOB-1" });
    expect(byAlias[0]).toMatchObject({ title: "First", displayId: "APP-1" });
    expect(await find(member.id, "APP-1")).toContain("First");
    expect(await find(member.id, "MOB-99")).toEqual([]);
  });
});

test.concurrent("results respect project visibility and role", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, guest, projects, items, create, find } = await setup(transaction);
    const other = await createMemberFactory(transaction, workspace.id, "Member");
    const secret = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
    await create("Roadmap public item");
    await create("Roadmap secret item", undefined, secret.id);
    expect(await find(member.id, "roadmap")).toEqual(["Roadmap public item", "Roadmap secret item"]);
    expect(await find(admin.id, "roadmap")).toEqual(["Roadmap public item", "Roadmap secret item"]);
    expect(await find(other.id, "roadmap")).toEqual(["Roadmap public item"]);
    expect(await find(guest.id, "roadmap")).toEqual(["Roadmap public item"]);
    expect(await find(other.id, "SEC-1")).toEqual([]);
    const secretItem = (await items.listWorkItems.handler({ userId: member.id }, { projectId: secret.id }))[0]!;
    await items.deleteWorkItem.handler({ userId: member.id }, { workItemId: secretItem.id });
    expect(await find(member.id, "roadmap")).toEqual(["Roadmap public item"]);
  });
});

test.concurrent("a non-member of the workspace cannot search it", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, search } = await setup(transaction);
    const outsider = await createMemberFactory(transaction, (await createWorkspaceFactory(transaction)).id, "Admin");
    await expect(search.searchWorkItems.handler({ userId: outsider.id }, { workspaceId: workspace.id, query: "x" })).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("search stays inside the workspace", async () => {
  await withRollback(db, async (transaction) => {
    const { member, create, find } = await setup(transaction);
    const second = await setup(transaction);
    await create("Shared words here");
    await second.create("Shared words elsewhere");
    expect(await find(member.id, "shared words")).toEqual(["Shared words here"]);
  });
});
