import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { comments, createDatabase, workItems, wikiPages, workItemDescriptionVersions, type Database } from "@weft/db";
import { createCommentActions, createIntakeActions, createProjectActions, createWikiActions, createWorkItemActions, prepareRichText, prepareRichTextGuarded, richTextTextContent } from "../src";
import { storedMarkdownToDoc } from "../src/markdown-doc";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
/** Six text shapes whose Written form is longer than the text: escapes, links and marks. */
const shapes: Record<string, (index: number) => unknown> = {
  "snake_case": (i) => paragraph(`my_var_name_${i} other_snake_word `.repeat(4)),
  "f(x) calls": (i) => paragraph(`f(x${i}) g(y) [z] `.repeat(8)),
  "plain words": (i) => paragraph(`plain words number ${i} and more words `.repeat(4)),
  "bold words": (i) => ({ type: "paragraph", content: [{ type: "text", text: `bold ${i}`, marks: [{ type: "bold" }] }, { type: "text", text: " then plain text and more text " }] }),
  "links": (i) => ({ type: "paragraph", content: [{ type: "text", text: `link ${i}`, marks: [{ type: "link", attrs: { href: `https://example.test/${i}` } }] }, { type: "text", text: " tail text " }] }),
  "mixed punctuation": (i) => paragraph(`a_b*c ~d~ <e> & ${i} # x | y `.repeat(6)),
};
const documentOf = (shape: string, bytes: number) => {
  const content: unknown[] = [];
  let size = 0;
  for (let index = 0; size < bytes; index++) { const block = shapes[shape]!(index); content.push(block); size += JSON.stringify(block).length * 0.6; }
  return { type: "doc", content };
};

test("invariant: for 150/190/200 KB of every text shape a write is either refused as input-too-long or reads back the same text, never blank", () => {
  for (const shape of Object.keys(shapes)) for (const kb of [150, 190, 200]) {
    const document = documentOf(shape, kb * 1024);
    let markdown: string | null = null;
    try { markdown = prepareRichText(document, undefined, "c", "m", {}, "derived").markdown; }
    catch (error) { expect({ shape, kb, code: (error as { code?: string }).code }).toEqual({ shape, kb, code: "input-too-long" }); }
    if (markdown === null) continue;
    expect({ shape, kb, within: markdown.length <= 200_000 }).toEqual({ shape, kb, within: true });
    const back = storedMarkdownToDoc(markdown, { preserveStableReferences: true, preserveUnresolvedReferences: true });
    expect(richTextTextContent(back), `${shape} ${kb}`).toEqual(richTextTextContent(document));
  }
}, 120_000);

test("a write whose serialised form would exceed the cap is refused with input-too-long, and the plain text degrade obeys the same cap", () => {
  const document = documentOf("snake_case", 240 * 1024);
  expect(() => prepareRichText(document, undefined, "c", "m", {}, "derived")).toThrow(/too long/);
});

