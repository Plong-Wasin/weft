import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { comments, createDatabase, projects, workItems, wikiPages, type Database } from "@weft/db";
import { createCommentActions, createProjectActions, createWikiActions, createWorkItemActions } from "../src";
import { backfillRichText } from "../src/migrations/rich-text-backfill";
import { plainTextWrittenForm } from "../src/rich-markdown";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import * as Y from "yjs";
import { plainTextLines } from "./support/plain-text-fuzz";

/** The links of a source are the union of its parts, so a target linked from two parts is one link. */

const { client, db } = createDatabase();
beforeAll(async () => {
  await db.execute(sql`alter table comments alter column body_markdown drop not null`);
  await db.execute(sql`alter table comment_versions alter column body_markdown drop not null`);
});
afterAll(async () => {
  await db.execute(sql`alter table comments alter column body_markdown set not null`);
  await db.execute(sql`alter table comment_versions alter column body_markdown set not null`);
  await client.end();
});

async function seed(transaction: Database, bad = true) {
  await transaction.execute(sql`delete from rich_text_backfill_state where key = 'written-form-v1'`);
  const workspace = await createWorkspaceFactory(transaction);
  const owner = await createMemberFactory(transaction, workspace.id, "Admin");
  const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Migration", key: "MIG", visibility: "public" });
  const target = await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Target" });
  const linkDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "MIG-2", marks: [{ type: "link", attrs: { href: `weft://work-item/${target.id}`, kind: "work-item", targetId: target.id, target: "MIG-2" } }] }] }] };
  const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Old document", description: linkDoc });
  const comment = await createCommentActions(transaction).createComment.handler({ userId: owner.id }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old comment" }] }] } });
  const page = await createWikiActions(transaction).createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Old Yjs", contentMarkdown: `[[MIG-2|work-item:${target.id}]]` });
  const legacyCorpus = ["see https://example.com now", "http://localhost:3000/a?b=c&d=e", "www.x.com", "a@b.c", "mailto:a@b.com", "1. x", "2023. was a year", "&lt;", "+", "[[x]]", "a[[0]]", "[[a|b]]", ...plainTextLines(400, 0xbac)];
  const legacyDoc = { type: "doc", content: [
    { type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "old alignment" }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { backgroundColor: "#ff0000", colwidth: [240] }, content: [{ type: "paragraph", content: [{ type: "text", text: "old cell" }] }] }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "old parent" }] }, { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "old child" }] }] }] }] }] },
    { type: "paragraph", content: [{ type: "text", text: "telephone", marks: [{ type: "link", attrs: { href: "tel:+66812345678" } }] }, { type: "text", text: " and parentheses", marks: [{ type: "link", attrs: { href: "https://example.test/wiki/Foo_(bar)" } }] }] },
    { type: "assetImage", attrs: { assetId: "legacy-asset", width: 320, alignment: "right" } },
    ...legacyCorpus.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    ...linkDoc.content,
  ] };
  await transaction.execute(sql`update work_items set description = ${JSON.stringify(legacyDoc)}::jsonb, description_markdown = null where id = ${item.id}`);
  await transaction.execute(sql`update comments set body = ${bad ? JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "unknownNode" }] }] }) : JSON.stringify(legacyDoc)}::jsonb, body_markdown = null where id = ${comment.id}`);
  const [pageState] = await transaction.select({ state: wikiPages.ydocState }).from(wikiPages).where(eq(wikiPages.id, page.id));
  await transaction.execute(sql`update wiki_pages set content_markdown = '', content = ${JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "stale" }] }] })}::jsonb, ydoc_state = ${bad ? Buffer.from([255]) : pageState!.state} where id = ${page.id}`);
  const noState = await createWikiActions(transaction).createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Legacy JSON only" });
  await transaction.execute(sql`update wiki_pages set content_markdown = '', content = ${JSON.stringify(legacyDoc)}::jsonb, ydoc_state = null where id = ${noState.id}`);
  return { item, comment, page, noState, target, legacyDoc, owner };
}

