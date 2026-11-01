import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { commentMentions, createDatabase, type Database } from "@weft/db";
import { createCommentActions, createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const doc = (...parts: Array<string | { mention: string }>) => ({
  type: "doc",
  content: [{ type: "paragraph", content: parts.map((part) => typeof part === "string" ? { type: "text", text: part } : { type: "mention", attrs: { id: part.mention, label: "x" } }) }],
});

async function setup(transaction: Database, visibility: "public" | "private" = "public") {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const other = await createMemberFactory(transaction, workspace.id, "Member");
  const bystander = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility });
  for (const user of [member, other, guest]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: user === guest ? "Guest" : "Member" });
  const items = createWorkItemActions(transaction);
  const item = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Item" });
  return { workspace, admin, member, other, bystander, guest, items, item, project, comments: createCommentActions(transaction) };
}

test.concurrent("comment stores Tiptap JSON and plain text, and lists in order", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, member, item } = await setup(transaction);
    const body = doc("Hello ", { mention: member.id }, " world");
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body });
    expect(created).toMatchObject({ body, bodyText: "Hello  world", authorId: member.id, editedAt: null });
    await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("second") });
    const list = await comments.listComments.handler({ userId: member.id }, { workItemId: item.id });
    expect(list.map((row) => row.bodyText)).toEqual(["Hello  world", "second"]);
  });
});

test.concurrent("guests and outsiders cannot comment; empty comments are rejected", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, guest, item, member } = await setup(transaction);
    await expect(comments.createComment.handler({ userId: guest.id }, { workItemId: item.id, body: doc("hi") })).rejects.toMatchObject({ status: 403 });
    await expect(comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("   ") })).rejects.toMatchObject({ status: 400 });
    await expect(comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: { nope: true } })).rejects.toMatchObject({ status: 400 });
    expect(await comments.listComments.handler({ userId: guest.id }, { workItemId: item.id })).toEqual([]);
  });
});

test.concurrent("mention picker lists only members who can see the project", async () => {
  await withRollback(db, async (transaction) => {
    const pub = await setup(transaction, "public");
    const publicIds = (await pub.comments.listMentionableMembers.handler({ userId: pub.member.id }, { projectId: pub.project.id })).map((row) => row.userId);
    expect(publicIds).toContain(pub.bystander.id);
    const priv = await setup(transaction, "private");
    const privateIds = (await priv.comments.listMentionableMembers.handler({ userId: priv.member.id }, { projectId: priv.project.id })).map((row) => row.userId);
    expect(privateIds).toContain(priv.other.id);
    expect(privateIds).toContain(priv.admin.id);
    expect(privateIds).not.toContain(priv.bystander.id);
    await expect(priv.comments.createComment.handler({ userId: priv.member.id }, { workItemId: priv.item.id, body: doc({ mention: priv.bystander.id }) })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("mentions are recorded, re-synced on edit, and self-mentions skipped", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, member, other, admin, item } = await setup(transaction);
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc({ mention: other.id }, { mention: other.id }, { mention: member.id }) });
    expect(created.mentionedUserIds).toEqual([other.id]);
    const rows = () => transaction.select().from(commentMentions).where(eq(commentMentions.commentId, created.id));
    expect((await rows()).map((row) => row.userId)).toEqual([other.id]);
    const edited = await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body: doc({ mention: admin.id }) });
    expect(edited.mentionedUserIds).toEqual([admin.id]);
    expect((await rows()).map((row) => row.userId)).toEqual([admin.id]);
  });
});

test.concurrent("only the author edits or deletes; deletion is soft and hides the comment", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, member, other, admin, item } = await setup(transaction);
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("mine") });
    await expect(comments.updateComment.handler({ userId: other.id }, { commentId: created.id, body: doc("x") })).rejects.toMatchObject({ status: 403 });
    await expect(comments.deleteComment.handler({ userId: admin.id }, { commentId: created.id })).rejects.toMatchObject({ status: 403 });
    const edited = await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body: doc("fixed") });
    expect(edited).toMatchObject({ bodyText: "fixed" });
    expect(edited.editedAt).not.toBeNull();
    await comments.deleteComment.handler({ userId: member.id }, { commentId: created.id });
    expect(await comments.listComments.handler({ userId: member.id }, { workItemId: item.id })).toEqual([]);
    await expect(comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body: doc("again") })).rejects.toMatchObject({ status: 404 });
    await expect(comments.deleteComment.handler({ userId: member.id }, { commentId: created.id })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("comments appear in the Activity timeline with actor and source", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, items, member, item } = await setup(transaction);
    const created = await comments.createComment.handler({ userId: member.id, source: "mcp" }, { workItemId: item.id, body: doc("hi") });
    await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body: doc("hello") });
    await comments.deleteComment.handler({ userId: member.id }, { commentId: created.id });
    const log = (await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id })).filter((row) => row.field.startsWith("comment"));
    expect(log.map((row) => row.field)).toEqual(["comment_added", "comment_edited", "comment_deleted"]);
    expect(log[0]).toMatchObject({ actorId: member.id, source: "mcp", newValue: { commentId: created.id, text: "hi" } });
  });
});

test.concurrent("a comment holding only an inline image is not empty", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const image = { type: "doc", content: [{ type: "assetImage", attrs: { assetId: crypto.randomUUID() } }] };
    const created = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: image });
    expect(created.body).toEqual(image);
    await expect(env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: { type: "doc", content: [{ type: "paragraph" }] } })).rejects.toMatchObject({ status: 400 });
  });
});
