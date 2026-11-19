import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { assets, commentMentions, commentVersions, comments as commentsTable, createDatabase, outlinks, type Database } from "@weft/db";
import { backfillCommentWrittenForms } from "../src/migrations/comment-written-form";
import { commentMarkdownOptions, createAgentActions, createApiTokenActions, createCommentActions, createIntakeActions, createProjectActions, createRuntimeActions, createTimelineActions, createWikiActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
beforeAll(async () => {
  await db.execute(sql`alter table comments alter column body_markdown drop not null`);
  await db.execute(sql`alter table comment_versions alter column body_markdown drop not null`);
});
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

test("comment reference lookup skips plain text and uses a bounded number of queries", async () => {
  await withRollback(db, async (transaction) => {
    const { member, project, workspace } = await setup(transaction);
    const select = spyOn(transaction, "select");
    try {
      await commentMarkdownOptions(transaction, member.id, workspace.id, project.id, "plain text without any references");
      expect(select).toHaveBeenCalledTimes(0);
      select.mockClear();
      await commentMarkdownOptions(transaction, member.id, workspace.id, project.id, "[[MOB-1]]");
      const oneReferenceQueries = select.mock.calls.length;
      select.mockClear();
      await commentMarkdownOptions(transaction, member.id, workspace.id, project.id, Array.from({ length: 20 }, (_, index) => "[[MOB-" + (index + 1) + "]]").join(" "));
      expect(select.mock.calls.length).toBe(oneReferenceQueries);
    } finally { select.mockRestore(); }
  });
});

test.concurrent("comment stores Tiptap JSON and plain text, and lists in order", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, member, item } = await setup(transaction);
    const body = doc("Hello ", { mention: member.id }, " world");
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body });
    expect(created).toMatchObject({ body, bodyText: "Hello x world", authorId: member.id, editedAt: null });
    const persisted = await transaction.execute<{ bodyMarkdown: string }>(sql`select body_markdown as "bodyMarkdown" from comments where id = ${created.id}::uuid`);
    expect(persisted[0]?.bodyMarkdown).toBe(`Hello @{x|${member.id}} world`);
    await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("second") });
    const list = await comments.listComments.handler({ userId: member.id }, { workItemId: item.id });
    expect(list.map((row) => row.bodyText)).toEqual(["Hello x world", "second"]);
  });
});

test.concurrent("comment create and update save legacy alignment with the same warning code", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, member, item } = await setup(transaction);
    const body = { type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Aligned" }] }] };
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body });
    expect(created.markdown).toContain("Aligned");
    expect(created.markdownWarningDetails).toContainEqual(expect.objectContaining({ code: "attribute-not-persisted", message: expect.stringContaining("text alignment") }));
    const updated = await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body });
    expect(updated.markdownWarningDetails).toContainEqual(expect.objectContaining({ code: "attribute-not-persisted" }));
  });
});

test.concurrent("a Guest can discuss their own Triage item through Activity, but cannot read another Guest's item", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const intake = createIntakeActions(transaction);
    const own = await intake.submitIntakeItem.handler({ userId: env.guest.id }, { projectId: env.project.id, title: "Guest request" });
    const other = await intake.submitIntakeItem.handler({ userId: env.bystander.id }, { projectId: env.project.id, title: "Private request" });
    const created = await env.comments.createComment.handler({ userId: env.guest.id }, { workItemId: own.workItemId, body: doc("More detail") });
    expect((await env.comments.listComments.handler({ userId: env.guest.id }, { workItemId: own.workItemId })).map((row) => row.bodyText)).toEqual(["More detail"]);
    expect((await createTimelineActions(transaction).listTimeline.handler({ userId: env.guest.id }, { workItemId: own.workItemId })).some((entry) => entry.kind === "comment" && entry.comment?.id === created.id)).toBe(true);
    await expect(env.comments.listComments.handler({ userId: env.guest.id }, { workItemId: other.workItemId })).rejects.toMatchObject({ status: 403 });
    await expect(createTimelineActions(transaction).listTimeline.handler({ userId: env.guest.id }, { workItemId: other.workItemId })).rejects.toMatchObject({ status: 403 });
    await intake.rejectIntakeItem.handler({ userId: env.member.id }, { intakeItemId: own.id });
    await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: own.workItemId, body: doc("Decision follow-up") });
    expect((await env.comments.listComments.handler({ userId: env.guest.id }, { workItemId: own.workItemId })).map((row) => row.bodyText)).toEqual(["More detail", "Decision follow-up"]);
  });
});

