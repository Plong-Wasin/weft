import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { commentVersions, comments, createDatabase, outlinks, wikiPages, workItems, workItemDescriptionVersions, type Database } from "@weft/db";
import { sql } from "drizzle-orm";
import { createCommentActions, createOutlinkActions, createProjectActions, createWikiActions, createWorkItemActions, writtenFormPoolStats } from "../src";
import * as outlinksModule from "../src/outlinks";
import { configureWrittenFormPool, resetWrittenFormPoolConfig, prepareRichTextGuarded, withWrittenFormKey } from "../src";
import { rebuildPageOutlinks } from "../src/outlinks";

// Read through the namespace so a missing hook fails this test only, not the whole file.
const rebuildPageMarkdownHooks = (outlinksModule as unknown as { rebuildPageMarkdownHooks: { beforeWrite?: (pageId: string) => Promise<void> } }).rebuildPageMarkdownHooks ?? {};
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const owner = await createMemberFactory(transaction, workspace.id, "Admin");
  const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Reads", key: "RD", visibility: "public" });
  const items = createWorkItemActions(transaction);
  const item = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Heavy" });
  return { workspace, owner, items, item };
}

test.serial("30 versions of 150 KB: the list returns the first page at once, pages by cursor, and keeps the event loop free", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, items, item } = await setup(transaction);
    const body = "my\\_var\\_name\\_x and f(x) ".repeat(6_000).slice(0, 150_000);
    for (let index = 0; index < 30; index++) await transaction.insert(workItemDescriptionVersions).values({ workItemId: item.id, contentMarkdown: `${index} ${body}`, contentText: `v${index}`, createdBy: owner.id, createdAt: new Date(Date.now() - index * 1_000) });
    let worstGap = 0, last = performance.now();
    const ticker = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 5);
    const started = performance.now();
    const first = await items.listWorkItemDescriptionVersions.handler({ userId: owner.id }, { workItemId: item.id }) as Array<{ id: string; contentMarkdown: string; content?: unknown }>;
    const elapsed = performance.now() - started;
    clearInterval(ticker);
    // A page stops before its Markdown passes ~1 MB, so 150 KB rows come back a few at a time and the cursor continues.
    expect(first.length).toBeGreaterThanOrEqual(5);
    expect(first.length).toBeLessThanOrEqual(7);
    expect(first[0]!.contentMarkdown.length).toBeGreaterThan(149_000);
    expect(first.every((row) => row.content === undefined)).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
    expect(worstGap).toBeLessThan(250);
    const seen = [...first] as Array<{ id: string }>;
    for (let page = 0; page < 10 && seen.length < 30; page++) seen.push(...await items.listWorkItemDescriptionVersions.handler({ userId: owner.id }, { workItemId: item.id, limit: 100, after: seen.at(-1)!.id }) as Array<{ id: string }>);
    expect(new Set(seen.map((row) => row.id)).size).toBe(30);
    const one = await items.listWorkItemDescriptionVersions.handler({ userId: owner.id }, { workItemId: item.id, versionId: first[3]!.id }) as Array<{ content: unknown }>;
    expect(JSON.stringify(one[0]!.content).length).toBeGreaterThan(100_000);
  });
}, 60_000);

test.serial("get_work_item converts a large stored description in one worker job and returns the stored Markdown as is", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, workspace, items, item } = await setup(transaction);
    const stored = "my\\_var\\_name\\_x and f(x) ".repeat(7_000);
    await transaction.update(workItems).set({ descriptionMarkdown: stored, descriptionText: "x" }).where(eq(workItems.id, item.id));
    const before = (writtenFormPoolStats() as { jobsRun?: number }).jobsRun ?? 0;
    const read = await items.getWorkItem.handler({ userId: owner.id }, { workspaceId: workspace.id, displayId: item.displayId }) as { descriptionMarkdown: string };
    const jobs = ((writtenFormPoolStats() as { jobsRun?: number }).jobsRun ?? 0) - before;
    expect(read.descriptionMarkdown).toBe(stored);
    expect(jobs).toBe(1);
  });
}, 60_000);

