import { expect, test } from "bun:test";
import { markdownToDocWithWarnings } from "../src/markdown-doc";
import { prepareRichText, richTextMarkdown } from "../src/rich-markdown";

/** CI runners are slower and noisier than a workstation; the limits below guard against quadratic blow-ups, which run far past three times over. */
const slack = Number(Bun.env.WEFT_TIMING_SLACK ?? 1);
const codes = (source: string) => markdownToDocWithWarnings(source).warningDetails.map(({ code }) => code);
const timed = <T>(run: () => T) => { const started = performance.now(); const value = run(); return { value, ms: performance.now() - started }; };

test("nested block markers on one line are refused before any parse, in time and without memory growth", () => {
  const inputs: Record<string, string> = {
    "+ x40000": "+ ".repeat(40_000), "1. x40000": "1. ".repeat(40_000), "> x40000": "> ".repeat(40_000), "* x40000": "* ".repeat(40_000), "- 1. > x20000": "- 1. > ".repeat(20_000),
    "- x10000 lines indented": Array.from({ length: 10_000 }, (_, i) => `${" ".repeat(i * 2)}- x`).join("\n"),
    "> > > x15000 lines": Array.from({ length: 15_000 }, () => "> ".repeat(70) + "x").join("\n"),
  };
  const before = process.memoryUsage().heapUsed;
  for (const [name, source] of Object.entries(inputs)) {
    const { value, ms } = timed(() => markdownToDocWithWarnings(source));
    expect({ name, refused: value.warningDetails.map(({ code }) => code).some((code) => ["nesting-too-deep", "input-too-complex", "input-too-long"].includes(code)) }).toEqual({ name, refused: true });
    expect({ name, fast: ms < 200 }).toEqual({ name, fast: true });
  }
  expect(process.memoryUsage().heapUsed - before).toBeLessThan(150 * 1024 * 1024);
});

test("lists and quotes nested to the documented depth still parse", () => {
  const source = "- a\n  - b\n    - c\n\n> quote\n> > inner\n\n1. one\n   1. nested";
  expect(codes(source)).toEqual([]);
});

test("valid dense documents are accepted whatever their delimiter density", () => {
  const short = Array.from({ length: 20 }, (_, i) => `Item **${i}** is ok (see [docs](https://example.test/${i})).`).join("\n");
  expect(codes(short)).toEqual([]);
  const bold = Array.from({ length: 1_500 }, (_, i) => `**${i}** __ok__`).join("\n");
  expect(bold.length).toBeGreaterThan(15_000);
  expect(codes(bold)).toEqual([]);
});

test("a 200 KB prose document with ordinary bold and links is accepted through the editor path and the text path under 1.5 s", () => {
  const line = "This sentence has **bold words**, a [link](https://example.test/path?q=1), _emphasis_ and `code` for density.";
  const source = Array.from({ length: Math.floor(200_000 / (line.length + 2)) }, () => line).join("\n\n");
  const text = timed(() => prepareRichText(undefined, source, "body", "bodyMarkdown", {}, "verbatim"));
  expect(text.value.markdown).toBe(source);
  expect(text.ms).toBeLessThan(1_500 * slack);
  const document = markdownToDocWithWarnings(source).document;
  const editor = timed(() => prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived"));
  expect(editor.value.markdown.length).toBeGreaterThan(130_000);
  expect(editor.ms).toBeLessThan(1_500 * slack);
});

test("hostile text with stray closers or unmatched delimiters is refused quickly; the editor path never sees it", () => {
  const hostile: Record<string, string> = { "] ": "] ".repeat(99_999), "a] ": "a] ".repeat(60_000), "]]": "]]".repeat(90_000), "a_ ": "a_ ".repeat(60_000), "*a* *b ": "*a* *b ".repeat(28_000), "`": "`".repeat(199_999) };
  for (const [name, source] of Object.entries(hostile)) {
    const { value, ms } = timed(() => markdownToDocWithWarnings(source));
    expect({ name, refused: value.warningDetails.some(({ code }) => code === "input-too-complex") }).toEqual({ name, refused: true });
    expect({ name, fast: ms < 200 }).toEqual({ name, fast: true });
  }
  // A document that holds the same characters as text is escaped by the serializer, so it parses back in linear time.
  const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a] ".repeat(30_000) }] }] };
  const { ms } = timed(() => prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived"));
  expect(ms).toBeLessThan(1_500 * slack);
});

test("richTextMarkdown output of dense marks parses back with no budget refusal", () => {
  const content = Array.from({ length: 3_000 }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `n${i}`, marks: [{ type: "bold" }] }, { type: "text", text: " ok", marks: [{ type: "italic" }] }, { type: "text", text: " docs", marks: [{ type: "link", attrs: { href: `https://example.test/${i}` } }] }] }));
  const { markdown } = richTextMarkdown({ type: "doc", content });
  expect(codes(markdown)).toEqual([]);
});

