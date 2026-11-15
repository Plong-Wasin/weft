import { Type } from "@sinclair/typebox";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { markdownToDocWithWarnings } from "./markdown-doc";
import { needsWorker, prepareRichTextGuarded, runInWorker, WrittenFormTimeout, WRITTEN_FORM_INLINE_LIMIT } from "./written-form-pool";
import { comments, collectionMembers, collections, outlinks, projectMembers, projects, users, wikiPageShares, wikiPages, workItemPages, workItems, type Database } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { featuresOf } from "./features";
import { wikiContentFromYState } from "./wiki-yjs";
import { requireProjectAccess } from "./projects";
import { requireWikiPageAccess } from "./wiki";

/** Test seam: runs after a page was converted and before its Markdown is written. */
export const rebuildPageMarkdownHooks: { beforeWrite?: (pageId: string) => Promise<void> } = {};

export type OutlinkKind = "work-item" | "page" | "wiki";
export type OutlinkTarget = { kind: OutlinkKind; id: string };

/** Stable-id references found in a parsed document: link marks outside code. Code, code blocks and escaped brackets never count. */
export function referencesInDocument(document: unknown): OutlinkTarget[] {
  const unique = new Map<string, OutlinkTarget>();
  const stack: unknown[] = [document];
  while (stack.length) {
    const node = stack.pop() as { type?: string; marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>; content?: unknown[] } | null;
    if (!node || typeof node !== "object") continue;
    if (node.type === "codeBlock") continue;
    if (node.type === "text" && !node.marks?.some((mark) => mark.type === "code")) {
      for (const mark of node.marks ?? []) {
        const kind = mark.attrs?.kind, id = mark.attrs?.targetId;
        if (mark.type === "link" && (kind === "work-item" || kind === "page" || kind === "wiki") && typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) && mark.attrs?.href === `weft://${kind}/${id}`) unique.set(`${kind}:${id.toLowerCase()}`, { kind, id: id.toLowerCase() });
      }
    }
    if (Array.isArray(node.content)) for (let index = node.content.length - 1; index >= 0; index--) stack.push(node.content[index]);
  }
  return [...unique.values()];
}

const parseOptions = { preserveUnresolvedReferences: true, preserveStableReferences: true, trustedSource: true } as const;
/** Stable-id references only, read from the parsed Written form. Bare titles and keys are resolved when Written form is accepted. */
export function referencesInWrittenForm(markdown: string): OutlinkTarget[] {
  return referencesInDocument(markdownToDocWithWarnings(markdown, parseOptions).document);
}
/**
 * The same, with a large Written form parsed on a worker so it cannot hold the event loop. Only the repair paths parse: a write takes its links from the document it just prepared.
 * Returns null when the form could not be read in time, so the caller keeps the links it already has.
 */
async function referencesInWrittenFormGuarded(markdown: string): Promise<OutlinkTarget[] | null> {
  // A reference carries a stable id (`kind:uuid` or `weft://kind/uuid`); text without one has no links, so it is not parsed at all.
  if (!/(?:work-item|page|wiki)[:/]+[0-9a-f]{8}-[0-9a-f]{4}/i.test(markdown)) return [];
  if (markdown.length <= WRITTEN_FORM_INLINE_LIMIT && !needsWorker(markdown)) return referencesInWrittenForm(markdown);
  try { return referencesInDocument((await runInWorker<ReturnType<typeof markdownToDocWithWarnings>>("parse", [markdown, parseOptions], { size: markdown.length, text: markdown })).document); }
  catch (error) { if (error instanceof WrittenFormTimeout) { console.warn("Outlink extraction timed out; the previous links are kept"); return null; } throw error; }
}

/** Replace one source's derived references atomically with the links in its current Written form. */
function targetKey(kind: string, id: string) { return `${kind}:${id}`; }