test.serial("get_work_item on a stored row too slow to parse shows the stored Markdown, never an escaped copy of it", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, workspace, items, item } = await setup(transaction);
    const stored = "www.a_".repeat(8_000);
    await transaction.update(workItems).set({ descriptionMarkdown: stored, descriptionText: "x" }).where(eq(workItems.id, item.id));
    const read = await items.getWorkItem.handler({ userId: owner.id }, { workspaceId: workspace.id, displayId: item.displayId }) as { descriptionMarkdown: string; description: unknown };
    expect(read.descriptionMarkdown).toBe(stored);
    expect(JSON.stringify(read.description)).toContain("www.a_www.a_");
  });
}, 60_000);

test("a page flagged markdown_stale rebuilds its outlinks from the document, not from the old Markdown", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, owner, item } = await setup(transaction);
    const link = { type: "text", text: "RD-1", marks: [{ type: "link", attrs: { href: `weft://work-item/${item.id}`, kind: "work-item", targetId: item.id, target: "RD-1" } }] };
    const page = await createWikiActions(transaction).createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Stale", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "plain" }] }] } });
    await transaction.update(wikiPages).set({ content: { type: "doc", content: [{ type: "paragraph", content: [link] }] }, contentMarkdown: "old text without links", markdownStale: true, ydocState: null }).where(eq(wikiPages.id, page.id));
    await rebuildPageOutlinks(transaction, page.id, owner.id);
    const rows = await transaction.select().from(outlinks).where(eq(outlinks.sourceId, page.id));
    expect(rows.map((row) => row.targetId)).toEqual([item.id]);
  });
});

test.serial("the description versions cursor skips nothing when rows share a timestamp or differ by microseconds", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, items, item } = await setup(transaction);
    const sameMoment = new Date("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 30; index++) await transaction.insert(workItemDescriptionVersions).values({ workItemId: item.id, contentMarkdown: `same ${index}`, contentText: `same ${index}`, createdBy: owner.id, createdAt: sameMoment });
    for (let index = 0; index < 15; index++) await transaction.execute(sql`insert into work_item_description_versions (work_item_id, content_markdown, content_text, created_by, created_at) values (${item.id}, ${`micro ${index}`}, ${`micro ${index}`}, ${owner.id}, ${`2026-01-02 00:00:00.${String(100 + index).padStart(6, "0")}+00`}::timestamptz)`);
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await items.listWorkItemDescriptionVersions.handler({ userId: owner.id }, { workItemId: item.id, limit: 7, ...(after ? { after } : {}) }) as Array<{ id: string }>;
      if (!rows.length) break;
      seen.push(...rows.map((row) => row.id));
      after = rows.at(-1)!.id;
    }
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
  });
}, 60_000);

test.serial("comment versions are paged (default 20, cursor) and a cursor never skips rows that share a timestamp", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, item } = await setup(transaction);
    const actionsOf = createCommentActions(transaction);
    const comment = await actionsOf.createComment.handler({ userId: owner.id }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] } });
    const sameMoment = new Date("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 25; index++) await transaction.insert(commentVersions).values({ commentId: comment.id, body: { type: "doc", content: [] }, bodyMarkdown: `version ${index}`, bodyText: `version ${index}`, createdAt: sameMoment, writtenAt: sameMoment });
    const first = await actionsOf.listCommentVersions.handler({ userId: owner.id }, { commentId: comment.id }) as Array<{ id: string }>;
    expect(first).toHaveLength(20);
    const second = await actionsOf.listCommentVersions.handler({ userId: owner.id }, { commentId: comment.id, after: first.at(-1)!.id }) as Array<{ id: string }>;
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(25);
  });
}, 60_000);

test.serial("ten stored 190 KB comments and a stored row of a slow shape do not stall the event loop", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, item } = await setup(transaction);
    const actionsOf = createCommentActions(transaction);
    const heavy = "my\\_var\\_name\\_x and f(x) **b** ".repeat(6_500).slice(0, 190_000);
    for (let index = 0; index < 10; index++) {
      const comment = await actionsOf.createComment.handler({ userId: owner.id }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `c${index}` }] }] } });
      await transaction.update(comments).set({ bodyMarkdown: index === 9 ? "\\[\\[".repeat(30_000) : heavy, bodyText: "x" }).where(eq(comments.id, comment.id));
    }
    let worstGap = 0, last = performance.now();
    const ticker = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 5);
    const listed = await actionsOf.listComments.handler({ userId: owner.id }, { workItemId: item.id }) as Array<{ markdown: string }>;
    clearInterval(ticker);
    expect(listed).toHaveLength(10);
    expect(worstGap).toBeLessThan(300);
  });
}, 120_000);

