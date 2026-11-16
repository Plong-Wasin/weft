import { expect, test } from "bun:test";
import { markdownToDoc } from "../src/markdown-doc";

test("wikiContentOf turns Markdown into a doc, keeps a doc, and rejects anything else", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  expect(await wikiContentOf("# Title\n\nbody")).toEqual(markdownToDoc("# Title\n\nbody"));
  const doc = { type: "doc", content: [{ type: "paragraph" }] };
  expect(await wikiContentOf(doc)).toBe(doc);
  expect(await wikiContentOf(undefined)).toBeUndefined();
  await expect(wikiContentOf(42)).rejects.toThrow("content must be Markdown text or a Tiptap doc");
  await expect(wikiContentOf({ foo: 1 })).rejects.toThrow("content must be Markdown text or a Tiptap doc");
});

test("a document the editor schema cannot build is refused", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  await expect(wikiContentOf({ type: "doc", content: [{ type: "unknownNode" }] })).rejects.toThrow("content is not a valid document");
});

test("an object without type doc is refused even when it has a content array", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  await expect(wikiContentOf({ content: [] })).rejects.toThrow("content must be Markdown text or a Tiptap doc");
  });

test("null content and structurally invalid documents are refused", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  await expect(wikiContentOf(null)).rejects.toThrow("content must be Markdown text or a Tiptap doc");
  const bad = (content: unknown[]) => wikiContentOf({ type: "doc", content });
  await expect(bad([{ type: "paragraph", content: [{ type: "paragraph" }] }])).rejects.toThrow("content is not a valid document");
  await expect(bad([])).rejects.toThrow("content is not a valid document");
});

test("Markdown the editor schema would reject is repaired into a valid document", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  const { assertWikiDoc } = await import("../src/wiki-yjs");
  for (const md of ["- - a\n  - b", "- ```\n  x\n  ```", "- # T", ">", "1. > quote", "- "]) {
    const doc = await wikiContentOf(md);
    expect(() => assertWikiDoc(doc), md).not.toThrow();
  }
});
