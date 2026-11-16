import { expect, test } from "bun:test";
import { markdownToDoc, markdownToDocWithWarnings, markdownTitle } from "../src/markdown-doc";

const content = (md: string) => markdownToDoc(md).content as Array<Record<string, any>>;

test("headings, paragraphs and marks map to editor nodes", () => {
  const [h, p] = content("## Plan\n\nA **bold** and *it* and `code` and [site](https://x.test)");
  expect(h).toEqual({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan" }] });
  expect(p.content.map((n: any) => [n.text, (n.marks ?? []).map((m: any) => m.type)])).toEqual([
    ["A ", []], ["bold", ["bold"]], [" and ", []], ["it", ["italic"]], [" and ", []], ["code", ["code"]], [" and ", []], ["site", ["link"]],
  ]);
  expect(p.content[7].marks[0].attrs.href).toBe("https://x.test");
});

test("written form preserves hard breaks and heading levels through six", () => {
  const nodes = content("###### Deep\n\nfirst  \nsecond");
  expect(nodes[0]).toMatchObject({ type: "heading", attrs: { level: 6 } });
  expect(nodes[1].content).toEqual([{ type: "text", text: "first" }, { type: "hardBreak" }, { type: "text", text: "second" }]);
});

test("inline code containing HTML remains literal", () => {
  expect(content("use `<div>` here")[0].content[1]).toEqual({ type: "text", text: "<div>", marks: [{ type: "code" }] });
});

test("inline code containing highlight delimiters remains literal", () => {
  expect(content("a `a==b==c` b")[0].content[1]).toEqual({ type: "text", text: "a==b==c", marks: [{ type: "code" }] });
});

test("underline can wrap bold across inline HTML siblings", () => {
  expect(content("<u>**x**</u>")[0].content).toEqual([{ type: "text", text: "x", marks: [{ type: "underline" }, { type: "bold" }] }]);
});

test("highlight can wrap bold across markdown siblings", () => {
  expect(content("==**x**==")[0].content).toEqual([{ type: "text", text: "x", marks: [{ type: "highlight" }, { type: "bold" }] }]);
});

test("allowed marks nest across HTML and Markdown inside color", () => {
  const text = content('<span style="color:purple"><u>**x**</u></span>')[0].content[0];
  expect(text).toEqual({ type: "text", text: "x", marks: [{ type: "textStyle", attrs: { color: "purple" } }, { type: "underline" }, { type: "bold" }] });
});

test("unpaired allowlisted HTML tags stay visible and warn", () => {
  const result = markdownToDocWithWarnings("<u>unfinished");
  expect(JSON.stringify(result.document)).toContain("<u>");
  expect(result.warningDetails.map(({ code }) => code)).toContain("unsupported-html");
});

test("callout bodies retain bold and links", () => {
  const [callout] = content("> [!note]\n> **bold** [link](https://example.test)");
  expect(JSON.stringify(callout)).toContain('"type":"bold"');
  expect(JSON.stringify(callout)).toContain('"href":"https://example.test"');
});

test("bullet and ordered lists nest", () => {
  const [ul, ol] = content("- one\n  - inner\n- two\n\n3. a\n4. b");
  expect(ul.type).toBe("bulletList");
  expect(ul.content).toHaveLength(2);
  expect(ul.content[0].content[1].type).toBe("bulletList");
  expect(ol).toMatchObject({ type: "orderedList", attrs: { start: 3 } });
});

test("supported lists do not produce source-mode conversion warnings", () => {
  expect(markdownToDocWithWarnings("- one\n  - nested\n\n- [x] done").warnings).toEqual([]);
});

test("code block keeps text and language", () => {
  const [c] = content("```ts\nlet a  = 1\n```");
  expect(c).toEqual({ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "let a  = 1" }] });
});

test("hostile Mermaid source stays exact code and does not create HTML warnings", () => {
  const source = '```mermaid\nflowchart LR\nA["<script>alert(1)</script>"]\nclick A "javascript:alert(1)"\nA@{ img: "https://example.invalid/diagram.png" }\n```';
  const result = markdownToDocWithWarnings(source);
  const [block] = result.document.content;
  expect(block).toMatchObject({ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: 'flowchart LR\nA["<script>alert(1)</script>"]\nclick A "javascript:alert(1)"\nA@{ img: "https://example.invalid/diagram.png" }' }] });
  expect(result.warnings).toEqual([]);
});

