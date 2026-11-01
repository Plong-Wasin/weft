import { Type } from "@sinclair/typebox";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { aiRequests, comments, confirmations, notifications, projects, sessions, users, workItems, workspaceInvites, workspaceMembers, type Database } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { enqueueJob, type JobHandlers } from "./jobs";
import { publishSignal, type Signal } from "./realtime";

export type NotificationKind = "mention" | "assignment" | "reply" | "intake_accepted" | "intake_rejected" | "intake_duplicate";

export interface NotifyPayload {
  kind: NotificationKind;
  workItemId: string;
  commentId?: string;
  actorId: string;
  recipientIds: string[];
}

/** Queues a fan-out job inside the caller's transaction; the recipients are notified when the worker runs it. */
export async function enqueueNotification(database: Database, payload: NotifyPayload) {
  const recipientIds = [...new Set(payload.recipientIds)].filter((id) => id !== payload.actorId);
  if (recipientIds.length === 0) return;
  await enqueueJob(database, { type: "notify", payload: { ...payload, recipientIds } });
}

async function fanOut(database: Database, payload: NotifyPayload, job: { id: string }, publish: SignalPublisher) {
  const [item] = await database.select().from(workItems).where(and(eq(workItems.id, payload.workItemId), isNull(workItems.deletedAt)));
  if (!item) return;
  if (payload.commentId) {
    const [comment] = await database.select({ id: comments.id, parentId: comments.parentId }).from(comments).where(and(eq(comments.id, payload.commentId), isNull(comments.deletedAt)));
    if (!comment) return;
    // A reply whose parent is gone is hidden with it, so it notifies nobody.
    if (comment.parentId) {
      const [parent] = await database.select({ id: comments.id }).from(comments).where(and(eq(comments.id, comment.parentId), isNull(comments.deletedAt)));
      if (!parent) return;
    }
  }
  const members = await database.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, item.workspaceId), inArray(workspaceMembers.userId, payload.recipientIds)));
  if (members.length === 0) return;
  const created = await database.insert(notifications).values(members.map(({ userId }) => ({
    workspaceId: item.workspaceId, userId, actorId: payload.actorId, kind: payload.kind, workItemId: item.id, commentId: payload.commentId ?? null, jobId: job.id,
  }))).onConflictDoNothing().returning({ userId: notifications.userId });
  for (const { userId } of created) await publish(database, { type: "notification", workspaceId: item.workspaceId, userId });
}

export const cleanupJobTypes = ["cleanup_invites", "cleanup_sessions", "cleanup_confirmations", "cleanup_ai_requests"] as const;

/** Every job type the worker handles. */
/** Sends a signal through the job's transaction, so it goes out only if the notifications commit. */
export type SignalPublisher = (database: Database, signal: Signal) => Promise<void>;

export function createJobHandlers(publish: SignalPublisher = publishSignal): JobHandlers {
  return {
    notify: (database, payload, job) => fanOut(database, payload as NotifyPayload, job, publish),
    cleanup_invites: async (database) => { await database.delete(workspaceInvites).where(lt(workspaceInvites.expiresAt, new Date())); },
    cleanup_sessions: async (database) => { await database.delete(sessions).where(lt(sessions.expiresAt, new Date())); },
    cleanup_confirmations: async (database) => { await database.delete(confirmations).where(lt(confirmations.expiresAt, new Date())); },
    // The rate-limit window is one minute; a day of history is plenty.
    cleanup_ai_requests: async (database) => { await database.delete(aiRequests).where(lt(aiRequests.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))); },
  };
}

/** Enqueues one cleanup job per kind unless one is already open. Returns how many were added. */
export async function scheduleCleanupJobs(database: Database) {
  let added = 0;
  for (const type of cleanupJobTypes) if (await enqueueJob(database, { type, dedupeKey: type })) added++;
  return added;
}