test("a document whose Written form passes the 200,000-character cap is refused; one below it is saved", () => {
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const line = "snake_case_name and other_words (with) [brackets] ".repeat(2);
  const content = Array.from({ length: Math.floor(190_000 / line.length) }, () => paragraph(line));
  const document = { type: "doc", content };
  // The escaped form is a few percent longer than its source: past the cap it is refused with its own code, never stored.
  expect(() => prepareRichText(document, undefined, "body", "bodyMarkdown", {}, "derived")).toThrow(/too long/);
  const shorter = { type: "doc", content: content.slice(0, Math.floor(content.length * 0.7)) };
  expect(prepareRichText(shorter, undefined, "body", "bodyMarkdown", {}, "derived").markdown.length).toBeGreaterThan(130_000);
  const plain = { type: "doc", content: Array.from({ length: Math.floor(195_000 / 100) }, (_, i) => paragraph(`paragraph ${i} `.padEnd(99, "x"))) };
  expect(prepareRichText(plain, undefined, "body", "bodyMarkdown", {}, "derived").markdown.length).toBeGreaterThan(190_000);
});

test("an over-long untrusted text returns input-too-long with its own plain message, never text-loss", () => {
  let thrown: { code?: string; message?: string } = {};
  try { prepareRichText(undefined, "x".repeat(200_001), "body", "bodyMarkdown", {}, "verbatim"); } catch (error) { thrown = error as typeof thrown; }
  expect(thrown.code).toBe("input-too-long");
  expect(thrown.message).toContain("This text is too long to save. The limit is 200,000 characters");
  expect(thrown.message).toContain("needs 200,001 characters");
  expect(markdownToDocWithWarnings("x".repeat(200_001)).warningDetails.map(({ code }) => code)).toEqual(["input-too-long"]);
});

// The normal form of valid text can be the longer one (every underscore and parenthesis escaped). Over the cap the shortest form that reads back is used, so text that fits as typed is accepted.
for (const [name, text] of Object.entries({
  "my_var_name x15000 (180,000 characters)": "my_var_name ".repeat(15_000), "my_var_name x15833 (190,000 characters)": "my_var_name ".repeat(16_000).slice(0, 190_000),
  "f(x) x30000 (150,000 characters)": "f(x) ".repeat(30_000), "f(x) x39800 (199,000 characters)": "f(x) ".repeat(39_800),
})) {
  test(`text that fits as typed is accepted and reads back exactly: ${name}`, () => {
    const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
    const prepared = prepareRichText(document, undefined, "d", "m", {}, "derived");
    expect(prepared.markdown.length).toBeLessThanOrEqual(200_000);
    const back = markdownToDocWithWarnings(prepared.markdown, { trustedSource: true } as never).document as { content: Array<{ content: Array<{ text: string }> }> };
    expect(back.content[0]!.content.map((node) => node.text).join("")).toBe(text);
  });
}

test("text dense with [[references]] is refused at once with a plain message, and 2,000 of them are still accepted", () => {
  const dense = "[[ref]] ".repeat(6_000);
  const refused = timed(() => markdownToDocWithWarnings(dense));
  expect(refused.value.warningDetails.map(({ code }) => code)).toEqual(["input-too-complex"]);
  expect(refused.value.warnings[0]).toContain("too many [[ brackets");
  expect(refused.ms).toBeLessThan(200);
  expect(() => prepareRichText(undefined, "[[ref]] ".repeat(50_000).slice(0, 100_000), "d", "m", {}, "verbatim")).toThrow(/too many \[\[ brackets/);
  expect(markdownToDocWithWarnings("[[ref]] ".repeat(2_000)).warningDetails.map(({ code }) => code)).not.toContain("input-too-complex");
});

test("the guarded write refuses a [[reference]]-dense text at once, before it queues for a worker", async () => {
  const { prepareRichTextGuarded } = await import("../src");
  const started = performance.now();
  await expect(prepareRichTextGuarded(undefined, "[[ref]] ".repeat(12_000), "d", "m", {}, "verbatim")).rejects.toMatchObject({ status: 400, code: "input-too-complex" });
  expect(performance.now() - started).toBeLessThan(100);
});
