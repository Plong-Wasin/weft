import { expect, test } from "bun:test";
import { richTextInput, richTextMarkdown } from "../src/rich-markdown";

test("Markdown field round-trips a heading, table, list, link, code and task list", () => {
  const markdown = "## Plan\n\n| Name | Value |\n| --- | --- |\n| Ada | [site](https://example.test) |\n\n- one\n\n- [x] done\n\n```ts\nconst x = 1;\n```";
  const document = richTextInput(undefined, markdown, "body", "bodyMarkdown");
  const result = richTextMarkdown(document);
  expect(result.markdown).toContain("## Plan");
  expect(result.markdown).toContain("| Ada | [site](https://example.test) |");
  expect(result.markdown).toContain("- one");
  expect(result.markdown).toContain("```ts");
  expect(result.markdownWarnings).toEqual([]);
});

test("rich text read flags callouts, mentions and images that Markdown cannot represent", () => {
  const result = richTextMarkdown({ type: "doc", content: [{ type: "callout", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "user" } }, { type: "assetImage", attrs: { assetId: "asset" } }] }] }] });
  expect(result.markdown).toContain("[!CALLOUT]");
  expect(result.markdown).toContain("@{user}");
  expect(result.markdown).toContain("![Image: asset]");
  expect(result.markdownWarnings).toEqual([
    "callout is preserved in the document but has no Markdown representation",
    "mention is preserved in the document but has no Markdown representation",
    "assetImage is preserved in the document but has no Markdown representation",
  ]);
});

test("rich text rejects both representations with a fix", () => {
  expect(() => richTextInput({ type: "doc", content: [] }, "hello", "body", "bodyMarkdown")).toThrow("Send either bodyMarkdown (Markdown text) or body (a Tiptap document), not both.");
});
