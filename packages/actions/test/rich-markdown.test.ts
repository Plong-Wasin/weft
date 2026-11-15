import { expect, test } from "bun:test";
import { describeStructureChanges, normalizeRichTextDocument, prepareRichText, richTextInput, richTextInputWithWarnings, richTextMarkdown, richTextTextContent } from "../src/rich-markdown";
import { markdownToDocWithWarnings } from "../src/markdown-doc";
import { plainTextLines } from "./support/plain-text-fuzz";
import { containerDocuments } from "./support/container-fuzz";

test("external image Markdown kept as text stays literal after its import warning", () => {
  const source = "![remote image](https://example.test/image.png)";
  const options = { preserveUnresolvedReferences: true };
  const imported = markdownToDocWithWarnings(source, options);
  expect(imported.warningDetails.map(({ code }) => code)).toContain("external-image");
  const written = richTextMarkdown(imported.document).markdown;
  expect(markdownToDocWithWarnings(written, options).document).toEqual(imported.document);
});

test("diff code blocks survive Written form round trips with their signs", () => {
  const markdown = "```diff\n-old line\n+new line\n```";
  expect(richTextMarkdown(richTextInput(undefined, markdown, "body", "bodyMarkdown")).markdown).toBe(markdown);
});

test("code blocks with absent, null, empty, and set languages pass the shared write policy", () => {
  const variants = [
    { type: "codeBlock", content: [{ type: "text", text: "Code block" }] },
    { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "Code block" }] },
    { type: "codeBlock", attrs: { language: "" }, content: [{ type: "text", text: "Code block" }] },
    { type: "codeBlock", attrs: { language: "typescript" }, content: [{ type: "text", text: "Code block" }] },
  ];
  for (const storage of ["verbatim", "derived"] as const) for (const block of variants) {
    const result = prepareRichText({ type: "doc", content: [block] }, undefined, "content", "contentMarkdown", {}, storage);
    expect(result.markdown).toContain("Code block");
  }
});

test("known non-persisted editor attributes save with explicit attribute warnings", () => {
  const fixtures = [
    { type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Aligned" }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { backgroundColor: "#ff0000", colwidth: [240] }, content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }] }] }] },
    { type: "assetImage", attrs: { assetId: "asset-1", width: 240, alignment: "right" } },
  ];
  const result = prepareRichText({ type: "doc", content: fixtures }, undefined, "content", "contentMarkdown");
  expect(result.markdown).toContain("Aligned");
  expect(result.warningDetails.filter(({ code }) => code === "attribute-not-persisted").map(({ message }) => message)).toEqual(expect.arrayContaining([
    expect.stringContaining("text alignment"), expect.stringContaining("table cell colour"), expect.stringContaining("table column width"), expect.stringContaining("image width"), expect.stringContaining("image alignment"),
  ]));
  expect(() => prepareRichText({ type: "doc", content: [{ type: "unknownNode" }] }, undefined, "content", "contentMarkdown")).toThrow(/can't be saved|could not be saved/i);
});

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

test("named plain-text lines that CommonMark would read as structure are written exactly", () => {
  for (const text of ["#", "##", "---", "===", "1.", "[link](http://x.com)", "www.example.com/x_y_z", "<https://auto.link>", "    code-like", "\ttab start"]) {
    const prepared = prepareRichText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }, undefined, "body", "bodyMarkdown", {}, "derived");
    expect(richTextTextContent(markdownToDocWithWarnings(prepared.markdown).document), text).toEqual(richTextTextContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }));
  }
});

test("an internal reference keeps literal private-use text from the editor", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "New\uE000", marks: [{ type: "link", attrs: { href: `weft://wiki/${id}`, kind: "wiki", targetId: id, target: "New" } }] }] }] };
  const prepared = prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived");
  expect(richTextTextContent(prepared.document)).toEqual(richTextTextContent(document));
  expect(prepared.markdown).toContain("New");
});

test("a mention with an absent label keeps the same target through the shared write policy", () => {
  const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "00000000-0000-4000-8000-000000000001" } }] }] };
  const prepared = prepareRichText(document, undefined, "body", "bodyMarkdown", {}, "derived");
  expect(richTextTextContent(prepared.document)).toEqual(richTextTextContent(document));
});

test("wf-block table comments validate decoded marks and code languages", () => {
  const encoded = (node: unknown) => `<!-- wf-block:${encodeURIComponent(JSON.stringify(node))} -->`;
  const unsafeLink = { type: "paragraph", content: [{ type: "text", text: "keep this", marks: [{ type: "link", attrs: { href: "javascript:alert(1)", kind: "work-item", targetId: "forged", target: "forged" } }] }] };
  const unsupportedCode = { type: "codeBlock", attrs: { language: "untrusted-lang" }, content: [{ type: "text", text: "some code" }] };
  const source = `| block |\n| --- |\n| ${encoded(unsafeLink)} |\n| <!-- wf-block:${encodeURIComponent(JSON.stringify(unsupportedCode))} --> |`;
  const imported = markdownToDocWithWarnings(source, { preserveUnresolvedReferences: true });
  expect(JSON.stringify(imported.document)).not.toContain("javascript:");
  expect(JSON.stringify(imported.document)).not.toContain('"language":"untrusted-lang"');
  expect(imported.warningDetails.map(({ code }) => code)).toEqual(expect.arrayContaining(["unsafe-link", "unsupported-code-language"]));
});

test("the delimiter budget rejects adversarial input quickly and permits normal 200 KB text", () => {
  const hostile = ["] ".repeat(99_999), "`".repeat(199_999), "] ".repeat(40_000), "[](".repeat(20_000), "`".repeat(100_000), "[a](".repeat(30_000)];
  for (const source of hostile) {
    const started = performance.now();
    const imported = markdownToDocWithWarnings(source);
    expect(imported.warningDetails.map(({ code }) => code)).toContain("input-too-complex");
    expect(performance.now() - started).toBeLessThan(200);
  }
  const normal = "ordinary prose with words and punctuation. ".repeat(4_500).slice(0, 200_000);
  const started = performance.now();
  const result = prepareRichText(undefined, normal, "body", "bodyMarkdown", {}, "verbatim");
  expect(result.markdown).toBe(normal);
  expect(performance.now() - started).toBeLessThan(1_500);
});

test("structural differences warn while preserving text, links, mentions, code, and asset ids", () => {
  const doc = { type: "doc", content: [
    { type: "blockquote", content: [{ type: "callout", attrs: { type: "note" }, content: [{ type: "paragraph", content: [{ type: "text", text: "plain" }] }] }] },
    { type: "orderedList", attrs: { start: 5 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] }] },
    { type: "orderedList", attrs: { start: 8 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] }] },
  ] };
  const result = prepareRichText(doc, undefined, "content", "contentMarkdown", {}, "derived");
  expect(result.warningDetails.map(({ code }) => code)).toContain("structure-simplified");
});

