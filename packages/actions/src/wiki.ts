import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, projects, users, wikiPageProjects, wikiPageVersions, wikiPages } from "@weft/db";
import { ActionError, requireWorkspaceRole, type WorkspaceRole } from "./members";
import { accessibleProjects, requireProjectAccess } from "./projects";
import { escapeLike } from "./search";
import { activityActor, plainText, type ActivityContext } from "./work-items";

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
const activityOutput = Type.Object({
  id: Type.String(), field: Type.String(), oldValue: Type.Any(), newValue: Type.Any(), actorId: Type.String(), actorName: Type.String(),
  source: Type.String(), chatId: nullable(Type.String()), createdAt: Type.String(),
});
const linkOutput = Type.Object({ projectId: Type.String(), key: Type.String(), name: Type.String() });
const searchOutput = Type.Object({ id: Type.String(), title: Type.String(), snippet: Type.String(), access: accessSchema });

type Context = ActivityContext;
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

  /** Appends one Activity row for a wiki page, in the caller's transaction. Wiki pages are workspace-level, so there is no project. */
  async function logActivity(database: Database, context: Context, page: { id: string; workspaceId: string }, field: string, oldValue: unknown, newValue: unknown) {
    await database.insert(activities).values({
      workspaceId: page.workspaceId, projectId: null, entityType: "wiki_page", entityId: page.id, field,
      oldValue: oldValue ?? null, newValue: newValue ?? null, ...activityActor(context),
      createdAt: now(),
    });
  }

  return {
    createWikiPage: {
      name: "create_wiki_page", kind: "write" as const,
      input: Type.Object({
        workspaceId: uuid(), title: Type.String({ minLength: 1, maxLength: 300 }), parentId: Type.Optional(nullable(uuid())),
        access: Type.Optional(accessSchema), content: Type.Optional(Type.Any()),
      }),
      output: pageOutput,
      handler: async (context: Context, input: { workspaceId: string; title: string; parentId?: string | null; access?: WikiAccess; content?: unknown }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        await requireWorkspaceRole(database, context.userId, input.workspaceId, "write");
        await assertParent(database, context.userId, input.workspaceId, input.parentId ?? null);
        const [last] = await database.select({ order: wikiPages.sortOrder }).from(wikiPages)
          .where(and(eq(wikiPages.workspaceId, input.workspaceId), input.parentId ? eq(wikiPages.parentId, input.parentId) : isNull(wikiPages.parentId)))
          .orderBy(desc(wikiPages.sortOrder)).limit(1);
        const [page] = await database.insert(wikiPages).values({
          workspaceId: input.workspaceId, parentId: input.parentId ?? null, ownerId: context.userId, title: input.title,
          content: input.content ?? null, contentText: plainText(input.content), access: input.access ?? "public",
          sortOrder: (last?.order ?? 0) + 1, createdAt: now(), updatedAt: now(),
        }).returning();
        await snapshot(database, page!, context.userId);
        await logActivity(database, context, page!, "created", null, { title: page!.title, access: page!.access });
        return pageOut(database, page!);
      }),
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
        const versioned = !latest || now().getTime() - latest.at.getTime() >= versionIntervalMs;
        if (versioned) await snapshot(database, updated!, context.userId);
        if (titleChanged) await logActivity(database, context, page, "title", page.title, updated!.title);
        // Autosave fires every few seconds, so a human edit is logged once per saved version; AI edits are always logged.
        if (contentChanged && (versioned || (context.source !== undefined && context.source !== "ui"))) await logActivity(database, context, page, "content", null, { changed: true });
        return pageOut(database, updated!);
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
        await database.execute(sql`update wiki_pages set deleted_at = ${now().toISOString()}::timestamptz, locked_by = null, lock_expires_at = null
          where id in (${sql.join(subtree.map((row) => sql`${row.id}::uuid`), sql`, `)}) and deleted_at is null`);
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
        await takeLock(database, page, context.userId);
        const [version] = await database.select().from(wikiPageVersions).where(and(eq(wikiPageVersions.id, input.versionId), eq(wikiPageVersions.pageId, page.id)));
        if (!version) throw new ActionError("Version not found", 404);
        await snapshot(database, page, context.userId);
        const [updated] = await database.update(wikiPages).set({ title: version.title, content: version.content, contentText: version.contentText, updatedAt: now() })
          .where(eq(wikiPages.id, page.id)).returning();
        await logActivity(database, context, page, "restored", null, { versionId: version.id });
        return pageOut(database, updated!);
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
        // Link and unlink rows name a project: hide the ones whose project the caller cannot see.
        const visible = new Set((await accessibleProjects(db, context.userId, page.workspaceId)).map((project) => project.id));
        const rows = found.filter(({ activity: row }) => {
          if (row.field !== "linked" && row.field !== "unlinked") return true;
          const projectId = ((row.newValue ?? row.oldValue) as { projectId?: string } | null)?.projectId;
          return projectId !== undefined && visible.has(projectId);
        });
        return rows.map(({ activity: row, actorName }) => ({
          id: row.id, field: row.field, oldValue: row.oldValue ?? null, newValue: row.newValue ?? null, actorId: row.actorId, actorName,
          source: row.source, chatId: row.chatId, createdAt: row.createdAt.toISOString(),
        }));
      },
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
    /** Links a page to a project, so the page shows under that project's Pages. Needs write on both the page and the project. Linking twice is a no-op. */
    linkWikiPageToProject: {
      name: "link_wiki_page_to_project", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), projectId: uuid() }),
      output: linkOutput,
      handler: async (context: Context, input: { pageId: string; projectId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await load(database, context.userId, input.pageId, "write");
        const { project } = await requireProjectAccess(database, context.userId, input.projectId, "write");
        if (project.workspaceId !== page.workspaceId) throw new ActionError("Project not found", 404);
        const inserted = await database.insert(wikiPageProjects).values({ pageId: page.id, projectId: project.id, workspaceId: page.workspaceId, linkedBy: context.userId })
          .onConflictDoNothing().returning();
        if (inserted.length > 0) await logActivity(database, context, page, "linked", null, { projectId: project.id, key: project.key });
        return { projectId: project.id, key: project.key, name: project.name };
      }),
    },
    unlinkWikiPageFromProject: {
      name: "unlink_wiki_page_from_project", kind: "write" as const,
      input: Type.Object({ pageId: uuid(), projectId: uuid() }),
      output: Type.Object({ unlinked: Type.Boolean() }),
      handler: async (context: Context, input: { pageId: string; projectId: string }) => db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const { page } = await load(database, context.userId, input.pageId, "write");
        const { project } = await requireProjectAccess(database, context.userId, input.projectId, "write", { allowArchived: true });
        const removed = await database.delete(wikiPageProjects).where(and(eq(wikiPageProjects.pageId, page.id), eq(wikiPageProjects.projectId, project.id))).returning();
        if (removed.length > 0) await logActivity(database, context, page, "unlinked", { projectId: project.id, key: project.key }, null);
        return { unlinked: removed.length > 0 };
      }),
    },
    /** The projects a page is linked to, limited to the ones the caller can see. */
    listWikiPageProjects: {
      name: "list_wiki_page_projects", kind: "read" as const,
      input: Type.Object({ pageId: uuid() }),
      output: Type.Array(linkOutput),
      handler: async (context: Context, input: { pageId: string }) => {
        const { page } = await load(db, context.userId, input.pageId, "read");
        const rows = await db.select({ id: projects.id, key: projects.key, name: projects.name }).from(wikiPageProjects)
          .innerJoin(projects, eq(projects.id, wikiPageProjects.projectId)).where(eq(wikiPageProjects.pageId, page.id)).orderBy(asc(projects.key));
        const visible = [];
        for (const row of rows) {
          const allowed = await requireProjectAccess(db, context.userId, row.id, "read", { allowArchived: true }).then(() => true, () => false);
          if (allowed) visible.push({ projectId: row.id, key: row.key, name: row.name });
        }
        return visible;
      },
    },
    /** A project's Pages: the wiki pages linked to it that the caller may see. */
    listProjectWikiPages: {
      name: "list_project_wiki_pages", kind: "read" as const,
      input: Type.Object({ projectId: uuid() }),
      output: Type.Array(summaryOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read", { allowArchived: true });
        const rows = await db.select({ page: wikiPages }).from(wikiPageProjects).innerJoin(wikiPages, eq(wikiPages.id, wikiPageProjects.pageId)).where(and(
          eq(wikiPageProjects.projectId, project.id), isNull(wikiPages.deletedAt),
          sql`(${wikiPages.access} = 'public' or ${wikiPages.ownerId} = ${context.userId})`,
        )).orderBy(asc(wikiPages.sortOrder), asc(wikiPages.createdAt), asc(wikiPages.id));
        return rows.map((row) => summary(row.page));
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
