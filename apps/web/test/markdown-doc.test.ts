import { expect, test } from "bun:test";
import { markdownToDoc, markdownTitle } from "../src/markdown-doc";

const content = (md: string) => markdownToDoc(md).content as Array<Record<string, any>>;

test("headings, paragraphs and marks map to editor nodes", () => {
  const [h, p] = content("## Plan\n\nA **bold** and *it* and `code` and [site](https://x.test)");
  expect(h).toEqual({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan" }] });
  expect(p.content.map((n: any) => [n.text, (n.marks ?? []).map((m: any) => m.type)])).toEqual([
    ["A ", []], ["bold", ["bold"]], [" and ", []], ["it", ["italic"]], [" and ", []], ["code", ["code"]], [" and ", []], ["site", ["link"]],
  ]);
  expect(p.content[7].marks[0].attrs.href).toBe("https://x.test");
});

test("bullet and ordered lists nest", () => {
  const [ul, ol] = content("- one\n  - inner\n- two\n\n3. a\n4. b");
  expect(ul.type).toBe("bulletList");
  expect(ul.content).toHaveLength(2);
  expect(ul.content[0].content[1].type).toBe("bulletList");
  expect(ol).toMatchObject({ type: "orderedList", attrs: { start: 3 } });
});

test("code block keeps text and language", () => {
  const [c] = content("```ts\nlet a  = 1\n```");
  expect(c).toEqual({ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "let a  = 1" }] });
});

test("unsupported nodes degrade to paragraphs", () => {
  const nodes = content("| h | v |\n|---|---|\n| x | y |\n\n<div>raw</div>\n\n![alt](https://e.test/i.png)");
  expect(nodes.every((n) => ["paragraph", "blockquote", "heading"].includes(n.type))).toBe(true);
  expect(JSON.stringify(nodes)).toContain("x");
  expect(JSON.stringify(nodes)).toContain("raw");
});

test("empty input yields a valid doc", () => {
  expect(markdownToDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
});

test("title is the first non-empty line without markers, capped", () => {
  expect(markdownTitle("\n\n## **Hello** `w`\n\nbody")).toBe("Hello w");
  expect(markdownTitle("- item")).toBe("item");
  expect(markdownTitle("x".repeat(200))).toHaveLength(120);
  expect(markdownTitle("")).toBe("");
});

test("converted doc is valid against the wiki editor schema", async () => {
  const { getSchema } = await import("@tiptap/core");
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const schema = getSchema([StarterKit]);
  const md = "# T\n\n- a\n  - b\n\n1. x\n\n> q\n\n---\n\n```js\nx\n```\n\n**b** *i* ~~s~~ `c` [l](https://x.test)\n\n| h | v |\n|---|---|\n| x | y |\n\n<b>raw</b>\n\nline  \nbreak";
  expect(() => schema.nodeFromJSON(markdownToDoc(md)).check()).not.toThrow();
});