test("written form represents callouts, mentions and images without warnings", () => {
  const result = richTextMarkdown({ type: "doc", content: [{ type: "callout", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "user" } }, { type: "assetImage", attrs: { assetId: "asset" } }] }] }] });
  expect(result.markdown).toContain("[!note]");
  expect(result.markdown).toContain("@{user}");
  expect(result.markdown).toContain("![[asset:asset]]");
  expect(result.markdownWarnings).toEqual([]);
});

test("written form keeps stable mention and image ids and preserves ordered list starts", () => {
  const source = "@{Ada Lovelace|user-1}\n\n![[asset:img-1|Portrait]]\n\n7. first\n8. second";
  const document = richTextInput(undefined, source, "body", "bodyMarkdown") as any;
  expect(document.content[0].content[0]).toMatchObject({ type: "mention", attrs: { id: "user-1", label: "Ada Lovelace" } });
  expect(document.content[1]).toMatchObject({ type: "assetImage", attrs: { assetId: "img-1" } });
  expect(document.content[2]).toMatchObject({ type: "orderedList", attrs: { start: 7 } });
  expect(richTextMarkdown(document).markdown).toContain("@{Ada Lovelace|user-1}");
  expect(richTextMarkdown(document).markdown).toContain("![[asset:img-1|Portrait]]");
  expect(richTextMarkdown(document).markdown).toContain("7. first");
});

test("image references parse back to a block assetImage even when alone", () => {
  const document = richTextInput(undefined, "![[asset:image-1|Diagram]]", "body", "bodyMarkdown") as any;
  expect(document.content).toEqual([{ type: "assetImage", attrs: { assetId: "image-1", alt: "Diagram" } }]);
});

test("short image embeds map to assetImage nodes", () => {
  const document = richTextInput(undefined, "![[asset-legacy]]", "body", "bodyMarkdown") as any;
  expect(document.content).toEqual([{ type: "assetImage", attrs: { assetId: "asset-legacy", alt: null } }]);
});

test("callout written form parses type and contents back into a callout node", () => {
  const document = richTextInput(undefined, "> [!note]\n> Keep this\n> safe", "body", "bodyMarkdown") as any;
  expect(document.content[0]).toMatchObject({ type: "callout", attrs: { type: "note" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this\nsafe" }] }] });
  expect((document.content[0] as any).attrs.icon).toBeUndefined();
});

test("callout body uses block parsing for nested lists", () => {
  const { content } = richTextInput(undefined, "> [!warning]\n> - parent\n>   - child", "body", "bodyMarkdown") as any;
  expect(content[0]).toMatchObject({ type: "callout", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "parent" }] }, { type: "bulletList" }] }] }] });
});

test("highlight and allowlisted inline tags parse to editor marks", () => {
  const document = richTextInput(undefined, "==glow== <u>under</u> <sub>low</sub> <sup>high</sup> <span style=\"color:#ff0000\">red</span>", "body", "bodyMarkdown") as any;
  const marks = document.content[0].content.filter((n: any) => n.type === "text").map((n: any) => [n.text, n.marks?.map((m: any) => m.type)]);
  expect(marks).toEqual([["glow", ["highlight"]], [" ", undefined], ["under", ["underline"]], [" ", undefined], ["low", ["subscript"]], [" ", undefined], ["high", ["superscript"]], [" ", undefined], ["red", ["textStyle"]]]);
});

test("a basic named color is retained as a text style color", () => {
  const document = richTextInput(undefined, "<span style=\"color:purple\">violet</span>", "body", "bodyMarkdown") as any;
  expect(document.content[0].content[0]).toEqual({ type: "text", text: "violet", marks: [{ type: "textStyle", attrs: { color: "purple" } }] });
});

test("unsafe link marks in stored documents serialize as plain text", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,hi", "vbscript:alert(1)"]) {
    const result = richTextMarkdown({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "unsafe", marks: [{ type: "link", attrs: { href } }] }] }] });
    expect(result.markdown).toBe("unsafe");
  }
});

test("link schemes with embedded controls or Unicode spaces are dropped in both directions", async () => {
  const { richTextInputWithWarnings } = await import("../src/rich-markdown");
  for (const href of ["java\tscript:alert(1)", "java\nscript:alert(1)", "java\u00a0script:alert(1)", " javascript:alert(1)", "/\\evil.com", "\\\\evil"]) {
    const imported = richTextInputWithWarnings(`[x](<${href}>)`);
    expect(imported.warningDetails.map(({ code }) => code)).toContain("unsafe-link");
    const serialized = richTextMarkdown({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] }] });
    expect(serialized.markdown).toBe("x");
  }
});

test("editor and Written form share allowed link schemes and escape unusual href delimiters", async () => {
  const { writtenFormLinkSchemes } = await import("../src/written-form-attributes");
  const { linkConfig } = await import("../src/wiki-editor-extensions");
  expect(linkConfig.protocols).toEqual([...writtenFormLinkSchemes]);
  for (const href of [...writtenFormLinkSchemes.map((scheme) => `${scheme}:example/path`), "https://example.test/wiki/Foo_(bar)", "https://example.test/x)y", "https://example.test/x(y", "https://example.test/<x>"]) {
    const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "label", marks: [{ type: "link", attrs: { href } }] }] }] };
    const result = prepareRichText(document, undefined, "body", "bodyMarkdown");
    expect(result.markdown).toContain("label");
    expect((richTextInput(undefined, result.markdown, "body", "bodyMarkdown") as any).content[0].content[0].marks[0].attrs.href).toBe(href.replace(/</g, "%3C").replace(/>/g, "%3E"));
  }
  const unsupported = prepareRichText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "visible", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] }, undefined, "body", "bodyMarkdown");
  expect(unsupported.markdown).toBe("visible");
  expect(unsupported.warningDetails).toContainEqual(expect.objectContaining({ code: "link-not-persisted" }));
});

test("document to Written form warns for each unrepresented editor loss", () => {
  const result = richTextMarkdown({ type: "doc", content: [
    { type: "mysteryNode" },
    { type: "assetImage", attrs: { assetId: "image", width: 300 } },
    { type: "paragraph", content: [{ type: "text", text: "word", marks: [{ type: "customMark" }] }] },
    { type: "callout", attrs: { type: "note", color: "url(javascript:alert(1))", icon: "🛸" }, content: [{ type: "paragraph", content: [{ type: "text", text: "care" }] }] },
  ] });
  expect(result.markdownWarnings).toHaveLength(4);
  expect(result.markdownWarnings.every((warning) => !warning.includes("Written form") && warning.includes("text was kept"))).toBe(true);
});

