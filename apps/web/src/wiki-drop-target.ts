export type WikiDropTarget = { id: string; collectionId: string; parentId: string | null; descendants: ReadonlySet<string>; canEdit: boolean };
export type WikiDropDecision = { kind: "nest" | "top-level" | "move-collection"; parentId: string | null; collectionId: string } | null;

/** Describes a valid Wiki page drop. Descendants and read-only pages are never targets. */
export function wikiDropDecision(source: WikiDropTarget, target: WikiDropTarget | { id: string; collectionId: string; header: true }, canMoveAcrossCollections: boolean): WikiDropDecision {
  if (!source.canEdit || source.id === target.id) return null;
  if ("header" in target) {
    if (target.collectionId === source.collectionId) return source.parentId === null ? null : { kind: "top-level", parentId: null, collectionId: source.collectionId };
    return canMoveAcrossCollections ? { kind: "move-collection", parentId: null, collectionId: target.collectionId } : null;
  }
  if (source.descendants.has(target.id)) return null;
  if (target.collectionId !== source.collectionId) return canMoveAcrossCollections ? { kind: "move-collection", parentId: null, collectionId: target.collectionId } : null;
  return { kind: "nest", parentId: target.id, collectionId: source.collectionId };
}