/** Resolve a group of targets with at most one query per target kind; inaccessible ids are deliberately absent. */
async function visibleTargets(db: Database, userId: string, workspaceId: string, workspaceRole: string, targets: Array<{ kind: string; id: string }>) {
  const result = new Map<string, { id: string; kind: OutlinkKind; title: string; displayId: string | null; project: string | null; projectKey: string | null; collection: string | null }>();
  const idsByKind = new Map<OutlinkKind, string[]>();
  for (const target of targets) if (["work-item", "page", "wiki"].includes(target.kind)) idsByKind.set(target.kind as OutlinkKind, [...new Set([...(idsByKind.get(target.kind as OutlinkKind) ?? []), target.id])]);
  const itemIds = idsByKind.get("work-item") ?? [];
  if (itemIds.length) {
    const rows = await db.select({ item: workItems, project: projects, memberId: projectMembers.userId }).from(workItems)
      .innerJoin(projects, eq(projects.id, workItems.projectId))
      .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
      .where(and(inArray(workItems.id, itemIds), eq(projects.workspaceId, workspaceId), isNull(workItems.deletedAt)));
    for (const row of rows) {
      if (row.project.visibility !== "public" && workspaceRole !== "Admin" && !row.memberId) continue;
      result.set(targetKey("work-item", row.item.id), { id: row.item.id, kind: "work-item", title: row.item.title, displayId: `${row.project.key}-${row.item.sequence}`, project: row.project.name, projectKey: row.project.key, collection: null });
    }
  }
  for (const kind of ["page", "wiki"] as const) {
    const ids = idsByKind.get(kind) ?? [];
    if (!ids.length) continue;
    const rows = await db.select({ page: wikiPages, project: projects, collection: collections, pageShareId: wikiPageShares.userId, collectionMemberId: collectionMembers.userId, projectMemberId: projectMembers.userId })
      .from(wikiPages)
      .leftJoin(projects, eq(projects.id, wikiPages.projectId))
      .leftJoin(collections, eq(collections.id, wikiPages.collectionId))
      .leftJoin(wikiPageShares, and(eq(wikiPageShares.pageId, wikiPages.id), eq(wikiPageShares.userId, userId)))
      .leftJoin(collectionMembers, and(eq(collectionMembers.collectionId, wikiPages.collectionId), eq(collectionMembers.userId, userId)))
      .leftJoin(projectMembers, and(eq(projectMembers.projectId, wikiPages.projectId), eq(projectMembers.userId, userId)))
      .where(and(inArray(wikiPages.id, ids), eq(wikiPages.workspaceId, workspaceId), isNull(wikiPages.deletedAt)));
    for (const row of rows) {
      if ((row.page.projectId ? "page" : "wiki") !== kind) continue;
      const hasShare = !row.page.projectId && !!row.pageShareId;
      if (row.page.projectId) {
        if (!row.project || !row.projectMemberId || !featuresOf(row.project).pages || (row.page.access === "private" && row.page.ownerId !== userId)) continue;
      } else {
        if (row.page.access === "private" && row.page.ownerId !== userId && !hasShare) continue;
        if (row.page.collectionId && row.collection?.visibility === "private" && row.collection.ownerId !== userId && !row.collectionMemberId && !hasShare) continue;
      }
      result.set(targetKey(kind, row.page.id), { id: row.page.id, kind, title: row.page.title, displayId: null, project: row.project?.name ?? null, projectKey: row.project?.key ?? null, collection: row.collection?.name ?? null });
    }
  }
  return result;
}

/**
 * The links of a source are the union of its parts: "body" (a description or a page), "c:<comment id>" and "legacy" (work_item_pages). A write replaces only its own part,
 * from the document it prepared, so it never parses another row. `null` means the part could not be derived: its previous rows are kept.
 */
