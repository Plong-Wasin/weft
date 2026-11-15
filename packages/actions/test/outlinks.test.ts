import { afterAll, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { comments as commentsTable, createDatabase, outlinks, projectMembers, workItems } from "@weft/db";
import { createCommentActions, createProjectActions, createWikiActions, createWorkItemActions, workItemMarkdownOptions } from "../src";
import { createOutlinkActions, referencesInWrittenForm, setOutlinkPart } from "../src/outlinks";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

/** The links of a source are the union of its parts, so a target linked from two parts is one link. */
const distinctTargets = <T extends { targetKind: string; targetId: string }>(rows: T[]) => [...new Map(rows.map((row) => [`${row.targetKind}:${row.targetId}`, row])).values()];

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("0106 backfills legacy links with project Page and workspace Wiki target kinds", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const project = await createProjectActions(tx).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Source" });
    const wiki = createWikiActions(tx);
    const projectPage = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, projectId: project.id, title: "Project page" });
    const wikiPage = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, title: "Workspace page" });
    await wiki.linkWorkItemPage.handler({ userId: admin.id }, { workItemId: item.id, pageId: projectPage.id });
    await wiki.linkWorkItemPage.handler({ userId: admin.id }, { workItemId: item.id, pageId: wikiPage.id });
    await tx.delete(outlinks);
    const migration = await readFile(new URL("../../db/migrations/0106_outlinks.sql", import.meta.url), "utf8");
    const insert = migration.match(/INSERT INTO outlinks[\s\S]*?;/i)?.[0];
    expect(insert).toBeDefined();
    await tx.execute(sql.raw(insert!));
    expect((await tx.select({ kind: outlinks.targetKind, id: outlinks.targetId }).from(outlinks).where(eq(outlinks.sourceId, item.id))).sort((a, b) => a.kind.localeCompare(b.kind)))
      .toEqual([{ kind: "page", id: projectPage.id }, { kind: "wiki", id: wikiPage.id }]);
  });
});

test("written form references retain stable target ids and ignore ordinary links", () => {
  expect(referencesInWrittenForm("See [[MOB-12|work-item:00000000-0000-0000-0000-000000000012]] and [[Roadmap|wiki:00000000-0000-0000-0000-000000000013]]. [site](https://example.com)"))
    .toEqual([
      { kind: "work-item", id: "00000000-0000-0000-0000-000000000012" },
      { kind: "wiki", id: "00000000-0000-0000-0000-000000000013" },
    ]);
});

test("references inside inline code and fenced code are not outlinks", () => {
  const id = (n: number) => `00000000-0000-0000-0000-0000000000${n}`;
  const markdown = [`real [[A|page:${id(10)}]]`, `inline \`[[B|page:${id(11)}]]\` code`, "```\n[[C|page:" + id(12) + "]]\n```", `~~~md\n[[E|wiki:${id(14)}]]\n~~~`].join("\n\n");
  expect(referencesInWrittenForm(markdown)).toEqual([{ kind: "page", id: id(10) }]);
});

test("duplicate references produce a single outlink", () => {
  expect(referencesInWrittenForm("[[A|page:00000000-0000-0000-0000-000000000001]] [[A|page:00000000-0000-0000-0000-000000000001]]"))
    .toEqual([{ kind: "page", id: "00000000-0000-0000-0000-000000000001" }]);
});

test("reference resolution preloads only work item titles and keys named in the Markdown", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const project = await createProjectActions(tx).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
    const work = createWorkItemActions(tx);
    const mentioned = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Mentioned title" });
    await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Unmentioned title" });
    const options = await workItemMarkdownOptions(tx, admin.id, workspace.id, project.id, "See [[Mentioned title]] and [[MOB-1]]");
    expect(options.resolveReference?.("Mentioned title")).toMatchObject({ id: mentioned.id });
    expect(options.resolveReference?.("MOB-1")).toMatchObject({ id: mentioned.id });
    expect(options.resolveReference?.("Unmentioned title")).toBeNull();
  });
});

test("concurrent Outlink rebuilds do not fail or create duplicate rows", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const project = await createProjectActions(tx).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
    const work = createWorkItemActions(tx);
    const target = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Target" });
    const source = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Source" });
    await expect(Promise.all(Array.from({ length: 8 }, () => setOutlinkPart(db, "work-item", source.id, "body", [{ kind: "work-item", id: target.id }])))).resolves.toHaveLength(8);
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, source.id))).toMatchObject([{ targetId: target.id }]);
  });
});