test.concurrent("comment create and update accept every code-block language spelling", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, member, item } = await setup(transaction);
    const variants = [undefined, null, "", "typescript"] as const;
    for (const [index, language] of variants.entries()) {
      const block = { type: "codeBlock", ...(index === 0 ? {} : { attrs: { language } }), content: [{ type: "text", text: "Code block" }] };
      const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: { type: "doc", content: [block] } });
      expect(created.markdown).toContain("Code block");
      const updated = await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, body: { type: "doc", content: [block] } });
      expect(updated.markdown).toContain("Code block");
    }
  });
});

test.concurrent("comment saves rebuild the work item's Outlinks and removing one reference removes its row", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, items, member, project, item } = await setup(transaction);
    const target = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Target" });
    const reference = `[[MOB-2|work-item:${target.id}]]`;
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, bodyMarkdown: reference });
    expect(await transaction.select().from(outlinks).where(eq(outlinks.sourceId, item.id))).toMatchObject([
      { sourceKind: "work-item", sourceId: item.id, targetKind: "work-item", targetId: target.id },
    ]);
    await comments.updateComment.handler({ userId: member.id }, { commentId: created.id, bodyMarkdown: "Removed the reference" });
    expect(await transaction.select().from(outlinks).where(eq(outlinks.sourceId, item.id))).toEqual([]);
  });
});

test.concurrent("work-item references resolve old project keys and keep stable IDs after target renames", async () => {
  await withRollback(db, async (transaction) => {
    const { comments, items, member, admin, project, item, workspace } = await setup(transaction);
    const projects = createProjectActions(transaction);
    const target = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Original" });
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: member.id }, { workspaceId: workspace.id, projectId: project.id, title: "Manual" });
    await projects.renameProjectKey.handler({ userId: admin.id }, { projectId: project.id, key: "APP" });
    const referenceOptions = await commentMarkdownOptions(transaction, member.id, workspace.id, project.id, "MOB-2 [[MOB-2]]");
    expect(referenceOptions.options.resolveReference?.("MOB-2", "work-item")).toMatchObject({ id: target.id, kind: "work-item" });
    const created = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, bodyMarkdown: `MOB-2 [[MOB-2]] [[Manual|page:${page.id}]]` });
    expect(JSON.stringify(created.body)).toContain(target.id);
    expect(JSON.stringify(created.body)).toContain(page.id);
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: target.id, title: "Renamed" });
    await wiki.updateWikiPage.handler({ userId: member.id }, { pageId: page.id, title: "Renamed Manual" });
    const reread = await comments.listComments.handler({ userId: member.id }, { workItemId: item.id });
    expect(JSON.stringify(reread[0]?.body)).toContain(target.id);
    expect(JSON.stringify(reread[0]?.body)).toContain(page.id);
    expect(workspace.id).toBeTruthy();
  });
});

test("comment Written form backfill rolls back and names an unconvertible row", async () => {
  await withRollback(db, async (transaction) => {
    const { member, other, item, project, workspace } = await setup(transaction);
    const [row] = await transaction.insert(commentsTable).values({
      workspaceId: workspace.id, projectId: project.id, workItemId: item.id, authorId: member.id,
      body: { type: "doc", content: [{ type: "unknown_widget" }] }, bodyMarkdown: null as unknown as string, bodyText: "legacy",
    }).returning();
    await expect(backfillCommentWrittenForms(transaction)).rejects.toThrow(`comments row ${row!.id} cannot be converted to Written form`);
    const [unchanged] = await transaction.select({ bodyMarkdown: commentsTable.bodyMarkdown }).from(commentsTable).where(eq(commentsTable.id, row!.id));
    expect(unchanged?.bodyMarkdown).toBeNull();
  });
});