export async function setOutlinkPart(db: Database, sourceKind: OutlinkKind, sourceId: string, part: string, found: OutlinkTarget[] | null) {
  if (found === null) return 0;
  const unique = new Map(found.filter((target) => !(target.kind === sourceKind && target.id === sourceId)).map((target) => [`${target.kind}:${target.id}`, target]));
  await db.delete(outlinks).where(and(eq(outlinks.sourceKind, sourceKind), eq(outlinks.sourceId, sourceId), eq(outlinks.sourcePart, part)));
  if (unique.size) await db.insert(outlinks).values([...unique.values()].map((target) => ({ sourceKind, sourceId, sourcePart: part, targetKind: target.kind, targetId: target.id }))).onConflictDoNothing();
  return unique.size;
}
/** The links of one part from the prepared document of the write that changed it. */
export const setOutlinksFromDocument = (db: Database, sourceKind: OutlinkKind, sourceId: string, part: string, document: unknown) => setOutlinkPart(db, sourceKind, sourceId, part, referencesInDocument(document));
export const clearOutlinkPart = (db: Database, sourceKind: OutlinkKind, sourceId: string, part: string) => setOutlinkPart(db, sourceKind, sourceId, part, []);
/**
 * The stable references a row already holds in one part ("kind:uuid"): those of its current Markdown and its stored Outlinks. A writer who cannot open a target still keeps a link that is
 * already there (resolution decides display, never storage), but cannot add one.
 */
export async function existingStableReferences(db: Database, sourceKind: OutlinkKind, sourceId: string, part: string, currentMarkdown: string | null | undefined): Promise<string[]> {
  const found = new Set<string>();
  for (const match of (currentMarkdown ?? "").matchAll(/\|\s*(work-item|page|wiki):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/gi)) found.add(`${match[1]!.toLowerCase()}:${match[2]!.toLowerCase()}`);
  for (const row of await db.select({ kind: outlinks.targetKind, id: outlinks.targetId }).from(outlinks).where(and(eq(outlinks.sourceKind, sourceKind), eq(outlinks.sourceId, sourceId), eq(outlinks.sourcePart, part)))) found.add(`${row.kind}:${row.id.toLowerCase()}`);
  return [...found];
}
export const commentPart = (commentId: string) => `c:${commentId}`;

/** The legacy Page links of a Work item (work_item_pages), as their own part. */
export async function syncLegacyPageLinks(db: Database, workItemId: string) {
  const legacy = await db.select({ id: wikiPages.id, projectId: wikiPages.projectId }).from(workItemPages).innerJoin(wikiPages, eq(wikiPages.id, workItemPages.pageId)).where(eq(workItemPages.workItemId, workItemId));
  return setOutlinkPart(db, "work-item", workItemId, "legacy", legacy.map(({ id, projectId }) => ({ kind: projectId ? "page" as const : "wiki" as const, id })));
}

/** One stored part: its stored document when it has one, else its Written form parsed once on a worker. */
async function storedPartTargets(document: unknown, markdown: string | null): Promise<OutlinkTarget[] | null> {
  if (document && typeof document === "object") return referencesInDocument(document);
  return referencesInWrittenFormGuarded(markdown ?? "");
}

/** Repair: rebuild every part of a Work item's Outlinks from what is stored (backfill and the admin Action; never on a write). A part that cannot be read keeps its previous links. */
export async function rebuildWorkItemOutlinks(db: Database, workItemId: string, _userId?: string) {
  const [item] = await db.select({ markdown: workItems.descriptionMarkdown, doc: workItems.descriptionDoc, legacyDoc: workItems.description }).from(workItems).where(eq(workItems.id, workItemId));
  if (!item) return 0;
  let total = await setOutlinkPart(db, "work-item", workItemId, "body", await storedPartTargets(item.doc ?? item.legacyDoc, item.markdown));
  const rows = await db.select({ id: comments.id, doc: comments.body, markdown: comments.bodyMarkdown }).from(comments).where(and(eq(comments.workItemId, workItemId), isNull(comments.deletedAt)));
  const live = new Set(rows.map((row) => commentPart(row.id)));
  for (const row of rows) total += await setOutlinkPart(db, "work-item", workItemId, commentPart(row.id), await storedPartTargets(row.doc, row.markdown));
  const old = await db.select({ part: outlinks.sourcePart }).from(outlinks).where(and(eq(outlinks.sourceKind, "work-item"), eq(outlinks.sourceId, workItemId)));
  for (const part of new Set(old.map((row) => row.part))) if (part.startsWith("c:") && !live.has(part)) await clearOutlinkPart(db, "work-item", workItemId, part);
  return total + await syncLegacyPageLinks(db, workItemId);
}

