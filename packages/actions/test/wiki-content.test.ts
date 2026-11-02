import { expect, test } from "bun:test";
import { markdownToDoc } from "../src/markdown-doc";

test("wikiContentOf turns Markdown into a doc, keeps a doc, and rejects anything else", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  expect(wikiContentOf("# Title\n\nbody")).toEqual(markdownToDoc("# Title\n\nbody"));
  const doc = { type: "doc", content: [{ type: "paragraph" }] };
  expect(wikiContentOf(doc)).toBe(doc);
  expect(wikiContentOf(undefined)).toBeUndefined();
  expect(wikiContentOf(null)).toBeNull();
  expect(() => wikiContentOf(42)).toThrow("content must be Markdown text or a Tiptap doc");
  expect(() => wikiContentOf({ foo: 1 })).toThrow("content must be Markdown text or a Tiptap doc");
});

test("a document the editor schema cannot build is refused", async () => {
  const { wikiContentOf } = await import("../src/wiki-content");
  expect(() => wikiContentOf({ type: "doc", content: [{ type: "unknownNode" }] })).toThrow("content is not a valid document");
});