test.serial("rebuild_page_markdown recomputes stale Markdown and Outlinks for one page or all pages of a workspace, and leaves what it cannot convert flagged", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, owner, item } = await setup(transaction);
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const wiki = createWikiActions(transaction);
    const link = { type: "text", text: "RD-1", marks: [{ type: "link", attrs: { href: `weft://work-item/${item.id}`, kind: "work-item", targetId: item.id, target: "RD-1" } }] };
    const make = async (title: string, content: unknown, stale: boolean) => {
      const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "start" }] }] } });
      await transaction.update(wikiPages).set({ content, contentMarkdown: "old text from before the edit", markdownStale: stale, ydocState: null }).where(eq(wikiPages.id, page.id));
      return page;
    };
    const good = await make("Good", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new text " }, link] }] }, true);
    const other = await make("Other", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "second page" }] }] }, true);
    const hopeless = await make("Hopeless", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "word ".repeat(50_000) }] }] }, true);
    const fresh = await make("Fresh", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "not stale" }] }] }, false);
    const actionsOf = createOutlinkActions(transaction);
    await expect(actionsOf.rebuildPageMarkdown.handler({ userId: member.id }, { workspaceId: workspace.id })).rejects.toMatchObject({ status: 403 });
    const one = await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id, pageId: good.id });
    expect(one).toMatchObject({ pagesRebuilt: 1, pagesStillStale: [] });
    const [goodRow] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, good.id));
    expect(goodRow!.markdownStale).toBe(false);
    expect(goodRow!.contentMarkdown).toContain("new text");
    expect(goodRow!.contentMarkdown).not.toContain("old text");
    expect((await transaction.select().from(outlinks).where(eq(outlinks.sourceId, good.id))).map((row) => row.targetId)).toEqual([item.id]);
    const all = await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id });
    expect(all.pagesRebuilt).toBe(1);
    expect(all.pagesStillStale).toEqual([expect.objectContaining({ pageId: hopeless.id })]);
    const [otherRow] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, other.id));
    expect(otherRow).toMatchObject({ markdownStale: false });
    const [hopelessRow] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, hopeless.id));
    expect(hopelessRow!.markdownStale).toBe(true);
    const [freshRow] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, fresh.id));
    expect(freshRow!.contentMarkdown).toBe("old text from before the edit");
  });
}, 120_000);

test.serial("rebuild_page_markdown does at most `limit` pages per call and reports what remains; a page saved again while it converts stays stale and keeps the newer save", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, owner } = await setup(transaction);
    const wiki = createWikiActions(transaction);
    const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: `P${index}`, content: doc("start") });
      await transaction.update(wikiPages).set({ content: doc(`page ${index} text`), contentMarkdown: "", markdownStale: true }).where(eq(wikiPages.id, page.id));
      ids.push(page.id);
    }
    const actionsOf = createOutlinkActions(transaction);
    const first = await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id, limit: 2 });
    expect(first).toMatchObject({ pagesRebuilt: 2, remaining: 3 });
    // The default is 25 per call, so a second call with no limit finishes the rest.
    const rest = await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id });
    expect(rest).toMatchObject({ pagesRebuilt: 3, remaining: 0 });
    // Interleaved write: a live save lands between the conversion and the write of the rebuild.
    const victim = ids[0]!;
    await transaction.update(wikiPages).set({ content: doc("before the save"), contentMarkdown: "", markdownStale: true }).where(eq(wikiPages.id, victim));
    rebuildPageMarkdownHooks.beforeWrite = async (pageId) => {
      if (pageId === victim) await transaction.update(wikiPages).set({ content: doc("the newer live save"), contentMarkdown: "", markdownStale: true }).where(eq(wikiPages.id, victim));
    };
    try {
      const raced = await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id, pageId: victim });
      expect(raced).toMatchObject({ pagesRebuilt: 0, pagesChangedMeanwhile: 1 });
    } finally { rebuildPageMarkdownHooks.beforeWrite = undefined; }
    const [row] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, victim));
    expect(row!.markdownStale).toBe(true);
    expect(row!.contentMarkdown).not.toContain("before the save");
    // The next call converts the newer save.
    const again = await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id, pageId: victim });
    expect(again).toMatchObject({ pagesRebuilt: 1 });
    const [done] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, victim));
    expect(done!.contentMarkdown).toContain("the newer live save");
    expect(done!.markdownStale).toBe(false);
  });
}, 120_000);