test("serializer warns for every editor attribute deliberately excluded from Written form", () => {
  const result = richTextMarkdown({ type: "doc", content: [
    { type: "orderedList", attrs: { type: "upper-alpha" }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    { type: "codeBlock", attrs: { language: "bad language" }, content: [{ type: "text", text: "code" }] },
    { type: "mention", attrs: { id: "member", label: "Member", mentionSuggestionChar: "/" } },
    { type: "assetImage", attrs: { assetId: "asset", width: 420, alignment: "left" } },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2 }, content: [{ type: "paragraph" }] }] }] },
    { type: "paragraph", content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.test", target: "_self", rel: "nofollow", class: "quiet", title: "Title" } }] }] },
  ] });
  expect(result.markdownWarnings.length).toBeGreaterThan(0);
});

test("Written form to document warns for unrepresented images, tags, and unsafe links", async () => {
  const { richTextInputWithWarnings } = await import("../src/rich-markdown");
  const result = richTextInputWithWarnings("![remote](https://example.test/image.png)\n\n<script>unsafe</script>\n\n[unsafe](javascript:alert(1))");
  expect(result.warningDetails.map(({ code }) => code)).toEqual(["unsupported-html", "external-image", "unsafe-link"]);
});

const hostileImportCases = [
  ["unknown HTML tag", "<custom-widget>keep me</custom-widget>", "unsupported-html", "<custom-widget>keep me</custom-widget>"],
  ["javascript link", "[keep label](javascript:alert(1))", "unsafe-link", "[keep label](javascript:alert(1))"],
  ["unresolved reference", "[[No such page]]", "unresolved-reference", "[[No such page]]"],
  ["non-Asset image", "![diagram](https://example.test/diagram.png)", "external-image", "![diagram](https://example.test/diagram.png)"],
  ["ragged table", "| A | B |\n| --- | --- |\n| value |", "irregular-table", "A | B\nvalue"],
  ["heading above level six", "####### Too deep", "deep-heading", "####### Too deep"],
] as const;

for (const [name, markdown, warning, retainedText] of hostileImportCases) {
  test(`Markdown import keeps ${name} visible and explains why`, async () => {
    const { richTextInputWithWarnings } = await import("../src/rich-markdown");
    const result = richTextInputWithWarnings(markdown, { preserveUnresolvedReferences: true });
    expect(result.warningDetails.map(({ code }) => code), name).toContain(warning);
    const visible = (node: any): string => (node?.text ?? "") + (node?.content ?? []).map(visible).join("");
    expect(visible(result.document)).toContain(retainedText);
  });
}

test("document corpus round-trips in both directions without changing Written form or node structure", async () => {
  const corpus = await Promise.all(["long-description.md", "comment-with-table.md", "wiki-page.md", "links-tasks-diagrams.md"].map((name) => Bun.file(`${import.meta.dir}/markdown-corpus/${name}`).text()));
  for (const written of corpus) {
    const first = richTextInput(undefined, written, "body", "bodyMarkdown");
    const serialized = richTextMarkdown(first).markdown;
    expect(serialized).toBe(written);
    const second = richTextInput(undefined, serialized, "body", "bodyMarkdown");
    expect(second).toEqual(first);
  }
});

test("every Markdown corpus document imports without warnings or changes", async () => {
  const { richTextInputWithWarnings } = await import("../src/rich-markdown");
  for (const name of ["long-description.md", "comment-with-table.md", "wiki-page.md", "links-tasks-diagrams.md"]) {
    const source = await Bun.file(`${import.meta.dir}/markdown-corpus/${name}`).text();
    const imported = richTextInputWithWarnings(source, { preserveUnresolvedReferences: true });
    expect(imported.warnings, name).toEqual([]);
    expect(richTextMarkdown(imported.document).markdown, name).toBe(source);
  }
});

test("editor schema nodes and marks all have Written form allowlist entries", async () => {
  const { getSchema, Node: TiptapNode } = await import("@tiptap/core");
  const { wikiEditorExtensions } = await import("../src/wiki-editor-extensions");
  const { writtenFormSchemaIssues, writtenFormAttributeIssues, writtenFormAttributePolicy } = await import("../src/rich-markdown");
  const schema = getSchema(wikiEditorExtensions);
  expect(writtenFormSchemaIssues(schema)).toEqual([]);
  expect(writtenFormAttributeIssues(schema)).toEqual([]);
  expect(Object.entries(writtenFormAttributePolicy).filter(([, policy]) => !policy.persisted).every(([, policy]) => "reason" in policy && policy.reason.trim().length > 0)).toBe(true);

  const deliberateExtraNode = TiptapNode.create({ name: "temporaryUnwrittenNode", group: "block" });
  const expandedSchema = getSchema([...wikiEditorExtensions, deliberateExtraNode]);
  expect(writtenFormSchemaIssues(expandedSchema)).toContain("node:temporaryUnwrittenNode");
  const { Mark } = await import("@tiptap/core");
  const extraAttributeMark = Mark.create({ name: "temporaryUnwrittenMark", addAttributes() { return { title: { default: null } }; } });
  const attributeSchema = getSchema([...wikiEditorExtensions, extraAttributeMark]);
  expect(writtenFormAttributeIssues(attributeSchema)).toContain("mark:temporaryUnwrittenMark.title");
});

test("converter preserves inline code, nested marks, and callout formatting", async () => {
  const source = "use `<div>` and `a==b==c`; <u>**x**</u> and ==**y**==\n\n> [!note]\n> **bold** [link](https://example.test)";
  const original = richTextInput(undefined, source, "body", "bodyMarkdown");
  const second = richTextInput(undefined, richTextMarkdown(original).markdown, "body", "bodyMarkdown");
  expect(second).toEqual(original);
});

