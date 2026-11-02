import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, assets, projectMembers, projects, users, wikiPageVersions, wikiPages, workspaceMembers, workItemPages, workItems } from "@weft/db";
import { ActionError, requireWorkspaceRole, type WorkspaceRole } from "./members";
import { accessibleProjects, requireProjectAccess } from "./projects";
import { escapeLike } from "./search";
import { plainText, type ActivitySource } from "./work-items";
import { wikiYStateFromContent } from "./wiki-yjs";
import { createS3Storage, type AssetStorage } from "./storage";
import { enqueuePageMention } from "./notifications";

export const wikiAccess = ["public", "private"] as const;
export type WikiAccess = (typeof wikiAccess)[number];

/** Autosave writes a new version only when the latest one is at least this old. */
export const versionIntervalMs = 5 * 60_000;

const uuid = () => Type.String({ format: "uuid" });
const accessSchema = Type.Union(wikiAccess.map((value) => Type.Literal(value)));
const nullable = <T extends import("@sinclair/typebox").TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const summaryOutput = Type.Object({
  id: Type.String(), projectId: nullable(Type.String()), parentId: nullable(Type.String()), title: Type.String(), access: accessSchema, ownerId: Type.String(), ownerName: nullable(Type.String()), sortOrder: Type.Number(), createdAt: Type.String(), updatedAt: Type.String(),
});
const pageOutput = Type.Object({
  id: Type.String(), workspaceId: Type.String(), projectId: nullable(Type.String()), parentId: nullable(Type.String()), title: Type.String(), access: accessSchema, ownerId: Type.String(), ownerName: nullable(Type.String()),
  sortOrder: Type.Number(), content: Type.Any(), contentText: Type.String(), canEdit: Type.Boolean(), createdAt: Type.String(), updatedAt: Type.String(),
});
const versionOutput = Type.Object({ id: Type.String(), title: Type.String(), createdBy: Type.String(), createdAt: Type.String() });
const activityOutput = Type.Object({
  id: Type.String(), field: Type.String(), oldValue: Type.Any(), newValue: Type.Any(), actorId: Type.String(), actorName: Type.String(),
  source: Type.String(), chatId: nullable(Type.String()), createdAt: Type.String(),
});
const searchOutput = Type.Object({ id: Type.String(), title: Type.String(), snippet: Type.String(), access: accessSchema });

