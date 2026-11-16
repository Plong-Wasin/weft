import { expect, test } from "bun:test";
import * as Y from "yjs";
import { wikiContentFromYState, wikiYStateAfterContent, wikiYStateFromContent } from "../src/wiki-yjs";

const paragraphs = (prefix: string, count: number) => ({ type: "doc", content: Array.from({ length: count }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `${prefix} ${index} some words that make the block longer` }] })) });

test("replacing a 190 KB Page with another large document takes seconds, and the result is the new document", () => {
  const before = paragraphs("old", 2_500), after = paragraphs("new", 2_500);
  const state = wikiYStateFromContent(before);
  const started = performance.now();
  const next = wikiYStateAfterContent(state, after);
  expect(performance.now() - started).toBeLessThan(5_000);
  const text = JSON.stringify(wikiContentFromYState(next));
  expect(text).toContain("new 2499 some words");
  expect(text).not.toContain("old 0 some words");
}, 180_000);

test("a large edit keeps the unchanged blocks at both ends of the document", () => {
  const before = paragraphs("same", 2_000);
  const after = { type: "doc", content: [...before.content.slice(0, 1_000), { type: "paragraph", content: [{ type: "text", text: "inserted" }] }, ...before.content.slice(1_000)] };
  const state = wikiYStateFromContent(before);
  const next = wikiYStateAfterContent(state, after);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, next);
  expect(JSON.stringify(wikiContentFromYState(next))).toContain("inserted");
  // Applied on top of the old state, the update only adds: the old blocks were not deleted and recreated.
  const old = new Y.Doc();
  Y.applyUpdate(old, state);
  const diff = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(old));
  expect(diff.length).toBeLessThan(2_000);
}, 60_000);
