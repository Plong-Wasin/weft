import { and, eq, inArray, isNull } from "drizzle-orm";
import { assets, collectionMembers, collections, comments, projects, wikiPageShares, wikiPages, workItems, type Database } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";

type RichTextNode = { type?: string; attrs?: Record<string, unknown>; content?: RichTextNode[] };

const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate embedded images for every write surface; shared workspace assets must be visible to the writer. */
export async function validateRichTextAssets(database: Database, document: unknown, ownerType: "work_item" | "wiki_page", ownerId: string, userId?: string, previouslyStoredDocument?: unknown) {
  const { invalid, unavailable } = await unavailableRichTextAssets(database, document, ownerType, ownerId, userId, previouslyStoredDocument);
  if (invalid.length) throw new ActionError("An image reference is not valid.", 400, "asset-invalid");
  if (unavailable.length) throw new ActionError("An image is not available in the content being saved.", 400, "asset-unavailable");
}

/** Image ids in a document that are not asset ids at all (`invalid`) or that the writer cannot use (`unavailable`). Never throws for either, so a live save can store the state as typed. */
export async function unavailableRichTextAssets(database: Database, document: unknown, ownerType: "work_item" | "wiki_page", ownerId: string, userId?: string, previouslyStoredDocument?: unknown): Promise<{ invalid: string[]; unavailable: string[] }> {
  const ids = new Set<string>();
  const previouslyStoredIds = new Set<string>();
  const visit = (node: RichTextNode) => {
    if (node.type === "assetImage" && typeof node.attrs?.assetId === "string" && node.attrs.assetId) ids.add(node.attrs.assetId);
    node.content?.forEach(visit);
  };
  const visitPrevious = (node: RichTextNode) => {
    if (node.type === "assetImage" && typeof node.attrs?.assetId === "string" && node.attrs.assetId) previouslyStoredIds.add(node.attrs.assetId);
    node.content?.forEach(visitPrevious);
  };
  if (document && typeof document === "object") visit(document as RichTextNode);
  if (previouslyStoredDocument && typeof previouslyStoredDocument === "object") visitPrevious(previouslyStoredDocument as RichTextNode);
  for (const id of previouslyStoredIds) ids.delete(id);
  const invalid = [...ids].filter((id) => !assetIdPattern.test(id));
  for (const id of invalid) ids.delete(id);
  if (!ids.size) return { invalid, unavailable: [] };
  const current = ownerType === "work_item"
    ? (await database.select({ workspaceId: projects.workspaceId }).from(workItems).innerJoin(projects, eq(projects.id, workItems.projectId)).where(eq(workItems.id, ownerId)))[0]
    : (await database.select({ workspaceId: wikiPages.workspaceId }).from(wikiPages).where(eq(wikiPages.id, ownerId)))[0];
  const rows = await database.select({ id: assets.id, workspaceId: assets.workspaceId, ownerType: assets.ownerType, ownerId: assets.ownerId, projectId: assets.projectId })
    .from(assets).where(and(inArray(assets.id, [...ids]), eq(assets.status, "uploaded")));
  const available = new Set<string>();
  for (const asset of rows) {
    if (asset.ownerType === ownerType && asset.ownerId === ownerId) { available.add(asset.id); continue; }
    if (!current || asset.workspaceId !== current.workspaceId || !userId) continue;
    try {
      if (asset.projectId) await requireProjectAccess(database, userId, asset.projectId, "read");
      else if (asset.ownerType === "wiki_page") {
        await requireWorkspaceRole(database, userId, asset.workspaceId, "read");
        const [page] = await database.select({ id: wikiPages.id, ownerId: wikiPages.ownerId, projectId: wikiPages.projectId, collectionId: wikiPages.collectionId, access: wikiPages.access })
          .from(wikiPages).where(and(eq(wikiPages.id, asset.ownerId), isNull(wikiPages.deletedAt)));
        if (!page) continue;
        if (page.projectId) await requireProjectAccess(database, userId, page.projectId, "read");
        if (page.access === "private" && page.ownerId !== userId) {
          const [share] = await database.select({ userId: wikiPageShares.userId }).from(wikiPageShares).where(and(eq(wikiPageShares.pageId, page.id), eq(wikiPageShares.userId, userId)));
          const [collection] = page.collectionId ? await database.select({ ownerId: collections.ownerId, visibility: collections.visibility }).from(collections).where(eq(collections.id, page.collectionId)) : [];
          const [member] = page.collectionId ? await database.select({ userId: collectionMembers.userId }).from(collectionMembers).where(and(eq(collectionMembers.collectionId, page.collectionId), eq(collectionMembers.userId, userId))) : [];
          if (!share && (!collection || collection.visibility !== "private" || collection.ownerId !== userId && !member)) continue;
        }
      } else if (asset.ownerType === "comment") {
        const [comment] = await database.select({ pageId: comments.wikiPageId, workItemId: comments.workItemId }).from(comments).where(eq(comments.id, asset.ownerId));
        if (!comment) continue;
        if (comment.workItemId) {
          const [item] = await database.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, comment.workItemId));
          if (!item) continue;
          await requireProjectAccess(database, userId, item.projectId, "read");
        } else if (comment.pageId) await requireWorkspaceRole(database, userId, asset.workspaceId, "read");
      } else continue;
      available.add(asset.id);
    } catch (error) { if (!(error instanceof ActionError) || ![403, 404].includes(error.status)) throw error; }
  }
  return { invalid, unavailable: [...ids].filter((id) => !available.has(id)) };
}
