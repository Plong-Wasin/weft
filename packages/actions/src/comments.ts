import { Type } from "@sinclair/typebox";
import { plainTextWrittenForm } from "./rich-markdown";
import { writtenFormOf } from "./written-form-pool";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, agentAccess, agents, collections, collectionMembers, commentMentions, commentVersions, comments, intakeItems, outlinks, projectKeyAliases, projectMembers, projects, runtimes, users, wikiPageShares, wikiPages, workItems, workItemAssignees, workspaceMembers } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { assertNotArchived, liveWorkItems } from "./triage";
import { enqueueNotification } from "./notifications";
import { accessibleProjects, requireProjectAccess } from "./projects";
import { requireWikiPageAccess } from "./wiki";
import { agentUserIds, withoutDisabledAgents } from "./agent-access";
import { queueRunsForAssignees, wakeOutcomeOutput, wakerOf } from "./runs";
import { fireEventTriggers } from "./triggers";
import { emitOutboundEvent, workItemSnapshot } from "./outbound-webhooks";
import { activityActor, plainText, workItemMarkdownOptions, type ActivityContext } from "./work-items";
import { resolveMarkdownMentions, richTextMarkdown } from "./rich-markdown";
import { prepareRichTextGuarded, inlineStoredDocument, PAGE_MARKDOWN_BUDGET, readWrittenFormOf, storedDocumentsWithWarnings } from "./written-form-pool";
import { markdownToDoc, storedMarkdownToDoc, markdownToDocWithWarnings, resolverFromReferences } from "./markdown-doc";
import { WRITTEN_FORM_MAX_INPUT_LENGTH, type MarkdownOptions, type ResolvedReference } from "./markdown-doc";
import { clearOutlinkPart, commentPart, existingStableReferences, makeUnavailableReferencesPlainText, setOutlinksFromDocument } from "./outlinks";
import { assertFeatureEnabled, featuresOf } from "./features";
import { validateRichTextAssets } from "./rich-text-validation";

type Context = ActivityContext;
type CommentRow = typeof comments.$inferSelect;
type CommentNode = { type?: string; attrs?: Record<string, unknown>; marks?: Array<{ attrs?: Record<string, unknown> }>; content?: CommentNode[] };

