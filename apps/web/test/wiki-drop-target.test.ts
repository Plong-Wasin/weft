import { expect, test } from "bun:test";
import { wikiDropDecision, type WikiDropTarget } from "../src/wiki-drop-target";

const source: WikiDropTarget = { id: "a", collectionId: "c1", parentId: "b", descendants: new Set(["b", "c"]), canEdit: true };

test("Wiki drop targets nest within a Collection and un-nest on its header", () => {
  expect(wikiDropDecision(source, { id: "other", collectionId: "c1", parentId: null, descendants: new Set(), canEdit: true }, false)).toEqual({ kind: "nest", parentId: "other", collectionId: "c1" });
  expect(wikiDropDecision(source, { id: "c1", collectionId: "c1", header: true }, false)).toEqual({ kind: "top-level", parentId: null, collectionId: "c1" });
});

test("Wiki drop targets reject descendants and read-only sources, and gate cross-Collection moves", () => {
  expect(wikiDropDecision(source, { id: "c", collectionId: "c1", parentId: "b", descendants: new Set(), canEdit: true }, false)).toBeNull();
  expect(wikiDropDecision({ ...source, canEdit: false }, { id: "other", collectionId: "c1", parentId: null, descendants: new Set(), canEdit: true }, false)).toBeNull();
  expect(wikiDropDecision(source, { id: "c2", collectionId: "c2", header: true }, false)).toBeNull();
  expect(wikiDropDecision(source, { id: "c2", collectionId: "c2", header: true }, true)).toEqual({ kind: "move-collection", parentId: null, collectionId: "c2" });
});