test("callout metadata preserves editor color and picker icons without warnings", () => {
  const document = { type: "doc", content: [{ type: "callout", attrs: { type: "tip", color: "#f97316", icon: "🚀" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Notice" }] }] }] };
  const written = richTextMarkdown(document);
  expect(written.markdown).toStartWith("> [!tip|color=#f97316|icon=🚀]");
  expect(written.markdownWarnings).toEqual([]);
  const roundTrip = richTextInput(undefined, written.markdown, "body", "bodyMarkdown") as any;
  expect(roundTrip.content[0].attrs).toMatchObject({ type: "tip", color: "#f97316", icon: "🚀" });
});

test("unsafe callout metadata is discarded with an explicit warning", async () => {
  const { richTextInputWithWarnings } = await import("../src/rich-markdown");
  const result = richTextInputWithWarnings("> [!tip|color=expression(alert(1))|icon=🚀🚀]\n> Safe body");
  expect(result.warningDetails.map(({ code }) => code)).toContain("unsupported-callout-metadata");
  expect(result.document.content[0].attrs).toMatchObject({ type: "tip", color: null });
  expect((result.document as any).content[0].content[0].content[0].text).toBe("Safe body");
});

test("serializer trims whitespace out of marks and normalizes those edges on import", () => {
  const source = "a== h==<u> u</u>";
  const document = richTextInput(undefined, source, "body", "bodyMarkdown") as any;
  const written = richTextMarkdown(document).markdown;
  expect(written).toBe("a ==h== <u>u</u>");
  expect(richTextMarkdown(richTextInput(undefined, written, "body", "bodyMarkdown")).markdown).toBe(written);
});

test("inline code uses the shortest fence and list empty lines have no whitespace", () => {
  const document = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "code" }] }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }, { type: "paragraph" }, { type: "paragraph", content: [{ type: "text", text: "b" }] }] }] },
  ] };
  const written = richTextMarkdown(document).markdown;
  expect(written).toBe("`x`\n\n- a\n\n  <!-- empty paragraph -->\n\n  b");
  expect(written.split("\n").some((line) => line.trim() === "")).toBe(true);
  expect(written.split("\n").some((line) => /^\s+$/.test(line))).toBe(false);
});

test("converter preserves multiple list item paragraphs and actual nested list indentation", () => {
  const source = "3. first\n\n   1. nested\n\n   second paragraph";
  const original = richTextInput(undefined, source, "body", "bodyMarkdown");
  const once = richTextMarkdown(original).markdown;
  expect(richTextInput(undefined, once, "body", "bodyMarkdown")).toEqual(original);
});

test("converter preserves awkward literal text, empty paragraphs, and multi-line code fences", () => {
  const original = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "# x - x 2024. Q3 *a* @{x} [[X-1]]" }] },
    { type: "paragraph" },
    { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "```\ninside" }] },
  ] };
  const once = richTextMarkdown(original).markdown;
  const roundTrip = richTextInput(undefined, once, "body", "bodyMarkdown") as any;
  for (const block of roundTrip.content) if (block.type === "paragraph" && block.content) {
    block.content = block.content.reduce((merged: any[], node: any) => {
      const previous = merged.at(-1);
      if (node.type === "text" && previous?.type === "text" && JSON.stringify(node.marks ?? []) === JSON.stringify(previous.marks ?? [])) previous.text += node.text;
      else merged.push(node);
      return merged;
    }, []);
  }
  expect(roundTrip).toEqual(original);
});

test("serializer keeps multiple quote and table-cell blocks plus hard breaks", () => {
  const original = { type: "doc", content: [
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }, { type: "paragraph", content: [{ type: "text", text: "two" }, { type: "hardBreak" }, { type: "text", text: "three" }] }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "heading" }, { type: "hardBreak" }, { type: "text", text: "line" }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "head" }, { type: "hardBreak" }, { type: "text", text: "line" }] }, { type: "paragraph", content: [{ type: "text", text: "second" }] }, { type: "paragraph" }] }] }] },
  ] };
  const markdown = richTextMarkdown(original).markdown;
  expect(richTextInput(undefined, markdown, "body", "bodyMarkdown")).toEqual(original);
});

test("headerless tables retain their first-row cell role in Written form", () => {
  const document = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Table block" }] }] }] }] }] };
  const markdown = richTextMarkdown(document).markdown;
  expect(markdown).toBe("| <!-- wf-cell -->Table block |\n| --- |");
  expect(richTextInput(undefined, markdown, "body", "bodyMarkdown")).toEqual(document);
});

test("seeded nested block generator covers every block under every container through the write policy", () => {
  const seed = 0x4e57;
  const containers = ["bulletList", "orderedList", "taskList", "blockquote", "callout", "tableCell", "listItem", "taskItem"] as const;
  const blocks = ["paragraph", "heading", "codeBlock", "bulletList", "orderedList", "taskList", "blockquote", "callout", "table", "horizontalRule", "assetImage"] as const;
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const leaf = (type: typeof blocks[number], n: number): any => {
    if (type === "paragraph") return paragraph(`p-${n}`);
    if (type === "heading") return { type, attrs: { level: 2 }, content: [{ type: "text", text: `h-${n}` }] };
    if (type === "codeBlock") return { type, content: [{ type: "text", text: `code-${n}` }] };
    if (type === "assetImage") return { type, attrs: { assetId: `asset-${n}` } };
    if (type === "horizontalRule") return { type };
    if (type === "table") return { type, content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [paragraph(`cell-${n}`)] }] }] };
    if (type === "bulletList" || type === "orderedList" || type === "taskList") {
      const itemType = type === "taskList" ? "taskItem" : "listItem";
      return { type, ...(type === "orderedList" ? { attrs: { start: 3 } } : {}), content: [{ type: itemType, ...(type === "taskList" ? { attrs: { checked: n % 2 === 0 } } : {}), content: [paragraph(`item-${n}`)] }] };
    }
    if (type === "blockquote" || type === "callout") return { type, ...(type === "callout" ? { attrs: { type: "tip" } } : {}), content: [paragraph(`quote-${n}`)] };
  };
  const wrap = (container: typeof containers[number], child: any, n: number): any => {
    const item = (task: boolean) => ({ type: task ? "taskItem" : "listItem", ...(task ? { attrs: { checked: n % 2 === 0 } } : {}), content: [paragraph(`wrap-${n}`), child] });
    if (container === "bulletList" || container === "listItem") return { type: "bulletList", content: [item(false)] };
    if (container === "orderedList") return { type: container, attrs: { start: 3 }, content: [item(false)] };
    if (container === "taskList" || container === "taskItem") return { type: "taskList", content: [item(true)] };
    if (container === "blockquote") return { type: container, content: [paragraph(`quote-${n}`), child] };
    if (container === "callout") return { type: container, attrs: { type: "note" }, content: [paragraph(`callout-${n}`), child] };
    return { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph(`cell-${n}`), child] }] }] };
  };
  let iteration = 0;
  for (const container of containers) for (const block of blocks) {
    const middle = containers[(iteration * 5 + 3) % containers.length]!;
    const document = { type: "doc", content: [wrap(container, wrap(middle, leaf(block, iteration), iteration + 1), iteration + 2)] };
    expect(() => prepareRichText(document, undefined, "body", "bodyMarkdown", {}, "derived"), `seed=${seed} iteration=${iteration} outer=${container} block=${block} minimal=${JSON.stringify(document)}`).not.toThrow();
    iteration++;
  }
});