test("an Admin can rebuild deleted Outlink rows from current Written forms", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const member = await createMemberFactory(tx, workspace.id, "Member");
    const project = await createProjectActions(tx).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
    const work = createWorkItemActions(tx);
    const target = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Target" });
    const source = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Source", descriptionMarkdown: `[[MOB-1|work-item:${target.id}]]` });
    await tx.delete(outlinks).where(eq(outlinks.sourceId, source.id));
    const actions = createOutlinkActions(tx);
    await expect(actions.rebuildOutlinks.handler({ userId: member.id }, { workspaceId: workspace.id })).rejects.toMatchObject({ status: 403 });
    expect(await actions.rebuildOutlinks.handler({ userId: admin.id }, { workspaceId: workspace.id })).toEqual({ sourcesRebuilt: 2, linksRebuilt: 1 });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, source.id))).toMatchObject([
      { sourceKind: "work-item", sourceId: source.id, targetKind: "work-item", targetId: target.id },
    ]);
  });
});

test("description, Page, and Wiki page saves record links and remove them when text changes", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const project = await createProjectActions(tx).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
    const work = createWorkItemActions(tx);
    const target = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Target" });
    const source = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Source", descriptionMarkdown: `[[MOB-1|work-item:${target.id}]]` });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, source.id))).toMatchObject([{ targetId: target.id }]);
    await work.updateWorkItem.handler({ userId: admin.id }, { workItemId: source.id, descriptionMarkdown: "Reference removed" });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, source.id))).toEqual([]);

    const wiki = createWikiActions(tx);
    const projectPage = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, projectId: project.id, title: "Project page", contentMarkdown: `[[MOB-1|work-item:${target.id}]]` });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, projectPage.id))).toMatchObject([{ sourceKind: "page", targetId: target.id }]);
    await wiki.updateWikiPage.handler({ userId: admin.id }, { pageId: projectPage.id, contentMarkdown: "Reference removed" });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, projectPage.id))).toEqual([]);

    const wikiPage = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, title: "Wiki page", contentMarkdown: `[[MOB-1|work-item:${target.id}]]` });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, wikiPage.id))).toMatchObject([{ sourceKind: "wiki", targetId: target.id }]);
    await wiki.updateWikiPage.handler({ userId: admin.id }, { pageId: wikiPage.id, contentMarkdown: "Reference removed" });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, wikiPage.id))).toEqual([]);
  });
});

test("Outlinks and Backlinks omit sources and targets the viewer cannot open", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const outsider = await createMemberFactory(tx, workspace.id, "Member");
    const projects = createProjectActions(tx);
    const publicProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Public", key: "PUB", visibility: "public" });
    const privateProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
    const work = createWorkItemActions(tx);
    const publicItem = await work.createWorkItem.handler({ userId: admin.id }, { projectId: publicProject.id, title: "Visible" });
    const privateSource = await work.createWorkItem.handler({ userId: admin.id }, { projectId: privateProject.id, title: "Hidden source", descriptionMarkdown: `[[PUB-1|work-item:${publicItem.id}]]` });
    const wiki = createWikiActions(tx);
    const privateCollection = await wiki.createCollection.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret collection", visibility: "private" });
    const hiddenWikiPage = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, collectionId: privateCollection.id, title: "Hidden wiki source", contentMarkdown: `[[PUB-1|work-item:${publicItem.id}]]` });
    const hiddenProjectPage = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, projectId: privateProject.id, title: "Hidden project source", contentMarkdown: `[[PUB-1|work-item:${publicItem.id}]]` });
    const actions = createOutlinkActions(tx);
    expect(await actions.listBacklinks.handler({ userId: outsider.id }, { kind: "work-item", id: publicItem.id })).toEqual([]);
    await expect(actions.listOutlinks.handler({ userId: outsider.id }, { kind: "work-item", id: privateSource.id })).rejects.toMatchObject({ status: 404 });
    await expect(actions.listOutlinks.handler({ userId: outsider.id }, { kind: "wiki", id: hiddenWikiPage.id })).rejects.toMatchObject({ status: 404 });
    await expect(actions.listOutlinks.handler({ userId: outsider.id }, { kind: "page", id: hiddenProjectPage.id })).rejects.toMatchObject({ status: 404 });
  });
});

test("listing Outlinks uses a bounded number of target queries by kind", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const project = await createProjectActions(tx).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
    const work = createWorkItemActions(tx);
    const source = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Source" });
    const targets = await Promise.all(Array.from({ length: 8 }, (_, index) => work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: `Target ${index}` })));
    const wiki = createWikiActions(tx);
    const pages = await Promise.all(Array.from({ length: 4 }, (_, index) => wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, projectId: project.id, title: `Page ${index}` })));
    const wikiPages = await Promise.all(Array.from({ length: 4 }, (_, index) => wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, title: `Wiki ${index}` })));
    await tx.insert(outlinks).values([
      ...targets.map((target) => ({ sourceKind: "work-item" as const, sourceId: source.id, targetKind: "work-item" as const, targetId: target.id })),
      ...pages.map((target) => ({ sourceKind: "work-item" as const, sourceId: source.id, targetKind: "page" as const, targetId: target.id })),
      ...wikiPages.map((target) => ({ sourceKind: "work-item" as const, sourceId: source.id, targetKind: "wiki" as const, targetId: target.id })),
    ]);
    const select = spyOn(tx, "select");
    try {
      expect(await createOutlinkActions(tx).listOutlinks.handler({ userId: admin.id }, { kind: "work-item", id: source.id })).toHaveLength(16);
      // The source query is a selectDistinct (a target linked from several parts is one link), which this spy on `select` does not count.
      expect(select).toHaveBeenCalledTimes(8);
    } finally { select.mockRestore(); }
  });
});