/** A Page's own links, from its `content` document (the live source): one row read, nothing parsed. */
export async function syncPageBodyLinks(db: Database, pageId: string) {
  const [page] = await db.select({ content: wikiPages.content, ydocState: wikiPages.ydocState, projectId: wikiPages.projectId }).from(wikiPages).where(eq(wikiPages.id, pageId));
  return page ? setOutlinksFromDocument(db, page.projectId ? "page" : "wiki", pageId, "body", pageDocument(page)) : 0;
}
/** The live document of a Page: its Yjs state when it has a valid one (as a read does), else `content`. */
function pageDocument(page: { content: unknown; ydocState: Uint8Array | null }) {
  if (page.ydocState) { try { return wikiContentFromYState(page.ydocState); } catch { /* an invalid state: fall back to content */ } }
  return page.content;
}

/** Repair: a Page's Outlinks from its `content` document (the live source) and its comments. */
export async function rebuildPageOutlinks(db: Database, pageId: string, _userId?: string) {
  const [page] = await db.select({ content: wikiPages.content, ydocState: wikiPages.ydocState, projectId: wikiPages.projectId }).from(wikiPages).where(eq(wikiPages.id, pageId));
  if (!page) return 0;
  const kind = page.projectId ? "page" as const : "wiki" as const;
  let total = await setOutlinksFromDocument(db, kind, pageId, "body", pageDocument(page));
  const rows = await db.select({ id: comments.id, doc: comments.body, markdown: comments.bodyMarkdown }).from(comments).where(and(eq(comments.wikiPageId, pageId), isNull(comments.deletedAt)));
  const live = new Set(rows.map((row) => commentPart(row.id)));
  for (const row of rows) total += await setOutlinkPart(db, kind, pageId, commentPart(row.id), await storedPartTargets(row.doc, row.markdown));
  const old = await db.select({ part: outlinks.sourcePart }).from(outlinks).where(and(eq(outlinks.sourceKind, kind), eq(outlinks.sourceId, pageId)));
  for (const part of new Set(old.map((row) => row.part))) if (part.startsWith("c:") && !live.has(part)) await clearOutlinkPart(db, kind, pageId, part);
  return total;
}