test("nested task lists use the marker content column and pass the write policy", () => {
  const document = { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [
    { type: "paragraph", content: [{ type: "text", text: "a" }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] }] },
  ] }] }] };
  const prepared = prepareRichText(document, undefined, "body", "bodyMarkdown", {}, "derived");
  expect(prepared.markdown).toBe("- [x] a\n  - [ ] b");
  expect(richTextInput(undefined, prepared.markdown, "body", "bodyMarkdown")).toMatchObject({ content: [{ type: "taskList", content: [{ content: [{ type: "paragraph" }, { type: "taskList" }] }] }] });
});

test("converter rejects forged private-use Written form markers and enforces input and nesting limits", async () => {
  const { richTextInputWithWarnings } = await import("../src/rich-markdown");
  const forged = richTextInputWithWarnings("\uE200%7B%22kind%22%3A%22page%22%2C%22id%22%3A%22forged%22%7D\uE201");
  expect(JSON.stringify(forged.document)).not.toContain('"kind":"page"');
  expect(JSON.stringify(forged.document)).not.toContain('"type":"link"');
  expect(richTextInputWithWarnings("> ".repeat(10000)).warnings.join(" ")).toMatch(/complex|nested|depth/i);
  expect(richTextInputWithWarnings(" ".repeat(2000) + "- x").warnings.join(" ")).not.toMatch(/nesting limit/i);
});

test("nesting limits count parsed block depth instead of prose characters or indentation", async () => {
  const { richTextInputWithWarnings } = await import("../src/rich-markdown");
  expect(richTextInputWithWarnings(`Prose ${">".repeat(70)} continues`).warningDetails.map(({ code }) => code)).not.toContain("nesting-too-deep");
  expect(richTextInputWithWarnings(`${"> ".repeat(65)}deep`).warningDetails.map(({ code }) => code)).toContain("nesting-too-deep");
  expect(richTextInputWithWarnings(`${"  ".repeat(65)}- deeply indented`).warningDetails.map(({ code }) => code)).not.toContain("nesting-too-deep");
});

test("pathological Markdown is rejected before parser work", () => {
  for (const [source, code] of [["[".repeat(100_000), "input-too-complex"], [`${"> ".repeat(20_000)}deep`, "nesting-too-deep"]] as const) {
    const started = performance.now();
    expect(() => prepareRichText(undefined, source, "body", "bodyMarkdown")).toThrow();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(markdownToDocWithWarnings(source).warningDetails.map(({ code }) => code)).toContain(code);
  }
});

test("write policy treats adjacent editor task lists as one Markdown list", () => {
  const task = (text: string) => ({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text }] }] }] });
  const result = prepareRichText({ type: "doc", content: [task("one"), task("two")] }, undefined, "content", "contentMarkdown");
  expect(result.markdown).toBe("- [ ] one\n\n- [ ] two");
});