/** Resolve only the labels/keys mentioned in this comment, with a bounded query count. */
export async function commentMarkdownOptions(database: Database, userId: string, workspaceId: string, currentProjectId?: string, markdown = "") {
  const tokens = [...markdown.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(?<![A-Z0-9_])([A-Z][A-Z0-9]{1,11}-\d+)(?![A-Z0-9_-])/g)];
  if (!tokens.length) return { references: [] as ResolvedReference[], options: {} as MarkdownOptions };
  const stableLabels = tokens.flatMap((match) => /^(?:work-item|page|wiki):[^\s|]+$/i.test(match[2]?.trim() ?? "") && match[1] ? [`[[${match[1]}]]`] : []);
  const workOptions = await workItemMarkdownOptions(database, userId, workspaceId, currentProjectId, [markdown, ...stableLabels].join("\n"));
  const references: ResolvedReference[] = [];
  const labels = new Set<string>();
  const stableItems = new Set<string>();
  const stablePages = new Set<string>();
  for (const match of tokens) {
    const label = (match[1] ?? match[3] ?? "").trim();
    const identity = match[2]?.trim() ?? "";
    const stable = /^(work-item|page|wiki):([^\s|]+)$/i.exec(identity);
    if (stable) {
      if (stable[1]!.toLowerCase() === "work-item") stableItems.add(stable[2]!); else stablePages.add(stable[2]!);
      if (label) labels.add(label);
    } else if (label) labels.add(label);
    if (label && !stable && workOptions.resolveReference) {
      const resolved = workOptions.resolveReference(label, /^[A-Z][A-Z0-9]{1,11}-\d+$/.test(label) ? "work-item" : undefined);
      if (resolved && "candidates" in resolved) references.push(...resolved.candidates);
      else if (resolved) references.push(resolved);
    }
  }

  if (stableItems.size) {
    const requestedLabels = new Map(tokens.flatMap((match) => {
      const identity = /^(?:work-item):([^\s|]+)$/i.exec(match[2]?.trim() ?? "");
      return identity ? [[identity[1]!, (match[1] ?? "").trim()] as const] : [];
    }));
    const workspaceRole = await requireWorkspaceRole(database, userId, workspaceId, "read");
    const rows = await database.select({ id: workItems.id, projectId: workItems.projectId, sequence: workItems.sequence, key: projects.key, visibility: projects.visibility, memberId: projectMembers.userId }).from(workItems).innerJoin(projects, eq(projects.id, workItems.projectId))
      .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
      .where(and(inArray(workItems.id, [...stableItems]), eq(projects.workspaceId, workspaceId), isNull(workItems.deletedAt)));
    for (const row of rows) {
      if (workspaceRole === "Admin" || row.visibility === "public" || row.memberId) references.push({ kind: "work-item", id: row.id, label: requestedLabels.get(row.id) || `${row.key}-${row.sequence}` });
    }
    if (currentProjectId && [...stableItems].some((id) => !references.some((reference) => reference.kind === "work-item" && reference.id === id))) {
      const suggestions = await database.select({ id: workItems.id, sequence: workItems.sequence, key: projects.key }).from(workItems).innerJoin(projects, eq(projects.id, workItems.projectId))
        .where(and(eq(workItems.projectId, currentProjectId), isNull(workItems.deletedAt))).limit(10);
      for (const row of suggestions) references.push({ kind: "work-item", id: row.id, label: `${row.key}-${row.sequence}` });
    }
  }

  const titleLabels = [...labels].filter((label) => !/^[A-Za-z][A-Za-z0-9]{1,11}-\d+$/.test(label));
  const pageConditions = [
    ...(titleLabels.length ? [inArray(sql`lower(${wikiPages.title})`, titleLabels.map((label) => label.toLocaleLowerCase()))] : []),
    ...(stablePages.size ? [inArray(wikiPages.id, [...stablePages])] : []),
  ];
  if (pageConditions.length) {
    const workspaceRole = await requireWorkspaceRole(database, userId, workspaceId, "read");
    const rows = await database.select({ page: wikiPages, project: projects, memberId: projectMembers.userId, collection: collections, collectionMemberId: collectionMembers.userId, shareRole: wikiPageShares.role })
      .from(wikiPages).leftJoin(projects, eq(projects.id, wikiPages.projectId))
      .leftJoin(projectMembers, and(eq(projectMembers.projectId, wikiPages.projectId), eq(projectMembers.userId, userId)))
      .leftJoin(collections, eq(collections.id, wikiPages.collectionId))
      .leftJoin(collectionMembers, and(eq(collectionMembers.collectionId, wikiPages.collectionId), eq(collectionMembers.userId, userId)))
      .leftJoin(wikiPageShares, and(eq(wikiPageShares.pageId, wikiPages.id), eq(wikiPageShares.userId, userId)))
      .where(and(eq(wikiPages.workspaceId, workspaceId), isNull(wikiPages.deletedAt), or(...pageConditions)));
    for (const { page, project, memberId, collection, collectionMemberId, shareRole } of rows) {
      const shared = ["view", "comment", "edit"].includes(String(shareRole));
      if (page.access === "private" && page.ownerId !== userId && !shared) continue;
      if (page.projectId) {
        if (!project || !featuresOf(project).pages || workspaceRole !== "Admin" && project.visibility !== "public" && !memberId) continue;
      } else {
        if (collection?.visibility === "private" && collection.ownerId !== userId && !collectionMemberId && !shared) continue;
        if (page.ownerId !== userId && !shared && page.access !== "public") continue;
      }
      if (titleLabels.some((label) => label.toLocaleLowerCase() === page.title.toLocaleLowerCase()) || stablePages.has(page.id)) references.push({ kind: page.projectId ? "page" : "wiki", id: page.id, label: page.title });
    }
  }
  const uniqueReferences = [...new Map(references.map((reference) => [`${reference.kind}:${reference.id}`, reference])).values()];
  const options: MarkdownOptions = { ...workOptions, resolveReference: resolverFromReferences(uniqueReferences), references: uniqueReferences };
  return { references: uniqueReferences, options };
}

const uuid = () => Type.String({ format: "uuid" });
const commentOutput = Type.Object({
  id: Type.String(), workItemId: Type.String(), authorId: Type.String(), authorName: Type.String(), body: Type.Any(), bodyText: Type.String(), markdown: Type.String(), markdownWarnings: Type.Array(Type.String()), markdownWarningDetails: Type.Array(Type.Object({ code: Type.String(), message: Type.String() })),
  mentionedUserIds: Type.Array(Type.String()), parentId: Type.Union([Type.String(), Type.Null()]), replyCount: Type.Integer(),
  /** Written by an Agent on a Run: the marker, and the Run it links to. */
  authorIsAgent: Type.Boolean(), authorCodeCapable: Type.Boolean(), runId: Type.Union([Type.String(), Type.Null()]),
  participants: Type.Array(Type.Object({ userId: Type.String(), name: Type.String() })), createdAt: Type.String(), editedAt: Type.Union([Type.String(), Type.Null()]),
});
const versionOutput = Type.Object({ id: Type.String(), commentId: Type.String(), body: Type.Any(), bodyMarkdown: Type.String(), bodyText: Type.String(), writtenAt: Type.String(), replacedAt: Type.String() });
const mentionableOutput = Type.Object({ userId: Type.String(), name: Type.String(), email: Type.String(), isAgent: Type.Boolean(), codeCapable: Type.Boolean(), hasAccess: Type.Boolean(), accessReason: Type.Union([Type.String(), Type.Null()]), accessAsk: Type.Union([Type.Literal("owner"), Type.Literal("admin"), Type.Null()]), accessOwnerName: Type.Union([Type.String(), Type.Null()]) });
const bodyInput = Type.Any();