test.serial("list_comment_versions stops a page before its Markdown passes about 1 MB, and one request does not parse a hundred 190 KB rows", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, item } = await setup(transaction);
    const actionsOf = createCommentActions(transaction);
    const comment = await actionsOf.createComment.handler({ userId: owner.id }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] } });
    const heavy = "my\\_var\\_name\\_x and f(x) **b** ".repeat(6_500).slice(0, 190_000);
    for (let index = 0; index < 30; index++) await transaction.insert(commentVersions).values({ commentId: comment.id, body: { type: "doc", content: [] }, bodyMarkdown: `${index} ${heavy}`, bodyText: `v${index}`, createdAt: new Date(Date.now() - index * 1_000), writtenAt: new Date() });
    const started = performance.now();
    const first = await actionsOf.listCommentVersions.handler({ userId: owner.id }, { commentId: comment.id, limit: 100 }) as Array<{ id: string; bodyMarkdown: string }>;
    const seconds = (performance.now() - started) / 1000;
    const bytes = first.reduce((sum, row) => sum + row.bodyMarkdown.length, 0);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first.length).toBeLessThan(30);
    expect(bytes).toBeLessThanOrEqual(1_000_000 + 190_100);
    expect(seconds).toBeLessThan(10);
    const seen = [...first];
    for (let page = 0; page < 10 && seen.length < 30; page++) seen.push(...await actionsOf.listCommentVersions.handler({ userId: owner.id }, { commentId: comment.id, limit: 100, after: seen.at(-1)!.id }) as Array<{ id: string; bodyMarkdown: string }>);
    expect(new Set(seen.map((row) => row.id)).size).toBe(30);
  });
}, 120_000);

test.serial("rebuild_page_markdown continues past a page it cannot convert (cursor), and two concurrent rebuilds do not occupy the workers that serve other people's requests", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, owner } = await setup(transaction);
    const wiki = createWikiActions(transaction);
    const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) ids.push((await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: `C${index}`, content: doc("start") })).id);
    ids.sort();
    // The first page in id order cannot be converted; the three behind it can.
    await transaction.update(wikiPages).set({ content: doc("word ".repeat(50_000)), contentMarkdown: "", markdownStale: true }).where(eq(wikiPages.id, ids[0]!));
    for (const id of ids.slice(1)) await transaction.update(wikiPages).set({ content: doc(`fine ${id}`), contentMarkdown: "", markdownStale: true }).where(eq(wikiPages.id, id));
    const actionsOf = createOutlinkActions(transaction);
    const first = await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id, limit: 1 });
    expect(first).toMatchObject({ pagesRebuilt: 0, next: ids[0], remaining: 3 });
    expect(first.pagesStillStale).toEqual([expect.objectContaining({ pageId: ids[0] })]);
    let cursor: string | null = first.next, done = 0;
    for (let call = 0; call < 5 && cursor; call++) {
      const step = await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id, limit: 1, after: cursor });
      done += step.pagesRebuilt;
      cursor = step.next;
    }
    expect(done).toBe(3);
    // With the default limit, the failing page no longer blocks the pages behind it.
    await transaction.update(wikiPages).set({ content: doc("again"), contentMarkdown: "", markdownStale: true }).where(eq(wikiPages.id, ids[3]!));
    expect(await actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id })).toMatchObject({ pagesRebuilt: 1 });

    // Two concurrent rebuilds of dense pages hold the long lane, not the ordinary one.
    configureWrittenFormPool({ timeoutBaseMs: 1_500, timeoutPerKbMs: 0 });
    try {
      for (const id of ids.slice(1)) await transaction.update(wikiPages).set({ content: doc("_a".repeat(95_000)), contentMarkdown: "", markdownStale: true }).where(eq(wikiPages.id, id));
      const rebuilds = [0, 1].map((index) => withWrittenFormKey(`user:admin-${index}`, () => actionsOf.rebuildPageMarkdown.handler({ userId: owner.id }, { workspaceId: workspace.id })));
      await Bun.sleep(200);
      const started = performance.now();
      await withWrittenFormKey("user:bystander", () => prepareRichTextGuarded(undefined, "A normal request. ".repeat(2_000), "body", "bodyMarkdown", {}, "verbatim"));
      expect((performance.now() - started) / 1000).toBeLessThan(2);
      await Promise.allSettled(rebuilds);
    } finally { resetWrittenFormPoolConfig(); }
  });
}, 180_000);
