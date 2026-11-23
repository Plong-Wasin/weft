import { expect, test } from "bun:test";
import { wikiDropDecision, wikiDropPosition, type WikiDropTarget } from "../src/wiki-drop-target";

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

test("Wiki drop targets place a page before or after a sibling in the target's parent", () => {
  const sibling = { id: "s", collectionId: "c1", parentId: "p", descendants: new Set<string>(), canEdit: true };
  expect(wikiDropDecision(source, sibling, false, "before")).toEqual({ kind: "before", parentId: "p", collectionId: "c1" });
  expect(wikiDropDecision(source, sibling, false, "after")).toEqual({ kind: "after", parentId: "p", collectionId: "c1" });
  const topLevel = { id: "t", collectionId: "c1", parentId: null, descendants: new Set<string>(), canEdit: true };
  expect(wikiDropDecision(source, topLevel, false, "before")).toEqual({ kind: "before", parentId: null, collectionId: "c1" });
  // The source's own descendants and the source itself are never targets, even at an edge.
  expect(wikiDropDecision(source, { id: "c", collectionId: "c1", parentId: "b", descendants: new Set(), canEdit: true }, false, "after")).toBeNull();
  expect(wikiDropDecision(source, { id: "a", collectionId: "c1", parentId: null, descendants: new Set(), canEdit: true }, false, "before")).toBeNull();
  // A sibling in another Collection moves the page into that Collection only when allowed, and lands it at the top level.
  const elsewhere = { id: "e", collectionId: "c2", parentId: null, descendants: new Set<string>(), canEdit: true };
  expect(wikiDropDecision(source, elsewhere, false, "after")).toBeNull();
  expect(wikiDropDecision(source, elsewhere, true, "after")).toEqual({ kind: "move-collection", parentId: null, collectionId: "c2" });
});

test("A pointer over a Wiki row maps its top and bottom quarters to before and after, and the middle to nest", () => {
  expect(wikiDropPosition(0, 40)).toBe("before");
  expect(wikiDropPosition(9, 40)).toBe("before");
  expect(wikiDropPosition(20, 40)).toBe("nest");
  expect(wikiDropPosition(31, 40)).toBe("after");
  expect(wikiDropPosition(40, 40)).toBe("after");
  expect(wikiDropPosition(5, 0)).toBe("nest");
});

test("nothing can be placed beside a page whose parent is hidden, but it can still be nested into", () => {
  const source = { id: "a", collectionId: "c", parentId: null, descendants: new Set<string>(), canEdit: true };
  const orphan = { id: "b", collectionId: "c", parentId: "hidden", descendants: new Set<string>(), canEdit: true, orphan: true };
  expect(wikiDropDecision(source, orphan, false, "before")).toBeNull();
  expect(wikiDropDecision(source, orphan, false, "after")).toBeNull();
  expect(wikiDropDecision(source, orphan, false, "nest")?.kind).toBe("nest");
});