test("Written form backfill dry run lists all bad rows without writing", async () => {
  await withRollback(db, async (transaction) => {
    const { item, comment, page } = await seed(transaction);
    const report = await backfillRichText(transaction, { dryRun: true });
    expect(report.failures.map(({ table, id }) => `${table}:${id}`).sort()).toEqual([
      `comments:${comment.id}`, `wiki_pages:${page.id}`,
    ]);
    expect(report.counts.workItems).toBe(1);
    expect(report.counts.wikiPages).toBe(1);
    expect((await transaction.select({ markdown: workItems.descriptionMarkdown }).from(workItems).where(eq(workItems.id, item.id)))[0]?.markdown).toBeNull();
    expect((await transaction.select({ markdown: comments.bodyMarkdown }).from(comments).where(eq(comments.id, comment.id)))[0]?.markdown).toBeNull();
    expect((await transaction.select({ markdown: wikiPages.contentMarkdown }).from(wikiPages).where(eq(wikiPages.id, page.id)))[0]?.markdown).toBe("");
  });
});

test("Written form backfill rejects all bad rows before writing any table", async () => {
  await withRollback(db, async (transaction) => {
    const { item, comment, page } = await seed(transaction);
    await expect(backfillRichText(transaction)).rejects.toThrow(new RegExp(`comments ${comment.id}:.+wiki_pages ${page.id}:`, "s"));
    expect((await transaction.select({ markdown: workItems.descriptionMarkdown }).from(workItems).where(eq(workItems.id, item.id)))[0]?.markdown).toBeNull();
    expect((await transaction.select({ markdown: comments.bodyMarkdown }).from(comments).where(eq(comments.id, comment.id)))[0]?.markdown).toBeNull();
    expect((await transaction.select({ markdown: wikiPages.contentMarkdown }).from(wikiPages).where(eq(wikiPages.id, page.id)))[0]?.markdown).toBe("");
  });
});

