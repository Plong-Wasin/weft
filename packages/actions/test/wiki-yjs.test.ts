import { expect, test } from "bun:test";
import { normalizeAssetImages, wikiContentFromYState, wikiYStateFromContent } from "../src/wiki-yjs";

test("wiki Yjs conversion round-trips every editor node and mark", () => {
  const content = { type: "doc", content: [
    ...[1, 2, 3, 4, 5, 6].map((level) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text: `h${level}` }] })),
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "bullet" }] }] }] },
    { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "ordered" }] }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph" }] }, { type: "tableCell", content: [{ type: "paragraph" }] }] }] },
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quote" }] }] },
    { type: "codeBlock", content: [{ type: "text", text: "code" }] },
    { type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "callout" }] }] },
    { type: "horizontalRule" }, { type: "paragraph", content: [
      { type: "text", text: "emoji 😀 " }, { type: "mention", attrs: { id: "member-id", label: "Member" } },
      { type: "text", text: " ", marks: [{ type: "textStyle", attrs: { color: "#7c3aed" } }] },
    ] },
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
  expect([...marks]).toEqual(["textStyle"]);
  expect(restored.content?.find((node: { type: string }) => node.type === "assetImage")).toMatchObject({ attrs: { assetId: "asset-id", width: 420, alignment: "center" } });
  expect(JSON.stringify(restored)).toContain("#7c3aed");
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
