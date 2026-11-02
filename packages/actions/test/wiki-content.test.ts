import { expect, test } from "bun:test";
import { markdownToDoc } from "../src/markdown-doc";

test("wikiContentOf turns Markdown into a doc, keeps a doc, and rejects anything else", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  expect(wikiContentOf("# Title\n\nbody")).toEqual(markdownToDoc("# Title\n\nbody"));
  const doc = { type: "doc", content: [{ type: "paragraph" }] };
  expect(wikiContentOf(doc)).toBe(doc);
  expect(wikiContentOf(undefined)).toBeUndefined();
  expect(() => wikiContentOf(42)).toThrow("content must be Markdown text or a Tiptap doc");
  expect(() => wikiContentOf({ foo: 1 })).toThrow("content must be Markdown text or a Tiptap doc");
});

test("a document the editor schema cannot build is refused", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  expect(() => wikiContentOf({ type: "doc", content: [{ type: "unknownNode" }] })).toThrow("content is not a valid document");
});

test("an object without type doc is refused even when it has a content array", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  expect(() => wikiContentOf({ content: [] })).toThrow("content must be Markdown text or a Tiptap doc");
  });

test("null content and structurally invalid documents are refused", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  expect(() => wikiContentOf(null)).toThrow("content must be Markdown text or a Tiptap doc");
  const bad = (content: unknown[]) => () => wikiContentOf({ type: "doc", content });
  expect(bad([{ type: "paragraph", content: [{ type: "paragraph" }] }])).toThrow("content is not a valid document");
  expect(bad([])).toThrow("content is not a valid document");
});

test("Markdown the editor schema would reject is repaired into a valid document", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  const { assertWikiDoc } = await import("../src/wiki-yjs");
  for (const md of ["- - a\n  - b", "- ```\n  x\n  ```", "- # T", ">", "1. > quote", "- "]) {
    const doc = wikiContentOf(md);
    expect(() => assertWikiDoc(doc), md).not.toThrow();
  }
});
