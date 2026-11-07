import { expect, test } from "bun:test";
import { assertWikiDoc, normalizeAssetImages, wikiContentFromYState, wikiYStateFromContent } from "../src/wiki-yjs";

test("wiki Yjs conversion round-trips every editor node and mark", () => {
  const content = { type: "doc", content: [
    ...[1, 2, 3, 4, 5, 6].map((level) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text: `h${level}` }] })),
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "bullet" }] }] }] },
    { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "ordered" }] }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph" }] }, { type: "tableCell", content: [{ type: "paragraph" }] }] }] },
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quote" }] }] },
    { type: "codeBlock", content: [{ type: "text", text: "code" }] },
    { type: "callout", attrs: { color: "#3b82f6", icon: "🚀" }, content: [{ type: "paragraph", content: [{ type: "text", text: "callout" }] }] },
    { type: "horizontalRule" }, { type: "paragraph", content: [
      { type: "text", text: "emoji 😀 " }, { type: "mention", attrs: { id: "member-id", label: "Member" } },
      { type: "text", text: " ", marks: [{ type: "textStyle", attrs: { color: "#7c3aed" } }, { type: "underline" }, { type: "highlight", attrs: { color: "#facc15" } }] },
    ] },
    { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [{ type: "text", text: "aligned" }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { backgroundColor: "#86efac" }, content: [{ type: "paragraph" }] }] }] },
    { type: "assetImage", attrs: { assetId: "asset-id", width: 420, alignment: "center" } },
  ] };
  const restored = wikiContentFromYState(wikiYStateFromContent(content));
  const types = new Set<string>();
  const marks = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const node = value as { type?: string; marks?: { type: string }[]; content?: unknown[] };
    if (node.type) types.add(node.type);
    for (const mark of node.marks ?? []) marks.add(mark.type);
    for (const child of node.content ?? []) visit(child);
  };
  visit(restored);
  expect([...types].sort()).toEqual(["assetImage", "blockquote", "bulletList", "callout", "codeBlock", "doc", "heading", "horizontalRule", "listItem", "mention", "orderedList", "paragraph", "table", "tableCell", "tableHeader", "tableRow", "taskItem", "taskList", "text"].sort());
  expect([...marks].sort()).toEqual(["highlight", "textStyle", "underline"].sort());
  expect(restored.content?.find((node: { type: string }) => node.type === "assetImage")).toMatchObject({ attrs: { assetId: "asset-id", width: 420, alignment: "center" } });
  expect(JSON.stringify(restored)).toContain("#7c3aed");
  expect(JSON.stringify(restored)).toContain("#facc15");
  expect(JSON.stringify(restored)).toContain("#86efac");
  expect(JSON.stringify(restored)).toContain("center");
  expect(restored.content?.find((node: { type: string }) => node.type === "callout")).toMatchObject({ attrs: { color: "#3b82f6", icon: "🚀" } });
});

test("legacy inline image documents load as block images while preserving surrounding text", () => {
  const legacy = { type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "before " }, { type: "assetImage", attrs: { assetId: "legacy-image" } }, { type: "text", text: "after" },
  ] }] };
  const expected = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "assetImage", attrs: { assetId: "legacy-image", width: null, alignment: "center" } },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ] };
  expect(normalizeAssetImages(legacy)).toEqual(expected);
  expect(wikiContentFromYState(wikiYStateFromContent(legacy))).toEqual(expected);
});

test("inline images normalise to valid documents in every container and keep their text", () => {
  const img = { type: "assetImage", attrs: { assetId: "a1" } };
  const para = (inline: unknown[]) => ({ type: "paragraph", content: inline });
  const text = (value: string) => ({ type: "text", text: value });
  const inline = () => [img, text("tail")];
  const wrap = (type: string, children: unknown[], attrs?: unknown) => ({ type: "doc", content: [{ type, ...(attrs ? { attrs } : {}), content: children }] });
  const cases: Record<string, unknown> = {
    listItem: wrap("bulletList", [{ type: "listItem", content: [para(inline())] }]),
    taskItem: wrap("taskList", [{ type: "taskItem", attrs: { checked: false }, content: [para(inline())] }]),
    heading: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [text("title "), img, text("more")] }] },
    imageOnlyHeading: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [img] }] },
    blockquote: wrap("blockquote", [para(inline())]),
    callout: wrap("callout", [para(inline())], { color: "#3b82f6", icon: "x" }),
    tableCell: wrap("table", [{ type: "tableRow", content: [{ type: "tableCell", content: [para(inline())] }] }]),
  };
  for (const [name, content] of Object.entries(cases)) {
    const normalized = normalizeAssetImages(content);
    assertWikiDoc(content);
    assertWikiDoc(normalized);
    const restored = wikiContentFromYState(wikiYStateFromContent(content));
    assertWikiDoc(restored);
    const json = JSON.stringify(restored);
    expect(json).toContain("a1");
    if (name !== "imageOnlyHeading") expect(json).toContain(name === "heading" ? "title more" : "tail");
  }
});
