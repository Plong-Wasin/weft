import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { comments as commentsTable, createDatabase, outlinks, projectMembers, wikiPages, workItems } from "@weft/db";
import { createCommentActions, createProjectActions, createWikiActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

// A link to something the writer cannot open stays a link when the writer edits another sentence (resolution decides display, never storage); the writer still cannot ADD such a link.
async function setup(tx: Parameters<Parameters<typeof withRollback>[1]>[0]) {
  const workspace = await createWorkspaceFactory(tx);
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const editor = await createMemberFactory(tx, workspace.id, "Member");
  const projects = createProjectActions(tx);
  const publicProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Public", key: "PUB", visibility: "public" });
  const privateProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Private", key: "SEC", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: publicProject.id, userId: editor.id, role: "Member" });
  const work = createWorkItemActions(tx);
  const secret = await work.createWorkItem.handler({ userId: admin.id }, { projectId: privateProject.id, title: "Secret plan" });
  const secretTwo = await work.createWorkItem.handler({ userId: admin.id }, { projectId: privateProject.id, title: "Other secret" });
  const visible = await work.createWorkItem.handler({ userId: admin.id }, { projectId: publicProject.id, title: "Visible" });
  return { workspace, admin, editor, projects, publicProject, privateProject, work, secret, secretTwo, visible };
}
const refs = (kind: string, id: string, label: string) => `[[${label}|${kind}:${id}]]`;
const targetsOf = async (tx: any, sourceId: string) => [...new Set((await tx.select().from(outlinks).where(eq(outlinks.sourceId, sourceId))).map((row: any) => row.targetId as string))].sort();

test("description via Markdown: an editor without access to a linked item edits another sentence; the link and its Outlink survive, and a NEW hidden link is refused", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const secretRef = refs("work-item", s.secret.id, "Secret plan"), visibleRef = refs("work-item", s.visible.id, "Visible");
    const source = await s.work.createWorkItem.handler({ userId: s.admin.id }, { projectId: s.publicProject.id, title: "Source", descriptionMarkdown: `Intro. ${secretRef} and ${visibleRef} end.` });
    expect(await targetsOf(tx, source.id)).toEqual([s.secret.id, s.visible.id].sort());
    const read: any = await s.work.getWorkItem.handler({ userId: s.editor.id }, { workspaceId: s.workspace.id, displayId: source.displayId });
    expect(read.descriptionMarkdown).toContain(secretRef);
    const written: any = await s.work.updateWorkItem.handler({ userId: s.editor.id }, { workItemId: source.id, descriptionMarkdown: read.descriptionMarkdown.replace("Intro.", "Intro2.") });
    expect(written.descriptionMarkdownWarnings).toEqual([]);
    const [row] = await tx.select({ markdown: workItems.descriptionMarkdown }).from(workItems).where(eq(workItems.id, source.id));
    expect(row!.markdown).toContain("Intro2.");
    expect(row!.markdown).toContain(secretRef);
    expect(row!.markdown).not.toContain("\\[\\[");
    expect(await targetsOf(tx, source.id)).toEqual([s.secret.id, s.visible.id].sort());
    const ownerRead: any = await s.work.getWorkItem.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, displayId: source.displayId });
    expect(ownerRead.descriptionMarkdown).toContain(secretRef);
    expect(JSON.stringify(ownerRead.description)).toContain(s.secret.id);
    // The editor cannot ADD a link to a different hidden item.
    const added: any = await s.work.updateWorkItem.handler({ userId: s.editor.id }, { workItemId: source.id, descriptionMarkdown: `${read.descriptionMarkdown.replace("Intro.", "Intro3.")} ${refs("work-item", s.secretTwo.id, "Sneaky")}` });
    expect(added.descriptionMarkdownWarnings.join(" ")).toMatch(/reference|link|unavailable/i);
    expect(await targetsOf(tx, source.id)).not.toContain(s.secretTwo.id);
    // Non-stable text stays escaped with the unresolved-reference warning.
    const nope: any = await s.work.updateWorkItem.handler({ userId: s.editor.id }, { workItemId: source.id, descriptionMarkdown: `Intro4. ${secretRef} [[Nope]]` });
    expect(nope.descriptionMarkdownWarningDetails.map((w: any) => w.code)).toContain("unresolved-reference");
  });
}, 120_000);

test("description via the document: the editor keeps the hidden link without a spurious attribute-not-persisted warning", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const source = await s.work.createWorkItem.handler({ userId: s.admin.id }, { projectId: s.publicProject.id, title: "Source", descriptionMarkdown: `Intro. ${refs("work-item", s.secret.id, "Secret plan")} end.` });
    const read: any = await s.work.getWorkItem.handler({ userId: s.editor.id }, { workspaceId: s.workspace.id, displayId: source.displayId });
    expect(JSON.stringify(read.description)).toContain('"unavailable":true');
    const document = { ...read.description, content: [...read.description.content, { type: "paragraph", content: [{ type: "text", text: "Changed visible sentence" }] }] };
    const written: any = await s.work.updateWorkItem.handler({ userId: s.editor.id }, { workItemId: source.id, description: document });
    expect(written.descriptionMarkdownWarningDetails.map((w: any) => w.code)).not.toContain("attribute-not-persisted");
    expect(await targetsOf(tx, source.id)).toEqual([s.secret.id]);
    const ownerRead: any = await s.work.getWorkItem.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, displayId: source.displayId });
    expect(ownerRead.descriptionMarkdown).toContain(refs("work-item", s.secret.id, "Secret plan"));
  });
}, 120_000);

