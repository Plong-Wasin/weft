import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { users, wikiPageVersions, wikiPages } from "@weft/db";
import { ActionError, requireWorkspaceRole, type WorkspaceRole } from "./members";
import { escapeLike } from "./search";
import { plainText } from "./work-items";

export const wikiAccess = ["public", "private"] as const;
export type WikiAccess = (typeof wikiAccess)[number];

/** A live lock lasts this long without a heartbeat; after that anyone may take over. */
export const lockTimeoutMs = 60_000;
/** Autosave writes a new version only when the latest one is at least this old. */
export const versionIntervalMs = 5 * 60_000;

const uuid = () => Type.String({ format: "uuid" });
const accessSchema = Type.Union(wikiAccess.map((value) => Type.Literal(value)));
const nullable = <T extends import("@sinclair/typebox").TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const lockOutput = nullable(Type.Object({ userId: Type.String(), name: Type.String(), expiresAt: Type.String() }));
const summaryOutput = Type.Object({
  id: Type.String(), parentId: nullable(Type.String()), title: Type.String(), access: accessSchema, ownerId: Type.String(), sortOrder: Type.Number(),
});
const pageOutput = Type.Object({
  id: Type.String(), workspaceId: Type.String(), parentId: nullable(Type.String()), title: Type.String(), access: accessSchema, ownerId: Type.String(),
  sortOrder: Type.Number(), content: Type.Any(), contentText: Type.String(), createdAt: Type.String(), updatedAt: Type.String(), lock: lockOutput,
});
const versionOutput = Type.Object({ id: Type.String(), title: Type.String(), createdBy: Type.String(), createdAt: Type.String() });
const searchOutput = Type.Object({ id: Type.String(), title: Type.String(), snippet: Type.String(), access: accessSchema });

type Context = { userId: string };
type PageRow = typeof wikiPages.$inferSelect;

