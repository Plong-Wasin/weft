export type WikiDropTarget = { id: string; collectionId: string; parentId: string | null; descendants: ReadonlySet<string>; canEdit: boolean };
/** Where a row is dropped: the middle nests under it; the top and bottom edges place the page beside it. */
export type WikiDropPosition = "nest" | "before" | "after";
export type WikiDropDecision = { kind: "nest" | "before" | "after" | "top-level" | "move-collection"; parentId: string | null; collectionId: string } | null;

/** Describes a valid Wiki page drop. Descendants and read-only pages are never targets. */
export function wikiDropDecision(source: WikiDropTarget, target: WikiDropTarget | { id: string; collectionId: string; header: true }, canMoveAcrossCollections: boolean, position: WikiDropPosition = "nest"): WikiDropDecision {
  if (!source.canEdit || source.id === target.id) return null;
  if ("header" in target) {
    if (target.collectionId === source.collectionId) return source.parentId === null ? null : { kind: "top-level", parentId: null, collectionId: source.collectionId };
    return canMoveAcrossCollections ? { kind: "move-collection", parentId: null, collectionId: target.collectionId } : null;
  }
  if (source.descendants.has(target.id)) return null;
  if (target.collectionId !== source.collectionId) return canMoveAcrossCollections ? { kind: "move-collection", parentId: null, collectionId: target.collectionId } : null;
  if (position === "nest") return { kind: "nest", parentId: target.id, collectionId: source.collectionId };
  return { kind: position, parentId: target.parentId, collectionId: source.collectionId };
}

/** The part of a row under the pointer: the top and bottom quarters place beside it, the middle nests. */
export function wikiDropPosition(offset: number, height: number): WikiDropPosition {
  if (height <= 0) return "nest";
  const ratio = offset / height;
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "nest";
}