type Context = { userId: string; source?: ActivitySource; chatId?: string };
type PageRow = typeof wikiPages.$inferSelect;

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
    id: page.id, projectId: page.projectId, parentId: page.parentId, title: page.title, access: page.access as WikiAccess, ownerId: page.ownerId, ownerName, sortOrder: page.sortOrder,
    createdAt: page.createdAt.toISOString(), updatedAt: page.updatedAt.toISOString(),
  });

  async function pageOut(database: Database, page: PageRow) {
    const [owner] = await database.select({ name: users.name }).from(users).where(eq(users.id, page.ownerId));
    return {
      ...summary(page, owner?.name ?? null), workspaceId: page.workspaceId, content: page.content ?? null, contentText: page.contentText,
      createdAt: page.createdAt.toISOString(), updatedAt: page.updatedAt.toISOString(),
    };
  }

  /** Public pages are open to every member; private pages only to their owner. A hidden page looks missing. */
  async function load(database: Database, userId: string, pageId: string, requirement: "read" | "write" | "owner") {
    const [page] = await database.select().from(wikiPages).where(and(eq(wikiPages.id, pageId), isNull(wikiPages.deletedAt)));
    if (!page) throw new ActionError("Wiki page not found", 404);
    const role = await requireWorkspaceRole(database, userId, page.workspaceId, requirement === "read" ? "read" : "write");
    let canWrite = role !== "Guest";
    if (page.projectId) {
      const projectAccess = await requireProjectAccess(database, userId, page.projectId, requirement === "read" ? "read" : "write");
      const [membership] = await database.select({ userId: projectMembers.userId }).from(projectMembers)
        .where(and(eq(projectMembers.projectId, page.projectId), eq(projectMembers.userId, userId)));
      if (projectAccess.project.workspaceId !== page.workspaceId || !membership) throw new ActionError("Wiki page not found", 404);
      canWrite = canWrite && (projectAccess.workspaceRole === "Admin" || projectAccess.projectRole !== "Guest");
    }
    if (page.access === "private" && page.ownerId !== userId) throw new ActionError("Wiki page not found", 404);
    if (requirement === "owner" && page.ownerId !== userId) throw new ActionError("Forbidden", 403);
    return { page, role: role as WorkspaceRole, canWrite };
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
    for (const id of ids) {
      const [item] = await database.select().from(workItems).where(eq(workItems.id, id));
      if (!item || item.workspaceId !== page.workspaceId) throw new ActionError("Mentioned work item not found", 400);
      try { await requireProjectAccess(database, userId, item.projectId, "read"); }
      catch { throw new ActionError("Mentioned work item is not visible", 400); }
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

  async function mentionable(database: Database, page: PageRow) {
    if (page.access === "private") return [{ userId: page.ownerId }];
    if (page.projectId) return database.select({ userId: projectMembers.userId }).from(projectMembers)
      .where(eq(projectMembers.projectId, page.projectId));
    return database.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, page.workspaceId));
  }

  /** Appends one Activity row for a wiki page, in the caller's transaction. Wiki pages are workspace-level, so there is no project. */
  async function logActivity(database: Database, context: Context, page: { id: string; workspaceId: string }, field: string, oldValue: unknown, newValue: unknown) {
    await database.insert(activities).values({
      workspaceId: page.workspaceId, projectId: null, entityType: "wiki_page", entityId: page.id, field,
      oldValue: oldValue ?? null, newValue: newValue ?? null, actorId: context.userId, source: context.source ?? "ui",
      chatId: context.source === "ai" ? context.chatId ?? null : null, createdAt: now(),
    });
  }

  return {
    listWikiPageMentionableMembers: {
      name: "list_wiki_page_mentionable_members", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }), output: Type.Array(Type.Object({ userId: Type.String(), name: Type.String() })),
      handler: async (context: Context, input: { pageId: string }) => {
        const { page } = await load(db, context.userId, input.pageId, "read");
        const allowed = await mentionable(db, page);
        if (allowed.length === 0) return [];
        return db.select({ userId: users.id, name: users.name }).from(users).where(inArray(users.id, allowed.map((row) => row.userId))).orderBy(asc(users.name), asc(users.id));
      },
    },
    createWikiPage: {
      name: "create_wiki_page", kind: "write" as const,
      input: Type.Object({
        workspaceId: uuid(), title: Type.String({ minLength: 1, maxLength: 300 }), parentId: Type.Optional(nullable(uuid())),
        projectId: Type.Optional(nullable(uuid())), access: Type.Optional(accessSchema), content: Type.Optional(Type.Any()),
      }),
      output: pageOutput,
      handler: async (context: Context, input: { workspaceId: string; title: string; parentId?: string | null; projectId?: string | null; access?: WikiAccess; content?: unknown }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        await requireWorkspaceRole(database, context.userId, input.workspaceId, "write");
        let project: typeof projects.$inferSelect | null = null;
        if (input.projectId) {
          const access = await requireProjectAccess(database, context.userId, input.projectId, "write");
          if (access.project.workspaceId !== input.workspaceId) throw new ActionError("Project not found", 404);
          project = access.project;
        }
        await assertParent(database, context.userId, input.workspaceId, input.parentId ?? null);
        if (input.parentId && (await pageProjectId(database, input.parentId)) !== (project?.id ?? null)) {
          throw new ActionError("A page and its parent must have the same scope", 400);
        }
        const [last] = await database.select({ order: wikiPages.sortOrder }).from(wikiPages)
          .where(and(eq(wikiPages.workspaceId, input.workspaceId), input.parentId ? eq(wikiPages.parentId, input.parentId) : isNull(wikiPages.parentId)))
          .orderBy(desc(wikiPages.sortOrder)).limit(1);
        const [page] = await database.insert(wikiPages).values({
          workspaceId: input.workspaceId, projectId: project?.id ?? null, parentId: input.parentId ?? null, ownerId: context.userId, title: input.title,
          content: input.content ?? null, contentText: plainText(input.content), ydocState: wikiYStateFromContent(input.content ?? { type: "doc", content: [{ type: "paragraph" }] }), access: input.access ?? "public",
          sortOrder: (last?.order ?? 0) + 1, createdAt: now(), updatedAt: now(),
        }).returning();
        await syncWorkItemMentions(database, context.userId, page!, input.content);
        await snapshot(database, page!, context.userId);
        await logActivity(database, context, page!, "created", null, { title: page!.title, access: page!.access });
        return { ...await pageOut(database, page!), canEdit: true };
      }),
    },
    listWikiPages: {
      name: "list_wiki_pages", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid() }),
      output: Type.Array(summaryOutput),
      handler: async (context: Context, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const rows = await db.select({ page: wikiPages, ownerName: users.name }).from(wikiPages).leftJoin(users, eq(users.id, wikiPages.ownerId)).where(and(
          eq(wikiPages.workspaceId, input.workspaceId), isNull(wikiPages.deletedAt),
          isNull(wikiPages.projectId),
          sql`(${wikiPages.access} = 'public' or ${wikiPages.ownerId} = ${context.userId})`,
        )).orderBy(asc(wikiPages.sortOrder), asc(wikiPages.createdAt), asc(wikiPages.id));
        return rows.map(({ page, ownerName }) => summary(page, ownerName));
      },
    },
    getWikiPage: {
      name: "get_wiki_page", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string }) => { const loaded = await load(db, context.userId, input.pageId, "read"); return { ...await pageOut(db, loaded.page), canEdit: loaded.canWrite }; },
    },
    duplicateWikiPage: {
      name: "duplicate_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await load(database, context.userId, input.pageId, "write");
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
          workspaceId: page.workspaceId, projectId: page.projectId, parentId: page.parentId, ownerId: context.userId,
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
    /** Autosave target: refreshes the editor lock, saves content, and snapshots a version on a cadence. */
    updateWikiPage: {
      name: "update_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), content: Type.Optional(Type.Any()) }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string; title?: string; content?: unknown }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await lockedForWrite(database, context.userId, input.pageId);
        const titleChanged = input.title !== undefined && input.title !== page.title;
        const contentChanged = input.content !== undefined && JSON.stringify(input.content) !== JSON.stringify(page.content);
        const addedMentions = contentChanged ? [...collectMentions(input.content)].filter((id) => !collectMentions(page.content).has(id)) : [];
        if (addedMentions.length) {
          const allowed = new Set((await mentionable(database, page)).map((row) => row.userId));
          if (addedMentions.some((id) => !allowed.has(id))) throw new ActionError("Mentioned user cannot see this page", 400);
        }
        if (!titleChanged && !contentChanged) return { ...await pageOut(database, page), canEdit: true };
        const [latest] = await database.select({ at: wikiPageVersions.createdAt }).from(wikiPageVersions)
          .where(eq(wikiPageVersions.pageId, page.id)).orderBy(desc(wikiPageVersions.createdAt)).limit(1);
        const versioned = context.source === "ai" || !latest || now().getTime() - latest.at.getTime() >= versionIntervalMs;
        if (context.source === "ai" && contentChanged) await snapshot(database, page, context.userId);
        const [updated] = await database.update(wikiPages).set({
          ...(titleChanged ? { title: input.title! } : {}),
          ...(contentChanged ? { content: input.content, contentText: plainText(input.content), ydocState: wikiYStateFromContent(input.content) } : {}),
          updatedAt: now(),
        }).where(eq(wikiPages.id, page.id)).returning();
        if (addedMentions.length) await enqueuePageMention(database, page.id, context.userId, addedMentions);
        if (contentChanged) await syncWorkItemMentions(database, context.userId, updated!, input.content);
        if (versioned && context.source !== "ai") await snapshot(database, updated!, context.userId);
        if (titleChanged) await logActivity(database, context, page, "title", page.title, updated!.title);
        // Autosave fires every few seconds, so a human edit is logged once per saved version; AI edits are always logged.
        if (contentChanged && (versioned || (context.source !== undefined && context.source !== "ui"))) await logActivity(database, context, page, "content", null, { changed: true });
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
        await assertParent(database, context.userId, page.workspaceId, input.parentId, page.id);
        if (input.parentId && (await pageProjectId(database, input.parentId)) !== (await pageProjectId(database, page.id))) {
          throw new ActionError("A page and its parent must have the same scope", 400);
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
        const [updated] = await database.update(wikiPages).set({ access: input.access, updatedAt: now() }).where(eq(wikiPages.id, page.id)).returning();
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
    movePageScope: {
      name: "move_page_scope", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), projectId: nullable(uuid()) }),
      output: Type.Object({ projectId: nullable(Type.String()), key: nullable(Type.String()), name: nullable(Type.String()) }),
      handler: async (context: Context, input: { pageId: string; projectId: string | null }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page, role } = await load(database, context.userId, input.pageId, "write");
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        const oldProjectId = await pageProjectId(database, page.id);
        let destination: typeof projects.$inferSelect | null = null;
        if (input.projectId) {
          const access = await requireProjectAccess(database, context.userId, input.projectId, "write");
          if (access.project.workspaceId !== page.workspaceId) throw new ActionError("Project not found", 404);
          destination = access.project;
        }
        const subtree = [...await database.execute<{ id: string }>(sql`
          with recursive subtree as (
            select id from wiki_pages where id = ${page.id} and deleted_at is null
            union all select child.id from wiki_pages child join subtree parent on child.parent_id = parent.id where child.deleted_at is null
          ) select id from subtree`)].map((row) => row.id);
        await database.update(wikiPages).set({ projectId: destination?.id ?? null }).where(inArray(wikiPages.id, subtree));
        if (oldProjectId !== (destination?.id ?? null)) await database.delete(workItemPages).where(inArray(workItemPages.pageId, subtree));
        if (oldProjectId !== (destination?.id ?? null)) await logActivity(database, context, page, "moved_scope", oldProjectId, destination?.id ?? null);
        return { projectId: destination?.id ?? null, key: destination?.key ?? null, name: destination?.name ?? null };
      }),
    },
    /** A project's Pages: the Pages assigned to it that the caller may see. */
    listProjectWikiPages: {
      name: "list_project_wiki_pages", kind: "read" as const,
      input: Type.Object({ projectId: uuid() }),
      output: Type.Array(summaryOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read", { allowArchived: true });
        const [membership] = await db.select({ userId: projectMembers.userId }).from(projectMembers)
          .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, context.userId)));
        if (!membership) throw new ActionError("Project not found", 404);
        const rows = await db.select({ page: wikiPages, ownerName: users.name }).from(wikiPages).leftJoin(users, eq(users.id, wikiPages.ownerId)).where(and(
          eq(wikiPages.projectId, project.id), isNull(wikiPages.deletedAt),
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
          eq(wikiPages.workspaceId, input.workspaceId), isNull(wikiPages.deletedAt),
          sql`(${wikiPages.projectId} is null or exists (
            select 1 from project_members m where m.project_id = ${wikiPages.projectId} and m.user_id = ${context.userId}))`,
          sql`(${wikiPages.access} = 'public' or ${wikiPages.ownerId} = ${context.userId})`,
          sql`(${wikiPages.title} ilike ${pattern} or ${wikiPages.contentText} ilike ${pattern}
            or to_tsvector('english', ${wikiPages.title} || ' ' || ${wikiPages.contentText}) @@ plainto_tsquery('english', ${query}))`,
        )).orderBy(sql`(${wikiPages.title} ilike ${pattern}) desc`, asc(wikiPages.sortOrder), asc(wikiPages.createdAt), asc(wikiPages.id)).limit(input.limit ?? 25);
        return rows.map((row) => ({ id: row.id, title: row.title, snippet: snippetOf(row.contentText, query), access: row.access as WikiAccess }));
      },
    },
  };
}