function snippetOf(text: string, query: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 40);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 120)}`;
}

export function createWikiActions(db: Database, now: () => Date = () => new Date()) {
  const summary = (page: PageRow) => ({
    id: page.id, parentId: page.parentId, title: page.title, access: page.access as WikiAccess, ownerId: page.ownerId, sortOrder: page.sortOrder,
  });

  async function lockOf(database: Database, page: PageRow) {
    if (!page.lockedBy || !page.lockExpiresAt || page.lockExpiresAt <= now()) return null;
    const [holder] = await database.select({ name: users.name }).from(users).where(eq(users.id, page.lockedBy));
    return { userId: page.lockedBy, name: holder?.name ?? "", expiresAt: page.lockExpiresAt.toISOString() };
  }

  async function pageOut(database: Database, page: PageRow) {
    return {
      ...summary(page), workspaceId: page.workspaceId, content: page.content ?? null, contentText: page.contentText,
      createdAt: page.createdAt.toISOString(), updatedAt: page.updatedAt.toISOString(), lock: await lockOf(database, page),
    };
  }

  /** Public pages are open to every member; private pages only to their owner. A hidden page looks missing. */
  async function load(database: Database, userId: string, pageId: string, requirement: "read" | "write" | "owner") {
    const [page] = await database.select().from(wikiPages).where(and(eq(wikiPages.id, pageId), isNull(wikiPages.deletedAt)));
    if (!page) throw new ActionError("Wiki page not found", 404);
    const role = await requireWorkspaceRole(database, userId, page.workspaceId, requirement === "read" ? "read" : "write");
    if (page.access === "private" && page.ownerId !== userId) throw new ActionError("Wiki page not found", 404);
    if (requirement === "owner" && page.ownerId !== userId) throw new ActionError("Forbidden", 403);
    return { page, role: role as WorkspaceRole };
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

  async function snapshot(database: Database, page: PageRow, userId: string) {
    await database.insert(wikiPageVersions).values({ pageId: page.id, title: page.title, content: page.content, contentText: page.contentText, createdBy: userId, createdAt: now() });
  }

  /** Takes the lock if it is free, expired, or already ours; refuses while someone else holds a live one. */
  async function takeLock(database: Database, page: PageRow, userId: string, takeover = false) {
    const live = await lockOf(database, page);
    if (live && live.userId !== userId && !takeover) throw new ActionError(`${live.name || "Another user"} is editing this page`, 409);
    const expires = new Date(now().getTime() + lockTimeoutMs);
    const [updated] = await database.update(wikiPages).set({ lockedBy: userId, lockExpiresAt: expires }).where(eq(wikiPages.id, page.id)).returning();
    return updated!;
  }

  async function lockedForWrite(database: Database, userId: string, pageId: string) {
    const loaded = await load(database, userId, pageId, "write");
    await database.execute(sql`select 1 from wiki_pages where id = ${pageId} for update`);
    const [fresh] = await database.select().from(wikiPages).where(eq(wikiPages.id, pageId));
    return { ...loaded, page: fresh! };
  }

  return {
    createWikiPage: {
      name: "create_wiki_page", kind: "write" as const,
      input: Type.Object({
        workspaceId: uuid(), title: Type.String({ minLength: 1, maxLength: 300 }), parentId: Type.Optional(nullable(uuid())),
        access: Type.Optional(accessSchema), content: Type.Optional(Type.Any()),
      }),
      output: pageOutput,
      handler: async (context: Context, input: { workspaceId: string; title: string; parentId?: string | null; access?: WikiAccess; content?: unknown }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "write");
        await assertParent(db, context.userId, input.workspaceId, input.parentId ?? null);
        const [last] = await db.select({ order: wikiPages.sortOrder }).from(wikiPages)
          .where(and(eq(wikiPages.workspaceId, input.workspaceId), input.parentId ? eq(wikiPages.parentId, input.parentId) : isNull(wikiPages.parentId)))
          .orderBy(desc(wikiPages.sortOrder)).limit(1);
        const [page] = await db.insert(wikiPages).values({
          workspaceId: input.workspaceId, parentId: input.parentId ?? null, ownerId: context.userId, title: input.title,
          content: input.content ?? null, contentText: plainText(input.content), access: input.access ?? "public",
          sortOrder: (last?.order ?? 0) + 1, createdAt: now(), updatedAt: now(),
        }).returning();
        await snapshot(db, page!, context.userId);
        return pageOut(db, page!);
      },
    },
    listWikiPages: {
      name: "list_wiki_pages", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid() }),
      output: Type.Array(summaryOutput),
      handler: async (context: Context, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const rows = await db.select().from(wikiPages).where(and(
          eq(wikiPages.workspaceId, input.workspaceId), isNull(wikiPages.deletedAt),
          sql`(${wikiPages.access} = 'public' or ${wikiPages.ownerId} = ${context.userId})`,
        )).orderBy(asc(wikiPages.sortOrder), asc(wikiPages.createdAt), asc(wikiPages.id));
        return rows.map(summary);
      },
    },
    getWikiPage: {
      name: "get_wiki_page", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string }) => pageOut(db, (await load(db, context.userId, input.pageId, "read")).page),
    },
    /** Autosave target: refreshes the editor lock, saves content, and snapshots a version on a cadence. */
    updateWikiPage: {
      name: "update_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), content: Type.Optional(Type.Any()) }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string; title?: string; content?: unknown }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await lockedForWrite(database, context.userId, input.pageId);
        const locked = await takeLock(database, page, context.userId);
        const titleChanged = input.title !== undefined && input.title !== page.title;
        const contentChanged = input.content !== undefined && JSON.stringify(input.content) !== JSON.stringify(page.content);
        if (!titleChanged && !contentChanged) return pageOut(database, locked);
        const [latest] = await database.select({ at: wikiPageVersions.createdAt }).from(wikiPageVersions)
          .where(eq(wikiPageVersions.pageId, page.id)).orderBy(desc(wikiPageVersions.createdAt)).limit(1);
        const [updated] = await database.update(wikiPages).set({
          ...(titleChanged ? { title: input.title! } : {}),
          ...(contentChanged ? { content: input.content, contentText: plainText(input.content) } : {}),
          updatedAt: now(),
        }).where(eq(wikiPages.id, page.id)).returning();
        if (!latest || now().getTime() - latest.at.getTime() >= versionIntervalMs) await snapshot(database, updated!, context.userId);
        return pageOut(database, updated!);
      }),
    },
    moveWikiPage: {
      name: "move_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), parentId: nullable(uuid()), sortOrder: Type.Optional(Type.Number()) }),
      output: summaryOutput,
      handler: async (context: Context, input: { pageId: string; parentId: string | null; sortOrder?: number }) => {
        const { page } = await load(db, context.userId, input.pageId, "write");
        await assertParent(db, context.userId, page.workspaceId, input.parentId, page.id);
        const [updated] = await db.update(wikiPages).set({
          parentId: input.parentId, ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}), updatedAt: now(),
        }).where(eq(wikiPages.id, page.id)).returning();
        return summary(updated!);
      },
    },
    setWikiPageAccess: {
      name: "set_wiki_page_access", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), access: accessSchema }),
      output: summaryOutput,
      handler: async (context: Context, input: { pageId: string; access: WikiAccess }) => {
        const { page } = await load(db, context.userId, input.pageId, "owner");
        const [updated] = await db.update(wikiPages).set({ access: input.access, updatedAt: now() }).where(eq(wikiPages.id, page.id)).returning();
        return summary(updated!);
      },
    },
    /** Soft delete. Only the owner or a workspace Admin; children are deleted with the page. */
    deleteWikiPage: {
      name: "delete_wiki_page", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Object({ deleted: Type.Integer() }),
      handler: async (context: Context, input: { pageId: string }) => {
        const { page, role } = await load(db, context.userId, input.pageId, "write");
        if (page.ownerId !== context.userId && role !== "Admin") throw new ActionError("Forbidden", 403);
        const result = await db.execute<{ id: string }>(sql`
          with recursive subtree as (
            select id from wiki_pages where id = ${page.id}
            union all select w.id from wiki_pages w join subtree s on w.parent_id = s.id where w.deleted_at is null
          )
          update wiki_pages set deleted_at = ${now().toISOString()}::timestamptz, locked_by = null, lock_expires_at = null
          where id in (select id from subtree) and deleted_at is null returning id`);
        return { deleted: [...result].length };
      },
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
        await takeLock(database, page, context.userId);
        const [version] = await database.select().from(wikiPageVersions).where(and(eq(wikiPageVersions.id, input.versionId), eq(wikiPageVersions.pageId, page.id)));
        if (!version) throw new ActionError("Version not found", 404);
        await snapshot(database, page, context.userId);
        const [updated] = await database.update(wikiPages).set({ title: version.title, content: version.content, contentText: version.contentText, updatedAt: now() })
          .where(eq(wikiPages.id, page.id)).returning();
        return pageOut(database, updated!);
      }),
    },
    /** Acquire or refresh the editor lock. `takeover` steals a live lock held by someone else (offered after it times out). */
    acquireWikiLock: {
      name: "acquire_wiki_lock", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), takeover: Type.Optional(Type.Boolean()) }),
      output: pageOutput,
      handler: async (context: Context, input: { pageId: string; takeover?: boolean }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await lockedForWrite(database, context.userId, input.pageId);
        return pageOut(database, await takeLock(database, page, context.userId, input.takeover ?? false));
      }),
    },
    releaseWikiLock: {
      name: "release_wiki_lock", kind: "write" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Object({ released: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string }) => {
        const { page } = await load(db, context.userId, input.pageId, "read");
        if (page.lockedBy !== context.userId) return { released: false };
        await db.update(wikiPages).set({ lockedBy: null, lockExpiresAt: null }).where(eq(wikiPages.id, page.id));
        return { released: true };
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
          sql`(${wikiPages.access} = 'public' or ${wikiPages.ownerId} = ${context.userId})`,
          sql`(${wikiPages.title} ilike ${pattern} or ${wikiPages.contentText} ilike ${pattern}
            or to_tsvector('english', ${wikiPages.title} || ' ' || ${wikiPages.contentText}) @@ plainto_tsquery('english', ${query}))`,
        )).orderBy(sql`(${wikiPages.title} ilike ${pattern}) desc`, asc(wikiPages.sortOrder), asc(wikiPages.createdAt), asc(wikiPages.id)).limit(input.limit ?? 25);
        return rows.map((row) => ({ id: row.id, title: row.title, snippet: snippetOf(row.contentText, query), access: row.access as WikiAccess }));
      },
    },
  };
}