test("comment via Markdown and via the document: its author lost access to the target, edits another sentence, the link survives", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    await s.projects.addProjectMember.handler({ userId: s.admin.id }, { projectId: s.privateProject.id, userId: s.editor.id, role: "Member" });
    const source = await s.work.createWorkItem.handler({ userId: s.admin.id }, { projectId: s.publicProject.id, title: "Source" });
    const secretRef = refs("work-item", s.secret.id, "Secret plan");
    const commentActions = createCommentActions(tx);
    const comment = await commentActions.createComment.handler({ userId: s.editor.id }, { workItemId: source.id, bodyMarkdown: `Note. ${secretRef} end.` });
    await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, s.privateProject.id), eq(projectMembers.userId, s.editor.id)));
    const listed: any = (await commentActions.listComments.handler({ userId: s.editor.id }, { workItemId: source.id })).find((row: any) => row.id === comment.id);
    await commentActions.updateComment.handler({ userId: s.editor.id }, { commentId: comment.id, bodyMarkdown: listed.markdown.replace("Note.", "Note2.") });
    const [stored] = await tx.select({ markdown: commentsTable.bodyMarkdown }).from(commentsTable).where(eq(commentsTable.id, comment.id));
    expect(stored!.markdown).toContain("Note2.");
    expect(stored!.markdown).toContain(secretRef);
    expect(await targetsOf(tx, source.id)).toEqual([s.secret.id]);
    const again: any = (await commentActions.listComments.handler({ userId: s.editor.id }, { workItemId: source.id })).find((row: any) => row.id === comment.id);
    const updated: any = await commentActions.updateComment.handler({ userId: s.editor.id }, { commentId: comment.id, body: { ...again.body, content: [...again.body.content, { type: "paragraph", content: [{ type: "text", text: "More" }] }] } });
    expect(updated.markdownWarnings ?? []).toEqual([]);
    expect(await targetsOf(tx, source.id)).toEqual([s.secret.id]);
    const owner: any = (await commentActions.listComments.handler({ userId: s.admin.id }, { workItemId: source.id })).find((row: any) => row.id === comment.id);
    expect(owner.markdown).toContain(secretRef);
    // A NEW hidden link in a comment is not stored as a link: it is kept as escaped text and no Outlink is made.
    await commentActions.updateComment.handler({ userId: s.editor.id }, { commentId: comment.id, bodyMarkdown: `${owner.markdown} ${refs("work-item", s.secretTwo.id, "Sneaky")}` });
    expect(await targetsOf(tx, source.id)).toEqual([s.secret.id]);
  });
}, 120_000);

test("page via Markdown and via the document: an editor without access to a linked item keeps the link and its Outlink", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const wiki = createWikiActions(tx);
    const secretRef = refs("work-item", s.secret.id, "Secret plan");
    const page = await wiki.createWikiPage.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, projectId: s.publicProject.id, title: "Page", contentMarkdown: `Intro. ${secretRef} end.` });
    expect(await targetsOf(tx, page.id)).toEqual([s.secret.id]);
    const read: any = await wiki.getWikiPage.handler({ userId: s.editor.id }, { pageId: page.id });
    await wiki.updateWikiPage.handler({ userId: s.editor.id }, { pageId: page.id, contentMarkdown: read.contentMarkdown.replace("Intro.", "Intro2.") });
    const [row] = await tx.select({ markdown: wikiPages.contentMarkdown }).from(wikiPages).where(eq(wikiPages.id, page.id));
    expect(row!.markdown).toContain("Intro2.");
    expect(row!.markdown).toContain(secretRef);
    expect(await targetsOf(tx, page.id)).toEqual([s.secret.id]);
    const document = { ...read.content, content: [...read.content.content, { type: "paragraph", content: [{ type: "text", text: "Changed" }] }] };
    await wiki.updateWikiPage.handler({ userId: s.editor.id }, { pageId: page.id, content: document });
    expect(await targetsOf(tx, page.id)).toEqual([s.secret.id]);
    const owner: any = await wiki.getWikiPage.handler({ userId: s.admin.id }, { pageId: page.id });
    expect(owner.contentMarkdown).toContain(secretRef);
    await wiki.updateWikiPage.handler({ userId: s.editor.id }, { pageId: page.id, contentMarkdown: `${owner.contentMarkdown} ${refs("work-item", s.secretTwo.id, "Sneaky")}` });
    expect(await targetsOf(tx, page.id)).not.toContain(s.secretTwo.id);
  });
}, 120_000);
