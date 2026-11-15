import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, wikiPages } from "@weft/db";
import { writtenFormPoolStats, createCommentActions, createPageMarkdownActions, createProjectActions, createWikiActions, createWorkItemActions } from "../src";
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
    const actionsOf = createPageMarkdownActions(tx);
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