test("comment Written form backfill converts current and historical bodies", async () => {
  await withRollback(db, async (transaction) => {
    const { member, other, item, project, workspace } = await setup(transaction);
    const [comment] = await transaction.insert(commentsTable).values({ workspaceId: workspace.id, projectId: project.id, workItemId: item.id, authorId: member.id, body: doc("Legacy ", { mention: other.id }), bodyMarkdown: null as unknown as string, bodyText: "Legacy " }).returning();
    const [version] = await transaction.insert(commentVersions).values({ commentId: comment!.id, body: doc("Earlier comment"), bodyMarkdown: null as unknown as string, bodyText: "Earlier comment", writtenAt: new Date() }).returning();
    await backfillCommentWrittenForms(transaction);
    const [convertedComment] = await transaction.select({ bodyMarkdown: commentsTable.bodyMarkdown, bodyText: commentsTable.bodyText }).from(commentsTable).where(eq(commentsTable.id, comment!.id));
    const [convertedVersion] = await transaction.select({ bodyMarkdown: commentVersions.bodyMarkdown }).from(commentVersions).where(eq(commentVersions.id, version!.id));
    expect(convertedComment?.bodyMarkdown).toBe(`Legacy @{x|${other.id}}`);
    expect(convertedComment?.bodyText).toBe("Legacy x");
    expect(await transaction.select().from(commentMentions).where(eq(commentMentions.commentId, comment!.id))).toMatchObject([{ userId: other.id }]);
    expect(convertedVersion?.bodyMarkdown).toBe("Earlier comment");
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

test.concurrent("mentionable members expose Agent identity and Runtime capability, independent of comment Runs", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const agent = await createAgentActions(transaction).createAgent.handler({ userId: env.admin.id }, { workspaceId: env.workspace.id, name: "Helper", model: "default" });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: env.admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const listed = await env.comments.listMentionableMembers.handler({ userId: env.member.id }, { projectId: env.project.id });
    expect(listed.find((row) => row.userId === agent.userId)).toMatchObject({ isAgent: true, codeCapable: false });
    const assignees = await createProjectActions(transaction).listProjectMembers.handler({ userId: env.member.id }, { projectId: env.project.id });
    expect(assignees.find((row) => row.userId === agent.userId)).toMatchObject({ isAgent: true, codeCapable: false });
    const token = await createApiTokenActions(transaction).createApiToken.handler({ userId: env.admin.id }, { name: "daemon" });
    const registered = await createRuntimeActions(transaction).registerDaemon.handler({ userId: env.admin.id, apiTokenId: token.id }, { hostname: "devbox", version: "1.0", agentClis: ["codex"] });
    const runtime = registered.runtimes[0]!;
    await createRuntimeActions(transaction).shareRuntime.handler({ userId: env.admin.id }, { runtimeId: runtime.id });
    const codeAgent = await createAgentActions(transaction).createAgent.handler({ userId: env.admin.id }, { workspaceId: env.workspace.id, name: "Coder", model: "default", runtimeId: runtime.id });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: env.admin.id }, { agentId: codeAgent.id, allProjects: true, projectIds: [] });
    const withCode = await env.comments.listMentionableMembers.handler({ userId: env.member.id }, { projectId: env.project.id });
    expect(withCode.find((row) => row.userId === codeAgent.userId)).toMatchObject({ isAgent: true, codeCapable: true });
    expect((await createProjectActions(transaction).listProjectMembers.handler({ userId: env.member.id }, { projectId: env.project.id })).find((row) => row.userId === codeAgent.userId)).toMatchObject({ isAgent: true, codeCapable: true });
  });
});

test.concurrent("a comment author is labelled by member identity even when the comment has no Run", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const agent = await createAgentActions(transaction).createAgent.handler({ userId: env.admin.id }, { workspaceId: env.workspace.id, name: "Helper", model: "default" });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: env.admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const comment = await env.comments.createComment.handler({ userId: agent.userId, source: "agent" }, { workItemId: env.item.id, body: doc("Reply") });
    expect(comment).toMatchObject({ authorIsAgent: true, runId: null, authorCodeCapable: false });
    expect((await env.comments.listComments.handler({ userId: env.member.id }, { workItemId: env.item.id }))[0]).toMatchObject({ authorIsAgent: true, runId: null });
    const timeline = await createTimelineActions(transaction).listTimeline.handler({ userId: env.member.id }, { workItemId: env.item.id });
    expect(timeline.find((entry) => entry.kind === "comment")?.comment).toMatchObject({ authorIsAgent: true, runId: null });
    await env.items.updateWorkItem.handler({ userId: agent.userId, source: "ui" }, { workItemId: env.item.id, title: "Updated by Agent" });
    expect((await env.items.listWorkItemActivities.handler({ userId: env.member.id }, { workItemId: env.item.id })).at(-1)).toMatchObject({ actorIsAgent: true, actorCodeCapable: false, actorId: agent.userId });
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

test.concurrent("ambiguous Markdown mentions fail with their visible candidates", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const people = await env.comments.listMentionableMembers.handler({ userId: env.member.id }, { projectId: env.project.id });
    const duplicateName = people.find((person, index) => people.some((other, otherIndex) => otherIndex !== index && other.name === person.name));
    expect(duplicateName).toBeDefined();
    await expect(env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, bodyMarkdown: `@{${duplicateName!.name}}` })).rejects.toThrow(new RegExp(`Candidates:.*${duplicateName!.userId}`));
  });
});