const uuid = () => Type.String({ format: "uuid" });
const notificationOutput = Type.Object({
  id: Type.String(), kind: Type.Union((["mention", "assignment", "reply", "intake_accepted", "intake_rejected", "intake_duplicate"] as const).map((kind) => Type.Literal(kind))), workItemId: Type.String(), projectId: Type.String(),
  displayId: Type.String(), workItemTitle: Type.String(), commentId: Type.Union([Type.String(), Type.Null()]),
  actorId: Type.String(), actorName: Type.String(), readAt: Type.Union([Type.String(), Type.Null()]), createdAt: Type.String(),
});

export function createNotificationActions(db: Database) {
  /** The caller's notifications in a workspace, minus those for work items in projects they can no longer see. */
  async function visibleRows(userId: string, workspaceId: string, unreadOnly: boolean) {
    await requireWorkspaceRole(db, userId, workspaceId, "read");
    const rows = await db.select({
      id: notifications.id, kind: notifications.kind, workItemId: notifications.workItemId, projectId: workItems.projectId, projectKey: projects.key,
      sequence: workItems.sequence, title: workItems.title, deletedAt: workItems.deletedAt, commentId: notifications.commentId, actorId: notifications.actorId,
      actorName: users.name, readAt: notifications.readAt, createdAt: notifications.createdAt,
    }).from(notifications)
      .innerJoin(workItems, eq(workItems.id, notifications.workItemId)).innerJoin(projects, eq(projects.id, workItems.projectId)).innerJoin(users, eq(users.id, notifications.actorId))
      .where(and(eq(notifications.userId, userId), eq(notifications.workspaceId, workspaceId), ...(unreadOnly ? [isNull(notifications.readAt)] : [])))
      .orderBy(desc(notifications.createdAt), desc(notifications.id));
    const visible = new Map<string, boolean>();
    for (const projectId of new Set(rows.map((row) => row.projectId))) {
      visible.set(projectId, await requireProjectAccess(db, userId, projectId, "read").then(() => true, () => false));
    }
    return rows.filter((row) => row.deletedAt === null && visible.get(row.projectId));
  }

  return {
    listNotifications: {
      name: "list_notifications", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid(), unreadOnly: Type.Optional(Type.Boolean()) }),
      output: Type.Object({ unreadCount: Type.Integer(), notifications: Type.Array(notificationOutput) }),
      handler: async (context: { userId: string }, input: { workspaceId: string; unreadOnly?: boolean }) => {
        const all = await visibleRows(context.userId, input.workspaceId, false);
        const shown = input.unreadOnly ? all.filter((row) => row.readAt === null) : all;
        return {
          unreadCount: all.filter((row) => row.readAt === null).length,
          notifications: shown.map((row) => ({
            id: row.id, kind: row.kind as NotificationKind, workItemId: row.workItemId, projectId: row.projectId, displayId: `${row.projectKey}-${row.sequence}`,
            workItemTitle: row.title, commentId: row.commentId, actorId: row.actorId, actorName: row.actorName,
            readAt: row.readAt ? row.readAt.toISOString() : null, createdAt: row.createdAt.toISOString(),
          })),
        };
      },
    },
    markNotificationRead: {
      name: "mark_notification_read", kind: "write" as const,
      input: Type.Object({ notificationId: uuid() }), output: Type.Object({ marked: Type.Boolean() }),
      handler: async (context: { userId: string }, input: { notificationId: string }) => {
        const updated = await db.update(notifications).set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
          .where(and(eq(notifications.id, input.notificationId), eq(notifications.userId, context.userId))).returning({ id: notifications.id });
        if (updated.length === 0) throw new ActionError("Notification not found", 404);
        return { marked: true };
      },
    },
    markAllNotificationsRead: {
      name: "mark_all_notifications_read", kind: "write" as const,
      input: Type.Object({ workspaceId: uuid() }), output: Type.Object({ marked: Type.Integer() }),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const updated = await db.update(notifications).set({ readAt: new Date() })
          .where(and(eq(notifications.userId, context.userId), eq(notifications.workspaceId, input.workspaceId), isNull(notifications.readAt))).returning({ id: notifications.id });
        return { marked: updated.length };
      },
    },
  };
}