test("stored rows longer than the old read cap are read whole through every read path, never as a blank document", async () => {
  await withRollback(db, async (transaction: Database) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Cap", key: "CAP", visibility: "public" });
    const items = createWorkItemActions(transaction);
    const wiki = createWikiActions(transaction);
    const stored = "my\\_var\\_name\\_x ".repeat(14_500);
    expect(stored.length).toBeGreaterThan(230_000);
    const expectedText = "my_var_name_x ".repeat(14_500).trim();
    const item = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Big" });
    await transaction.update(workItems).set({ descriptionMarkdown: stored, descriptionText: expectedText }).where(eq(workItems.id, item.id));
    const read = await items.getWorkItem.handler({ userId: owner.id }, { workspaceId: workspace.id, displayId: item.displayId }) as { description: unknown; descriptionMarkdown: string; descriptionText: string };
    const textOf = (document: unknown) => richTextTextContent(document).map((part) => part.kind === "text" ? part.text : "").join("");
    expect(textOf(read.description).replace(/\s+/g, " ").trim()).toBe(expectedText);
    expect(read.descriptionMarkdown.length).toBeGreaterThan(200_000);
    await transaction.insert(workItemDescriptionVersions).values({ workItemId: item.id, contentMarkdown: stored, contentText: expectedText, createdBy: owner.id });
    const versions = await items.listWorkItemDescriptionVersions.handler({ userId: owner.id }, { workItemId: item.id }) as Array<{ id: string; contentMarkdown: string; content?: unknown }>;
    expect(versions[0]!.contentMarkdown.length).toBeGreaterThan(200_000);
    expect(versions[0]!.content).toBeUndefined();
    const single = await items.listWorkItemDescriptionVersions.handler({ userId: owner.id }, { workItemId: item.id, versionId: versions[0]!.id }) as Array<{ content: unknown }>;
    expect(textOf(single[0]!.content).replace(/\s+/g, " ").trim()).toBe(expectedText);

    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Big page", content: { type: "doc", content: [paragraph("x")] } });
    await transaction.update(wikiPages).set({ ydocState: null, contentMarkdown: stored, content: { type: "doc", content: [paragraph("stale")] } }).where(eq(wikiPages.id, page.id));
    const pageRead = await wiki.getWikiPage.handler({ userId: owner.id }, { pageId: page.id });
    expect(textOf(pageRead.content).replace(/\s+/g, " ").trim()).toBe(expectedText);

    const comment = await createCommentActions(transaction).createComment.handler({ userId: owner.id }, { workItemId: item.id, body: { type: "doc", content: [paragraph("x")] } });
    // The comment document is the cache of its Markdown (ADR 0012), so a long row has both: the long document is what is served.
    await transaction.update(comments).set({ body: { type: "doc", content: [paragraph(expectedText)] }, bodyMarkdown: stored, bodyText: expectedText }).where(eq(comments.id, comment.id));
    const listed = await createCommentActions(transaction).listComments.handler({ userId: owner.id }, { workItemId: item.id }) as Array<{ body: unknown }>;
    expect(textOf(listed[0]!.body).replace(/\s+/g, " ").trim().length).toBeGreaterThan(100_000);

    const intake = await createIntakeActions(transaction).submitIntakeItem.handler({ userId: owner.id }, { projectId: project.id, title: "Intake" }) as { workItemId: string };
    await transaction.update(workItems).set({ descriptionMarkdown: stored }).where(eq(workItems.id, intake.workItemId));
    const rows = await createIntakeActions(transaction).listIntakeItems.handler({ userId: owner.id }, { projectId: project.id, outcome: "pending" } as never) as Array<{ descriptionMarkdown: string }>;
    expect(rows[0]?.descriptionMarkdown.length).toBeGreaterThan(200_000);
  });
}, 120_000);

test("the over-cap refusal names the limit, says special characters take extra room, and gives the current length", () => {
  const document = { type: "doc", content: [paragraph("*a ".repeat(65_000))] };
  let thrown: { code?: string; message?: string } = {};
  try { prepareRichText(document, undefined, "c", "m", {}, "derived"); } catch (error) { thrown = error as typeof thrown; }
  expect(thrown.code).toBe("input-too-long");
  expect(thrown.message).toContain("200,000 characters");
  expect(thrown.message).toContain("special characters");
  expect(thrown.message).toMatch(/needs 2\d\d,\d{3} characters/);
  for (const language of ["en", "th"]) {
    const catalog = (language === "en" ? require("../../shared/src/en") : require("../../shared/src/th"));
    expect(JSON.stringify(catalog)).toContain("200,000");
  }
});

test("text that fits the cap is accepted when its shortest safe escaping fits, and refused as input-too-long (never text-loss) when no escaping does", async () => {
  const link = (count: number) => ({ type: "doc", content: [paragraph("http://a_".repeat(count))] });
  // 180,000 characters of `http://a_`: the colon of each `scheme://` is escaped and the underscores between letters are not, so the form is exactly 200,000.
  const accepted = await prepareRichTextGuarded(link(20_000), undefined, "c", "m", {}, "derived");
  expect(accepted.markdown.length).toBeLessThanOrEqual(200_000);
  expect(richTextTextContent(storedMarkdownToDoc(accepted.markdown))).toEqual(richTextTextContent(link(20_000)));
  // 199,000 characters cannot fit whichever way they are escaped: the refusal is about the length, with the plain message.
  let thrown: { code?: string; message?: string } = {};
  try { await prepareRichTextGuarded(link(22_111), undefined, "c", "m", {}, "derived"); } catch (error) { thrown = error as typeof thrown; }
  expect(thrown.code).toBe("input-too-long");
  expect(thrown.message).toContain("200,000 characters");
  expect(thrown.message).toContain("special characters");
  // The normal form of ordinary text is unchanged by the new tier.
  expect(prepareRichText({ type: "doc", content: [paragraph("snake_case and see http://example.com now")] }, undefined, "c", "m", {}, "derived").markdown).toBe("snake\\_case and see http://example.com now");
}, 60_000);
