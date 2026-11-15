import { expect, test } from "bun:test";
import { prepareRichText, richTextMarkdown, richTextInput, richTextTextContent } from "../src/rich-markdown";
import { markdownToDocWithWarnings } from "../src/markdown-doc";
import { plainTextLines } from "./support/plain-text-fuzz";
import { containerDocuments } from "./support/container-fuzz";

// Heavy seeded fuzz lives in its own file so that its synchronous work cannot starve the quick tests of rich-markdown.test.ts under the concurrent runner.
test("legacy plain-text corpus: 3000 seeded token lines, every block starter included, are written and read back with no refusal", () => {
  const refusals: string[] = [];
  const mismatches: string[] = [];
  const contexts: Array<(text: string) => unknown> = [
    (text) => ({ type: "paragraph", content: [{ type: "text", text }] }),
    (text) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: text.replace(/\n/g, " ") }] }),
    (text) => ({ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }] }),
    (text) => ({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "head" }] }] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: text.replace(/\n/g, " ") }] }] }] }] }),
    (text) => ({ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }),
    (text) => ({ type: "paragraph", content: [{ type: "text", text: "lead ", marks: [{ type: "bold" }] }, { type: "text", text }] }),
    (text) => ({ type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }] }),
    (text) => ({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text }] }] }] }),
    (text) => ({ type: "callout", attrs: { type: "note" }, content: [{ type: "paragraph", content: [{ type: "text", text }] }] }),
    (text) => ({ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "outer" }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }] }] }] }),
  ];
  const lines = plainTextLines(3000);
  expect(lines.length).toBeGreaterThanOrEqual(3000 * 0.95);
  lines.forEach((text, index) => {
    const document = { type: "doc", content: [contexts[index % contexts.length]!(text)] };
    try {
      const prepared = prepareRichText(document, undefined, "body", "bodyMarkdown", {}, "derived");
      const stored = markdownToDocWithWarnings(prepared.markdown).document;
      if (JSON.stringify(richTextTextContent(stored)) !== JSON.stringify(richTextTextContent(document))) mismatches.push(JSON.stringify(text));
    } catch { refusals.push(JSON.stringify(text)); }
  });
  expect({ refusals: refusals.length, sample: refusals.slice(0, 5) }).toEqual({ refusals: 0, sample: [] });
  expect({ mismatches: mismatches.length, sample: mismatches.slice(0, 5) }).toEqual({ mismatches: 0, sample: [] });
}, 120_000);

