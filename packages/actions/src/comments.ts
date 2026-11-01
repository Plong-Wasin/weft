import { Type } from "@sinclair/typebox";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, commentMentions, comments, projectMembers, projects, users, workItems, workspaceMembers } from "@weft/db";
import { liveWorkItems } from "./triage";
import { ActionError } from "./members";
import { enqueueNotification } from "./notifications";
import { requireProjectAccess } from "./projects";
import { plainText, type ActivitySource } from "./work-items";

type Context = { userId: string; source?: ActivitySource };
type CommentRow = typeof comments.$inferSelect;

const uuid = () => Type.String({ format: "uuid" });
const commentOutput = Type.Object({
  id: Type.String(), workItemId: Type.String(), authorId: Type.String(), authorName: Type.String(), body: Type.Any(), bodyText: Type.String(),
  mentionedUserIds: Type.Array(Type.String()), parentId: Type.Union([Type.String(), Type.Null()]), replyCount: Type.Integer(),
  participants: Type.Array(Type.Object({ userId: Type.String(), name: Type.String() })), createdAt: Type.String(), editedAt: Type.Union([Type.String(), Type.Null()]),
});
const mentionableOutput = Type.Object({ userId: Type.String(), name: Type.String(), email: Type.String() });
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
    const [item] = await db.select().from(workItems).where(and(eq(workItems.id, workItemId), liveWorkItems));
    if (!item) throw new ActionError("Work item not found", 404);
    return item;
  }

  async function loadComment(commentId: string) {
    const [comment] = await db.select().from(comments).where(and(eq(comments.id, commentId), isNull(comments.deletedAt)));
    if (!comment) throw new ActionError("Comment not found", 404);
    // Replies are hidden together with a deleted parent, so they cannot be reached either.
    if (comment.parentId) await loadComment(comment.parentId);
    return comment;
  }

  /** Members who can see the project: everyone in the workspace for a public project, else project members and workspace admins. */
  async function mentionable(project: { id: string; workspaceId: string; visibility: string }) {
    const rows = await db.select({ userId: users.id, name: users.name, email: users.email, role: workspaceMembers.role })
      .from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, project.workspaceId)).orderBy(asc(users.name), asc(users.id));
    if (project.visibility !== "private") return rows;
    const members = new Set((await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id))).map((row) => row.userId));
    return rows.filter((row) => row.role === "Admin" || members.has(row.userId));
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

  function out(row: CommentRow, authorName: string, mentionedUserIds: string[], replies: Array<{ userId: string; name: string }> = [], replyCount = 0) {
    return {
      id: row.id, workItemId: row.workItemId, authorId: row.authorId, authorName, body: row.body, bodyText: row.bodyText, mentionedUserIds,
      parentId: row.parentId, replyCount, participants: replies,
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
      newValue, actorId: context.userId, source: context.source ?? "ui",
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
        return (await mentionable(project)).map(({ userId, name, email }) => ({ userId, name, email }));
      },
    },
    listComments: {
      name: "list_comments", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(commentOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const item = await loadItem(input.workItemId);
        await requireProjectAccess(db, context.userId, item.projectId, "read");
        const all = await db.select().from(comments).where(and(eq(comments.workItemId, item.id), isNull(comments.deletedAt))).orderBy(asc(comments.createdAt), asc(comments.id));
        // A reply is shown only while its parent is: deleting the parent hides the whole thread.
        const live = new Set(all.filter((row) => row.parentId === null).map((row) => row.id));
        const rows = all.filter((row) => row.parentId === null || live.has(row.parentId));
        const [names, mentions] = await Promise.all([authorNames([...new Set(rows.map((row) => row.authorId))]), mentionsOf(db, rows.map((row) => row.id))]);
        const repliesOf = new Map<string, CommentRow[]>();
        for (const row of rows) if (row.parentId) repliesOf.set(row.parentId, [...(repliesOf.get(row.parentId) ?? []), row]);
        return rows.map((row) => {
          const replies = repliesOf.get(row.id) ?? [];
          const people = [...new Set(replies.map((reply) => reply.authorId))].map((userId) => ({ userId, name: names.get(userId) ?? "" })).sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
          return out(row, names.get(row.authorId) ?? "", mentions.get(row.id) ?? [], people, replies.length);
        });
      },
    },
    createComment: {
      name: "create_comment", kind: "write" as const,
      input: Type.Object({ workItemId: uuid(), body: bodyInput, parentId: Type.Optional(uuid()) }), output: commentOutput,
      handler: async (context: Context, input: { workItemId: string; body: unknown; parentId?: string }) => {
        const item = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, item.projectId, "write");
        const parent = input.parentId ? await loadComment(input.parentId) : null;
        if (parent && parent.workItemId !== item.id) throw new ActionError("Parent comment belongs to another work item", 400);
        if (parent?.parentId) throw new ActionError("Cannot reply to a reply", 400);
        const { text, mentions } = parseBody(input.body);
        const mentionIds = await validatedMentions(project, context.userId, mentions);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [row] = await database.insert(comments).values({ workspaceId: project.workspaceId, projectId: project.id, workItemId: item.id, authorId: context.userId, parentId: parent?.id ?? null, body: input.body, bodyText: text, createdAt: sql`clock_timestamp()` }).returning();
          await replaceMentions(database, row!.id, mentionIds);
          await enqueueNotification(database, { kind: "mention", workItemId: item.id, commentId: row!.id, actorId: context.userId, recipientIds: mentionIds });
          // A parent author who is also mentioned gets the mention, not a second notification.
          if (parent) await enqueueNotification(database, { kind: "reply", workItemId: item.id, commentId: row!.id, actorId: context.userId, recipientIds: mentionIds.includes(parent.authorId) ? [] : [parent.authorId] });
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, workItemId: item.id }, "comment_added", { commentId: row!.id });
          return out(row!, (await authorNames([context.userId])).get(context.userId) ?? "", mentionIds);
        });
      },
    },
    updateComment: {
      name: "update_comment", kind: "write" as const,
      input: Type.Object({ commentId: uuid(), body: bodyInput }), output: commentOutput,
      handler: async (context: Context, input: { commentId: string; body: unknown }) => {
        const existing = await loadComment(input.commentId);
        const { project } = await requireProjectAccess(db, context.userId, existing.projectId, "write");
        if (existing.authorId !== context.userId) throw new ActionError("Only the author can edit a comment", 403);
        const { text, mentions } = parseBody(input.body);
        const mentionIds = await validatedMentions(project, context.userId, mentions);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [row] = await database.update(comments).set({ body: input.body, bodyText: text, editedAt: new Date() }).where(eq(comments.id, existing.id)).returning();
          const already = (await mentionsOf(database, [existing.id])).get(existing.id)!;
          await replaceMentions(database, existing.id, mentionIds);
          await enqueueNotification(database, { kind: "mention", workItemId: existing.workItemId, commentId: existing.id, actorId: context.userId, recipientIds: mentionIds.filter((id) => !already.includes(id)) });
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, workItemId: existing.workItemId }, "comment_edited", { commentId: existing.id });
          const replies = await database.select().from(comments).where(and(eq(comments.parentId, existing.id), isNull(comments.deletedAt)));
          const names = await authorNames([context.userId, ...new Set(replies.map((reply) => reply.authorId))]);
          const people = [...new Set(replies.map((reply) => reply.authorId))].map((userId) => ({ userId, name: names.get(userId) ?? "" })).sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
          return out(row!, names.get(context.userId) ?? "", mentionIds, people, replies.length);
        });
      },
    },
    deleteComment: {
      name: "delete_comment", kind: "write" as const,
      input: Type.Object({ commentId: uuid() }), output: Type.Object({ removed: Type.Boolean() }),
      handler: async (context: Context, input: { commentId: string }) => {
        const existing = await loadComment(input.commentId);
        const { project } = await requireProjectAccess(db, context.userId, existing.projectId, "write");
        if (existing.authorId !== context.userId) throw new ActionError("Only the author can delete a comment", 403);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, existing.id));
          await replaceMentions(database, existing.id, []);
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, workItemId: existing.workItemId }, "comment_deleted", { commentId: existing.id });
          return { removed: true };
        });
      },
    },
  };
}