test("Written form backfill converts legacy docs and Yjs", async () => {
  await withRollback(db, async (transaction) => {
    const { item, comment, page, noState, target, legacyDoc, owner } = await seed(transaction, false);
    const before = await transaction.select({ state: wikiPages.ydocState, content: wikiPages.content }).from(wikiPages).where(eq(wikiPages.id, page.id));
    const oldDescription = (await transaction.select({ description: workItems.description }).from(workItems).where(eq(workItems.id, item.id)))[0]?.description;
    const oldCommentBody = (await transaction.select({ body: comments.body }).from(comments).where(eq(comments.id, comment.id)))[0]?.body;
    const anchorDoc = new Y.Doc();
    Y.applyUpdate(anchorDoc, before[0]!.state!);
    const firstText = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText): Y.XmlText | null => {
      if (node instanceof Y.XmlText) return node;
      for (const child of node.toArray()) if (child instanceof Y.XmlText) return child; else if (child instanceof Y.XmlElement || child instanceof Y.XmlFragment) { const found = firstText(child); if (found) return found; }
      return null;
    };
    const anchorText = firstText(anchorDoc.getXmlFragment("default"))!;
    const anchorExpected = anchorText.toString().slice(0, Math.min(3, anchorText.length));
    const relativeStart = Y.createRelativePositionFromTypeIndex(anchorText, 0);
    const relativeEnd = Y.createRelativePositionFromTypeIndex(anchorText, Math.min(3, anchorText.length));
    const anchor = Buffer.from(JSON.stringify([Array.from(Y.encodeRelativePosition(relativeStart)), Array.from(Y.encodeRelativePosition(relativeEnd))])).toString("base64");
    anchorDoc.destroy();
    const wiki = createWikiActions(transaction);
    await wiki.createWikiPageComment.handler({ userId: owner.id }, { pageId: page.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Anchored" }] }] }, anchor });
    const report = await backfillRichText(transaction);
    expect(report.failures).toEqual([]);
    expect(report.counts).toMatchObject({ workItems: 1, comments: 1, wikiPages: 2, wikiPageVersions: 1 });
    expect(report.warnings.filter(({ id }) => id === item.id).map(({ code, message }) => `${code}:${message}`)).toEqual(expect.arrayContaining([
      expect.stringContaining("text alignment"), expect.stringContaining("table cell colour"), expect.stringContaining("table column width"), expect.stringContaining("image width"), expect.stringContaining("image alignment"),
    ]));
    const migratedDescription = (await transaction.select({ markdown: workItems.descriptionMarkdown }).from(workItems).where(eq(workItems.id, item.id)))[0]?.markdown ?? "";
    expect(migratedDescription).toContain(`work-item:${target.id}`);
    expect(migratedDescription).toContain("- [x] old parent\n  - [ ] old child");
    expect(migratedDescription).toContain("[telephone](tel:+66812345678)");
    expect((await transaction.select({ markdown: comments.bodyMarkdown }).from(comments).where(eq(comments.id, comment.id)))[0]?.markdown).toContain("[telephone](tel:+66812345678)");
    expect((await transaction.select({ body: comments.body }).from(comments).where(eq(comments.id, comment.id)))[0]?.body).toEqual(oldCommentBody);
    expect((await transaction.select({ description: workItems.description }).from(workItems).where(eq(workItems.id, item.id)))[0]?.description).toEqual(oldDescription);
    expect((await transaction.select({ markdown: wikiPages.contentMarkdown }).from(wikiPages).where(eq(wikiPages.id, page.id)))[0]?.markdown).toContain(`work-item:${target.id}`);
    const after = await transaction.select({ state: wikiPages.ydocState, content: wikiPages.content, markdown: wikiPages.contentMarkdown }).from(wikiPages).where(eq(wikiPages.id, page.id));
    expect(after[0]?.state).toEqual(before[0]?.state);
    expect(after[0]?.content).toEqual(before[0]?.content);
    expect(await transaction.select({ state: wikiPages.ydocState, content: wikiPages.content }).from(wikiPages).where(eq(wikiPages.id, noState.id))).toMatchObject([{ state: null, content: legacyDoc }]);
    const afterAnchorDoc = new Y.Doc();
    Y.applyUpdate(afterAnchorDoc, after[0]!.state!);
    const [startBytes, endBytes] = JSON.parse(Buffer.from(anchor, "base64").toString()) as [number[], number[]];
    const absoluteStart = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(new Uint8Array(startBytes)), afterAnchorDoc);
    const absoluteEnd = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(new Uint8Array(endBytes)), afterAnchorDoc);
    expect(absoluteStart).not.toBeNull();
    expect(absoluteEnd).not.toBeNull();
    expect((absoluteStart!.type as Y.XmlText).toString().slice(absoluteStart!.index, absoluteEnd!.index)).toBe(anchorExpected);
    afterAnchorDoc.destroy();
    expect((await wiki.listWikiPageComments.handler({ userId: owner.id }, { pageId: page.id }))[0]?.anchor).toBe(anchor);
    const [{ workspaceId }] = await transaction.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, item.projectId));
    const rereadItem: any = await createWorkItemActions(transaction).getWorkItem.handler({ userId: owner.id }, { workspaceId, displayId: item.displayId });
    expect(rereadItem.descriptionText).toContain("see https://example.com now");
    const rereadComment: any = (await createCommentActions(transaction).listComments.handler({ userId: owner.id }, { workItemId: item.id })).find((row) => row.id === comment.id);
    expect(rereadComment.bodyText).toContain("see https://example.com now");
    const rereadNoState: any = await wiki.getWikiPage.handler({ userId: owner.id }, { pageId: noState.id });
    expect(rereadNoState.contentText).toContain("see https://example.com now");
    expect(rereadNoState.contentText).not.toContain("stale");
    const rerun = await backfillRichText(transaction);
    expect(Object.values(rerun.counts).every((count) => count === 0)).toBe(true);
  });
});

test("the backfill takes its ALTER TABLE locks as the very last statements of the transaction, and reads in batches", async () => {
  await withRollback(db, async (transaction) => {
    await seed(transaction, false);
    const log: string[] = [];
    let selects = 0;
    const recording = new Proxy(transaction, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || !["execute", "update", "insert", "select", "delete"].includes(String(property))) return value;
      return (...args: unknown[]) => {
        if (property === "execute") { const text = JSON.stringify((args[0] as { queryChunks?: unknown[] })?.queryChunks ?? args[0]); log.push(/alter table/i.test(text) ? "alter" : "execute"); } else log.push(String(property));
        if (property === "select") selects++;
        return value.apply(target, args);
      };
    } }) as Database;
    let transactionStart = -1, transactionEnd = -1;
    const report = await backfillRichText(recording, { batchSize: 2, withTransaction: async (run) => { transactionStart = log.length; try { return await run(recording); } finally { transactionEnd = log.length; } } });
    expect(report.failures).toEqual([]);
    expect(log.filter((entry) => entry === "alter")).toHaveLength(2);
    // Inside the write transaction the ALTER TABLE statements are the last two.
    expect(log.slice(transactionStart, transactionEnd).slice(-2)).toEqual(["alter", "alter"]);
    expect(log.indexOf("alter")).toBe(transactionEnd - 2);
    expect(selects).toBeGreaterThan(12);
  });
});

