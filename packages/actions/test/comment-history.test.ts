import { afterAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { commentVersions, comments as commentsTable, createDatabase, type Database } from "@weft/db";
import { createActionList, createAiTools, createCommentActions, createProjectActions, createTimelineActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const other = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  for (const user of [member, other, guest]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: user === guest ? "Guest" : "Member" });
  const items = createWorkItemActions(transaction);
  const item = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Item" });
  return { workspace, admin, member, other, guest, items, item, comments: createCommentActions(transaction), timeline: createTimelineActions(transaction) };
}

test.concurrent("edit stores the previous body; only the author and workspace Admins read versions", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, member, other, admin, guest, item } = await setup(transaction);
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("v1") });
    expect(await comments.listCommentVersions.handler({ userId: member.id }, { commentId: created.id })).toEqual([]);
    await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body: doc("v2") });
    await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body: doc("v3") });
    for (const reader of [member, admin]) {
      const versions = await comments.listCommentVersions.handler({ userId: reader.id }, { commentId: created.id });
      expect(versions.map((row) => row.bodyText)).toEqual(["v2", "v1"]);
      expect(versions[1]!.body).toEqual(doc("v1"));
    }
    for (const reader of [other, guest]) await expect(comments.listCommentVersions.handler({ userId: reader.id }, { commentId: created.id })).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("deleting a comment removes its versions and its replies' versions; nothing can read them after", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, member, other, admin, guest, item, timeline } = await setup(transaction);
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("secret-one") });
    await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body: doc("secret-two") });
    const child = await comments.createComment.handler({ userId: other.id }, { workItemId: item.id, body: doc("reply-one"), parentId: created.id });
    await comments.updateComment.handler({ userId: other.id }, { commentId: child.id, body: doc("reply-two") });
    await comments.deleteComment.handler({ userId: member.id }, { commentId: created.id });

    expect(await transaction.select().from(commentVersions).where(eq(commentVersions.commentId, created.id))).toEqual([]);
    expect(await transaction.select().from(commentVersions).where(eq(commentVersions.commentId, child.id))).toEqual([]);
    expect((await transaction.select().from(commentsTable).where(eq(commentsTable.id, created.id)))).toHaveLength(1); // soft delete

    // Leak test: every caller, through every Action, gets neither the text nor any version.
    const probes = [member, admin, other, guest];
    for (const user of probes) {
      await expect(comments.listCommentVersions.handler({ userId: user.id }, { commentId: created.id })).rejects.toMatchObject({ status: 404 });
      await expect(comments.listCommentVersions.handler({ userId: user.id }, { commentId: child.id })).rejects.toMatchObject({ status: 404 });
      for (const filter of ["all", "comments", "updates"] as const) {
        expect(JSON.stringify(await timeline.listTimeline.handler({ userId: user.id }, { workItemId: item.id, filter }))).not.toMatch(/secret|reply-/);
      }
      expect(JSON.stringify(await comments.listComments.handler({ userId: user.id }, { workItemId: item.id }))).not.toMatch(/secret|reply-/);
    }
    for (const action of createActionList(transaction).filter((candidate) => candidate.kind === "read" && ["workItemId", "commentId"].some((key) => key in (candidate.input as { properties: object }).properties))) {
      const input = { workItemId: item.id, commentId: created.id, displayId: "MOB-1" };
      const shaped = Object.fromEntries(Object.keys((action.input as { properties: object }).properties).filter((key) => key in input).map((key) => [key, input[key as keyof typeof input]]));
      const result = await (action.handler as (context: { userId: string }, value: unknown) => Promise<unknown>)({ userId: member.id }, shaped).catch(() => null);
      expect(JSON.stringify(result)).not.toMatch(/secret|reply-/);
    }
  });
});

test.concurrent("the AI cannot call list_comment_versions, and reads of a live comment never include versions", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, member, workspace, item } = await setup(transaction);
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("old-text") });
    await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body: doc("new-text") });
    const tools = createAiTools(transaction, { userId: member.id, workspaceId: workspace.id, chatId: crypto.randomUUID() });
    expect(tools.map((tool) => tool.name)).not.toContain("list_comment_versions");
    expect(tools.map((tool) => tool.name)).toContain("list_timeline");
    const timelineTool = tools.find((tool) => tool.name === "list_timeline")!;
    const output = await timelineTool.execute({ workItemId: item.id });
    expect(output).toContain("new-text");
    expect(output).not.toContain("old-text");
  });
});

test.concurrent("timeline merges comments and Activity with filter and sort; replies nest; comment Activity stays id-only", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, items, member, other, item, timeline } = await setup(transaction);
    const first = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("first") });
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, priority: "high" } as never);
    await comments.createComment.handler({ userId: other.id }, { workItemId: item.id, body: doc("nested"), parentId: first.id });
    await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("last") });
    // Activity rows take the transaction's start time, so pin the order the feed must show.
    await transaction.execute(sql`update activities set created_at = case field when 'created' then now() - interval '4 minutes' else now() - interval '2 minutes 30 seconds' end where entity_id = ${item.id}`);
    await transaction.execute(sql`update comments set created_at = case body_text when 'first' then now() - interval '3 minutes' when 'nested' then now() - interval '2 minutes' else now() - interval '1 minute' end where work_item_id = ${item.id}`);
    const kinds = async (filter: "all" | "comments" | "updates", sort: "newest" | "oldest") =>
      (await timeline.listTimeline.handler({ userId: member.id }, { workItemId: item.id, filter, sort })).map((row) => row.kind === "comment" ? `c:${row.comment!.bodyText}` : `a:${row.activity!.field}`);
    expect(await kinds("all", "oldest")).toEqual(["a:created", "c:first", "a:priority", "c:last"]);
    expect(await kinds("all", "newest")).toEqual(["c:last", "a:priority", "c:first", "a:created"]);
    expect(await kinds("comments", "oldest")).toEqual(["c:first", "c:last"]);
    expect(await kinds("updates", "oldest")).toEqual(["a:created", "a:priority"]);
    const [, entry] = await timeline.listTimeline.handler({ userId: member.id }, { workItemId: item.id });
    expect(entry!.comment!.replies.map((row) => row.bodyText)).toEqual(["nested"]);
    const log = (await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id })).filter((row) => row.field === "comment_added");
    for (const row of log) expect(row.newValue).toEqual({ commentId: expect.any(String) });
  });
});