test("seeded Written form generator covers the editor schema and both round-trip directions", async () => {
  const { getSchema } = await import("@tiptap/core");
  const { wikiEditorExtensions } = await import("../src/wiki-editor-extensions");
  const { writtenFormAttributePolicy } = await import("../src/written-form");
  const schema = getSchema(wikiEditorExtensions);
  let seed = 0x7a31;
  const initialSeed = seed;
  const random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const names = Object.keys(schema.nodes);
  const marks = Object.keys(schema.marks);
  const seenNodes = new Set<string>(["doc"]), seenMarks = new Set<string>();
  const markNode = (text: string, index: number) => {
    const type = marks[index % marks.length]!;
    const variation = Math.floor(index / marks.length);
    const attrs = type === "link" ? variation % 2 === 0 ? { href: `weft://${["page", "wiki", "work-item"][variation % 3]}/target-${variation}`, kind: ["page", "wiki", "work-item"][variation % 3], targetId: `target-${variation}`, target: text } : { href: `https://example.test/${variation} a`, title: null } : type === "textStyle" || type === "highlight" ? { color: ["purple", "#f97316", "blue"][variation % 3] } : undefined;
    seenMarks.add(type);
    return { type: "text", text, marks: [{ type, ...(attrs ? { attrs } : {}) }] };
  };
  const make = (index: number): any => {
    const text = index % 17 === 0 ? " a " : ["# x", "*a*", "@{x}", "a==b==c", "x`y", "[z](<x>)"][Math.floor(random() * 6)]!;
    const paragraph = () => ({ type: "paragraph", content: [markNode(text, index)] });
    const block = [
      paragraph(), { type: "heading", attrs: { level: Math.floor(index / 12) % 6 + 1 }, content: [markNode(text, index)] },
      { type: "blockquote", content: [paragraph()] }, { type: "codeBlock", attrs: { language: ["typescript", "mermaid", null][Math.floor(index / 12) % 3] }, content: [{ type: "text", text }] },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph()] }] },
      { type: "orderedList", attrs: { start: Math.floor(index / 12) % 9 + 1 }, content: [{ type: "listItem", content: [paragraph()] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: Math.floor(index / 12) % 2 === 0 }, content: [paragraph()] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [paragraph()] }, { type: "tableCell", content: [paragraph()] }] }] },
      { type: "callout", attrs: { type: ["note", "warning", "tip"][Math.floor(index / 12) % 3], color: ["#f97316", "purple", null][Math.floor(index / 12) % 3], icon: ["🚀", "⚠️", "💡"][Math.floor(index / 12) % 3] }, content: [paragraph()] },
      { type: "assetImage", attrs: { assetId: index === 21 ? null : `asset-${index}`, alt: text } }, { type: "horizontalRule" },
      { type: "paragraph", content: [{ type: "mention", attrs: index === 23 ? { id: null, label: null } : { id: `m-${index}`, label: text } }, { type: "hardBreak" }, markNode(`line-${index}`, index + 1)] },
    ][index % 12]!;
    const walk = (n: any) => { seenNodes.add(n.type); n.content?.forEach(walk); };
    walk(block);
    const attributeMode = Math.floor(index / 12) % 3;
    const representative = (type: string, name: string): unknown => ({
      "callout.type": "warning", "callout.color": "purple", "callout.icon": "🚀",
      "assetImage.assetId": `asset-set-${index}`, "assetImage.alt": `alt-${index}`,
      "mention.id": `member-${index}`, "mention.label": `Member ${index}`,
      "codeBlock.language": "typescript", "heading.level": 3, "orderedList.start": 4,
      "taskItem.checked": true,
      "textStyle.color": "purple", "highlight.color": "#f97316",
    } as Record<string, unknown>)[`${type}.${name}`];
    const varyAttributes = (node: any) => {
      const specAttrs = (schema.nodes[node.type]?.spec.attrs ?? {}) as Record<string, { default?: unknown }>;
      for (const [name, spec] of Object.entries(specAttrs)) {
        node.attrs ??= {};
        if (attributeMode === 0) delete node.attrs[name];
        else if (attributeMode === 1 && spec.default === null) node.attrs[name] = null;
        else if (attributeMode === 2) {
          const value = representative(node.type, name);
          if (value !== undefined && writtenFormAttributePolicy[`node:${node.type}.${name}`]?.persisted) node.attrs[name] = value;
          else if (!Object.hasOwn(node.attrs, name)) node.attrs[name] = spec.default ?? null;
        }
      }
      if (node.attrs && !Object.keys(node.attrs).length) delete node.attrs;
      if (node.type === "mention" && node.attrs?.id == null && node.attrs?.label == null) node.attrs = { ...node.attrs, label: "Member" };
      for (const mark of node.marks ?? []) {
        const markAttrs = (schema.marks[mark.type]?.spec.attrs ?? {}) as Record<string, { default?: unknown }>;
        for (const [name, spec] of Object.entries(markAttrs)) {
          mark.attrs ??= {};
          if (attributeMode === 0) delete mark.attrs[name];
          else if (attributeMode === 1 && spec.default === null) mark.attrs[name] = null;
          else if (attributeMode === 2) {
            const value = representative(mark.type, name);
            if (value !== undefined && writtenFormAttributePolicy[`mark:${mark.type}.${name}`]?.persisted) mark.attrs[name] = value;
            else if (!Object.hasOwn(mark.attrs, name)) mark.attrs[name] = spec.default ?? null;
          }
        }
        if (mark.attrs && !Object.keys(mark.attrs).length) delete mark.attrs;
      }
      if (node.marks) node.marks = node.marks.filter((mark: any) => mark.type !== "link" || mark.attrs?.href != null || mark.attrs?.kind != null || mark.attrs?.targetId != null);
      node.content?.forEach(varyAttributes);
    };
    varyAttributes(block);
    return { type: "doc", content: [block] };
  };
  const normalize = (node: any) => normalizeRichTextDocument(node);
  const allowedWarnings = new Set(["structure-simplified", "task-state-simplified", "table-header-simplified", "code-language-simplified", "list-start-simplified", "callout-type-simplified", "image-alt-simplified", "heading-level-simplified", "attribute-not-persisted", "unsupported-html", "external-image", "unsafe-link", "unresolved-reference", "irregular-table", "deep-heading", "unsupported-callout-metadata", "unsupported-code-language", "unsafe-color", "unsupported-markdown"]);
  const shrinkForReport = (node: any): any => ({
    type: node.type,
    ...(node.attrs ? { attrs: Object.fromEntries(Object.entries(node.attrs).map(([key, value]) => [key, key === "alt" || key === "label" ? "x" : value])) } : {}),
    ...(node.text !== undefined ? { text: "x" } : {}),
    ...(node.marks ? { marks: node.marks } : {}),
    ...(node.content ? { content: node.content.map(shrinkForReport) } : {}),
  });
  const seenAttributeValues = new Map<string, Set<string>>();
  for (let i = 0; i < 2000; i++) {
    const document = make(i);
    const schemaDocument = schema.nodeFromJSON(document);
    schemaDocument.check();
    const expected = normalize(schemaDocument.toJSON());
    const recordAttrs = (node: any) => {
      for (const [name, value] of Object.entries(node.attrs ?? {})) {
        const key = `node:${node.type}.${name}`;
        if (writtenFormAttributePolicy[key]?.persisted) (seenAttributeValues.get(key) ?? (seenAttributeValues.set(key, new Set()), seenAttributeValues.get(key)!)).add(JSON.stringify(value));
      }
      for (const mark of node.marks ?? []) for (const [name, value] of Object.entries(mark.attrs ?? {})) {
        const key = `mark:${mark.type}.${name}`;
        if (writtenFormAttributePolicy[key]?.persisted) (seenAttributeValues.get(key) ?? (seenAttributeValues.set(key, new Set()), seenAttributeValues.get(key)!)).add(JSON.stringify(value));
      }
      node.content?.forEach(recordAttrs);
    };
    recordAttrs(schemaDocument.toJSON());
    const markdown = richTextMarkdown(document).markdown;
    const imported = richTextInputWithWarnings(markdown);
    const roundTrip = imported.document;
    expect(richTextTextContent(schema.nodeFromJSON(roundTrip).toJSON()), `seed=${initialSeed} iteration=${i} minimal=${JSON.stringify(shrinkForReport(document))}`).toEqual(richTextTextContent(expected));
    expect(imported.warningDetails.every(({ code }) => allowedWarnings.has(code)), `seed=${initialSeed} iteration=${i} warnings=${JSON.stringify(imported.warningDetails)} minimal=${JSON.stringify(shrinkForReport(document))}`).toBe(true);
    expect(richTextMarkdown(roundTrip).markdown, `seed=${initialSeed} iteration=${i} minimal=${JSON.stringify(shrinkForReport(document))}`).toBe(markdown);
    expect(() => prepareRichText(document, undefined, "body", "bodyMarkdown", {}, "derived"), `write-policy seed=${initialSeed} iteration=${i} minimal=${JSON.stringify(shrinkForReport(document))}`).not.toThrow();
  }
  expect([...seenNodes].sort()).toEqual(names.sort());
  expect([...seenMarks].sort()).toEqual(marks.sort());
  for (const [key, policy] of Object.entries(writtenFormAttributePolicy)) if (policy.persisted) expect(seenAttributeValues.get(key)?.size, `${key} must vary in generated documents`).toBeGreaterThan(1);
});

test("relative links are preserved", () => {
  const document = richTextInput(undefined, "[guide](../guide.md)", "body", "bodyMarkdown") as any;
  expect(document.content[0].content[0].marks).toEqual([{ type: "link", attrs: { href: "../guide.md" } }]);
  expect(richTextMarkdown(document).markdown).toBe("[guide](../guide.md)");
});

test("reference links keep a work item key, kind, and stable id", () => {
  const document = richTextInput(undefined, "[[ABC-12|work-item:item-12]]", "body", "bodyMarkdown") as any;
  expect(document.content[0].content[0]).toEqual({ type: "text", text: "ABC-12", marks: [{ type: "link", attrs: { href: "weft://work-item/item-12", kind: "work-item", targetId: "item-12", target: "ABC-12" } }] });
  expect(richTextMarkdown(document).markdown).toBe("[[ABC-12|work-item:item-12]]");
});

test("the readable bare work item key resolves when it is unambiguous", () => {
  const document = richTextInput(undefined, "[[ABC-12]]", "body", "bodyMarkdown", {
    resolveReference: (target, kind) => target === "ABC-12" && kind === "work-item" ? { kind: "work-item", id: "item-12", label: "ABC-12" } : null,
  }) as any;
  expect(document.content[0].content[0].marks[0].attrs).toMatchObject({ kind: "work-item", targetId: "item-12" });
});