test("the 400-line token corpus converts through the backfill with no refusal and the text intact", async () => {
  await withRollback(db, async (transaction) => {
    const { item } = await seed(transaction, false);
    const report = await backfillRichText(transaction);
    expect(report.failures).toEqual([]);
    const [row] = await transaction.select({ markdown: workItems.descriptionMarkdown, text: workItems.descriptionText }).from(workItems).where(eq(workItems.id, item.id));
    const { markdownToDoc } = await import("../src/markdown-doc");
    const { richTextTextContent } = await import("../src/rich-markdown");
    const restored = markdownToDoc(row!.markdown!, { preserveUnresolvedReferences: true, preserveStableReferences: true, trustedSource: true });
    const stored = richTextTextContent(restored).map((part) => part.kind === "text" ? part.text : "").join(" ");
    for (const line of plainTextLines(400, 0xbac).slice(0, 40)) expect(stored.replace(/\s+/g, " ")).toContain(line.trim().split(/\s+/).join(" ").slice(0, 12));
  });
});

const paragraphOf = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("a legacy description whose Written form passes the write cap is stored IN FULL (never truncated), keeps serving its legacy document, and its first editor save is refused with a clear message", async () => {
  await withRollback(db, async (transaction) => {
    const { item, owner } = await seed(transaction, false);
    const line = "*a* [b] *c* [d] ".repeat(2);
    const heavy = { type: "doc", content: Array.from({ length: Math.floor(150_000 / line.length) }, () => paragraphOf(line)) };
    await transaction.execute(sql`update work_items set description = ${JSON.stringify(heavy)}::jsonb, description_markdown = null, description_doc = null where id = ${item.id}`);
    const report = await backfillRichText(transaction);
    expect(report.failures).toEqual([]);
    // The escaped form of the document passes the 200,000-character write cap: the cap applies to new writes, not to existing data. The row is stored in full and listed.
    expect(report.degraded).toEqual([expect.objectContaining({ table: "work_items", id: item.id, reason: expect.stringContaining("input-too-long") })]);
    const [row] = await transaction.select({ markdown: workItems.descriptionMarkdown, doc: workItems.descriptionDoc }).from(workItems).where(eq(workItems.id, item.id));
    const expected = plainTextWrittenForm({ type: "doc", content: heavy.content.map((block) => ({ type: "paragraph", content: [{ type: "text", text: line }] })) });
    expect(expected.length).toBeGreaterThan(200_000);
    expect(row!.markdown).toBe(expected);
    expect(row!.doc).toBeNull();
    const read: any = await createWorkItemActions(transaction).getWorkItem.handler({ userId: owner.id }, { workspaceId: (await transaction.select({ id: projects.workspaceId }).from(projects).limit(1))[0]!.id, displayId: item.displayId });
    expect(read.description.content).toHaveLength(heavy.content.length);
    expect(read.description.content[0].content[0].text).toBe(line);
    // The first editor save sends the legacy document back: refused with the limit and the current length, never a silent cut.
    await expect(createWorkItemActions(transaction).updateWorkItem.handler({ userId: owner.id }, { workItemId: item.id, description: { ...read.description, content: [...read.description.content, paragraphOf("an edit")] } })).rejects.toMatchObject({ status: 400, code: "input-too-long", message: expect.stringMatching(/200,000.*[\d,]{7}/s) });
  });
}, 120_000);

