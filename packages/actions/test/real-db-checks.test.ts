import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, wikiPages } from "@weft/db";
import { writtenFormPoolStats, createCommentActions, createOutlinkActions, createProjectActions, createWikiActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

test.serial("rebuild_page_markdown: 25 failing pages and 5 good ones, walked with the `after` cursor, rebuild every good page and list every failing one", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const wiki = createWikiActions(tx);
    const ids: string[] = [];
    for (let index = 0; index < 30; index++) ids.push((await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: `P${index}`, content: doc("start") })).id);
    ids.sort();
    // Every page but every sixth one is good; the failing ones come first in id order and in between.
    const failing = new Set(ids.filter((_, index) => index < 25 ? true : false));
    for (const id of ids) await tx.update(wikiPages).set({ content: doc(failing.has(id) ? "word ".repeat(50_000) : `fine ${id}`), contentMarkdown: "", markdownStale: true }).where(eq(wikiPages.id, id));
    const actionsOf = createOutlinkActions(tx);
    let cursor: string | null | undefined, rebuilt = 0, calls = 0;
    const stillStale = new Set<string>();
    do {
      const step = await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id, limit: 10, ...(cursor ? { after: cursor } : {}) });
      rebuilt += step.pagesRebuilt;
      for (const entry of step.pagesStillStale) stillStale.add(entry.pageId);
      cursor = step.next; calls += 1;
    } while (cursor && calls < 12);
    expect(cursor).toBeNull();
    expect(rebuilt).toBe(5);
    expect([...stillStale].sort()).toEqual([...failing].sort());
    expect(calls).toBeLessThanOrEqual(4);
  });
}, 600_000);

test.serial("Outlinks follow a work item, a comment and a Page through state move, comment delete, Page duplicate, move and delete", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const projects = createProjectActions(tx), items = createWorkItemActions(tx), comments_ = createCommentActions(tx), wiki = createWikiActions(tx);
    const project = await projects.createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Out", key: "OUT", visibility: "public" });
    const other = await projects.createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    const targetA: any = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Target A" });
    const targetB: any = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Target B" });
    const link = (target: any) => `[[${target.title}|work-item:${target.id}]]`;
    const source: any = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Source", descriptionMarkdown: `see ${link(targetA)}` });
    const comment: any = await comments_.createComment.handler({ userId: owner.id }, { workItemId: source.id, bodyMarkdown: `and ${link(targetB)}` });
    const outlinkApi = createOutlinkActions(tx);
    const targets = async (kind: string, id: string) => ((await outlinkApi.listOutlinks.handler({ userId: owner.id }, { kind: kind as never, id })) as Array<{ id: string }>).map((row) => row.id).sort();
    const sorted = (...ids: string[]) => ids.sort();
    expect(await targets("work-item", source.id)).toEqual(sorted(targetA.id, targetB.id));

    const states: any[] = await (createProjectActions(tx) as any).listStates?.handler({ userId: owner.id }, { projectId: project.id }) ?? [];
    if (states.length > 1) await items.moveWorkItem.handler({ userId: owner.id }, { workItemId: source.id, stateId: states.at(-1).id });
    expect(await targets("work-item", source.id)).toEqual(sorted(targetA.id, targetB.id));

    await comments_.deleteComment.handler({ userId: owner.id }, { commentId: comment.id });
    expect(await targets("work-item", source.id)).toEqual([targetA.id]);

    const page: any = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, projectId: project.id, title: "Doc", contentMarkdown: `page links ${link(targetA)}` });
    expect(await targets("page", page.id)).toEqual([targetA.id]);
    const copy: any = await wiki.duplicateWikiPage.handler({ userId: owner.id }, { pageId: page.id });
    expect(await targets("page", copy.id)).toEqual([targetA.id]);
    await wiki.movePageScope.handler({ userId: owner.id }, { pageId: page.id, projectId: other.id });
    expect(await targets("page", page.id)).toEqual([targetA.id]);
    await wiki.deleteWikiPage.handler({ userId: owner.id }, { pageId: page.id });
    // A delete is soft (a restore brings the page back with its links), so the rows stay; what a reader sees no longer lists the deleted page.
    const backlinks = async () => ((await outlinkApi.listBacklinks.handler({ userId: owner.id }, { kind: "work-item", id: targetA.id })) as Array<{ id: string }>).map((row) => row.id).sort();
    expect(await backlinks()).toEqual(sorted(source.id, copy.id));
    expect(await targets("page", copy.id)).toEqual([targetA.id]);

    await items.deleteWorkItem.handler({ userId: owner.id }, { workItemId: source.id });
    expect(await backlinks()).toEqual([copy.id]);
  });
}, 300_000);

test.serial("a Page write of a large Markdown converts it once: one worker job, not two", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const wiki = createWikiActions(tx);
    const page: any = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Big" });
    const text = "**bold** and my_var_name words, a [link](https://example.com/a).\n\n".repeat(2_000).trimEnd();
    const jobs = () => (writtenFormPoolStats() as { jobsRun?: number }).jobsRun ?? 0;
    const before = jobs();
    await wiki.updateWikiPage.handler({ userId: owner.id }, { pageId: page.id, contentMarkdown: text });
    const used = jobs() - before;
    console.log("PAGE-WRITE-JOBS", used);
    expect(used).toBe(1);
  });
}, 120_000);