function collectMentions(node: unknown, found: Set<string> = new Set()) {
  if (!node || typeof node !== "object") return found;
  const { type, attrs, content } = node as { type?: string; attrs?: { id?: unknown }; content?: unknown[] };
  if (type === "mention" && typeof attrs?.id === "string" && attrs.id) found.add(attrs.id);
  if (Array.isArray(content)) for (const child of content) collectMentions(child, found);
  return found;
}

function hasImage(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const { type, content } = node as { type?: string; content?: unknown[] };
  return type === "assetImage" || (Array.isArray(content) && content.some(hasImage));
}

function parseBody(body: unknown) {
  if (!body || typeof body !== "object" || (body as { type?: unknown }).type !== "doc") throw new ActionError("Comment body must be a Tiptap document", 400);
  const text = plainText(body);
  const mentions = collectMentions(body);
  if (text.trim() === "" && mentions.size === 0 && !hasImage(body)) throw new ActionError("Comment is empty", 400);
  return { text, mentions };
}

export function createCommentActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  async function loadItem(workItemId: string) {
    const [normalItem] = await db.select().from(workItems).where(and(eq(workItems.id, workItemId), liveWorkItems));
    if (normalItem) return normalItem;
    // Only Intake conversations may bypass the normal Triage exclusion.
    const [item] = await db.select().from(workItems).where(and(eq(workItems.id, workItemId), isNull(workItems.deletedAt)));
    if (!item) throw new ActionError("Work item not found", 404);
    const [intake] = await db.select({ id: intakeItems.id }).from(intakeItems).where(eq(intakeItems.workItemId, item.id));
    if (!intake) throw new ActionError("Work item not found", 404);
    return item;
  }

  async function accessForComment(context: Context, item: typeof workItems.$inferSelect, requirement: "read" | "write") {
    const [intake] = await db.select().from(intakeItems).where(eq(intakeItems.workItemId, item.id));
    const access = await requireProjectAccess(db, context.userId, item.projectId, "read");
    if (intake && intake.outcome !== "accepted") {
      assertFeatureEnabled(access.project, "intake");
      if (requirement === "write" && access.project.archivedAt) throw new ActionError("Project is archived", 400);
      const guest = access.workspaceRole !== "Admin" && (access.workspaceRole === "Guest" || access.projectRole === "Guest");
      if (guest && intake.createdBy !== context.userId) throw new ActionError("Forbidden", 403);
    } else if (requirement === "write") await requireProjectAccess(db, context.userId, item.projectId, "write");
    return { project: access.project, intake: intake && intake.outcome !== "accepted" ? intake : null };
  }

  async function loadComment(commentId: string) {
    const [comment] = await db.select().from(comments).where(and(eq(comments.id, commentId), isNull(comments.deletedAt)));
    // Wiki page comments are managed through the Wiki actions, which check page access.
    if (!comment || comment.wikiPageId) throw new ActionError("Comment not found", 404);
    // Replies are hidden together with a deleted parent, so they cannot be reached either.
    if (comment.parentId) await loadComment(comment.parentId);
    return comment;
  }

  /** Members who can see the project: everyone in the workspace for a public project, else project members and workspace admins. */
  async function mentionable(project: { id: string; workspaceId: string; visibility: string }) {
    const rows = await db.select({ userId: users.id, name: users.name, email: users.email, role: workspaceMembers.role, isAgent: users.isAgent })
      .from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, project.workspaceId)).orderBy(asc(users.name), asc(users.id));
    // A disabled Agent cannot be mentioned.
    const people = await withoutDisabledAgents(db, rows);
    if (project.visibility !== "private") return people;
    const members = new Set((await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id))).map((row) => row.userId));
    return people.filter((row) => row.role === "Admin" || members.has(row.userId));
  }

  async function commentBody(context: Context, item: { id: string; projectId: string; workspaceId: string }, body: unknown, markdown: string | undefined, existingRefs: string[] = []) {
    const referenceText = markdown ?? await writtenFormOf(body);
    const { references, options } = await commentMarkdownOptions(db, context.userId, item.workspaceId, item.projectId, referenceText);
    let prepared;
    try {
      prepared = await prepareRichTextGuarded(body, markdown, "body", "bodyMarkdown", { ...options, existingStableReferences: existingRefs, preserveUnresolvedReferences: context.source === "agent" || options.preserveUnresolvedReferences }, "verbatim", { allowPreservedImportWarnings: context.source === "agent" });
    } catch (error) {
      if (context.source !== "agent" || typeof markdown !== "string") throw error;
      console.warn("Written form conversion failed for a system-posted Agent answer; preserving it as escaped code text", error);
      prepared = await prepareRichTextGuarded({ type: "doc", content: [{ type: "codeBlock", attrs: { language: "text" }, content: [{ type: "text", text: markdown }] }] }, undefined, "body", "bodyMarkdown", {}, "derived");
    }
    const document = prepared.document;
    if (!document || typeof document !== "object") throw new ActionError("Comment body is required", 400);
    const visibleIds = new Set(references.map((reference) => `${reference.kind}:${reference.id}`));
    const containsStableLink = (() => {
      const has = (node: CommentNode): boolean => (node.marks ?? []).some((mark) => typeof mark.attrs?.targetId === "string") || (node.content ?? []).some(has);
      return has(document as CommentNode);
    })();
    const previouslyLinkedIds = containsStableLink
      ? new Set((await db.select({ kind: outlinks.targetKind, id: outlinks.targetId }).from(outlinks).where(and(eq(outlinks.sourceKind, "work-item"), eq(outlinks.sourceId, item.id)))).map(({ kind, id }) => `${kind}:${id}`))
      : new Set<string>();
    await validateRichTextAssets(db, document, "work_item", item.id, context.userId);
    const visit = (node: CommentNode) => {
      for (const mark of node.marks ?? []) {
        const kind = String(mark.attrs?.kind ?? "");
        const id = String(mark.attrs?.targetId ?? "");
        if (kind && id && !visibleIds.has(`${kind}:${id}`) && !previouslyLinkedIds.has(`${kind}:${id}`) && !(kind === "page" && visibleIds.has(`wiki:${id}`))) {
          const candidates = references.filter((reference) => reference.kind === kind || (kind === "page" && reference.kind === "wiki")).map((reference) => `${reference.label} (${reference.id})`).slice(0, 10);
          throw new ActionError(`Markdown ${kind} link "${String(mark.attrs?.target ?? id)}" is unavailable. Candidates: ${candidates.join(", ") || "none"}.`, 400);
        }
      }
      for (const child of node.content ?? []) visit(child);
    };
    visit(document as CommentNode);
    return prepared;
  }

  async function authorNames(ids: string[]) {
    if (ids.length === 0) return new Map<string, string>();
    return new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((row) => [row.id, row.name]));
  }

  async function mentionsOf(database: Database, commentIds: string[]) {
    const result = new Map<string, string[]>(commentIds.map((id) => [id, []]));
    if (commentIds.length === 0) return result;
    for (const row of await database.select().from(commentMentions).where(inArray(commentMentions.commentId, commentIds)).orderBy(asc(commentMentions.userId))) result.get(row.commentId)!.push(row.userId);
    return result;
  }

  function out(row: CommentRow, authorName: string, authorIsAgent: boolean, authorCodeCapable: boolean, mentionedUserIds: string[], replies: Array<{ userId: string; name: string }> = [], replyCount = 0, markdownWarnings: string[] = [], markdownWarningDetails: Array<{ code: string; message: string }> = []) {
    // A row the backfill has not converted yet has no stored Markdown: it gets the escaped plain-text form, a linear serialise with no parse-back (measured 12 ms for 197 KB), never the verified form that parses.
    const markdown = row.bodyMarkdown ?? plainTextWrittenForm(row.body);
    const body = row.body && typeof row.body === "object" ? row.body : inlineStoredDocument(markdown, { preserveUnresolvedReferences: true });
    return {
      id: row.id, workItemId: row.workItemId, authorId: row.authorId, authorName, body, bodyText: row.bodyText, markdown, markdownWarnings, markdownWarningDetails, mentionedUserIds,
      parentId: row.parentId, replyCount, participants: replies, authorIsAgent, authorCodeCapable, runId: row.runId,
      createdAt: row.createdAt.toISOString(), editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    };
  }

  async function validatedMentions(project: { id: string; workspaceId: string; visibility: string }, authorId: string, mentions: Set<string>) {
    const allowed = new Set((await mentionable(project)).map((row) => row.userId));
    for (const id of mentions) if (!allowed.has(id)) throw new ActionError("Mentioned user cannot see this project", 400);
    return [...mentions].filter((id) => id !== authorId).sort();
  }

  async function logActivity(database: Database, context: Context, row: { workspaceId: string; projectId: string; workItemId: string }, field: string, newValue: unknown) {
    await database.insert(activities).values({
      workspaceId: row.workspaceId, projectId: row.projectId, entityType: "work_item", entityId: row.workItemId, field,
      newValue, ...activityActor(context),
    });
  }

  async function replaceMentions(database: Database, commentId: string, userIds: string[]) {
    await database.delete(commentMentions).where(eq(commentMentions.commentId, commentId));
    if (userIds.length > 0) await database.insert(commentMentions).values(userIds.map((userId) => ({ commentId, userId })));
  }

  return {
    listMentionableMembers: {
      name: "list_mentionable_members", kind: "read" as const,
      input: Type.Object({ projectId: uuid() }), output: Type.Array(mentionableOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        const people = await mentionable(project);
        const agentIds = people.filter((person) => person.isAgent).map((person) => person.userId);
        const codeAgents = new Set(agentIds.length ? (await db.select({ userId: agents.userId }).from(agents).where(and(inArray(agents.userId, agentIds), sql`${agents.runtimeId} is not null`))).map((row) => row.userId) : []);
        const agentRows = agentIds.length ? await db.select({ id: agents.id, userId: agents.userId, runtimeId: agents.runtimeId }).from(agents).where(inArray(agents.userId, agentIds)) : [];
        const ids = agentRows.map((row) => row.id);
        const grants = ids.length ? await db.select({ agentId: agentAccess.agentId, userId: agentAccess.userId }).from(agentAccess).where(inArray(agentAccess.agentId, ids)) : [];
        const owners = agentRows.some((row) => row.runtimeId) ? await db.select({ userId: agents.userId, ownerId: runtimes.ownerId }).from(agents).innerJoin(runtimes, eq(runtimes.id, agents.runtimeId)).where(inArray(agents.userId, agentIds)) : [];
        const ownerIds = owners.map((row) => row.ownerId);
        const ownerNames = ownerIds.length ? new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds))).map((row) => [row.id, row.name])) : new Map<string, string>();
        return people.map(({ userId, name, email, isAgent }) => {
          const agent = agentRows.find((row) => row.userId === userId);
          const hasAccess = !isAgent || grants.some((grant) => grant.agentId === agent?.id && grant.userId === context.userId);
          const owner = owners.find((row) => row.userId === userId)?.ownerId;
          return { userId, name, email, isAgent, codeCapable: codeAgents.has(userId), hasAccess, accessReason: isAgent && !hasAccess ? `needs permission from ${owner ? ownerNames.get(owner) ?? "the Runtime owner" : "a workspace Admin"}` : null, accessAsk: isAgent && !hasAccess ? (owner ? "owner" as const : "admin" as const) : null, accessOwnerName: isAgent && !hasAccess && owner ? ownerNames.get(owner) ?? null : null };
        });
      },
    },
    listComments: {
      name: "list_comments", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(commentOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const item = await loadItem(input.workItemId);
        await accessForComment(context, item, "read");
        const all = await db.select().from(comments).where(and(eq(comments.workItemId, item.id), isNull(comments.deletedAt))).orderBy(asc(comments.createdAt), asc(comments.id));
        // A reply is shown only while its parent is: deleting the parent hides the whole thread.
        const live = new Set(all.filter((row) => row.parentId === null).map((row) => row.id));
        const rows = all.filter((row) => row.parentId === null || live.has(row.parentId));
        const authorIds = [...new Set(rows.map((row) => row.authorId))];
        const [names, mentions, agentAuthors] = await Promise.all([authorNames(authorIds), mentionsOf(db, rows.map((row) => row.id)), agentUserIds(db, authorIds)]);
        const codeAgents = agentAuthors.size ? new Set((await db.select({ userId: agents.userId }).from(agents).where(and(inArray(agents.userId, [...agentAuthors]), sql`${agents.runtimeId} is not null`))).map((agent) => agent.userId)) : new Set<string>();
        const repliesOf = new Map<string, CommentRow[]>();
        for (const row of rows) if (row.parentId) repliesOf.set(row.parentId, [...(repliesOf.get(row.parentId) ?? []), row]);
        // Every row is parsed in ONE stored-read job (one queue slot for the whole thread), then finished in order.
        const results = rows.map((row) => {
          const replies = repliesOf.get(row.id) ?? [];
          const people = [...new Set(replies.map((reply) => reply.authorId))].map((userId) => ({ userId, name: names.get(userId) ?? "" })).sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
          return out(row, names.get(row.authorId) ?? "", agentAuthors.has(row.authorId), codeAgents.has(row.authorId), mentions.get(row.id) ?? [], people, replies.length);
        });
        // A comment carries its document (`body`, written with the Markdown, or the legacy document of a backfilled row): it is served as it is. Only a row without one is parsed, in one batch.
        const hasDocument = (row: CommentRow) => !!row.body && typeof row.body === "object" && (row.body as { type?: unknown }).type === "doc";
        const parseIndexes = rows.flatMap((row, index) => hasDocument(row) ? [] : [index]);
        const items = [];
        for (const index of parseIndexes) items.push({ markdown: results[index]!.markdown, options: { ...(await commentMarkdownOptions(db, context.userId, item.workspaceId, item.projectId, results[index]!.markdown)).options, preserveUnresolvedReferences: true, preserveStableReferences: true } });
        const parsedRows = items.length ? await storedDocumentsWithWarnings(items) : [];
        const parsed = new Map(parseIndexes.map((index, at) => [index, parsedRows[at]!]));
        for (const [index, result] of results.entries()) {
          const converted = parsed.get(index) ?? { document: rows[index]!.body, warnings: [] as string[], warningDetails: [] as Array<{ code: string; message: string }> };
          result.body = await makeUnavailableReferencesPlainText(db, context.userId, converted.document);
          // The stored Markdown is the Written form; it is serialised again only when references the reader cannot open were rewritten, and then falls back to the stored text.
          if (JSON.stringify(result.body) !== JSON.stringify(converted.document)) result.markdown = await readWrittenFormOf(result.body, result.markdown);
          result.bodyText = plainText(result.body);
          result.markdownWarnings = converted.warnings;
          result.markdownWarningDetails = converted.warningDetails;
        }
        return results;
      },
    },
    listCommentVersions: {
      name: "list_comment_versions", kind: "read" as const,
      // A page of earlier versions, newest first: pass the last id back as `after`. Rows are read one at a time, large ones on a worker.
      input: Type.Object({ commentId: uuid(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), after: Type.Optional(uuid()) }), output: Type.Array(versionOutput),
      handler: async (context: Context, input: { commentId: string; limit?: number; after?: string }) => {
        const comment = await loadComment(input.commentId);
        const item = await loadItem(comment.workItemId!);
        const { project } = await accessForComment(context, item, "read");
        if (comment.authorId !== context.userId) {
          const role = await requireWorkspaceRole(db, context.userId, project.workspaceId, "read");
          if (role !== "Admin") throw new ActionError("Only the author and workspace Admins can read comment versions", 403);
        }
        const where = [eq(commentVersions.commentId, comment.id)];
        if (input.after) {
          const [cursor] = await db.select({ id: commentVersions.id }).from(commentVersions).where(and(eq(commentVersions.id, input.after), eq(commentVersions.commentId, comment.id)));
          if (!cursor) throw new ActionError("Version not found", 404);
          // Compared inside the database, so timestamps keep their microseconds.
          where.push(sql`(${commentVersions.createdAt}, ${commentVersions.id}) < (select created_at, id from comment_versions where id = ${input.after})`);
        }
        const rows = await db.select().from(commentVersions).where(and(...where)).orderBy(desc(commentVersions.createdAt), desc(commentVersions.id)).limit(Math.min(Math.max(input.limit ?? 20, 1), 100));
        const references = await commentMarkdownOptions(db, context.userId, comment.workspaceId, comment.projectId!, rows.map((row) => row.bodyMarkdown ?? "").join("\n"));
        // One stored-read job for the page; the page also stops early when its Markdown would pass ~1 MB (the cursor continues from the last row returned).
        const picked: typeof rows = [];
        let bytes = 0;
        for (const row of rows) { const size = (row.bodyMarkdown ?? row.bodyText).length; if (picked.length && bytes + size > PAGE_MARKDOWN_BUDGET) break; picked.push(row); bytes += size; }
        const markdowns: string[] = [];
        for (const row of picked) markdowns.push(row.bodyMarkdown ?? await readWrittenFormOf(row.body, row.bodyText));
        // A version is a snapshot of the comment document: it is served as it is, and only a row without a document is parsed.
        const hasDocument = (row: (typeof picked)[number]) => !!row.body && typeof row.body === "object" && (row.body as { type?: unknown }).type === "doc";
        const parseIndexes = picked.flatMap((row, index) => hasDocument(row) ? [] : [index]);
        const parsedRows = parseIndexes.length ? await storedDocumentsWithWarnings(parseIndexes.map((index) => ({ markdown: markdowns[index]!, options: { ...references.options, preserveUnresolvedReferences: true, preserveStableReferences: true } }))) : [];
        const parsed = new Map(parseIndexes.map((index, at) => [index, parsedRows[at]!]));
        return picked.map((row, index) => ({ id: row.id, commentId: row.commentId, body: parsed.get(index)?.document ?? row.body, bodyMarkdown: markdowns[index]!, bodyText: row.bodyText, writtenAt: row.writtenAt.toISOString(), replacedAt: row.createdAt.toISOString() }));
      },
    },
    createComment: {
      name: "create_comment", kind: "write" as const,
      input: Type.Object({ workItemId: uuid(), body: Type.Optional(bodyInput), bodyMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH, description: "Markdown comment text. Use this instead of body; for example, **bold** or | A | B |. Mention a person or Agent with @{exact name}; a plain @Name is only text." })), parentId: Type.Optional(uuid()) }), output: Type.Intersect([commentOutput, Type.Object({ wakeOutcomes: Type.Array(wakeOutcomeOutput) })]),
      handler: async (context: Context, input: { workItemId: string; body?: unknown; bodyMarkdown?: string; parentId?: string }) => {
        const item = await loadItem(input.workItemId);
        const { project, intake } = await accessForComment(context, item, "write");
        const prepared = await commentBody(context, { id: item.id, projectId: item.projectId, workspaceId: project.workspaceId }, input.body, input.bodyMarkdown);
        input.body = prepared.document;
        if (input.bodyMarkdown !== undefined) input.body = resolveMarkdownMentions(input.body, await mentionable(project));
        assertNotArchived(item);
        const parent = input.parentId ? await loadComment(input.parentId) : null;
        if (parent && parent.workItemId !== item.id) throw new ActionError("Parent comment belongs to another work item", 400);
        if (parent?.parentId) throw new ActionError("Cannot reply to a reply", 400);
        const { text, mentions } = parseBody(input.body);
        const written = input.bodyMarkdown !== undefined ? await writtenFormOf(input.body) : prepared.markdown;
        const mentionIds = await validatedMentions(project, context.userId, mentions);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          // Archiving takes the item row FOR UPDATE, so this share lock makes a comment and an archive wait for each other.
          const [locked] = await database.select().from(workItems).where(and(eq(workItems.id, item.id), isNull(workItems.deletedAt))).for("share");
          if (!locked) throw new ActionError("Work item not found", 404);
          assertNotArchived(locked);
          const [row] = await database.insert(comments).values({ workspaceId: project.workspaceId, projectId: project.id, workItemId: item.id, authorId: context.userId, runId: context.source === "agent" ? context.agent?.runId ?? null : null, parentId: parent?.id ?? null, body: input.body, bodyMarkdown: written, bodyText: text, createdAt: sql`clock_timestamp()` }).returning();
          await setOutlinksFromDocument(database, "work-item", item.id, commentPart(row!.id), input.body);
          await replaceMentions(database, row!.id, mentionIds);
          const assignees = (await database.select({ userId: workItemAssignees.userId }).from(workItemAssignees).where(eq(workItemAssignees.workItemId, item.id))).map((entry) => entry.userId);
          const intakeRecipients = intake ? [intake.createdBy, ...assignees, ...mentionIds] : [];
          const recipients = intake ? intakeRecipients : mentionIds;
          await enqueueNotification(database, { kind: "mention", workItemId: item.id, commentId: row!.id, actorId: context.userId, recipientIds: recipients });
          // A mention wakes an enabled Agent. An Agent-authored or Autopilot comment is decided per Agent by the wake decision: it wakes only when that Agent's Run may wake Agents (ADR 0013).
          const wakeOutcomes = intake ? [] : await queueRunsForAssignees(database, { originatorId: context.userId, waker: wakerOf(context.source), wakingRunId: context.agent?.runId ?? null, project, workItemId: item.id, assigneeUserIds: mentionIds, commentId: row!.id });
          // A parent author who already receives the comment notification gets no duplicate reply.
          if (parent) await enqueueNotification(database, { kind: "reply", workItemId: item.id, commentId: row!.id, actorId: context.userId, recipientIds: recipients.includes(parent.authorId) ? [] : [parent.authorId] });
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, workItemId: item.id }, "comment_added", { commentId: row!.id });
          if (!intake) {
            await fireEventTriggers(database, { eventType: "comment_added", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null });
            await emitOutboundEvent(database, { workspaceId: project.workspaceId, projectId: project.id, type: "comment.created", build: async (database) => ({ comment: { id: row!.id, text: row!.bodyText, authorName: (await authorNames([context.userId])).get(context.userId) ?? null, createdAt: row!.createdAt.toISOString() }, workItem: await workItemSnapshot(database, item.id) }) });
          }
          const authorAgent = (await agentUserIds(database, [context.userId])).has(context.userId);
          const authorCodeCapable = authorAgent && (await database.select({ userId: agents.userId }).from(agents).where(and(eq(agents.userId, context.userId), sql`${agents.runtimeId} is not null`))).length > 0;
          return { ...out(row!, (await authorNames([context.userId])).get(context.userId) ?? "", authorAgent, authorCodeCapable, mentionIds, [], 0, prepared.warnings, prepared.warningDetails), wakeOutcomes };
        });
      },
    },
    updateComment: {
      name: "update_comment", kind: "write" as const,
      input: Type.Object({ commentId: uuid(), bodyMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH, description: "Markdown comment text, for example **fixed**. Use this instead of body." })), body: Type.Optional(bodyInput) }), output: Type.Intersect([commentOutput, Type.Object({ wakeOutcomes: Type.Array(wakeOutcomeOutput) })]),
      handler: async (context: Context, input: { commentId: string; body?: unknown; bodyMarkdown?: string }) => {
        const existing = await loadComment(input.commentId);
        const item = await loadItem(existing.workItemId!);
        const { project, intake } = await accessForComment(context, item, "write");
        const prepared = await commentBody(context, { id: existing.workItemId!, projectId: project.id, workspaceId: project.workspaceId }, input.body, input.bodyMarkdown, await existingStableReferences(db, "work-item", existing.workItemId!, commentPart(existing.id), existing.bodyMarkdown));
        input.body = prepared.document;
        if (input.bodyMarkdown !== undefined) input.body = resolveMarkdownMentions(input.body, await mentionable(project));
        if (existing.authorId !== context.userId) throw new ActionError("Only the author can edit a comment", 403);
        assertNotArchived(await loadItem(existing.workItemId!));
        const { text, mentions } = parseBody(input.body);
        const written = input.bodyMarkdown !== undefined ? await writtenFormOf(input.body) : prepared.markdown;
        const mentionIds = await validatedMentions(project, context.userId, mentions);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.insert(commentVersions).values({ commentId: existing.id, body: existing.body, bodyMarkdown: existing.bodyMarkdown ?? await writtenFormOf(existing.body), bodyText: existing.bodyText, writtenAt: existing.editedAt ?? existing.createdAt, createdAt: sql`clock_timestamp()` });
          const [row] = await database.update(comments).set({ body: input.body, bodyMarkdown: written, bodyText: text, editedAt: new Date() }).where(eq(comments.id, existing.id)).returning();
          await setOutlinksFromDocument(database, "work-item", existing.workItemId!, commentPart(existing.id), input.body);
          const already = (await mentionsOf(database, [existing.id])).get(existing.id)!;
          await replaceMentions(database, existing.id, mentionIds);
          const newMentions = mentionIds.filter((id) => !already.includes(id));
          await enqueueNotification(database, { kind: "mention", workItemId: existing.workItemId!, commentId: existing.id, actorId: context.userId, recipientIds: newMentions });
          const wakeOutcomes = intake ? [] : await queueRunsForAssignees(database, { originatorId: context.userId, waker: wakerOf(context.source), wakingRunId: context.agent?.runId ?? null, project, workItemId: existing.workItemId!, assigneeUserIds: newMentions, commentId: existing.id });
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, workItemId: existing.workItemId! }, "comment_edited", { commentId: existing.id });
          const replies = await database.select().from(comments).where(and(eq(comments.parentId, existing.id), isNull(comments.deletedAt)));
          const names = await authorNames([context.userId, ...new Set(replies.map((reply) => reply.authorId))]);
          const people = [...new Set(replies.map((reply) => reply.authorId))].map((userId) => ({ userId, name: names.get(userId) ?? "" })).sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
          const authorAgent = (await agentUserIds(database, [context.userId])).has(context.userId);
          const authorCodeCapable = authorAgent && (await database.select({ userId: agents.userId }).from(agents).where(and(eq(agents.userId, context.userId), sql`${agents.runtimeId} is not null`))).length > 0;
          return { ...out(row!, names.get(context.userId) ?? "", authorAgent, authorCodeCapable, mentionIds, people, replies.length, prepared.warnings, prepared.warningDetails), wakeOutcomes };
        });
      },
    },
    deleteComment: {
      name: "delete_comment", kind: "write" as const,
      input: Type.Object({ commentId: uuid() }), output: Type.Object({ removed: Type.Boolean() }),
      handler: async (context: Context, input: { commentId: string }) => {
        const existing = await loadComment(input.commentId);
        const item = await loadItem(existing.workItemId!);
        const { project } = await accessForComment(context, item, "write");
        if (existing.authorId !== context.userId) throw new ActionError("Only the author can delete a comment", 403);
        assertNotArchived(await loadItem(existing.workItemId!));
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, existing.id));
          // The deleted text must not survive in any earlier version, nor in the hidden replies' versions.
          const replyIds = (await database.select({ id: comments.id }).from(comments).where(eq(comments.parentId, existing.id))).map((row) => row.id);
          await database.update(comments).set({ deletedAt: new Date() }).where(inArray(comments.id, replyIds));
          for (const id of [existing.id, ...replyIds]) await clearOutlinkPart(database, "work-item", existing.workItemId!, commentPart(id));
          await database.delete(commentVersions).where(inArray(commentVersions.commentId, [existing.id, ...replyIds]));
          await replaceMentions(database, existing.id, []);
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, workItemId: existing.workItemId! }, "comment_deleted", { commentId: existing.id });
          return { removed: true };
        });
      },
    },
  };
}