test.concurrent("list mentions produce readable search text and stable Written form", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const comment = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, bodyMarkdown: `- Escalate to @{${env.other.id}}` });
    expect(comment.markdown).toBe(`- Escalate to @{Test user|${env.other.id}}`);
    expect(comment.bodyText).toContain("Escalate to Test user");
    expect(comment.bodyText).not.toContain("@{");
    expect(comment.mentionedUserIds).toContain(env.other.id);
  });
});

test.concurrent("unresolved Markdown references remain text with warnings while missing images fail", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const missing = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, bodyMarkdown: "[[MISSING-99]]" });
    expect(missing.bodyText).toContain("[[MISSING-99]]");
    expect(missing.markdownWarningDetails.map(({ code }) => code)).toContain("unresolved-reference");
    const stableMissing = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, bodyMarkdown: `[[Missing|work-item:${crypto.randomUUID()}]]` });
    expect(stableMissing.bodyText).toContain("Missing");
    expect(stableMissing.markdownWarningDetails.map(({ code }) => code)).toContain("unresolved-reference");
    await expect(env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, bodyMarkdown: `![[asset:${crypto.randomUUID()}]]` })).rejects.toThrow(/image/i);
  });
});

test.concurrent("ambiguous Markdown links name their accessible candidate pages", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const wiki = createWikiActions(transaction);
    await wiki.createWikiPage.handler({ userId: env.member.id }, { workspaceId: env.workspace.id, title: "Duplicate" });
    await wiki.createWikiPage.handler({ userId: env.member.id }, { workspaceId: env.workspace.id, title: "Duplicate" });
    await expect(env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, bodyMarkdown: "[[Duplicate]]" })).rejects.toThrow(/Candidates: wiki [a-f0-9-]+, wiki [a-f0-9-]+/);
  });
});

test.concurrent("Agent Markdown mentions still cannot name someone outside a private project's access", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction, "private");
    const agent = await createAgentActions(transaction).createAgent.handler({ userId: env.admin.id }, { workspaceId: env.workspace.id, name: "Helper", model: "default" });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: env.admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await expect(env.comments.createComment.handler({ userId: agent.userId, source: "agent" }, { workItemId: env.item.id, bodyMarkdown: `@{${env.bystander.id}}` })).rejects.toMatchObject({ status: 400 });
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
    expect(log[0]).toMatchObject({ actorId: member.id, source: "mcp", newValue: { commentId: created.id } });
    for (const row of log) expect(JSON.stringify(row)).not.toMatch(/"text"|hello|"hi"/);
  });
});

test.concurrent("a comment holding only an inline image is not empty", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const assetId = crypto.randomUUID();
    await transaction.insert(assets).values({ id: assetId, workspaceId: env.workspace.id, projectId: env.project.id, ownerType: "work_item", ownerId: env.item.id, uploaderId: env.member.id, storageKey: `${env.workspace.id}/${assetId}`, filename: "screenshot.png", contentType: "image/png", size: 10, status: "uploaded", uploadedAt: new Date() });
    const image = { type: "doc", content: [{ type: "assetImage", attrs: { assetId } }] };
    const created = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: image });
    // The stored document is what a parse of the stored Markdown gives, which names the empty alt text.
    expect(created.body).toEqual({ type: "doc", content: [{ type: "assetImage", attrs: { alt: null, assetId: (image.content[0] as { attrs: { assetId: string } }).attrs.assetId } }] });
    await expect(env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: { type: "doc", content: [{ type: "paragraph" }] } })).rejects.toMatchObject({ status: 400 });
  });
});

const reply = (env: Awaited<ReturnType<typeof setup>>, userId: string, parentId: string, text = "re") =>
  env.comments.createComment.handler({ userId }, { workItemId: env.item.id, body: doc(text), parentId });

test.concurrent("a Member replies one level deep; reply count and participants show on the parent", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const parent = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: doc("root") });
    expect(parent).toMatchObject({ parentId: null, replyCount: 0, participants: [] });
    const first = await reply(env, env.other.id, parent.id, "one");
    await reply(env, env.other.id, parent.id, "two");
    await reply(env, env.admin.id, parent.id, "three");
    expect(first.parentId).toBe(parent.id);
    const list = await env.comments.listComments.handler({ userId: env.member.id }, { workItemId: env.item.id });
    expect(list).toHaveLength(4);
    const root = list.find((row) => row.id === parent.id)!;
    expect(root.replyCount).toBe(3);
    expect(root.participants.map((person) => person.userId).sort()).toEqual([env.admin.id, env.other.id].sort());
    expect(list.filter((row) => row.parentId === parent.id)).toHaveLength(3);
  });
});

