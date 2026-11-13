import { wikiContentOf } from "./wiki-content";
import { richTextInput, richTextMarkdown } from "./rich-markdown";
import { Type } from "@sinclair/typebox";
import { assertNotArchived } from "./triage";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, agents, assets, collectionMembers, collections, comments, projectMembers, projects, users, wikiPageFavorites, wikiPageShares, wikiPageTemplates, wikiPageVersions, wikiPages, workItemPages, workItems, workspaceMembers } from "@weft/db";
import { ActionError, requireWorkspaceRole, type WorkspaceRole } from "./members";
import { accessibleProjects, requireProjectAccess } from "./projects";
import { assertFeatureEnabled } from "./features";
import { escapeLike } from "./search";
import { activityActor, plainText, type ActivityContext } from "./work-items";
import { wikiYStateFromContent } from "./wiki-yjs";
import { createS3Storage, type AssetStorage } from "./storage";
import { enqueuePageMention } from "./notifications";
import { publishSignal } from "./realtime";
import { createHash, randomBytes } from "node:crypto";

export const wikiAccess = ["public", "private"] as const;
export type WikiAccess = (typeof wikiAccess)[number];
export const wikiShareRoles = ["view", "comment", "edit"] as const;
export type WikiShareRole = (typeof wikiShareRoles)[number];

/** Autosave writes a new version only when the latest one is at least this old. */
export const versionIntervalMs = 5 * 60_000;

const uuid = () => Type.String({ format: "uuid" });
const publishedTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const accessSchema = Type.Union(wikiAccess.map((value) => Type.Literal(value)));
const nullable = <T extends import("@sinclair/typebox").TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const summaryOutput = Type.Object({
  id: Type.String(), projectId: nullable(Type.String()), collectionId: nullable(Type.String()), parentId: nullable(Type.String()), title: Type.String(), access: accessSchema, archived: Type.Boolean(), locked: Type.Boolean(), ownerId: Type.String(), ownerName: nullable(Type.String()), sortOrder: Type.Number(), createdAt: Type.String(), updatedAt: Type.String(),
});
const sidebarSummaryOutput = Type.Intersect([summaryOutput, Type.Object({ canEdit: Type.Boolean(), canMoveAcrossCollections: Type.Boolean() })]);
const pageOutput = Type.Object({
  id: Type.String(), workspaceId: Type.String(), projectId: nullable(Type.String()), collectionId: nullable(Type.String()), parentId: nullable(Type.String()), title: Type.String(), access: accessSchema, ownerId: Type.String(), ownerName: nullable(Type.String()),
  sortOrder: Type.Number(), content: Type.Any(), contentText: Type.String(), contentMarkdown: Type.String(), contentMarkdownWarnings: Type.Array(Type.String()), archived: Type.Boolean(), locked: Type.Boolean(), canEdit: Type.Boolean(), canLock: Type.Optional(Type.Boolean()), canArchive: Type.Optional(Type.Boolean()), createdAt: Type.String(), updatedAt: Type.String(),
});
const versionOutput = Type.Object({ id: Type.String(), title: Type.String(), createdBy: Type.String(), createdAt: Type.String() });
const activityOutput = Type.Object({
  id: Type.String(), field: Type.String(), oldValue: Type.Any(), newValue: Type.Any(), actorId: Type.String(), actorName: Type.String(),
  source: Type.String(), chatId: nullable(Type.String()), createdAt: Type.String(),
});
const searchOutput = Type.Object({ id: Type.String(), title: Type.String(), snippet: Type.String(), access: accessSchema, projectId: Type.Union([Type.String(), Type.Null()]) });

type Context = ActivityContext;
type PageRow = typeof wikiPages.$inferSelect;

/** Shared authorization entry point for Wiki pages and their attached assets. */
export async function requireWikiPageAccess(db: Database, userId: string, pageId: string, requirement: "read" | "write") {
  const [page] = await db.select().from(wikiPages).where(and(eq(wikiPages.id, pageId), isNull(wikiPages.deletedAt)));
  if (!page) throw new ActionError("Wiki page not found", 404);
  let shareRole: WikiShareRole | null = null;
  if (!page.projectId) {
    const [share] = await db.select({ role: wikiPageShares.role }).from(wikiPageShares).where(and(eq(wikiPageShares.pageId, pageId), eq(wikiPageShares.userId, userId)));
    if (share && wikiShareRoles.includes(share.role as WikiShareRole)) shareRole = share.role as WikiShareRole;
  }
  if (!page.projectId && page.collectionId) {
    const [collection] = await db.select().from(collections).where(and(eq(collections.id, page.collectionId), isNull(collections.deletedAt)));
    const [shared] = await db.select({ userId: collectionMembers.userId }).from(collectionMembers).where(and(eq(collectionMembers.collectionId, page.collectionId), eq(collectionMembers.userId, userId)));
    if (collection?.visibility === "private" && collection.ownerId !== userId && !shared && !shareRole) throw new ActionError("Wiki page not found", 404);
  }
  const role = await requireWorkspaceRole(db, userId, page.workspaceId, "read");
  let canWrite = role !== "Guest";
  if (page.projectId) {
    const access = await requireProjectAccess(db, userId, page.projectId, requirement);
    const [member] = await db.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, page.projectId), eq(projectMembers.userId, userId)));
    if (!member || access.project.workspaceId !== page.workspaceId) throw new ActionError("Wiki page not found", 404);
    assertFeatureEnabled(access.project, "pages");
    canWrite = canWrite && (access.workspaceRole === "Admin" || access.projectRole !== "Guest");
  }
  if (page.access === "private" && page.ownerId !== userId && !shareRole) throw new ActionError("Wiki page not found", 404);
  if (!page.projectId && page.ownerId !== userId && shareRole === null && page.access !== "public") throw new ActionError("Wiki page not found", 404);
  if (!page.projectId && page.ownerId !== userId && shareRole) canWrite = shareRole === "edit";
  if (requirement === "write" && !canWrite) throw new ActionError("Forbidden", 403);
  return page;
}