/** Admin-only repair Action that recreates every Outlink in one Workspace from its current Written forms. */
export function createOutlinkActions(db: Database) {
  const kindSchema = Type.Union([Type.Literal("work-item"), Type.Literal("page"), Type.Literal("wiki")]);
  const itemOutput = Type.Object({ id: Type.String(), kind: kindSchema, title: Type.String(), displayId: Type.Union([Type.String(), Type.Null()]), project: Type.Union([Type.String(), Type.Null()]), projectKey: Type.Union([Type.String(), Type.Null()]), collection: Type.Union([Type.String(), Type.Null()]) });
  type Context = { userId: string };
  async function entity(context: Context, kind: OutlinkKind, id: string) {
    if (kind === "work-item") {
      const [row] = await db.select({ item: workItems, project: projects }).from(workItems).innerJoin(projects, eq(projects.id, workItems.projectId)).where(eq(workItems.id, id));
      if (!row || row.item.deletedAt) throw new ActionError("Work item not found", 404);
      await requireProjectAccess(db, context.userId, row.project.id, "read");
      return { id, kind, title: row.item.title, displayId: `${row.project.key}-${row.item.sequence}`, project: row.project.name, projectKey: row.project.key, collection: null, workspaceId: row.project.workspaceId };
    }
    const page = await requireWikiPageAccess(db, context.userId, id, "read");
    const actualKind = page.projectId ? "page" : "wiki";
    if (actualKind !== kind) throw new ActionError("Page not found", 404);
    const [project] = page.projectId ? await db.select({ name: projects.name, key: projects.key }).from(projects).where(eq(projects.id, page.projectId)) : [];
    const [collection] = page.collectionId ? await db.select({ name: collections.name }).from(collections).where(eq(collections.id, page.collectionId)) : [];
    return { id, kind, title: page.title, displayId: null, project: project?.name ?? null, projectKey: project?.key ?? null, collection: collection?.name ?? null, workspaceId: page.workspaceId };
  }
  async function list(context: Context, input: { kind: OutlinkKind; id: string }, direction: "out" | "in") {
    const source = await entity(context, input.kind, input.id);
    const rows = direction === "out"
      // A target linked from several parts (the description and comments) is one link: distinct (kind, id), whatever the part.
      ? await db.selectDistinct({ kind: outlinks.targetKind, id: outlinks.targetId }).from(outlinks).where(and(eq(outlinks.sourceKind, input.kind), eq(outlinks.sourceId, input.id)))
      : await db.selectDistinct({ kind: outlinks.sourceKind, id: outlinks.sourceId }).from(outlinks).where(and(eq(outlinks.targetKind, input.kind), eq(outlinks.targetId, input.id)));
    const workspaceRole = await requireWorkspaceRole(db, context.userId, source.workspaceId, "read");
    const visible = await visibleTargets(db, context.userId, source.workspaceId, workspaceRole, rows);
    return rows.flatMap(({ kind, id }) => {
      const target = visible.get(targetKey(kind, id));
      return target ? [{ id: target.id, kind: target.kind, title: target.title, displayId: target.displayId, project: target.project, projectKey: target.projectKey, collection: target.collection }] : [];
    });
  }
  const referenceInput = Type.Object({ kind: kindSchema, id: Type.String({ format: "uuid" }) });
  return {
    listOutlinks: {
      name: "list_outlinks", kind: "read" as const, input: referenceInput, output: Type.Array(itemOutput),
      handler: (context: Context, input: { kind: OutlinkKind; id: string }) => list(context, input, "out"),
    },
    listBacklinks: {
      name: "list_backlinks", kind: "read" as const, input: referenceInput, output: Type.Array(itemOutput),
      handler: (context: Context, input: { kind: OutlinkKind; id: string }) => list(context, input, "in"),
    },
    rebuildPageMarkdown: {
      name: "rebuild_page_markdown", kind: "write" as const,
      // A live save that hit a conversion limit keeps the document and flags the Markdown stale. This recomputes it (and the Outlinks) for one Page or for stale Pages of a Workspace, at most `limit` pages
      // per call (default 25), and says how many are left: call again until `remaining` is 0. A page that was saved again while it converted is left stale, because the newer save wins.
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }), pageId: Type.Optional(Type.String({ format: "uuid" })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), after: Type.Optional(Type.String({ format: "uuid", description: "The `next` of the previous call: continue after this page id." })) }),
      output: Type.Object({
        next: Type.Union([Type.String(), Type.Null()]), pagesRebuilt: Type.Integer(), pagesStillStale: Type.Array(Type.Object({ pageId: Type.String(), code: Type.String() })), linksRebuilt: Type.Integer(),
        pagesChangedMeanwhile: Type.Integer(), remaining: Type.Integer(),
      }),
      handler: async (context: { userId: string }, input: { workspaceId: string; pageId?: string; limit?: number; after?: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
        const stale = and(eq(wikiPages.workspaceId, input.workspaceId), eq(wikiPages.markdownStale, true), isNull(wikiPages.deletedAt), ...(input.pageId ? [eq(wikiPages.id, input.pageId)] : []));
        // Pages are taken in id order from the cursor: a page that cannot be converted is listed and passed, so it cannot block the pages behind it.
        const batch = await db.select({ id: wikiPages.id, content: wikiPages.content }).from(wikiPages).where(and(stale, ...(input.after ? [gt(wikiPages.id, input.after)] : []))).orderBy(asc(wikiPages.id)).limit(limit);
        let pagesRebuilt = 0, linksRebuilt = 0, pagesChangedMeanwhile = 0;
        const stillStale: Array<{ pageId: string; code: string }> = [];
        for (const page of batch) {
          try {
            // Converted one page at a time, outside any transaction, on the long lane under the admin's own key: it cannot hold the workers that serve other people's requests.
            const prepared = await prepareRichTextGuarded(page.content, undefined, "content", "contentMarkdown", {}, "derived", {}, { lane: "request", group: "long", key: `user:${context.userId}`, deadlineMs: 120_000 });
            await rebuildPageMarkdownHooks.beforeWrite?.(page.id);
            // The write only lands if the page still holds the content that was converted: a live save that arrived meanwhile wins, and the page stays stale.
            const written = await db.update(wikiPages).set({ contentMarkdown: prepared.markdown, markdownStale: false })
              .where(and(eq(wikiPages.id, page.id), eq(wikiPages.markdownStale, true), sql`${wikiPages.content} = ${JSON.stringify(page.content)}::jsonb`)).returning({ id: wikiPages.id });
            if (!written.length) { pagesChangedMeanwhile++; continue; }
            linksRebuilt += await rebuildPageOutlinks(db, page.id);
            pagesRebuilt++;
          } catch (error) {
            if (!(error instanceof ActionError)) throw error;
            stillStale.push({ pageId: page.id, code: error.code ?? "error" });
          }
        }
        const next = batch.length ? batch[batch.length - 1]!.id : null;
        // `remaining` counts the stale pages behind the cursor; pages that failed or changed are behind it already, so a failing page is never counted twice.
        const [left] = await db.select({ value: sql<number>`count(*)::int` }).from(wikiPages).where(and(stale, ...(next ? [gt(wikiPages.id, next)] : input.after ? [gt(wikiPages.id, input.after)] : [])));
        return { next: (left?.value ?? 0) > 0 ? next : null, pagesRebuilt, pagesStillStale: stillStale, linksRebuilt, pagesChangedMeanwhile, remaining: left?.value ?? 0 };
      },
    },
    rebuildOutlinks: {
      name: "rebuild_outlinks", kind: "write" as const,
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }) }),
      output: Type.Object({ sourcesRebuilt: Type.Integer(), linksRebuilt: Type.Integer() }),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        return db.transaction(async (transaction) => {
          const database = transaction as unknown as Database;
          const items = await database.select({ id: workItems.id }).from(workItems).innerJoin(projects, eq(projects.id, workItems.projectId)).where(eq(projects.workspaceId, input.workspaceId));
          const pages = await database.select({ id: wikiPages.id }).from(wikiPages).where(eq(wikiPages.workspaceId, input.workspaceId));
          const sourceIds = [...items.map((row) => row.id), ...pages.map((row) => row.id)];
          if (sourceIds.length) await database.delete(outlinks).where(inArray(outlinks.sourceId, sourceIds));
          let linksRebuilt = 0;
          for (const { id } of items) linksRebuilt += await rebuildWorkItemOutlinks(database, id);
          for (const { id } of pages) linksRebuilt += await rebuildPageOutlinks(database, id);
          return { sourcesRebuilt: sourceIds.length, linksRebuilt };
        });
      },
    },
  };
}

/** Read-time rendering: inaccessible stable links remain intact but are marked inert for this viewer. */
export async function makeUnavailableReferencesPlainText(db: Database, userId: string, document: unknown) {
  const copy = structuredClone(document) as { type?: string; text?: string; marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>; content?: unknown[] };
  const canOpen = async (kind: string, id: string) => {
    try {
      if (kind === "work-item") {
        const [item] = await db.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, id));
        if (!item) return false;
        await requireProjectAccess(db, userId, item.projectId, "read");
      } else if (kind === "page" || kind === "wiki") {
        await requireWikiPageAccess(db, userId, id, "read");
      } else return true;
      return true;
    } catch (error) { if (error instanceof ActionError && (error.status === 403 || error.status === 404)) return false; throw error; }
  };
  const visit = async (node: typeof copy) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== "link" || typeof mark.attrs?.targetId !== "string" || typeof mark.attrs?.kind !== "string") continue;
      if (await canOpen(mark.attrs.kind, mark.attrs.targetId)) continue;
      mark.attrs = { ...mark.attrs, unavailable: true };
    }
    for (const child of (node.content ?? []) as typeof copy[]) await visit(child);
  };
  if (copy && typeof copy === "object") await visit(copy);
  return copy;
}