test.concurrent("a reply to a reply, a reply to a missing comment, and a reply across work items are refused", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const parent = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: doc("root") });
    const child = await reply(env, env.other.id, parent.id);
    await expect(reply(env, env.member.id, child.id)).rejects.toMatchObject({ status: 400 });
    await expect(reply(env, env.member.id, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
    const second = await env.items.createWorkItem.handler({ userId: env.member.id }, { projectId: env.project.id, title: "Other" });
    await expect(env.comments.createComment.handler({ userId: env.member.id }, { workItemId: second.id, body: doc("x"), parentId: parent.id })).rejects.toMatchObject({ status: 400 });
    await expect(reply(env, env.guest.id, parent.id)).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("reply author-only edit and delete hold for Admins; editing keeps the parent", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const parent = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: doc("root") });
    const child = await reply(env, env.other.id, parent.id);
    await expect(env.comments.updateComment.handler({ userId: env.admin.id }, { commentId: child.id, body: doc("x") })).rejects.toMatchObject({ status: 403 });
    await expect(env.comments.deleteComment.handler({ userId: env.admin.id }, { commentId: child.id })).rejects.toMatchObject({ status: 403 });
    expect((await env.comments.updateComment.handler({ userId: env.other.id }, { commentId: child.id, body: doc("y") })).parentId).toBe(parent.id);
    await env.comments.deleteComment.handler({ userId: env.other.id }, { commentId: child.id });
    const list = await env.comments.listComments.handler({ userId: env.member.id }, { workItemId: env.item.id });
    expect(list.map((row) => row.id)).toEqual([parent.id]);
    expect(list[0]!.replyCount).toBe(0);
  });
});

test.concurrent("deleting the parent hides its replies together, and they cannot be edited, deleted, or replied to", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const keep = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: doc("keep") });
    const parent = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: doc("root") });
    const child = await reply(env, env.other.id, parent.id);
    await env.comments.deleteComment.handler({ userId: env.member.id }, { commentId: parent.id });
    const list = await env.comments.listComments.handler({ userId: env.member.id }, { workItemId: env.item.id });
    expect(list.map((row) => row.id)).toEqual([keep.id]);
    await expect(env.comments.updateComment.handler({ userId: env.other.id }, { commentId: child.id, body: doc("z") })).rejects.toMatchObject({ status: 404 });
    await expect(env.comments.deleteComment.handler({ userId: env.other.id }, { commentId: child.id })).rejects.toMatchObject({ status: 404 });
    await expect(reply(env, env.other.id, parent.id)).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("a reply logs only the comment id in Activity", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const parent = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: doc("root") });
    const child = await reply(env, env.other.id, parent.id, "secretreply");
    const log = (await env.items.listWorkItemActivities.handler({ userId: env.member.id }, { workItemId: env.item.id })).filter((row) => row.field === "comment_added");
    expect(log.map((row) => row.newValue)).toEqual([{ commentId: parent.id }, { commentId: child.id }]);
    expect(JSON.stringify(log)).not.toContain("secretreply");
  });
});

test.concurrent("an Agent comment with a mermaid block is accepted; the diagram source is stored as plain code text and the notes say so", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const agent = await createAgentActions(transaction).createAgent.handler({ userId: env.admin.id }, { workspaceId: env.workspace.id, name: "Drawer", model: "default" });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: env.admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const source = "graph TD\n  A[\"<img src=x onerror=alert(1)>\"] --> B";
    const written = `Plan:\n\n\`\`\`mermaid\n${source}\n\`\`\``;
    const created: any = await env.comments.createComment.handler({ userId: agent.userId, source: "agent" } as any, { workItemId: env.item.id, bodyMarkdown: written });
    const block = created.body.content.find((node: any) => node.type === "codeBlock");
    expect(block.attrs.language).toBe("mermaid");
    expect(block.content).toEqual([{ type: "text", text: source }]);
    expect(created.markdown).toBe(written);
    const { actionNotes } = await import("../src/tool-notes");
    expect(actionNotes.create_comment).toContain("mermaid");
    expect(actionNotes.list_outlinks).toContain("on purpose");
    expect(actionNotes.list_backlinks).toContain("on purpose");
  });
}, 60_000);