function snippetOf(text: string, query: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 40);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 120)}`;
}

function remapAssetIds(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => remapAssetIds(entry, ids));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, key === "assetId" && typeof entry === "string" && ids.has(entry) ? ids.get(entry) : remapAssetIds(entry, ids),
  ]));
}

function collectMentions(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return found;
  const node = value as { type?: string; attrs?: { id?: unknown }; content?: unknown[] };
  if (node.type === "mention" && typeof node.attrs?.id === "string" && !node.attrs.id.startsWith("work-item:")) found.add(node.attrs.id);
  if (Array.isArray(node.content)) for (const child of node.content) collectMentions(child, found);
  return found;
}

export function createWikiActions(db: Database, now: () => Date = () => new Date(), storage: AssetStorage = createS3Storage()) {
  const summary = (page: PageRow, ownerName: string | null = null) => ({
    id: page.id, projectId: page.projectId, collectionId: page.collectionId, parentId: page.parentId, title: page.title, access: page.access as WikiAccess, archived: page.archivedAt !== null, locked: page.lockedAt !== null, ownerId: page.ownerId, ownerName, sortOrder: page.sortOrder,
    createdAt: page.createdAt.toISOString(), updatedAt: page.updatedAt.toISOString(),
  });

  async function pageOut(database: Database, page: PageRow) {
    const [owner] = await database.select({ name: users.name }).from(users).where(eq(users.id, page.ownerId));
    return {
      ...summary(page, owner?.name ?? null), workspaceId: page.workspaceId, content: page.content ?? null, contentText: page.contentText,
      contentMarkdown: richTextMarkdown(page.content ?? null).markdown, contentMarkdownWarnings: richTextMarkdown(page.content ?? null).markdownWarnings, archived: page.archivedAt !== null, locked: page.lockedAt !== null,
      createdAt: page.createdAt.toISOString(), updatedAt: page.updatedAt.toISOString(),
    };
  }

  /** Public pages are open to every member; private pages only to their owner. A hidden page looks missing. */
  async function load(database: Database, userId: string, pageId: string, requirement: "read" | "write" | "owner", options: { allowArchived?: boolean; allowWorkspaceAdmin?: boolean } = {}) {
    const [page] = await database.select().from(wikiPages).where(and(eq(wikiPages.id, pageId), isNull(wikiPages.deletedAt)));
    if (!page) throw new ActionError("Wiki page not found", 404);
    if (page.archivedAt && requirement === "write" && !options.allowArchived) throw new ActionError("Page is archived", 400);
    let shareRole: WikiShareRole | null = null;
    if (!page.projectId) {
      const [share] = await database.select({ role: wikiPageShares.role }).from(wikiPageShares).where(and(eq(wikiPageShares.pageId, pageId), eq(wikiPageShares.userId, userId)));
      if (share && wikiShareRoles.includes(share.role as WikiShareRole)) shareRole = share.role as WikiShareRole;
    }
    if (!page.projectId && page.collectionId) {
      const [collection] = await database.select().from(collections).where(and(eq(collections.id, page.collectionId), isNull(collections.deletedAt)));
      const [shared] = await database.select({ userId: collectionMembers.userId }).from(collectionMembers).where(and(eq(collectionMembers.collectionId, page.collectionId), eq(collectionMembers.userId, userId)));
      if (collection?.visibility === "private" && collection.ownerId !== userId && !shared && !shareRole) throw new ActionError("Wiki page not found", 404);
    }
    const role = await requireWorkspaceRole(database, userId, page.workspaceId, "read");
    let canWrite = role !== "Guest";
    if (page.projectId) {
      const projectAccess = await requireProjectAccess(database, userId, page.projectId, requirement === "read" ? "read" : "write");
      const [membership] = await database.select({ userId: projectMembers.userId }).from(projectMembers)
        .where(and(eq(projectMembers.projectId, page.projectId), eq(projectMembers.userId, userId)));
      if (projectAccess.project.workspaceId !== page.workspaceId || (!membership && !(options.allowWorkspaceAdmin && projectAccess.workspaceRole === "Admin"))) throw new ActionError("Wiki page not found", 404);
      assertFeatureEnabled(projectAccess.project, "pages");
      canWrite = canWrite && (projectAccess.workspaceRole === "Admin" || projectAccess.projectRole !== "Guest");
    }
    if (page.access === "private" && page.ownerId !== userId && !shareRole) throw new ActionError("Wiki page not found", 404);
    if (!page.projectId && page.ownerId !== userId && shareRole === null && page.access !== "public") throw new ActionError("Wiki page not found", 404);
    if (requirement === "owner" && page.ownerId !== userId) throw new ActionError("Forbidden", 403);
    if (!page.projectId && page.ownerId !== userId && shareRole) canWrite = shareRole === "edit";
    if (requirement === "write" && !canWrite) throw new ActionError("Forbidden", 403);
    return { page, role: role as WorkspaceRole, canWrite, shareRole };
  }

  async function assertParent(database: Database, userId: string, workspaceId: string, parentId: string | null, selfId?: string) {
    if (!parentId) return;
    if (parentId === selfId) throw new ActionError("A page cannot be its own parent", 400);
    const parent = await load(database, userId, parentId, "read");
    if (parent.page.workspaceId !== workspaceId) throw new ActionError("Wiki page not found", 404);
    // Walk up from the new parent: reaching the page itself would make a cycle.
    for (let cursor: string | null = parent.page.parentId, hops = 0; cursor && hops < 1000; hops++) {
      if (cursor === selfId) throw new ActionError("A page cannot move under its own descendant", 400);
      const [up] = await database.select({ parentId: wikiPages.parentId }).from(wikiPages).where(eq(wikiPages.id, cursor));
      cursor = up?.parentId ?? null;
    }
  }

  async function pageProjectId(database: Database, pageId: string) {
    const [page] = await database.select({ projectId: wikiPages.projectId }).from(wikiPages).where(eq(wikiPages.id, pageId));
    return page?.projectId ?? null;
  }

  async function snapshot(database: Database, page: PageRow, userId: string) {
    await database.insert(wikiPageVersions).values({ pageId: page.id, title: page.title, content: page.content, contentText: page.contentText, ydocState: page.ydocState, createdBy: userId, createdAt: now() });
  }

  async function syncWorkItemMentions(database: Database, userId: string, page: PageRow, content: unknown) {
    const ids = new Set<string>();
    const visit = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (value === null || typeof value !== "object") return;
      const node = value as { attrs?: { id?: unknown }; content?: unknown };
      if (typeof node.attrs?.id === "string" && node.attrs.id.startsWith("work-item:")) ids.add(node.attrs.id.slice("work-item:".length));
      visit(node.content);
    };
    visit(content);
    const current = await database.select({ workItemId: workItemPages.workItemId, archivedAt: workItems.archivedAt }).from(workItemPages)
      .innerJoin(workItems, eq(workItems.id, workItemPages.workItemId)).where(eq(workItemPages.pageId, page.id));
    const desired = new Set(ids);
    // An archived work item is read-only: editing a page never adds or removes its page links.
    for (const link of current) if (!desired.has(link.workItemId) && !link.archivedAt) await database.delete(workItemPages).where(and(eq(workItemPages.pageId, page.id), eq(workItemPages.workItemId, link.workItemId)));
    for (const id of ids) {
      const [item] = await database.select().from(workItems).where(eq(workItems.id, id));
      if (!item || item.workspaceId !== page.workspaceId) throw new ActionError("Mentioned work item not found", 400);
      try { await requireProjectAccess(database, userId, item.projectId, "read"); }
      catch { throw new ActionError("Mentioned work item is not visible", 400); }
      if (item.archivedAt) continue;
      const [existing] = await database.select().from(workItemPages).where(and(eq(workItemPages.workItemId, item.id), eq(workItemPages.pageId, page.id)));
      if (!existing) await database.insert(workItemPages).values({ workItemId: item.id, pageId: page.id, createdBy: userId });
    }
  }

  async function lockedForWrite(database: Database, userId: string, pageId: string) {
    const loaded = await load(database, userId, pageId, "write");
    await database.execute(sql`select 1 from wiki_pages where id = ${pageId} for update`);
    const [fresh] = await database.select().from(wikiPages).where(eq(wikiPages.id, pageId));
    return { ...loaded, page: fresh! };
  }

  async function assertUnlocked(page: PageRow) {
    if (page.lockedAt) throw new ActionError("Page is locked", 409);
  }

  async function mentionable(database: Database, page: PageRow) {
    const shared = await database.select({ userId: wikiPageShares.userId }).from(wikiPageShares).where(eq(wikiPageShares.pageId, page.id));
    if (page.access === "private") return [{ userId: page.ownerId }, ...shared];
    if (page.projectId) return database.select({ userId: projectMembers.userId }).from(projectMembers)
      .where(eq(projectMembers.projectId, page.projectId));
    const [collection] = page.collectionId ? await database.select().from(collections).where(eq(collections.id, page.collectionId)) : [];
    if (collection?.visibility === "private") {
      const members = await database.select({ userId: collectionMembers.userId }).from(collectionMembers).where(eq(collectionMembers.collectionId, collection.id));
      return [{ userId: collection.ownerId }, ...members, ...shared];
    }
    return database.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, page.workspaceId));
  }

  /** Appends one Activity row for a wiki page, in the caller's transaction. Wiki pages are workspace-level, so there is no project. */
  async function logActivity(database: Database, context: Context, page: { id: string; workspaceId: string }, field: string, oldValue: unknown, newValue: unknown) {
    await database.insert(activities).values({
      workspaceId: page.workspaceId, projectId: null, entityType: "wiki_page", entityId: page.id, field,
      oldValue: oldValue ?? null, newValue: newValue ?? null, ...activityActor(context),
      createdAt: now(),
    });
  }

  /** Shared content-save effects for Action writes and realtime editor saves. */
  async function processPageContentEffects(database: Database, context: Context, page: PageRow, oldContent: unknown, content: unknown, logContent: boolean) {
    const oldMentions = collectMentions(oldContent);
    const addedMentions = [...collectMentions(content)].filter((id) => !oldMentions.has(id));
    if (addedMentions.length) {
      const allowed = new Set((await mentionable(database, page)).map((row) => row.userId));
      if (addedMentions.some((id) => !allowed.has(id))) throw new ActionError("Mentioned user cannot see this page", 400);
      await enqueuePageMention(database, page.id, context.userId, addedMentions);
    }
    await syncWorkItemMentions(database, context.userId, page, content);
    if (logContent) await logActivity(database, context, page, "content", null, { changed: true });
  }

  return {
    processPageContentEffects,
    publishWikiPage: {
      name: "publish_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }), output: Type.Object({ token: Type.String() }),
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page, role } = await load(database, context.userId, input.pageId, "read");
        if (page.projectId || page.access !== "public" || (page.collectionId && (await database.select({ visibility: collections.visibility }).from(collections).where(eq(collections.id, page.collectionId)))[0]?.visibility === "private")) throw new ActionError("Only public Wiki pages in a public Collection can be published", 400);
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        const token = randomBytes(32).toString("base64url");
        await database.update(wikiPages).set({ publishedTokenHash: publishedTokenHash(token), updatedAt: now() }).where(eq(wikiPages.id, page.id));
        return { token };
      }),
    },
    revokeWikiPagePublishedLink: {
      name: "revoke_wiki_page_published_link", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }), output: Type.Object({ revoked: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page, role } = await load(database, context.userId, input.pageId, "read");
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        const [updated] = await database.update(wikiPages).set({ publishedTokenHash: null, updatedAt: now() }).where(eq(wikiPages.id, page.id)).returning({ id: wikiPages.id });
        return { revoked: Boolean(updated) };
      }),
    },
    createWikiPageTemplate: {
      name: "create_wiki_page_template", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Object({ id: Type.String(), workspaceId: Type.String(), title: Type.String(), content: Type.Any(), contentText: Type.String(), createdBy: Type.String(), createdAt: Type.String() }),
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await load(database, context.userId, input.pageId, "read");
        await requireWorkspaceRole(database, context.userId, page.workspaceId, "admin");
        const [template] = await database.insert(wikiPageTemplates).values({ workspaceId: page.workspaceId, createdBy: context.userId, title: page.title, content: page.content, contentText: page.contentText, createdAt: now() }).returning();
        return { id: template!.id, workspaceId: template!.workspaceId, title: template!.title, content: template!.content, contentText: template!.contentText, createdBy: template!.createdBy, createdAt: template!.createdAt.toISOString() };
      }),
    },
    listWikiPageTemplates: {
      name: "list_wiki_page_templates", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid() }),
      output: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), content: Type.Any(), contentText: Type.String(), createdBy: Type.String(), createdAt: Type.String() })),
      handler: async (context: Context, input: { workspaceId: string }) => {
        const role = await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        if (role === "Guest") return [];
        const rows = await db.select().from(wikiPageTemplates).where(eq(wikiPageTemplates.workspaceId, input.workspaceId)).orderBy(asc(wikiPageTemplates.createdAt), asc(wikiPageTemplates.id));
        return rows.map((row) => ({ id: row.id, title: row.title, content: row.content, contentText: row.contentText, createdBy: row.createdBy, createdAt: row.createdAt.toISOString() }));
      },
    },
    deleteWikiPageTemplate: {
      name: "delete_wiki_page_template", kind: "write" as const,
      input: Type.Object({ templateId: uuid() }), output: Type.Object({ deleted: Type.Boolean() }),
      handler: async (context: Context, input: { templateId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const [template] = await database.select().from(wikiPageTemplates).where(eq(wikiPageTemplates.id, input.templateId));
        if (!template) throw new ActionError("Template not found", 404);
        await requireWorkspaceRole(database, context.userId, template.workspaceId, "admin");
        await database.delete(wikiPageTemplates).where(eq(wikiPageTemplates.id, template.id));
        return { deleted: true };
      }),
    },
    createCollection: {
      name: "create_collection", kind: "write" as const,
      input: Type.Object({ workspaceId: uuid(), name: Type.String({ minLength: 1, maxLength: 120 }), icon: Type.Optional(Type.String({ maxLength: 32 })), visibility: Type.Optional(accessSchema) }),
      output: Type.Object({ id: Type.String(), workspaceId: Type.String(), name: Type.String(), icon: Type.String(), visibility: accessSchema, ownerId: Type.String(), isDefault: Type.Boolean() }),
      handler: async (context: Context, input: { workspaceId: string; name: string; icon?: string; visibility?: WikiAccess }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "write");
        const [row] = await db.insert(collections).values({ workspaceId: input.workspaceId, ownerId: context.userId, name: input.name, icon: input.icon ?? "📚", visibility: input.visibility ?? "public" }).returning();
        return { id: row!.id, workspaceId: row!.workspaceId, name: row!.name, icon: row!.icon, visibility: row!.visibility as WikiAccess, ownerId: row!.ownerId, isDefault: row!.isDefault };
      },
    },
    listCollections: {
      name: "list_collections", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid() }),
      output: Type.Array(Type.Object({ id: Type.String(), workspaceId: Type.String(), name: Type.String(), icon: Type.String(), visibility: accessSchema, ownerId: Type.String(), isDefault: Type.Boolean() })),
      handler: async (context: Context, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const shared = db.select({ id: collectionMembers.collectionId }).from(collectionMembers).where(eq(collectionMembers.userId, context.userId));
        const rows = await db.select().from(collections).where(and(eq(collections.workspaceId, input.workspaceId), isNull(collections.deletedAt), sql`(${collections.visibility} = 'public' or ${collections.ownerId} = ${context.userId} or ${collections.id} in (${shared}))`)).orderBy(asc(collections.isDefault), asc(collections.name));
        return rows.map((row) => ({ id: row.id, workspaceId: row.workspaceId, name: row.name, icon: row.icon, visibility: row.visibility as WikiAccess, ownerId: row.ownerId, isDefault: row.isDefault }));
      },
    },
    renameCollection: {
      name: "rename_collection", kind: "write" as const,
      input: Type.Object({ collectionId: uuid(), name: Type.String({ minLength: 1, maxLength: 120 }) }), output: Type.Object({ id: Type.String(), name: Type.String() }),
      handler: async (context: Context, input: { collectionId: string; name: string }) => {
        const [row] = await db.select().from(collections).where(and(eq(collections.id, input.collectionId), isNull(collections.deletedAt)));
        if (!row) throw new ActionError("Collection not found", 404);
        const role = await requireWorkspaceRole(db, context.userId, row.workspaceId, "write");
        if ((row.ownerId !== context.userId || row.isDefault) && role !== "Admin") throw new ActionError("Forbidden", 403);
        const [updated] = await db.update(collections).set({ name: input.name, updatedAt: now() }).where(eq(collections.id, row.id)).returning();
        return { id: updated!.id, name: updated!.name };
      },
    },
    setCollectionVisibility: {
      name: "set_collection_visibility", kind: "write" as const,
      input: Type.Object({ collectionId: uuid(), visibility: accessSchema }), output: Type.Object({ id: Type.String(), visibility: accessSchema }),
      handler: async (context: Context, input: { collectionId: string; visibility: WikiAccess }) => {
        const [row] = await db.select().from(collections).where(and(eq(collections.id, input.collectionId), isNull(collections.deletedAt)));
        if (!row) throw new ActionError("Collection not found", 404);
        const role = await requireWorkspaceRole(db, context.userId, row.workspaceId, "write");
        if ((row.ownerId !== context.userId || row.isDefault) && role !== "Admin") throw new ActionError("Forbidden", 403);
        if (row.isDefault && input.visibility !== "public") throw new ActionError("The default Collection is always public", 400);
        const [updated] = await db.update(collections).set({ visibility: input.visibility, updatedAt: now() }).where(eq(collections.id, row.id)).returning();
        if (input.visibility === "private") await db.update(wikiPages).set({ publishedTokenHash: null }).where(and(eq(wikiPages.collectionId, row.id), isNull(wikiPages.projectId)));
        return { id: updated!.id, visibility: updated!.visibility as WikiAccess };
      },
    },
    shareCollection: {
      name: "share_collection", kind: "write" as const,
      input: Type.Object({ collectionId: uuid(), userId: Type.String() }), output: Type.Object({ shared: Type.Boolean() }),
      handler: async (context: Context, input: { collectionId: string; userId: string }) => {
        const [row] = await db.select().from(collections).where(eq(collections.id, input.collectionId));
        if (!row) throw new ActionError("Collection not found", 404);
        const role = await requireWorkspaceRole(db, context.userId, row.workspaceId, "write");
        if ((row.ownerId !== context.userId || row.isDefault) && role !== "Admin") throw new ActionError("Forbidden", 403);
        const [member] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, row.workspaceId), eq(workspaceMembers.userId, input.userId)));
        if (!member) throw new ActionError("Workspace member not found", 404);
        await db.insert(collectionMembers).values({ collectionId: row.id, userId: input.userId }).onConflictDoNothing();
        return { shared: true };
      },
    },
    listCollectionMembers: {
      name: "list_collection_members", kind: "read" as const,
      input: Type.Object({ collectionId: uuid() }), output: Type.Array(Type.Object({ userId: Type.String(), name: Type.String() })),
      handler: async (context: Context, input: { collectionId: string }) => {
        const [row] = await db.select().from(collections).where(eq(collections.id, input.collectionId));
        if (!row) throw new ActionError("Collection not found", 404);
        const role = await requireWorkspaceRole(db, context.userId, row.workspaceId, "read");
        if (row.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        return db.select({ userId: collectionMembers.userId, name: users.name }).from(collectionMembers).innerJoin(users, eq(users.id, collectionMembers.userId)).where(eq(collectionMembers.collectionId, row.id)).orderBy(asc(users.name));
      },
    },
    revokeCollectionShare: {
      name: "revoke_collection_share", kind: "write" as const,
      input: Type.Object({ collectionId: uuid(), userId: Type.String() }), output: Type.Object({ revoked: Type.Boolean() }),
      handler: async (context: Context, input: { collectionId: string; userId: string }) => {
        const [row] = await db.select().from(collections).where(eq(collections.id, input.collectionId));
        if (!row) throw new ActionError("Collection not found", 404);
        const role = await requireWorkspaceRole(db, context.userId, row.workspaceId, "write");
        if (row.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        const deleted = await db.delete(collectionMembers).where(and(eq(collectionMembers.collectionId, row.id), eq(collectionMembers.userId, input.userId))).returning({ userId: collectionMembers.userId });
        return { revoked: deleted.length > 0 };
      },
    },
    deleteCollection: {
      name: "delete_collection", kind: "write" as const,
      input: Type.Object({ collectionId: uuid() }), output: Type.Object({ deleted: Type.Boolean() }),
      handler: async (context: Context, input: { collectionId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const [row] = await database.select().from(collections).where(eq(collections.id, input.collectionId));
        if (!row) throw new ActionError("Collection not found", 404);
        const role = await requireWorkspaceRole(database, context.userId, row.workspaceId, "write");
        if (row.isDefault) throw new ActionError("The default Collection cannot be deleted", 400);
        if (row.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        const [{ total }] = await database.select({ total: sql<number>`count(*)::int` }).from(wikiPages).where(and(eq(wikiPages.collectionId, row.id), isNull(wikiPages.deletedAt)));
        if (total > 0) throw new ActionError(`Collection still holds ${total} Wiki page${total === 1 ? "" : "s"}; move or delete them first`, 400);
        await database.update(collections).set({ deletedAt: now() }).where(eq(collections.id, row.id));
        return { deleted: true };
      }),
    },
    listWikiPageMentionableMembers: {
      name: "list_wiki_page_mentionable_members", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }), output: Type.Array(Type.Object({ userId: Type.String(), name: Type.String(), isAgent: Type.Boolean(), codeCapable: Type.Boolean() })),
      handler: async (context: Context, input: { pageId: string }) => {
        const { page } = await load(db, context.userId, input.pageId, "read");
        const allowed = await mentionable(db, page);
        if (allowed.length === 0) return [];
        const people = await db.select({ userId: users.id, name: users.name, isAgent: users.isAgent }).from(users).where(inArray(users.id, allowed.map((row) => row.userId))).orderBy(asc(users.name), asc(users.id));
        const agentIds = people.filter((person) => person.isAgent).map((person) => person.userId);
        const codeAgents = new Set(agentIds.length ? (await db.select({ userId: agents.userId }).from(agents).where(and(inArray(agents.userId, agentIds), isNotNull(agents.runtimeId)))).map((agent) => agent.userId) : []);
        return people.map((person) => ({ ...person, codeCapable: codeAgents.has(person.userId) }));
      },
    },
    createWikiPage: {
      name: "create_wiki_page", kind: "write" as const,
      input: Type.Object({
        workspaceId: uuid(), title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), templateId: Type.Optional(uuid()), parentId: Type.Optional(nullable(uuid())),
        projectId: Type.Optional(nullable(uuid())), collectionId: Type.Optional(nullable(uuid())), access: Type.Optional(accessSchema), contentMarkdown: Type.Optional(Type.String({ description: "Markdown page content, for example ## Plan followed by - First step. Use instead of content." })), content: Type.Optional(Type.Any()),
      }),
      output: pageOutput,
      handler: async (context: Context, input: { workspaceId: string; title?: string; templateId?: string; parentId?: string | null; projectId?: string | null; collectionId?: string | null; access?: WikiAccess; content?: unknown; contentMarkdown?: string }) => db.transaction(async (tx) => {
        input.content = richTextInput(input.content, input.contentMarkdown, "content", "contentMarkdown");
        const database = tx as unknown as Database;
        await requireWorkspaceRole(database, context.userId, input.workspaceId, "write");
        const [template] = input.templateId ? await database.select().from(wikiPageTemplates).where(and(eq(wikiPageTemplates.id, input.templateId), eq(wikiPageTemplates.workspaceId, input.workspaceId))) : [];
        if (input.templateId && !template) throw new ActionError("Template not found", 404);
        const title = input.title ?? template?.title;
        if (!title) throw new ActionError("A title is required", 400);
        const content = template ? template.content : wikiContentOf(input.content);
        let project: typeof projects.$inferSelect | null = null;
        if (input.projectId) {
          const access = await requireProjectAccess(database, context.userId, input.projectId, "write");
          if (access.project.workspaceId !== input.workspaceId) throw new ActionError("Project not found", 404);
          assertFeatureEnabled(access.project, "pages");
          project = access.project;
        }
        let collectionId: string | null = null;
        if (!project) {
          const [parent] = input.parentId ? await database.select({ collectionId: wikiPages.collectionId }).from(wikiPages).where(eq(wikiPages.id, input.parentId)) : [];
          const wantedCollection = input.collectionId ?? parent?.collectionId ?? null;
          const [collection] = await database.select().from(collections).where(and(eq(collections.workspaceId, input.workspaceId), input.collectionId ? eq(collections.id, input.collectionId) : eq(collections.isDefault, true), isNull(collections.deletedAt)));
          let selected = collection;
          if (!selected && !wantedCollection) {
            const [created] = await database.insert(collections).values({ workspaceId: input.workspaceId, ownerId: context.userId, name: "Wiki", isDefault: true }).onConflictDoNothing().returning();
            selected = created;
            if (!selected) [selected] = await database.select().from(collections).where(and(eq(collections.workspaceId, input.workspaceId), eq(collections.isDefault, true), isNull(collections.deletedAt)));
          }
          if (wantedCollection) [selected] = await database.select().from(collections).where(and(eq(collections.workspaceId, input.workspaceId), eq(collections.id, wantedCollection), isNull(collections.deletedAt)));
          if (!selected) throw new ActionError("Collection not found", 404);
          if (selected.visibility === "private" && selected.ownerId !== context.userId) {
            const [shared] = await database.select().from(collectionMembers).where(and(eq(collectionMembers.collectionId, selected.id), eq(collectionMembers.userId, context.userId)));
            if (!shared) throw new ActionError("Collection not found", 404);
          }
          collectionId = selected.id;
        }
        await assertParent(database, context.userId, input.workspaceId, input.parentId ?? null);
        if (input.parentId && (await pageProjectId(database, input.parentId)) !== (project?.id ?? null)) {
          throw new ActionError("A page and its parent must have the same scope", 400);
        }
        if (input.parentId && !project) {
          const [parent] = await database.select({ collectionId: wikiPages.collectionId }).from(wikiPages).where(eq(wikiPages.id, input.parentId));
          if (parent?.collectionId !== collectionId) throw new ActionError("A page and its parent must have the same Collection", 400);
        }
        const [last] = await database.select({ order: wikiPages.sortOrder }).from(wikiPages)
          .where(and(eq(wikiPages.workspaceId, input.workspaceId), input.parentId ? eq(wikiPages.parentId, input.parentId) : isNull(wikiPages.parentId)))
          .orderBy(desc(wikiPages.sortOrder)).limit(1);
        const [page] = await database.insert(wikiPages).values({
          workspaceId: input.workspaceId, projectId: project?.id ?? null, collectionId, parentId: input.parentId ?? null, ownerId: context.userId, title,
          content: content ?? null, contentText: plainText(content), ydocState: wikiYStateFromContent(content ?? { type: "doc", content: [{ type: "paragraph" }] }), access: input.access ?? "public",
          sortOrder: (last?.order ?? 0) + 1, createdAt: now(), updatedAt: now(),
        }).returning();
        await syncWorkItemMentions(database, context.userId, page!, content);
        await snapshot(database, page!, context.userId);
        await logActivity(database, context, page!, "created", null, { title: page!.title, access: page!.access });
        return { ...await pageOut(database, page!), canEdit: true };
      }),
    },
    listWikiPages: {
      name: "list_wiki_pages", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid(), archived: Type.Optional(Type.Boolean()) }),
      output: Type.Array(sidebarSummaryOutput),
      handler: async (context: Context, input: { workspaceId: string; archived?: boolean }) => {
        const workspaceRole = await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const rows = await db.select({ page: wikiPages, ownerName: users.name }).from(wikiPages).leftJoin(users, eq(users.id, wikiPages.ownerId)).where(and(
          eq(wikiPages.workspaceId, input.workspaceId), isNull(wikiPages.deletedAt),
          input.archived ? sql`${wikiPages.archivedAt} is not null` : isNull(wikiPages.archivedAt), isNull(wikiPages.projectId),
          sql`(${wikiPages.access} = 'public' or ${wikiPages.ownerId} = ${context.userId} or exists (select 1 from wiki_page_shares s where s.page_id = ${wikiPages.id} and s.user_id = ${context.userId}))`,
        )).orderBy(asc(wikiPages.sortOrder), asc(wikiPages.createdAt), asc(wikiPages.id));
        const visible = [];
        for (const row of rows) {
          if (!row.page.collectionId) continue;
          const [collection] = await db.select().from(collections).where(and(eq(collections.id, row.page.collectionId), isNull(collections.deletedAt)));
          if (!collection) continue;
          if (collection.visibility === "private" && collection.ownerId !== context.userId) {
            const [shared] = await db.select().from(collectionMembers).where(and(eq(collectionMembers.collectionId, collection.id), eq(collectionMembers.userId, context.userId)));
            const [pageShare] = await db.select().from(wikiPageShares).where(and(eq(wikiPageShares.pageId, row.page.id), eq(wikiPageShares.userId, context.userId)));
            if (!shared && !pageShare) continue;
          }
          let canEdit = false;
          try { await load(db, context.userId, row.page.id, "write"); canEdit = true; } catch (error) { if (!(error instanceof ActionError)) throw error; }
          visible.push({ ...summary(row.page, row.ownerName), canEdit, canMoveAcrossCollections: workspaceRole === "Admin" });
        }
        return visible;
      },
    },
    listSharedWikiPages: {
      name: "list_shared_wiki_pages", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid() }), output: Type.Array(sidebarSummaryOutput),
      handler: async (context: Context, input: { workspaceId: string }) => {
        const workspaceRole = await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const rows = await db.select({ page: wikiPages, ownerName: users.name }).from(wikiPageShares)
          .innerJoin(wikiPages, eq(wikiPages.id, wikiPageShares.pageId)).leftJoin(users, eq(users.id, wikiPages.ownerId))
          .where(and(eq(wikiPageShares.userId, context.userId), eq(wikiPages.workspaceId, input.workspaceId), isNull(wikiPages.projectId), isNull(wikiPages.deletedAt), isNull(wikiPages.archivedAt)));
        const visible = [];
        for (const { page, ownerName } of rows) {
          try { await load(db, context.userId, page.id, "read"); let canEdit = false; try { await load(db, context.userId, page.id, "write"); canEdit = true; } catch (error) { if (!(error instanceof ActionError)) throw error; } visible.push({ ...summary(page, ownerName), canEdit, canMoveAcrossCollections: workspaceRole === "Admin" }); }
          catch (error) { if (!(error instanceof ActionError) || error.status !== 404) throw error; }
        }
        return visible;
      },
    },
    listWikiPageShares: {
      name: "list_wiki_page_shares", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }), output: Type.Array(Type.Object({ userId: Type.String(), name: Type.String(), role: Type.Union(wikiShareRoles.map((role) => Type.Literal(role))) })),
      handler: async (context: Context, input: { pageId: string }) => {
        const { page } = await load(db, context.userId, input.pageId, "owner");
        if (page.projectId) throw new ActionError("Pages cannot be shared individually", 400);
        return db.select({ userId: wikiPageShares.userId, name: users.name, role: wikiPageShares.role }).from(wikiPageShares)
          .innerJoin(users, eq(users.id, wikiPageShares.userId)).where(eq(wikiPageShares.pageId, page.id)).orderBy(asc(users.name), asc(users.id)) as Promise<Array<{ userId: string; name: string; role: WikiShareRole }>>;
      },
    },
    shareWikiPage: {
      name: "share_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), userId: Type.String(), role: Type.Union(wikiShareRoles.map((role) => Type.Literal(role))) }), output: Type.Object({ shared: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string; userId: string; role: WikiShareRole }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await load(database, context.userId, input.pageId, "owner");
        if (page.projectId) throw new ActionError("Pages cannot be shared individually", 400);
        const [member] = await database.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, page.workspaceId), eq(workspaceMembers.userId, input.userId)));
        if (!member) throw new ActionError("Workspace member not found", 404);
        if (input.userId === page.ownerId) throw new ActionError("Page owner already has full access", 400);
        await database.insert(wikiPageShares).values({ pageId: page.id, userId: input.userId, role: input.role })
          .onConflictDoUpdate({ target: [wikiPageShares.pageId, wikiPageShares.userId], set: { role: input.role } });
        await publishSignal(database, { type: "revoke", workspaceId: page.workspaceId, pageId: page.id, userId: input.userId });
        return { shared: true };
      }),
    },
    revokeWikiPageShare: {
      name: "revoke_wiki_page_share", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), userId: Type.String() }), output: Type.Object({ revoked: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string; userId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await load(database, context.userId, input.pageId, "owner");
        if (page.projectId) throw new ActionError("Pages cannot be shared individually", 400);
        await database.delete(wikiPageShares).where(and(eq(wikiPageShares.pageId, page.id), eq(wikiPageShares.userId, input.userId)));
        await publishSignal(database, { type: "revoke", workspaceId: page.workspaceId, pageId: page.id, userId: input.userId });
        return { revoked: true };
      }),
    },
    getWikiPage: {
      name: "get_wiki_page", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string }) => { const loaded = await load(db, context.userId, input.pageId, "read"); return { ...await pageOut(db, loaded.page), canEdit: loaded.canWrite && !loaded.page.archivedAt && !loaded.page.lockedAt, canLock: loaded.page.ownerId === context.userId || loaded.role === "Admin", canArchive: loaded.page.ownerId === context.userId || loaded.role === "Admin" }; },
    },
    getWikiPageAccess: {
      name: "get_wiki_page_access", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Object({ canRead: Type.Boolean(), canWrite: Type.Boolean(), locked: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string }) => {
        const loaded = await load(db, context.userId, input.pageId, "read");
        return { canRead: true, canWrite: loaded.canWrite && !loaded.page.archivedAt && !loaded.page.lockedAt, locked: loaded.page.lockedAt !== null };
      },
    },
    lockWikiPage: {
      name: "lock_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }), output: Type.Object({ locked: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const [page] = await database.select().from(wikiPages).where(and(eq(wikiPages.id, input.pageId), isNull(wikiPages.deletedAt))).for("update");
        if (!page) throw new ActionError("Wiki page not found", 404);
        const role = await requireWorkspaceRole(database, context.userId, page.workspaceId, "read");
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        if (!page.lockedAt) {
          await database.update(wikiPages).set({ lockedAt: now(), updatedAt: now() }).where(eq(wikiPages.id, page.id));
          await logActivity(database, context, page, "locked", false, true);
          await publishSignal(database, { type: "change", workspaceId: page.workspaceId, pageId: page.id });
        }
        return { locked: true };
      }),
    },
    unlockWikiPage: {
      name: "unlock_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }), output: Type.Object({ locked: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const [page] = await database.select().from(wikiPages).where(and(eq(wikiPages.id, input.pageId), isNull(wikiPages.deletedAt))).for("update");
        if (!page) throw new ActionError("Wiki page not found", 404);
        const role = await requireWorkspaceRole(database, context.userId, page.workspaceId, "read");
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        if (page.lockedAt) {
          await database.update(wikiPages).set({ lockedAt: null, updatedAt: now() }).where(eq(wikiPages.id, page.id));
          await logActivity(database, context, page, "unlocked", true, false);
          await publishSignal(database, { type: "change", workspaceId: page.workspaceId, pageId: page.id });
        }
        return { locked: false };
      }),
    },
    archiveWikiPage: {
      name: "archive_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Object({ archived: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page, role } = await load(database, context.userId, input.pageId, "write", { allowArchived: true, allowWorkspaceAdmin: true });
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        if (!page.archivedAt) await database.update(wikiPages).set({ archivedAt: now(), updatedAt: now() }).where(eq(wikiPages.id, page.id));
        return { archived: true };
      }),
    },
    unarchiveWikiPage: {
      name: "unarchive_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Object({ archived: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page, role } = await load(database, context.userId, input.pageId, "write", { allowArchived: true, allowWorkspaceAdmin: true });
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        if (page.archivedAt) await database.update(wikiPages).set({ archivedAt: null, updatedAt: now() }).where(eq(wikiPages.id, page.id));
        return { archived: false };
      }),
    },
    duplicateWikiPage: {
      name: "duplicate_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await load(database, context.userId, input.pageId, "write");
        if (!page.projectId && page.collectionId) {
          // A sharee reaches the page without belonging to its private Collection; a copy placed there would be unreadable to its creator.
          const [collection] = await database.select().from(collections).where(and(eq(collections.id, page.collectionId), isNull(collections.deletedAt)));
          const [member] = await database.select({ userId: collectionMembers.userId }).from(collectionMembers).where(and(eq(collectionMembers.collectionId, page.collectionId), eq(collectionMembers.userId, context.userId)));
          if (collection?.visibility === "private" && collection.ownerId !== context.userId && !member) throw new ActionError("Forbidden", 403);
        }
        const sourceAssets = await database.select().from(assets).where(and(
          eq(assets.ownerType, "wiki_page"), eq(assets.ownerId, page.id), eq(assets.status, "uploaded"),
        ));
        const assetIds = new Map(sourceAssets.map((asset) => [asset.id, crypto.randomUUID()]));
        const content = remapAssetIds(page.content, assetIds);
        const [last] = await database.select({ order: wikiPages.sortOrder }).from(wikiPages).where(and(
          eq(wikiPages.workspaceId, page.workspaceId),
          page.projectId ? eq(wikiPages.projectId, page.projectId) : isNull(wikiPages.projectId),
          page.parentId ? eq(wikiPages.parentId, page.parentId) : isNull(wikiPages.parentId),
          isNull(wikiPages.deletedAt),
        )).orderBy(desc(wikiPages.sortOrder)).limit(1);
        const [copy] = await database.insert(wikiPages).values({
          workspaceId: page.workspaceId, projectId: page.projectId, collectionId: page.collectionId, parentId: page.parentId, ownerId: context.userId,
          title: `${page.title} (copy)`, access: page.access, content, contentText: page.contentText,
          ydocState: wikiYStateFromContent(content ?? { type: "doc", content: [{ type: "paragraph" }] }),
          sortOrder: (last?.order ?? 0) + 1, createdAt: now(), updatedAt: now(),
        }).returning();
        for (const asset of sourceAssets) {
          const id = assetIds.get(asset.id)!;
          const storageKey = `${page.workspaceId}/${id}`;
          await storage.copy(asset.storageKey, storageKey);
          await database.insert(assets).values({
            id, workspaceId: page.workspaceId, projectId: page.projectId, ownerType: "wiki_page", ownerId: copy!.id,
            uploaderId: context.userId, storageKey, filename: asset.filename, contentType: asset.contentType,
            size: asset.size, status: "uploaded", createdAt: now(), uploadedAt: now(),
          });
        }
        await logActivity(database, context, copy!, "created", null, { title: copy!.title, access: copy!.access });
        return { ...await pageOut(database, copy!), canEdit: true };
      }),
    },
    favoriteWikiPage: {
      name: "favorite_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), favorite: Type.Boolean() }),
      output: Type.Object({ favorite: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string; favorite: boolean }) => {
        const { page } = await load(db, context.userId, input.pageId, "read");
        if (input.favorite) {
          await db.insert(wikiPageFavorites).values({ userId: context.userId, pageId: page.id }).onConflictDoNothing();
        } else {
          await db.delete(wikiPageFavorites).where(and(eq(wikiPageFavorites.userId, context.userId), eq(wikiPageFavorites.pageId, input.pageId)));
        }
        return { favorite: input.favorite };
      },
    },
    listFavoriteWikiPages: {
      name: "list_favorite_wiki_pages", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid() }), output: Type.Array(summaryOutput),
      handler: async (context: Context, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const rows = await db.select({ page: wikiPages, ownerName: users.name, createdAt: wikiPageFavorites.createdAt })
          .from(wikiPageFavorites).innerJoin(wikiPages, eq(wikiPages.id, wikiPageFavorites.pageId))
          .leftJoin(projects, eq(projects.id, wikiPages.projectId))
          .leftJoin(users, eq(users.id, wikiPages.ownerId))
          .where(and(eq(wikiPageFavorites.userId, context.userId), eq(wikiPages.workspaceId, input.workspaceId), isNull(wikiPages.deletedAt), sql`(${wikiPages.projectId} is null or ${projects.pagesEnabled} = true)`))
          .orderBy(asc(wikiPageFavorites.createdAt), asc(wikiPages.title));
        const visible = [];
        for (const row of rows) {
          try {
            await load(db, context.userId, row.page.id, "read");
            visible.push(summary(row.page, row.ownerName));
          } catch (error) {
            if (!(error instanceof ActionError) || error.status !== 404) throw error;
          }
        }
        return visible;
      },
    },
    /** Autosave target: refreshes the editor lock, saves content, and snapshots a version on a cadence. */
    updateWikiPage: {
      name: "update_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), contentMarkdown: Type.Optional(Type.String({ description: "Markdown page content, for example ## Plan followed by - First step. Use instead of content." })), content: Type.Optional(Type.Any()) }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string; title?: string; content?: unknown; contentMarkdown?: string }) => db.transaction(async (tx) => {
        input.content = richTextInput(input.content, input.contentMarkdown, "content", "contentMarkdown");
        const database = tx as unknown as Database;
        const { page } = await lockedForWrite(database, context.userId, input.pageId);
        await assertUnlocked(page);
        const nextContent = wikiContentOf(input.content);
        const titleChanged = input.title !== undefined && input.title !== page.title;
        const contentChanged = nextContent !== undefined && JSON.stringify(nextContent) !== JSON.stringify(page.content);
        if (!titleChanged && !contentChanged) return { ...await pageOut(database, page), canEdit: true };
        const [latest] = await database.select({ at: wikiPageVersions.createdAt }).from(wikiPageVersions)
          .where(eq(wikiPageVersions.pageId, page.id)).orderBy(desc(wikiPageVersions.createdAt)).limit(1);
        const versioned = context.source === "ai" || context.source === "ai_autopilot" || !latest || now().getTime() - latest.at.getTime() >= versionIntervalMs;
        if ((context.source === "ai" || context.source === "ai_autopilot") && contentChanged) await snapshot(database, page, context.userId);
        const [updated] = await database.update(wikiPages).set({
          ...(titleChanged ? { title: input.title! } : {}),
          ...(contentChanged ? { content: nextContent, contentText: plainText(nextContent), ydocState: wikiYStateFromContent(nextContent) } : {}),
          updatedAt: now(),
        }).where(eq(wikiPages.id, page.id)).returning();
        if (contentChanged) await processPageContentEffects(database, context, updated!, page.content, nextContent, versioned || (context.source !== undefined && context.source !== "ui"));
        if (versioned && context.source !== "ai" && context.source !== "ai_autopilot") await snapshot(database, updated!, context.userId);
        if (titleChanged) await logActivity(database, context, page, "title", page.title, updated!.title);
        // Autosave fires every few seconds, so a human edit is logged once per saved version; AI edits are always logged.
        return { ...await pageOut(database, updated!), canEdit: true };
      }),
    },
    moveWikiPage: {
      name: "move_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), parentId: nullable(uuid()), sortOrder: Type.Optional(Type.Number()) }),
      output: summaryOutput,
      handler: async (context: Context, input: { pageId: string; parentId: string | null; sortOrder?: number }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await load(database, context.userId, input.pageId, "write");
        await assertUnlocked(page);
        await assertParent(database, context.userId, page.workspaceId, input.parentId, page.id);
        if (input.parentId && (await pageProjectId(database, input.parentId)) !== (await pageProjectId(database, page.id))) {
          throw new ActionError("A page and its parent must have the same scope", 400);
        }
        if (input.parentId && !page.projectId) {
          const [parent] = await database.select({ collectionId: wikiPages.collectionId }).from(wikiPages).where(eq(wikiPages.id, input.parentId));
          if (parent?.collectionId !== page.collectionId) throw new ActionError("A page and its parent must have the same Collection", 400);
        }
        if (input.parentId) {
          // Only the owner can see a private parent, so a page placed under one would vanish for everyone else. Only your own page may go there.
          const [parent] = await database.select({ access: wikiPages.access }).from(wikiPages).where(eq(wikiPages.id, input.parentId));
          if (parent?.access === "private" && page.ownerId !== context.userId) throw new ActionError("Only your own pages can be moved under a private page", 403);
        }
        const [updated] = await database.update(wikiPages).set({
          parentId: input.parentId, ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}), updatedAt: now(),
        }).where(eq(wikiPages.id, page.id)).returning();
        if (page.parentId !== input.parentId) await logActivity(database, context, page, "moved", page.parentId, input.parentId);
        return summary(updated!);
      }),
    },
    setWikiPageAccess: {
      name: "set_wiki_page_access", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), access: accessSchema }),
      output: summaryOutput,
      handler: async (context: Context, input: { pageId: string; access: WikiAccess }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await load(database, context.userId, input.pageId, "owner");
        const [updated] = await database.update(wikiPages).set({ access: input.access, ...(input.access === "private" ? { publishedTokenHash: null } : {}), updatedAt: now() }).where(eq(wikiPages.id, page.id)).returning();
        if (page.access !== input.access) await logActivity(database, context, page, "access", page.access, input.access);
        return summary(updated!);
      }),
    },
    /** Soft delete. Only the owner or a workspace Admin; children are deleted with the page. */
    deleteWikiPage: {
      name: "delete_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Object({ deleted: Type.Integer() }),
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page, role } = await load(database, context.userId, input.pageId, "write");
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        const subtree = [...await database.execute<{ id: string; access: string; owner_id: string }>(sql`
          with recursive subtree as (
            select id, access, owner_id from wiki_pages where id = ${page.id}
            union all select w.id, w.access, w.owner_id from wiki_pages w join subtree s on w.parent_id = s.id where w.deleted_at is null
          ) select id, access, owner_id from subtree`)];
        // A caller must not delete pages they cannot see: private pages of other users under this page block the delete.
        if (subtree.some((row) => row.access === "private" && row.owner_id !== context.userId)) {
          throw new ActionError("This page has sub-pages that are private to other people. Move them out before deleting.", 409);
        }
        // Pages by other people under this one are theirs to delete: only a workspace Admin may take them down with it.
        if (role !== "Admin" && subtree.some((row) => row.owner_id !== context.userId)) {
          throw new ActionError("This page has sub-pages owned by other people. Ask an Admin to delete it.", 403);
        }
        await database.execute(sql`update wiki_pages set deleted_at = ${now().toISOString()}::timestamptz
          where id in (${sql.join(subtree.map((row) => sql`${row.id}::uuid`), sql`, `)}) and deleted_at is null`);
        await database.delete(workItemPages).where(inArray(workItemPages.pageId, subtree.map((row) => row.id)));
        await logActivity(database, context, page, "deleted", { title: page.title }, { pages: subtree.length });
        return { deleted: subtree.length };
      }),
    },
    listWikiPageVersions: {
      name: "list_wiki_page_versions", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Array(versionOutput),
      handler: async (context: Context, input: { pageId: string }) => {
        await load(db, context.userId, input.pageId, "read");
        const rows = await db.select().from(wikiPageVersions).where(eq(wikiPageVersions.pageId, input.pageId)).orderBy(desc(wikiPageVersions.createdAt), desc(wikiPageVersions.id));
        return rows.map((row) => ({ id: row.id, title: row.title, createdBy: row.createdBy, createdAt: row.createdAt.toISOString() }));
      },
    },
    /** Restoring snapshots the current state first, so a restore can itself be undone. */
    restoreWikiPageVersion: {
      name: "restore_wiki_page_version", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), versionId: uuid() }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string; versionId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await lockedForWrite(database, context.userId, input.pageId);
        await assertUnlocked(page);
        const [version] = await database.select().from(wikiPageVersions).where(and(eq(wikiPageVersions.id, input.versionId), eq(wikiPageVersions.pageId, page.id)));
        if (!version) throw new ActionError("Version not found", 404);
        await snapshot(database, page, context.userId);
        const [updated] = await database.update(wikiPages).set({ title: version.title, content: version.content, contentText: version.contentText, ydocState: version.ydocState, updatedAt: now() })
          .where(eq(wikiPages.id, page.id)).returning();
        await logActivity(database, context, page, "restored", null, { versionId: version.id });
        return { ...await pageOut(database, updated!), canEdit: true };
      }),
    },
    listWikiPageActivities: {
      name: "list_wiki_page_activities", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Array(activityOutput),
      handler: async (context: Context, input: { pageId: string }) => {
        const { page } = await load(db, context.userId, input.pageId, "read");
        const found = await db.select({ activity: activities, actorName: users.name }).from(activities).innerJoin(users, eq(users.id, activities.actorId))
          .where(and(eq(activities.entityType, "wiki_page"), eq(activities.entityId, input.pageId))).orderBy(asc(activities.seq));
        // Historical link rows and move rows carry project ids; never reveal an inaccessible project.
        const visible = new Set((await accessibleProjects(db, context.userId, page.workspaceId)).map((project) => project.id));
        const rows = found.filter(({ activity: row }) => {
          if (row.field !== "linked" && row.field !== "unlinked") return true;
          const projectId = ((row.newValue ?? row.oldValue) as { projectId?: string } | null)?.projectId;
          return projectId !== undefined && visible.has(projectId);
        });
        return rows.map(({ activity: row, actorName }) => ({
          id: row.id, field: row.field,
          oldValue: row.field === "moved_scope" && typeof row.oldValue === "string" && !visible.has(row.oldValue) ? null : row.oldValue ?? null,
          newValue: row.field === "moved_scope" && typeof row.newValue === "string" && !visible.has(row.newValue) ? null : row.newValue ?? null,
          actorId: row.actorId, actorName,
          source: row.source, chatId: row.chatId, createdAt: row.createdAt.toISOString(),
        }));
      },
    },
    /** Moves a page tree between the Wiki and one project. Only the owner or a workspace Admin may move it. */
    getPageMoveImpact: {
      name: "get_page_move_impact", kind: "read" as const,
      input: Type.Object({ pageId: uuid(), projectId: nullable(uuid()), collectionId: Type.Optional(nullable(uuid())) }),
      output: Type.Object({ pageCount: Type.Integer(), shareCount: Type.Integer(), publishedLink: Type.Boolean(), workItemLinkCount: Type.Integer() }),
      handler: async (context: Context, input: { pageId: string; projectId: string | null; collectionId?: string | null }) => {
        const { page, role } = await load(db, context.userId, input.pageId, "write", { allowWorkspaceAdmin: true });
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        let destination: typeof projects.$inferSelect | null = null;
        if (input.projectId) {
          const access = await requireProjectAccess(db, context.userId, input.projectId, "write");
          if (access.project.workspaceId !== page.workspaceId) throw new ActionError("Project not found", 404);
          destination = access.project;
        } else {
          const targetCollectionId = input.collectionId ?? page.collectionId;
          if (targetCollectionId) {
            const [target] = await db.select().from(collections).where(and(eq(collections.id, targetCollectionId), isNull(collections.deletedAt)));
            if (!target || target.workspaceId !== page.workspaceId) throw new ActionError("Collection not found", 404);
            const workspaceRole = await requireWorkspaceRole(db, context.userId, page.workspaceId, "write");
            if (target.visibility === "private" && target.ownerId !== context.userId && workspaceRole !== "Admin") throw new ActionError("Forbidden", 403);
          }
        }
        const subtree = [...await db.execute<{ id: string }>(sql`
          with recursive subtree as (
            select id from wiki_pages where id = ${page.id} and deleted_at is null
            union all select child.id from wiki_pages child join subtree parent on child.parent_id = parent.id where child.deleted_at is null
          ) select id from subtree`)].map((row) => row.id);
        const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(workItemPages).where(inArray(workItemPages.pageId, subtree));
        const [{ published }] = await db.execute<{ published: boolean }>(sql`
          select exists(select 1 from wiki_pages where id in (${sql.join(subtree.map((id) => sql`${id}::uuid`), sql`, `)}) and published_token_hash is not null) as published`);
        const [{ shares }] = await db.select({ shares: sql<number>`count(*)::int` }).from(wikiPageShares).where(inArray(wikiPageShares.pageId, subtree));
        return { pageCount: subtree.length, shareCount: destination ? shares : 0, publishedLink: Boolean(published), workItemLinkCount: total };
      },
    },
    movePageScope: {
      name: "move_page_scope", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), projectId: nullable(uuid()), collectionId: Type.Optional(nullable(uuid())) }),
      output: Type.Object({ projectId: nullable(Type.String()), key: nullable(Type.String()), name: nullable(Type.String()) }),
      handler: async (context: Context, input: { pageId: string; projectId: string | null; collectionId?: string | null }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page, role } = await load(database, context.userId, input.pageId, "write", { allowWorkspaceAdmin: true });
        await assertUnlocked(page);
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        const oldProjectId = await pageProjectId(database, page.id);
        let destination: typeof projects.$inferSelect | null = null;
        if (input.projectId) {
          const access = await requireProjectAccess(database, context.userId, input.projectId, "write");
          if (access.project.workspaceId !== page.workspaceId) throw new ActionError("Project not found", 404);
          destination = access.project;
        }
        let targetCollectionId: string | null = null;
        let targetPrivate = false;
        if (!destination) {
          if (input.collectionId) {
            const [target] = await database.select().from(collections).where(and(eq(collections.id, input.collectionId), isNull(collections.deletedAt)));
            if (!target || target.workspaceId !== page.workspaceId) throw new ActionError("Collection not found", 404);
            const workspaceRole = await requireWorkspaceRole(database, context.userId, page.workspaceId, "write");
            if (target.visibility === "private" && target.ownerId !== context.userId && workspaceRole !== "Admin") throw new ActionError("Forbidden", 403);
            targetCollectionId = target.id;
            targetPrivate = target.visibility === 'private';
          } else {
            const [fallback] = await database.select().from(collections).where(and(eq(collections.workspaceId, page.workspaceId), eq(collections.isDefault, true), isNull(collections.deletedAt)));
            let target = fallback;
            if (!target) [target] = await database.insert(collections).values({ workspaceId: page.workspaceId, ownerId: context.userId, name: "Wiki", isDefault: true }).returning();
            targetCollectionId = target!.id;
          }
        }
        const subtree = [...await database.execute<{ id: string }>(sql`
          with recursive subtree as (
            select id from wiki_pages where id = ${page.id} and deleted_at is null
            union all select child.id from wiki_pages child join subtree parent on child.parent_id = parent.id where child.deleted_at is null
          ) select id from subtree`)].map((row) => row.id);
        // Like delete: a mover must not strand private pages of other people in a scope their owners cannot reach.
        const [foreignPrivate] = await database.select({ id: wikiPages.id }).from(wikiPages).where(and(inArray(wikiPages.id, subtree), eq(wikiPages.access, "private"), ne(wikiPages.ownerId, context.userId))).limit(1);
        if (foreignPrivate) throw new ActionError("This page has sub-pages that are private to other people. Move them out before moving.", 409);
        const [lockedInSubtree] = await database.select({ id: wikiPages.id }).from(wikiPages).where(and(inArray(wikiPages.id, subtree), isNotNull(wikiPages.lockedAt))).limit(1);
        if (lockedInSubtree) throw new ActionError("This page has sub-pages that are locked. Unlock them before moving.", 409);
        await database.update(wikiPages).set({ projectId: destination?.id ?? null, collectionId: targetCollectionId, ...(destination || targetPrivate ? { publishedTokenHash: null } : {}) }).where(inArray(wikiPages.id, subtree));
        await database.update(wikiPages).set({ parentId: null }).where(eq(wikiPages.id, page.id));
        if (destination) await database.delete(wikiPageShares).where(inArray(wikiPageShares.pageId, subtree));
        if (oldProjectId !== (destination?.id ?? null)) await database.delete(workItemPages).where(inArray(workItemPages.pageId, subtree));
        if (oldProjectId !== (destination?.id ?? null)) await logActivity(database, context, page, "moved_scope", oldProjectId, destination?.id ?? null);
        return { projectId: destination?.id ?? null, key: destination?.key ?? null, name: destination?.name ?? null };
      }),
    },
    /** A project's Pages: the Pages assigned to it that the caller may see. */
    listProjectWikiPages: {
      name: "list_project_wiki_pages", kind: "read" as const,
      input: Type.Object({ projectId: uuid(), archived: Type.Optional(Type.Boolean()) }),
      output: Type.Array(summaryOutput),
      handler: async (context: Context, input: { projectId: string; archived?: boolean }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read", { allowArchived: true });
        assertFeatureEnabled(project, "pages");
        const [membership] = await db.select({ userId: projectMembers.userId }).from(projectMembers)
          .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, context.userId)));
        if (!membership) throw new ActionError("Project not found", 404);
        const rows = await db.select({ page: wikiPages, ownerName: users.name }).from(wikiPages).leftJoin(users, eq(users.id, wikiPages.ownerId)).where(and(
          eq(wikiPages.projectId, project.id), isNull(wikiPages.deletedAt),
          input.archived ? sql`${wikiPages.archivedAt} is not null` : isNull(wikiPages.archivedAt),
          sql`exists (select 1 from project_members m where m.project_id = ${project.id} and m.user_id = ${context.userId})`,
          sql`(${wikiPages.access} = 'public' or ${wikiPages.ownerId} = ${context.userId})`,
        )).orderBy(asc(wikiPages.sortOrder), asc(wikiPages.createdAt), asc(wikiPages.id));
        return rows.map(({ page, ownerName }) => summary(page, ownerName));
      },
    },
    linkWorkItemPage: {
      name: "link_work_item_page", kind: "write" as const,
      input: Type.Object({ workItemId: uuid(), pageId: uuid() }), output: Type.Object({ linked: Type.Boolean() }),
      handler: async (context: Context, input: { workItemId: string; pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const [item] = await database.select().from(workItems).where(eq(workItems.id, input.workItemId));
        if (!item) throw new ActionError("Work item not found", 404);
        await requireProjectAccess(database, context.userId, item.projectId, "write");
        assertNotArchived(item);
        const { page } = await load(database, context.userId, input.pageId, "read");
        if (page.workspaceId !== item.workspaceId) throw new ActionError("Page not found", 404);
        const [existing] = await database.select().from(workItemPages).where(and(eq(workItemPages.workItemId, item.id), eq(workItemPages.pageId, page.id)));
        if (!existing) await database.insert(workItemPages).values({ workItemId: item.id, pageId: page.id, createdBy: context.userId });
        return { linked: true };
      }),
    },
    unlinkWorkItemPage: {
      name: "unlink_work_item_page", kind: "write" as const,
      input: Type.Object({ workItemId: uuid(), pageId: uuid() }), output: Type.Object({ unlinked: Type.Boolean() }),
      handler: async (context: Context, input: { workItemId: string; pageId: string }) => {
        const [item] = await db.select().from(workItems).where(eq(workItems.id, input.workItemId));
        if (!item) throw new ActionError("Work item not found", 404);
        await requireProjectAccess(db, context.userId, item.projectId, "write");
        assertNotArchived(item);
        await db.delete(workItemPages).where(and(eq(workItemPages.workItemId, item.id), eq(workItemPages.pageId, input.pageId)));
        return { unlinked: true };
      },
    },
    listWorkItemPages: {
      name: "list_work_item_pages", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), projectId: nullable(Type.String()) })),
      handler: async (context: Context, input: { workItemId: string }) => {
        const [item] = await db.select().from(workItems).where(eq(workItems.id, input.workItemId));
        if (!item) throw new ActionError("Work item not found", 404);
        await requireProjectAccess(db, context.userId, item.projectId, "read");
        const rows = await db.select({ page: wikiPages }).from(workItemPages).innerJoin(wikiPages, eq(wikiPages.id, workItemPages.pageId))
          .where(and(eq(workItemPages.workItemId, item.id), isNull(wikiPages.deletedAt)));
        const result = [];
        for (const { page } of rows) {
          try { await load(db, context.userId, page.id, "read"); result.push({ id: page.id, title: page.title, projectId: page.projectId }); }
          catch (error) { if (!(error instanceof ActionError) || error.status !== 404) throw error; }
        }
        return result;
      },
    },
    listWikiPageWorkItems: {
      name: "list_wiki_page_work_items", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Array(Type.Object({ id: Type.String(), projectId: Type.String(), sequence: Type.Integer(), displayId: Type.String(), title: Type.String() })),
      handler: async (context: Context, input: { pageId: string }) => {
        const { page } = await load(db, context.userId, input.pageId, "read");
        const rows = await db.select({ item: workItems, projectKey: projects.key }).from(workItemPages)
          .innerJoin(workItems, eq(workItems.id, workItemPages.workItemId)).innerJoin(projects, eq(projects.id, workItems.projectId))
          .where(and(eq(workItemPages.pageId, page.id), isNull(workItems.deletedAt)));
        const result = [];
        for (const { item, projectKey } of rows) {
          try {
            await requireProjectAccess(db, context.userId, item.projectId, "read");
            result.push({ id: item.id, projectId: item.projectId, sequence: item.sequence, displayId: `${projectKey}-${item.sequence}`, title: item.title });
          } catch (error) { if (!(error instanceof ActionError) || (error.status !== 403 && error.status !== 404)) throw error; }
        }
        return result;
      },
    },
    createWikiPageComment: {
      name: "create_wiki_page_comment", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), body: Type.Any(), anchor: Type.String({ minLength: 1, maxLength: 2048 }) }),
      output: Type.Any(),
      handler: async (context: Context, input: { pageId: string; body: unknown; anchor: string }) => {
        const { page } = await load(db, context.userId, input.pageId, "read");
        if (page.projectId) {
          const access = await requireProjectAccess(db, context.userId, page.projectId, "read");
          if (access.projectRole === "Guest") throw new ActionError("Forbidden", 403);
        } else {
          const [share] = await db.select({ role: wikiPageShares.role }).from(wikiPageShares).where(and(eq(wikiPageShares.pageId, page.id), eq(wikiPageShares.userId, context.userId)));
          if (page.ownerId !== context.userId && share?.role !== "comment" && share?.role !== "edit") throw new ActionError("Forbidden", 403);
        }
        const text = plainText(input.body);
        const [row] = await db.insert(comments).values({ workspaceId: page.workspaceId, projectId: page.projectId, workItemId: null, wikiPageId: page.id, authorId: context.userId, body: input.body, bodyText: text, anchor: input.anchor }).returning();
        return { ...row, authorName: (await db.select({ name: users.name }).from(users).where(eq(users.id, context.userId)))[0]?.name ?? "" , replies: [], resolved: false };
      },
    },
    listWikiPageComments: {
      name: "list_wiki_page_comments", kind: "read" as const,
      input: Type.Object({ pageId: uuid(), includeResolved: Type.Optional(Type.Boolean()) }), output: Type.Array(Type.Any()),
      handler: async (context: Context, input: { pageId: string; includeResolved?: boolean }) => {
        await load(db, context.userId, input.pageId, "read");
        const rows = await db.select({ comment: comments, authorName: users.name }).from(comments).innerJoin(users, eq(users.id, comments.authorId)).where(and(eq(comments.wikiPageId, input.pageId), isNull(comments.parentId), isNull(comments.deletedAt), input.includeResolved ? sql`true` : isNull(comments.resolvedAt))).orderBy(asc(comments.createdAt));
        const result = [];
        for (const { comment, authorName } of rows) {
          const replies = await db.select({ comment: comments, authorName: users.name }).from(comments).innerJoin(users, eq(users.id, comments.authorId)).where(and(eq(comments.parentId, comment.id), isNull(comments.deletedAt))).orderBy(asc(comments.createdAt));
          result.push({ ...comment, authorName, resolved: comment.resolvedAt !== null, replies: replies.map(({ comment: reply, authorName: replyAuthor }) => ({ ...reply, authorName: replyAuthor })) });
        }
        return result;
      },
    },
    replyWikiPageComment: {
      name: "reply_wiki_page_comment", kind: "write" as const,
      input: Type.Object({ commentId: uuid(), body: Type.Any() }), output: Type.Any(),
      handler: async (context: Context, input: { commentId: string; body: unknown }) => {
        const [parent] = await db.select().from(comments).where(and(eq(comments.id, input.commentId), isNull(comments.parentId), isNull(comments.deletedAt)));
        if (!parent?.wikiPageId) throw new ActionError("Comment not found", 404);
        const { page } = await load(db, context.userId, parent.wikiPageId, "read");
        if (page.projectId) {
          const access = await requireProjectAccess(db, context.userId, page.projectId, "read");
          if (access.projectRole === "Guest") throw new ActionError("Forbidden", 403);
        } else {
          const [share] = await db.select({ role: wikiPageShares.role }).from(wikiPageShares).where(and(eq(wikiPageShares.pageId, page.id), eq(wikiPageShares.userId, context.userId)));
          if (page.ownerId !== context.userId && share?.role !== "comment" && share?.role !== "edit") throw new ActionError("Forbidden", 403);
        }
        const [row] = await db.insert(comments).values({ workspaceId: parent.workspaceId, projectId: parent.projectId, workItemId: null, wikiPageId: page.id, authorId: context.userId, body: input.body, bodyText: plainText(input.body), parentId: parent.id }).returning();
        return { ...row, authorName: (await db.select({ name: users.name }).from(users).where(eq(users.id, context.userId)))[0]?.name ?? "" };
      },
    },
    updateWikiPageComment: {
      name: "update_wiki_page_comment", kind: "write" as const,
      input: Type.Object({ commentId: uuid(), body: Type.Any() }), output: Type.Any(),
      handler: async (context: Context, input: { commentId: string; body: unknown }) => {
        const [row] = await db.select().from(comments).where(and(eq(comments.id, input.commentId), isNull(comments.deletedAt)));
        if (!row?.wikiPageId) throw new ActionError("Comment not found", 404);
        const { page } = await load(db, context.userId, row.wikiPageId, "read");
        if (!page.projectId) {
          const [share] = await db.select({ role: wikiPageShares.role }).from(wikiPageShares).where(and(eq(wikiPageShares.pageId, page.id), eq(wikiPageShares.userId, context.userId)));
          if (page.ownerId !== context.userId && share?.role !== "comment" && share?.role !== "edit") throw new ActionError("Forbidden", 403);
        } else {
          const access = await requireProjectAccess(db, context.userId, page.projectId, "read");
          if (access.projectRole === "Guest") throw new ActionError("Forbidden", 403);
        }
        if (row.authorId !== context.userId) throw new ActionError("Forbidden", 403);
        const [updated] = await db.update(comments).set({ body: input.body, bodyText: plainText(input.body), editedAt: now() }).where(eq(comments.id, row.id)).returning();
        return updated;
      },
    },
    resolveWikiPageComment: {
      name: "resolve_wiki_page_comment", kind: "write" as const,
      input: Type.Object({ commentId: uuid(), resolved: Type.Boolean() }), output: Type.Object({ resolved: Type.Boolean() }),
      handler: async (context: Context, input: { commentId: string; resolved: boolean }) => {
        const [row] = await db.select().from(comments).where(and(eq(comments.id, input.commentId), isNull(comments.deletedAt)));
        if (!row?.wikiPageId) throw new ActionError("Comment not found", 404);
        const { page } = await load(db, context.userId, row.wikiPageId, "read");
        if (page.projectId) {
          const access = await requireProjectAccess(db, context.userId, page.projectId, "read");
          if (access.projectRole === "Guest") throw new ActionError("Forbidden", 403);
        } else {
          const [share] = await db.select({ role: wikiPageShares.role }).from(wikiPageShares).where(and(eq(wikiPageShares.pageId, page.id), eq(wikiPageShares.userId, context.userId)));
          if (page.ownerId !== context.userId && share?.role !== "comment" && share?.role !== "edit") throw new ActionError("Forbidden", 403);
        }
        await db.update(comments).set({ resolvedAt: input.resolved ? now() : null }).where(eq(comments.id, row.id));
        return { resolved: input.resolved };
      },
    },
    searchWikiPages: {
      name: "search_wiki_pages", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid(), query: Type.String({ minLength: 1, maxLength: 200 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      output: Type.Array(searchOutput),
      handler: async (context: Context, input: { workspaceId: string; query: string; limit?: number }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const query = input.query.trim();
        if (query.length === 0) return [];
        const pattern = `%${escapeLike(query)}%`;
        const rows = await db.select().from(wikiPages).where(and(
          eq(wikiPages.workspaceId, input.workspaceId), isNull(wikiPages.deletedAt), isNull(wikiPages.archivedAt),
          sql`(${wikiPages.projectId} is null or exists (select 1 from projects p where p.id = ${wikiPages.projectId} and p.pages_enabled = true))`,
          sql`(${wikiPages.projectId} is null or exists (
            select 1 from project_members m where m.project_id = ${wikiPages.projectId} and m.user_id = ${context.userId}))`,
          sql`(${wikiPages.access} = 'public' or ${wikiPages.ownerId} = ${context.userId} or exists (select 1 from wiki_page_shares s where s.page_id = ${wikiPages.id} and s.user_id = ${context.userId}))`,
          sql`(${wikiPages.projectId} is not null or exists (
            select 1 from wiki_collections c where c.id = ${wikiPages.collectionId} and c.deleted_at is null
            and (c.visibility = 'public' or c.owner_id = ${context.userId} or exists (
              select 1 from wiki_collection_members cm where cm.collection_id = c.id and cm.user_id = ${context.userId}
            ) or exists (select 1 from wiki_page_shares ps where ps.page_id = ${wikiPages.id} and ps.user_id = ${context.userId}))
          ))`,
          sql`(${wikiPages.title} ilike ${pattern} or ${wikiPages.contentText} ilike ${pattern}
            or to_tsvector('english', ${wikiPages.title} || ' ' || ${wikiPages.contentText}) @@ plainto_tsquery('english', ${query}))`,
        )).orderBy(sql`(${wikiPages.title} ilike ${pattern}) desc`, asc(wikiPages.sortOrder), asc(wikiPages.createdAt), asc(wikiPages.id)).limit(input.limit ?? 25);
        return rows.map((row) => ({ id: row.id, title: row.title, snippet: snippetOf(row.contentText, query), access: row.access as WikiAccess, projectId: row.projectId ?? null }));
      },
    },
  };
}