test("Markdown tables keep header and body cells, inline marks, and pad ragged rows", () => {
  const [table] = content("| **Name** | Value |\n|---|---|\n| *Ada* | `42` |\n| Grace |");
  expect(table.type).toBe("table");
  expect(table.content.map((row: any) => row.type)).toEqual(["tableRow", "tableRow", "tableRow"]);
  expect(table.content[0].content.map((cell: any) => cell.type)).toEqual(["tableHeader", "tableHeader"]);
  expect(table.content[1].content.map((cell: any) => cell.type)).toEqual(["tableCell", "tableCell"]);
  expect(table.content[0].content[0].content[0].content[0]).toMatchObject({ text: "Name", marks: [{ type: "bold" }] });
  expect(table.content[1].content[0].content[0].content[0]).toMatchObject({ text: "Ada", marks: [{ type: "italic" }] });
  expect(table.content[1].content[1].content[0].content[0]).toMatchObject({ text: "42", marks: [{ type: "code" }] });
  expect(table.content[2].content[1]).toEqual({ type: "tableCell", content: [{ type: "paragraph" }] });
});

test("a body row longer than the header widens every row, header included", () => {
  const [table] = content("| a |\n|---|\n| 1 | 2 | 3 |");
  expect(table.content.map((row: any) => row.content.length)).toEqual([3, 3]);
  expect(table.content[0].content.map((cell: any) => cell.type)).toEqual(["tableHeader", "tableHeader", "tableHeader"]);
  expect(table.content[0].content[2]).toEqual({ type: "tableHeader", content: [{ type: "paragraph" }] });
  expect(table.content[1].content[2].content[0].content[0]).toMatchObject({ text: "3" });
});

test("an empty header cell stays a header cell with an empty paragraph", () => {
  const [table] = content("| | v |\n|---|---|\n| x | y |");
  expect(table.content[0].content[0]).toEqual({ type: "tableHeader", content: [{ type: "paragraph" }] });
  expect(table.content[0].content[1].content[0].content[0]).toMatchObject({ text: "v" });
});

test("a header-only table has one header row and no body rows", () => {
  const [table] = content("| a | b |\n|---|---|");
  expect(table.content).toHaveLength(1);
  expect(table.content[0].content.map((cell: any) => cell.type)).toEqual(["tableHeader", "tableHeader"]);
});

test("unsupported nodes degrade to paragraphs", () => {
  const nodes = content("<div>raw</div>\n\n![alt](https://e.test/i.png)");
  expect(nodes.every((n) => ["paragraph", "blockquote", "heading"].includes(n.type))).toBe(true);
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
  const { wikiEditorExtensions } = await import("../src/wiki-editor-extensions");
  const schema = getSchema(wikiEditorExtensions);
  const md = "# T\n\n- a\n  - b\n\n1. x\n\n> q\n\n---\n\n```js\nx\n```\n\n**b** *i* ~~s~~ `c` [l](https://x.test)\n\n| h | v |\n|---|---|\n| x | y |\n\n<b>raw</b>\n\nline  \nbreak\n\n**`bold code`** and [`file.ts`](https://x.test) and *[a](https://x.test)*";
  expect(() => schema.nodeFromJSON(markdownToDoc(md)).check()).not.toThrow();
});

test("a link with an unsafe scheme keeps its text but loses the link", () => {
  const [p] = content("[click](javascript:alert(1)) and [ok](https://x.test)");
  expect(p.content[0]).toEqual({ type: "text", text: "click" });
  expect(p.content.at(-1).marks[0].attrs.href).toBe("https://x.test");
});

test("javascript links stay plain text", () => expect(content("[unsafe](javascript:alert(1))")[0].content?.[0]).toEqual({ type: "text", text: "unsafe" }));
test("data links stay plain text", () => expect(content("[unsafe](data:text/html,hi)")[0].content?.[0]).toEqual({ type: "text", text: "unsafe" }));
test("vbscript links stay plain text", () => expect(content("[unsafe](vbscript:alert(1))")[0].content?.[0]).toEqual({ type: "text", text: "unsafe" }));

test("unknown tags and attributes remain literal text", () => {
  for (const input of ["<script>run()</script>", "<u class=\"unexpected\">under</u>", "<span style=\"color:red;background:url(x)\">red</span>"]) {
    const nodes = content(input);
    const serialized = JSON.stringify(nodes);
    const visible = (value: any): string => value?.type === "text" ? value.text : (value?.content ?? []).map(visible).join("");
    expect(nodes.map(visible).join("")).toBe(input);
    expect(serialized).not.toContain("\"type\":\"underline\"");
    expect(serialized).not.toContain("\"type\":\"textStyle\"");
  }
});

test("source conversion warns about unsupported markup while retaining its exact text", () => {
  const source = "<script>keep this text</script>";
  const result = markdownToDocWithWarnings(source);
  expect(result.warningDetails.map(({ code }) => code)).toContain("unsupported-html");
  expect(result.warningDetails).toEqual([{ code: "unsupported-html", message: result.warnings[0] }]);
  const visible = (value: any): string => value?.type === "text" ? value.text : (value?.content ?? []).map(visible).join("");
  expect(result.document.content.map(visible).join("\n")).toBe(source);
});