test("page and wiki reference ids resolve without a title lookup", () => {
  for (const [written, kind, id] of [["[[Guide|page:p-1]]", "page", "p-1"], ["[[Home|wiki:w-1]]", "wiki", "w-1"]] as const) {
    const document = richTextInput(undefined, written, "body", "bodyMarkdown") as any;
    expect(document.content[0].content[0].marks[0].attrs).toMatchObject({ kind, targetId: id });
    expect(richTextMarkdown(document).markdown).toBe(written);
  }
});

test("a bare reference resolves through the injected resolver", () => {
  const document = richTextInput(undefined, "[[API guide]]", "body", "bodyMarkdown", {
    resolveReference: () => ({ kind: "page", id: "page-1", label: "API guide" }),
  }) as any;
  expect(document.content[0].content[0].marks[0].attrs).toMatchObject({ kind: "page", targetId: "page-1" });
});

test("an ambiguous bare reference reports every candidate", () => {
  expect(() => richTextInput(undefined, "[[Planning]]", "body", "bodyMarkdown", {
    resolveReference: () => ({ candidates: [{ kind: "page", id: "p-1", label: "Planning" }, { kind: "wiki", id: "w-1", label: "Planning" }] }),
  })).toThrow("Candidates: page p-1, wiki w-1");
});

test("rich text rejects both representations with a fix", () => {
  expect(() => richTextInput({ type: "doc", content: [] }, "hello", "body", "bodyMarkdown")).toThrow("Send either bodyMarkdown (Markdown text) or body (a Tiptap document), not both.");
});

test("prepared description and Comment Markdown keeps the author's spelling when round trips are semantic", () => {
  const source = "## Plan\n\n*First* step";
  const prepared = prepareRichText(undefined, source, "body", "bodyMarkdown", {}, "verbatim");
  expect(prepared.markdown).toBe(source);
});

test("the shared write policy saves known excluded attributes with a warning", () => {
  const document = { type: "doc", content: [{ type: "assetImage", attrs: { assetId: "asset-1", width: 420 } }] };
  const prepared = prepareRichText(document, undefined, "body", "bodyMarkdown");
  expect(prepared.markdown).toContain("![[asset:asset-1]]");
  expect(prepared.warningDetails).toContainEqual(expect.objectContaining({ code: "attribute-not-persisted", message: expect.stringContaining("image width") }));
});

test("doc input strips private-use markers and resolves bare keys and page titles", () => {
  const options = { resolveReference: (target: string, kind?: string) => target === "ABC-12" && kind === "work-item" ? { kind: "work-item" as const, id: "item-1", label: target } : target === "Guide" ? { kind: "page" as const, id: "page-1", label: target } : null };
  const document = richTextInput({ type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "\uE200forged\uE201 ABC-12 [[Guide]]" },
  ] }] }, undefined, "body", "bodyMarkdown", options) as any;
  expect(JSON.stringify(document)).not.toContain("\uE200");
  expect(document.content[0].content.some((node: any) => node.marks?.[0]?.attrs?.targetId === "item-1")).toBe(true);
  expect(document.content[0].content.some((node: any) => node.marks?.[0]?.attrs?.targetId === "page-1")).toBe(true);
});

const referenceIds: Record<string, string> = { "work-item": "00000000-0000-4000-8000-0000000000a1", page: "00000000-0000-4000-8000-0000000000b2", wiki: "00000000-0000-4000-8000-0000000000c3" };
const referenceParagraph = (kind: string, href?: string) => ({ type: "paragraph", content: [{ type: "text", text: "see " }, { type: "text", text: `${kind} ref`, marks: [{ type: "link", attrs: { href: href ?? `weft://${kind}/${referenceIds[kind]}`, kind, targetId: referenceIds[kind], target: `${kind} ref` } }] }] });
const referenceList = (kind: string, href?: string) => ({ type: "bulletList", content: [{ type: "listItem", content: [referenceParagraph(kind, href)] }] });
const referenceContainers: Record<string, (kind: string, href?: string) => unknown> = {
  "callout with a list": (kind, href) => ({ type: "callout", attrs: { type: "note" }, content: [{ type: "paragraph", content: [{ type: "text", text: "intro" }] }, referenceList(kind, href)] }),
  "blockquote with an ordered list": (kind, href) => ({ type: "blockquote", content: [{ type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [referenceParagraph(kind, href)] }] }] }),
  "table cell with a list": (kind, href) => ({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "head" }] }] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [referenceList(kind, href)] }] }] }),
};

test("an internal reference link inside a container block survives every container and every kind", () => {
  for (const [container, build] of Object.entries(referenceContainers)) for (const kind of ["work-item", "page", "wiki"]) {
    const document = { type: "doc", content: [build(kind)] };
    const prepared = prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived");
    const stored = markdownToDocWithWarnings(prepared.markdown, { preserveStableReferences: true, trustedSource: true }).document;
    expect(JSON.stringify(stored), `${container} / ${kind}`).toContain(`weft://${kind}/${referenceIds[kind]}`);
    expect(richTextTextContent(stored), `${container} / ${kind}`).toEqual(richTextTextContent(document));
  }
});

test("a forged internal link whose href does not match its kind and target is dropped with a warning", () => {
  for (const [container, build] of Object.entries(referenceContainers)) for (const kind of ["work-item", "page", "wiki"]) {
    const forged = build(kind, "weft://work-item/00000000-0000-4000-8000-00000000ffff");
    const marker = `<!-- wf-block:${encodeURIComponent(JSON.stringify(forged))} -->`;
    const imported = markdownToDocWithWarnings(marker, { preserveStableReferences: true });
    expect(JSON.stringify(imported.document), `${container} / ${kind}`).not.toContain("ffff");
    expect(imported.warningDetails.map(({ code }) => code), `${container} / ${kind}`).toContain("unsafe-link");
    const javascript = markdownToDocWithWarnings(`<!-- wf-block:${encodeURIComponent(JSON.stringify(build(kind, "javascript:alert(1)")))} -->`);
    expect(JSON.stringify(javascript.document)).not.toContain("javascript:");
  }
});

test("a task item that starts with a code block is written exactly (regression: the code fence cannot follow a checkbox)", () => {
  const document = { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: "w54" }] }, { type: "paragraph", content: [{ type: "text", text: "after" }] }] }] }] };
  const prepared = prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived");
  expect(richTextTextContent(markdownToDocWithWarnings(prepared.markdown, { trustedSource: true }).document)).toEqual(richTextTextContent(document));
});