test("editing descriptions, comments, and Pages keeps hidden stable references intact", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const editor = await createMemberFactory(tx, workspace.id, "Member");
    const projects = createProjectActions(tx);
    const publicProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Public", key: "PUB", visibility: "public" });
    const privateProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Private", key: "SEC", visibility: "private" });
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: publicProject.id, userId: editor.id, role: "Member" });
    const work = createWorkItemActions(tx);
    const hidden = await work.createWorkItem.handler({ userId: admin.id }, { projectId: privateProject.id, title: "Hidden target" });
    const reference = `[[Hidden|work-item:${hidden.id}]]`;
    const source = await work.createWorkItem.handler({ userId: admin.id }, { projectId: publicProject.id, title: "Public source", descriptionMarkdown: `See ${reference}\n\nOther text` });
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: privateProject.id, userId: editor.id, role: "Member" });
    const comments = createCommentActions(tx);
    const comment = await comments.createComment.handler({ userId: editor.id }, { workItemId: source.id, bodyMarkdown: `See ${reference}\n\nOther comment text` });
    await tx.delete(projectMembers).where(eq(projectMembers.projectId, privateProject.id));
    const wiki = createWikiActions(tx);
    const sourcePage = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, projectId: publicProject.id, title: "Public page", contentMarkdown: `See ${reference}\n\nOther page text` });

    const addVisibleParagraph = (document: any, text: string) => ({ ...document, content: [...document.content, { type: "paragraph", content: [{ type: "text", text }] }] });
    const itemRead: any = await work.getWorkItem.handler({ userId: editor.id }, { workspaceId: workspace.id, displayId: source.displayId });
    expect(itemRead.description.content[0].content.find((node: any) => node.marks)?.marks[0].attrs.unavailable).toBe(true);
    await work.updateWorkItem.handler({ userId: editor.id }, { workItemId: source.id, description: addVisibleParagraph(itemRead.description, "Changed visible sentence") });
    const commentRead: any = (await comments.listComments.handler({ userId: editor.id }, { workItemId: source.id })).find((row) => row.id === comment.id)!;
    expect(commentRead.body.content[0].content.find((node: any) => node.marks)?.marks[0].attrs.unavailable).toBe(true);
    await comments.updateComment.handler({ userId: editor.id }, { commentId: comment.id, body: addVisibleParagraph(commentRead.body, "Changed comment sentence") });
    const pageRead = await wiki.getWikiPage.handler({ userId: editor.id }, { pageId: sourcePage.id });
    expect(pageRead.content.content[0].content.find((node: any) => node.marks)?.marks[0].attrs.unavailable).toBe(true);
    await wiki.updateWikiPage.handler({ userId: editor.id }, { pageId: sourcePage.id, content: addVisibleParagraph(pageRead.content, "Changed page sentence") });

    for (const id of [source.id, sourcePage.id]) expect(distinctTargets(await tx.select().from(outlinks).where(eq(outlinks.sourceId, id)))).toMatchObject([{ targetKind: "work-item", targetId: hidden.id }]);
    expect((await tx.select().from(outlinks).where(eq(outlinks.sourceId, source.id))).some((row) => row.targetId === hidden.id)).toBe(true);
    expect((await tx.select({ markdown: workItems.descriptionMarkdown }).from(workItems).where(eq(workItems.id, source.id)))[0]?.markdown).toContain(reference);
    expect((await tx.select({ markdown: commentsTable.bodyMarkdown }).from(commentsTable).where(eq(commentsTable.id, comment.id)))[0]?.markdown).toContain(reference);
    const ownerItem: any = await work.getWorkItem.handler({ userId: admin.id }, { workspaceId: workspace.id, displayId: source.displayId });
    expect(ownerItem.descriptionMarkdown).toContain(reference);
    expect(ownerItem.description.content[0].content.find((node: any) => node.marks)?.marks[0].attrs.targetId).toBe(hidden.id);
    const ownerPage = await wiki.getWikiPage.handler({ userId: admin.id }, { pageId: sourcePage.id });
    expect(ownerPage.contentMarkdown).toContain(reference);
    expect(ownerPage.content.content[0].content.find((node: any) => node.marks)?.marks[0].attrs.targetId).toBe(hidden.id);
    await work.updateWorkItem.handler({ userId: editor.id }, { workItemId: source.id, description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Reference removed" }] }] } });
    await comments.updateComment.handler({ userId: editor.id }, { commentId: comment.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Comment reference removed" }] }] } });
    expect(await tx.select().from(outlinks).where(and(eq(outlinks.sourceId, source.id), eq(outlinks.targetId, hidden.id)))).toHaveLength(0);
  });
});