for (const [seed, runs] of [[0x4a19, 300], [4242, 500], [7, 500], [90210, 500]] as Array<[number, number]>) test(`seeded mixed containers simplify formatting but never lose text or refuse (seed ${seed})`, async () => {
  const { getSchema } = await import("@tiptap/core");
  const { wikiEditorExtensions } = await import("../src/wiki-editor-extensions");
  const schema = getSchema(wikiEditorExtensions);
  let state = seed;
  const random = () => { state = state + 0x6d2b79f5 | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const blockTypes = ["paragraph", "heading", "codeBlock", "blockquote", "callout", "bulletList", "orderedList", "taskList", "table", "horizontalRule", "assetImage"];
  const scalar = (index: number): any => {
    const text = "seed" + index;
    switch (Math.floor(random() * 4)) {
      case 0: return { type: "paragraph", content: [{ type: "text", text }] };
      case 1: return { type: "heading", attrs: { level: 1 + Math.floor(random() * 6) }, content: [{ type: "text", text }] };
      case 2: return { type: "codeBlock", attrs: { language: random() < 0.5 ? "typescript" : null }, content: [{ type: "text", text }] };
      default: return { type: "horizontalRule" };
    }
  };
  const contentBlocks = (depth: number, index: number, firstType?: string): any[] => {
    const count = Math.floor(random() * 5);
    const children = Array.from({ length: count }, (_, i) => makeBlock(i === 0 && firstType ? firstType : blockTypes[Math.floor(random() * blockTypes.length)]!, depth, index * 5 + i));
    return children.length ? children : [scalar(index)];
  };
  const makeBlock = (type: string, depth: number, index: number): any => {
    if (depth >= 4 || !["blockquote", "callout", "bulletList", "orderedList", "taskList", "table"].includes(type)) {
      if (type === "assetImage") return { type, attrs: { assetId: "asset-" + index, alt: "asset " + index } };
      if (type === "horizontalRule") return { type };
      return scalar(index);
    }
    if (type === "blockquote") return { type, content: contentBlocks(depth + 1, index) };
    if (type === "callout") return { type, attrs: { type: "note" }, content: contentBlocks(depth + 1, index) };
    if (type === "table") return { type, content: [{ type: "tableRow", content: [{ type: "tableHeader", content: contentBlocks(depth + 1, index) }, { type: "tableCell", content: contentBlocks(depth + 1, index + 1) }] }] };
    const itemType = type === "taskList" ? "taskItem" : "listItem";
    const nestedTypes = ["paragraph", "heading", "codeBlock", "blockquote", "callout", "bulletList", "orderedList", "taskList", "table"];
    const count = 1 + Math.floor(random() * 4);
    const itemContent = [{ type: "paragraph", content: [{ type: "text", text: "seed" + index }] }, ...Array.from({ length: count - 1 }, (_, i) => makeBlock(nestedTypes[Math.floor(random() * nestedTypes.length)]!, depth + 1, index * 5 + i))];
    const item = { type: itemType, ...(type === "taskList" ? { attrs: { checked: random() < 0.5 } } : {}), content: itemContent };
    return { type, ...(type === "orderedList" ? { attrs: { start: 1 + Math.floor(random() * 12) } } : {}), content: [item] };
  };
  const allowedWarnings = new Set(["whitespace-simplified", "structure-simplified", "task-state-simplified", "table-header-simplified", "code-language-simplified", "list-start-simplified", "callout-type-simplified", "image-alt-simplified", "heading-level-simplified", "attribute-not-persisted", "unsupported-html", "external-image", "unsafe-link", "unresolved-reference", "irregular-table", "deep-heading", "unsupported-callout-metadata", "unsupported-code-language", "unsafe-color"]);
  for (let index = 0; index < runs; index++) {
    const type = blockTypes[index % blockTypes.length]!;
    const content = contentBlocks(0, index, type);
    const document = { type: "doc", content };
    const parsed = schema.nodeFromJSON(document);
    parsed.check();
    let result: ReturnType<typeof prepareRichText>;
    try { result = prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived"); }
    catch (error) {
      const markdown = richTextMarkdown(document).markdown;
      const parsed = richTextInput(undefined, markdown, "content", "contentMarkdown");
      const before = richTextTextContent(document), after = richTextTextContent(parsed);
      const difference = before.findIndex((part, i) => JSON.stringify(part) !== JSON.stringify(after[i]));
      throw new Error(`seed=${seed} index=${index} difference=${difference} minimal=${JSON.stringify(document)} before=${JSON.stringify(before.slice(Math.max(0, difference), difference + 3))} after=${JSON.stringify(after.slice(Math.max(0, difference), difference + 3))} cause=${error instanceof Error ? error.message : error}`);
    }
    expect(richTextTextContent(result.document), `seed=${seed} index=${index}`).toEqual(richTextTextContent(document));
    expect(result.warningDetails.every(({ code }) => allowedWarnings.has(code)), `seed=${seed} index=${index}: ${JSON.stringify(result.warningDetails)}`).toBe(true);
  }
}, 120_000);

for (const seed of [4242, 1, 2, 3]) test(`nested container compositions at depth four are saved without text loss (seed ${seed}, 500 documents)`, () => {
  containerDocuments(seed, 500).forEach((document, index) => {
    let prepared: ReturnType<typeof prepareRichText>;
    try { prepared = prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived"); }
    catch (error) { throw new Error(`seed=${seed} index=${index} ${error instanceof Error ? error.message : error} document=${JSON.stringify(document)}`); }
    const stored = markdownToDocWithWarnings(prepared.markdown, { trustedSource: true, preserveStableReferences: true }).document;
    expect(richTextTextContent(stored), `seed=${seed} index=${index}`).toEqual(richTextTextContent(document));
  });
}, 120_000);


// The cached document is what a parse of the stored Markdown gives: the Markdown wins. Checked for document input (derived storage) and for Markdown input (verbatim storage).
for (const seed of [4242, 1, 2, 3]) test(`the cached document equals a parse of the stored Markdown, for document and Markdown input (seed ${seed}, 400 documents)`, () => {
  containerDocuments(seed, 400).forEach((document, index) => {
    const viaDocument = prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived");
    const parse = (markdown: string) => markdownToDocWithWarnings(markdown, { trustedSource: true, preserveStableReferences: true }).document;
    expect(viaDocument.document, `document input seed=${seed} index=${index}`).toEqual(parse(viaDocument.markdown));
    const written = richTextMarkdown(document).markdown;
    const viaMarkdown = prepareRichText(undefined, written, "content", "contentMarkdown", {}, "verbatim");
    expect(viaMarkdown.document, `markdown input seed=${seed} index=${index}`).toEqual(parse(viaMarkdown.markdown));
  });
}, 180_000);

test("a ```js fence is cached with its language, as a parse of the stored Markdown gives it", () => {
  const prepared = prepareRichText(undefined, "```js\nconst a = 1;\n```", "content", "contentMarkdown", {}, "verbatim");
  expect(prepared.document).toEqual(markdownToDocWithWarnings(prepared.markdown, { trustedSource: true, preserveStableReferences: true }).document);
  expect(JSON.stringify(prepared.document)).toContain('"language":"js"');
});