test("a change to task state, header role, code language, list start, callout type or image alt names itself in a specific warning", () => {
  const base = (patch: (document: any) => void) => {
    const document: any = { type: "doc", content: [
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "t" }] }] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "h" }] }] }] }] },
      { type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: "{}" }] },
      { type: "orderedList", attrs: { start: 4 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "o" }] }] }] },
      { type: "callout", attrs: { type: "warning" }, content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] },
      { type: "assetImage", attrs: { assetId: "a", alt: "description" } },
    ] };
    const changed = structuredClone(document);
    patch(changed);
    return describeStructureChanges(document, changed);
  };
  expect(base((d) => { d.content[0].content[0].attrs.checked = false; }).map(({ code }) => code)).toEqual(["task-state-simplified"]);
  expect(base((d) => { d.content[1].content[0].content[0].type = "tableCell"; }).map(({ code }) => code)).toEqual(["table-header-simplified"]);
  expect(base((d) => { d.content[2].attrs.language = "python"; }).map(({ code }) => code)).toEqual(["code-language-simplified"]);
  expect(base((d) => { d.content[3].attrs.start = 1; }).map(({ code }) => code)).toEqual(["list-start-simplified"]);
  expect(base((d) => { d.content[4].attrs.type = "note"; }).map(({ code }) => code)).toEqual(["callout-type-simplified"]);
  expect(base((d) => { d.content[5].attrs.alt = null; }).map(({ code }) => code)).toEqual(["image-alt-simplified"]);
  expect(base(() => {})).toEqual([]);
  expect(base((d) => { d.content[0].content[0].attrs.checked = false; d.content[0].content[0].content.push({ type: "paragraph", content: [{ type: "text", text: "more" }] }); }).map(({ code }) => code)).toEqual(["structure-simplified", "task-state-simplified"]);
});

test("a callout type the Written form cannot carry saves with a callout-type warning instead of the generic one", () => {
  const document = { type: "doc", content: [{ type: "callout", attrs: { type: "Warning" }, content: [{ type: "paragraph", content: [{ type: "text", text: "careful" }] }] }] };
  const prepared = prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived");
  expect(prepared.warningDetails.map(({ code }) => code)).toContain("callout-type-simplified");
  expect(prepared.warningDetails.map(({ code }) => code)).not.toContain("structure-simplified");
});

test("a heading level above six is clamped to six in the stored document as well as in the Markdown", () => {
  const document = { type: "doc", content: [{ type: "heading", attrs: { level: 99 }, content: [{ type: "text", text: "deep" }] }, { type: "heading", attrs: { level: 0 }, content: [{ type: "text", text: "zero" }] }] };
  const prepared = prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived") as { document: any; markdown: string; warningDetails: Array<{ code: string }> };
  expect(prepared.document.content.map((node: any) => node.attrs.level)).toEqual([6, 1]);
  expect(prepared.markdown).toContain("###### deep");
  expect(prepared.warningDetails.map(({ code }) => code)).toContain("heading-level-simplified");
});

test("code whose lines end in spaces is written exactly inside list items, quotes and task items", () => {
  const code = { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "first  \n  indented   \nlast \n" }] };
  const wrappers = [
    (inner: unknown) => ({ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }, inner] }] }),
    (inner: unknown) => ({ type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }, inner] }] }),
    (inner: unknown) => ({ type: "blockquote", content: [inner] }),
    (inner: unknown) => ({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }, inner] }] }),
    (inner: unknown) => ({ type: "callout", attrs: { type: "note" }, content: [inner] }),
  ];
  for (const [index, wrap] of wrappers.entries()) {
    const document = { type: "doc", content: [wrap(code)] };
    const prepared = prepareRichText(document, undefined, "content", "contentMarkdown", {}, "derived");
    const stored = markdownToDocWithWarnings(prepared.markdown, { trustedSource: true }).document;
    expect(JSON.stringify(stored), `wrapper ${index}`).toContain("first  ");
    expect(richTextTextContent(stored), `wrapper ${index}`).toEqual(richTextTextContent(document));
  }
});

test("URL and e-mail looking text is stored clean: no invisible characters, and it reads back as the same text", () => {
  for (const text of ["See www.example.com/a_b_c for details", "email me@x.org or https://a.b/c_d_e now", "Use <https://example.com> here", "mailto:a@b.com and ftp://x.y/z", "www.a_"]) {
    const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
    for (const written of [prepareRichText(document, undefined, "b", "m", {}, "derived").markdown, richTextMarkdown(document, { paranoid: "all" }).markdown]) {
      expect(written, text).not.toContain("⁠");
      expect(richTextTextContent(markdownToDocWithWarnings(written, { trustedSource: true }).document), text).toEqual(richTextTextContent(document));
    }
  }
});

test("a list item holding a paragraph, an image and a rule keeps all three (the rule is not a setext underline)", () => {
  for (const [list, item, extra] of [["bulletList", "listItem", {}], ["orderedList", "listItem", { attrs: { start: 1 } }], ["taskList", "taskItem", {}]] as const) {
    const document = { type: "doc", content: [{ type: list, ...extra, content: [{ type: item, ...(item === "taskItem" ? { attrs: { checked: false } } : {}), content: [{ type: "paragraph", content: [{ type: "text", text: "caption" }] }, { type: "assetImage", attrs: { assetId: "a1", alt: null } }, { type: "horizontalRule" }] }] }] };
    const prepared = prepareRichText(document, undefined, "c", "m", {}, "derived");
    const back = JSON.stringify(markdownToDocWithWarnings(prepared.markdown, { trustedSource: true }).document);
    expect(back, list).toContain("horizontalRule");
    expect(back, list).not.toContain('"heading"');
    expect(prepared.warningDetails.map(({ code }) => code), list).not.toContain("structure-simplified");
  }
});

test("a callout with a colour and no icon stays without an icon and saves with no warning (the default icon is a display default)", () => {
  const document = { type: "doc", content: [{ type: "callout", attrs: { type: "note", color: "red" }, content: [{ type: "paragraph", content: [{ type: "text", text: "coloured" }] }] }] };
  const prepared = prepareRichText(document, undefined, "c", "m", {}, "derived") as { document: any; markdown: string; warningDetails: Array<{ code: string }> };
  const stored = markdownToDocWithWarnings(prepared.markdown, { trustedSource: true }).document as any;
  expect(prepared.markdown).toContain("color=red");
  expect(prepared.markdown).not.toContain("icon=");
  expect(stored.content[0].attrs.icon).toBeUndefined();
  expect(prepared.warningDetails.map(({ code }) => code)).toEqual([]);
  const withDefaultIcon = prepareRichText({ type: "doc", content: [{ type: "callout", attrs: { type: "note", icon: "💡", color: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "plain" }] }] }] }, undefined, "c", "m", {}, "derived");
  expect(withDefaultIcon.warningDetails.map(({ code }) => code)).toEqual([]);
});