test("a 1,200,000-character legacy description keeps its Markdown empty, is listed as too-large-to-convert, and its legacy document serves", async () => {
  await withRollback(db, async (transaction) => {
    const { item, owner } = await seed(transaction, false);
    const line = "word_one and (two) [three] ".repeat(4);
    const huge = { type: "doc", content: Array.from({ length: Math.floor(1_200_000 / line.length) }, () => paragraphOf(line)) };
    await transaction.execute(sql`update work_items set description = ${JSON.stringify(huge)}::jsonb, description_markdown = null, description_doc = null where id = ${item.id}`);
    const report = await backfillRichText(transaction);
    expect(report.failures).toEqual([]);
    expect(report.degraded).toEqual([expect.objectContaining({ table: "work_items", id: item.id, reason: expect.stringContaining("too-large-to-convert") })]);
    const [row] = await transaction.select({ markdown: workItems.descriptionMarkdown, description: workItems.description }).from(workItems).where(eq(workItems.id, item.id));
    expect(row!.markdown).toBeNull();
    expect(row!.description).toEqual(huge);
    const read: any = await createWorkItemActions(transaction).getWorkItem.handler({ userId: owner.id }, { workspaceId: (await transaction.select({ id: projects.workspaceId }).from(projects).limit(1))[0]!.id, displayId: item.displayId });
    expect(read.description.content).toHaveLength(huge.content.length);
    expect(read.description.content[10].content[0].text).toBe(line);
  });
}, 180_000);

test("a row the converter cannot finish in time is stored as plain text, listed in the report, and keeps its legacy columns", async () => {
  await withRollback(db, async (transaction) => {
    const { item } = await seed(transaction, false);
    const hostile = { type: "doc", content: [paragraphOf("[[".repeat(30_000))] };
    await transaction.execute(sql`update work_items set description = ${JSON.stringify(hostile)}::jsonb, description_markdown = null where id = ${item.id}`);
    const report = await backfillRichText(transaction, { rowTimeoutMs: 400 });
    expect(report.failures).toEqual([]);
    expect(report.degraded).toEqual([expect.objectContaining({ table: "work_items", id: item.id, reason: expect.stringContaining("input-too-complex") })]);
    const [row] = await transaction.select({ markdown: workItems.descriptionMarkdown, description: workItems.description, text: workItems.descriptionText }).from(workItems).where(eq(workItems.id, item.id));
    expect(row!.markdown).not.toBeNull();
    expect(row!.text).toContain("[[[[");
    expect(row!.description).toEqual(hostile);
  });
}, 60_000);

test("a concurrent edit made while the backfill converts is never overwritten by the stale conversion", async () => {
  await withRollback(db, async (transaction) => {
    const { item } = await seed(transaction, false);
    const report = await backfillRichText(transaction, { beforeWrite: async () => { await transaction.execute(sql`update work_items set description_markdown = 'edited while converting', description_text = 'edited while converting' where id = ${item.id}`); } });
    expect(report.failures).toEqual([]);
    const [row] = await transaction.select({ markdown: workItems.descriptionMarkdown }).from(workItems).where(eq(workItems.id, item.id));
    expect(row!.markdown).toBe("edited while converting");
  });
}, 60_000);

test("many slow rows convert outside the transaction: the write transaction stays short and the report gives total time and the listed rows", async () => {
  await withRollback(db, async (transaction) => {
    const { item, owner } = await seed(transaction, false);
    const hostile = { type: "doc", content: [paragraphOf("[[".repeat(30_000))] };
    const ids = [item.id];
    for (let index = 0; index < 7; index++) ids.push((await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: item.projectId, title: `Slow ${index}` })).id);
    for (const id of ids) await transaction.execute(sql`update work_items set description = ${JSON.stringify(hostile)}::jsonb, description_markdown = null where id = ${id}`);
    let transactionMs = 0;
    const report = await backfillRichText(transaction, { rowTimeoutMs: 300, withTransaction: async (run) => { const started = performance.now(); try { return await run(transaction); } finally { transactionMs = performance.now() - started; } } });
    expect(report.failures).toEqual([]);
    expect(report.degraded.filter(({ table }) => table === "work_items").length).toBe(8);
    expect(report.rows).toBeGreaterThanOrEqual(8);
    // Eight rows at 300 ms each is conversion time; none of it is spent holding the write transaction.
    expect(report.seconds).toBeGreaterThan(2);
    expect(transactionMs).toBeLessThan(1_500);
    expect(report.writeSeconds).toBeLessThan(1.5);
  });
}, 60_000);
