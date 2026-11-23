import { Type } from "@sinclair/typebox";
import { and, desc, eq, inArray, isNull, lte, lt, sql } from "drizzle-orm";
import { aiRequests, apiTokens, cliDeviceAuthorizations, collectionMembers, collections, comments, confirmations, intakeItems, notifications, projectMembers, projects, recurrences, runs, sessions, users, wikiPageShares, workItems, workItemAssignees, wikiPages, workspaceInvites, workspaceMembers, type Database } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { enqueueJob, type JobHandlers } from "./jobs";
import { exportJobType, handleExportJob, handleExportCleanup } from "./exports";
import type { ExportStorage } from "./storage";
import { handleAgentRunJob, handleRunExpiryJob, type RunModel } from "./run-executor";
import { publishSignal, type Signal } from "./realtime";
import { fireScheduleTrigger } from "./triggers";
import { fireScheduleRecurrence } from "./recurrences";
import { purgeIntegrationDeliveries } from "./integration-deliveries";
import { purgeStaleRuntimes } from "./runtimes";
import { applyAutoRules, autoRulesJobType } from "./auto-rules";
import { canViewNotificationItem, purgeNotificationEmails, queueNotificationEmails, sendNotificationDigests } from "./email-digest";
import type { MailLocale } from "./email-templates";
import { webOriginFromEnv, type Mailer } from "./mail";
import { outboundDeliveryJobHandler, outboundJobType, purgeOutboundDeliveries } from "./outbound-webhooks";
import { outboundWebhooksEnabled } from "./outbound-webhooks-flag";
import { lockCliDeviceLifecycle } from "./api-tokens";

export type NotificationKind = "mention" | "assignment" | "reply" | "intake_accepted" | "intake_rejected" | "intake_duplicate" | "run_confirmation" | "run_skipped" | "wake_skipped" | "recurrence_paused" | "auto_rule" | "secret_output_blocked";

export interface NotifyPayload {
  kind: NotificationKind;
  workItemId?: string;
  /** A work-item-free scheduled Run a notification should open. */
  runId?: string;
  wikiPageId?: string;
  commentId?: string;
  actorId: string;
  recipientIds: string[];
  /** Plain-language reason, for kinds that carry one (auto_rule); a wake_skipped notice carries its reason code. */
  detail?: string;
}

export async function enqueuePageMention(database: Database, pageId: string, actorId: string, recipientIds: string[]) {
  const recipients = [...new Set(recipientIds)].filter((id) => id !== actorId);
  if (recipients.length) await enqueueJob(database, { type: "notify", payload: { kind: "mention", wikiPageId: pageId, actorId, recipientIds: recipients } });
}

/** Queues a fan-out job inside the caller's transaction; the recipients are notified when the worker runs it. */
export async function enqueueNotification(database: Database, payload: NotifyPayload) {
  const recipientIds = [...new Set(payload.recipientIds)].filter((id) => id !== payload.actorId);
  if (recipientIds.length === 0) return;
  await enqueueJob(database, { type: "notify", payload: { ...payload, recipientIds } });
}

/** A Run can block several outputs during one correction attempt; the Run id is the stable notification key. */
export async function recordSecretOutputBlockedNotifications(database: Database, input: { workspaceId: string; runId: string; actorId: string; recipientIds: string[] }) {
  const recipients = [...new Set(input.recipientIds)].filter((id) => id !== input.actorId);
  const members = recipients.length ? await database.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), inArray(workspaceMembers.userId, recipients), isNull(workspaceMembers.suspendedAt))) : [];
  for (const { userId } of members) {
    const [created] = await database.insert(notifications).values({ workspaceId: input.workspaceId, userId, actorId: input.actorId, kind: "secret_output_blocked", detail: null, jobId: input.runId })
      .onConflictDoNothing().returning({ userId: notifications.userId });
    if (created) await publishSignal(database, { type: "notification", workspaceId: input.workspaceId, userId });
  }
}

async function fanOut(database: Database, payload: NotifyPayload, job: { id: string }, publish: SignalPublisher) {
  if (payload.kind === "secret_output_blocked" && payload.workItemId) {
    const [item] = await database.select({ workspaceId: workItems.workspaceId }).from(workItems).where(eq(workItems.id, payload.workItemId));
    if (!item) return;
    for (const userId of payload.recipientIds) {
      const [member] = await database.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, item.workspaceId), eq(workspaceMembers.userId, userId), isNull(workspaceMembers.suspendedAt)));
      if (!member) continue;
      const [created] = await database.insert(notifications).values({ workspaceId: item.workspaceId, userId, actorId: payload.actorId, kind: payload.kind, detail: null, jobId: job.id }).onConflictDoNothing().returning({ userId: notifications.userId });
      if (created) await publish(database, { type: "notification", workspaceId: item.workspaceId, userId });
    }
    return;
  }
  const recurrencePayload = payload as NotifyPayload & { recurrenceId?: string; reason?: string };
  if (payload.kind === "recurrence_paused" && recurrencePayload.recurrenceId) {
    const [recurrence] = await database.select().from(recurrences).where(eq(recurrences.id, recurrencePayload.recurrenceId));
    if (!recurrence || recurrence.status !== "paused") return;
    const admins = await database.select({ userId: projectMembers.userId }).from(projectMembers)
      .where(and(eq(projectMembers.projectId, recurrence.projectId), eq(projectMembers.role, "Admin")));
    const adminIds = new Set(admins.map(({ userId }) => userId));
    for (const userId of recurrencePayload.recipientIds ?? []) {
      const [member] = await database.select({ role: workspaceMembers.role }).from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, recurrence.workspaceId), eq(workspaceMembers.userId, userId)));
      if (!member || (!adminIds.has(userId) && member.role !== "Admin")) continue;
      const [created] = await database.insert(notifications).values({ workspaceId: recurrence.workspaceId, userId, actorId: payload.actorId, kind: payload.kind, recurrenceId: recurrence.id, detail: `${recurrence.name}: ${recurrencePayload.reason ?? recurrence.pausedReason ?? "creator lost access"}`, jobId: job.id }).onConflictDoNothing().returning({ userId: notifications.userId });
      if (created) await publish(database, { type: "notification", workspaceId: recurrence.workspaceId, userId });
    }
    return;
  }
  if (payload.kind === "auto_rule" && payload.workItemId) {
    const [item] = await database.select().from(workItems).where(and(eq(workItems.id, payload.workItemId), isNull(workItems.deletedAt)));
    if (!item) return;
    for (const userId of payload.recipientIds) {
      const [member] = await database.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, item.workspaceId), eq(workspaceMembers.userId, userId)));
      if (!member) continue;
      const [created] = await database.insert(notifications).values({ workspaceId: item.workspaceId, userId, actorId: payload.actorId, kind: payload.kind, workItemId: item.id, detail: payload.detail ?? null, jobId: job.id }).onConflictDoNothing().returning({ userId: notifications.userId });
      if (created) await publish(database, { type: "notification", workspaceId: item.workspaceId, userId });
    }
    return;
  }
  const [item] = payload.workItemId ? await database.select().from(workItems).where(and(eq(workItems.id, payload.workItemId), isNull(workItems.deletedAt))) : [];
  const [page] = payload.wikiPageId ? await database.select().from(wikiPages).where(and(eq(wikiPages.id, payload.wikiPageId), isNull(wikiPages.deletedAt))) : [];
  const [scheduledRun] = payload.runId ? await database.select({ id: runs.id, workspaceId: runs.workspaceId, workItemId: runs.workItemId }).from(runs).where(and(eq(runs.id, payload.runId), isNull(runs.workItemId))) : [];
  if (!item && !page && !scheduledRun) return;
  let allowedRecipients = payload.recipientIds;
  if (item) {
    const [intake] = await database.select().from(intakeItems).where(and(eq(intakeItems.workItemId, item.id), sql`${intakeItems.outcome} <> 'accepted'`));
    if (intake) {
      const [project] = await database.select().from(projects).where(eq(projects.id, item.projectId));
      if (!project || !project.intakeEnabled) return;
      const [projectRows, workspaceRows, assigneeRows] = await Promise.all([
        database.select({ userId: projectMembers.userId, role: projectMembers.role }).from(projectMembers).where(eq(projectMembers.projectId, project.id)),
        database.select({ userId: workspaceMembers.userId, role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, item.workspaceId), inArray(workspaceMembers.userId, payload.recipientIds), isNull(workspaceMembers.suspendedAt))),
        database.select({ userId: workItemAssignees.userId }).from(workItemAssignees).where(eq(workItemAssignees.workItemId, item.id)),
      ]);
      const projectIds = new Set(projectRows.map((row) => row.userId));
      const projectRoles = new Map(projectRows.map((row) => [row.userId, row.role]));
      const roles = new Map(workspaceRows.map((row) => [row.userId, row.role]));
      const participants = new Set([intake.createdBy, ...assigneeRows.map((row) => row.userId)]);
      let replyAuthor: string | undefined;
      if (payload.kind === "reply" && payload.commentId) {
        const [reply] = await database.select({ parentId: comments.parentId }).from(comments).where(and(eq(comments.id, payload.commentId), isNull(comments.deletedAt)));
        if (reply?.parentId) {
          const [parent] = await database.select({ authorId: comments.authorId }).from(comments).where(and(eq(comments.id, reply.parentId), isNull(comments.deletedAt)));
          replyAuthor = parent?.authorId;
        }
      }
      allowedRecipients = payload.recipientIds.filter((id) => {
        const role = roles.get(id);
        if (!role || (project.visibility === "private" && role !== "Admin" && !projectIds.has(id))) return false;
        if (role !== "Admin" && (role === "Guest" || projectRoles.get(id) === "Guest")) return id === intake.createdBy;
        return participants.has(id) || (payload.kind === "mention" && payload.commentId !== undefined) || id === replyAuthor;
      });
    }
  }
  if (payload.commentId) {
    const [comment] = await database.select({ id: comments.id, parentId: comments.parentId }).from(comments).where(and(eq(comments.id, payload.commentId), isNull(comments.deletedAt)));
    if (!comment) return;
    // A reply whose parent is gone is hidden with it, so it notifies nobody.
    if (comment.parentId) {
      const [parent] = await database.select({ id: comments.id }).from(comments).where(and(eq(comments.id, comment.parentId), isNull(comments.deletedAt)));
      if (!parent) return;
    }
  }
  const workspaceId = item?.workspaceId ?? page?.workspaceId ?? scheduledRun!.workspaceId;
  if (page) {
    const shares = (await database.select({ userId: wikiPageShares.userId }).from(wikiPageShares).where(eq(wikiPageShares.pageId, page.id))).map((row) => row.userId);
    if (page.access === "private") allowedRecipients = allowedRecipients.filter((id) => id === page.ownerId || shares.includes(id));
    else if (page.projectId) {
      const pageMembers = new Set((await database.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, page.projectId))).map((row) => row.userId));
      allowedRecipients = allowedRecipients.filter((id) => pageMembers.has(id));
    } else if (page.collectionId) {
      const [collection] = await database.select().from(collections).where(and(eq(collections.id, page.collectionId), isNull(collections.deletedAt)));
      if (collection?.visibility === "private") {
        const collectionMembersList = await database.select({ userId: collectionMembers.userId }).from(collectionMembers).where(eq(collectionMembers.collectionId, page.collectionId));
        const visible = new Set([collection.ownerId, ...collectionMembersList.map((row) => row.userId), ...shares]);
        allowedRecipients = allowedRecipients.filter((id) => visible.has(id));
      }
    }
  }
  const members = await database.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, allowedRecipients), isNull(workspaceMembers.suspendedAt)));
  if (members.length === 0) return;
  const created = await database.insert(notifications).values(members.map(({ userId }) => ({
    workspaceId, userId, actorId: payload.actorId, kind: payload.kind, workItemId: item?.id ?? null, runId: scheduledRun?.id ?? null, wikiPageId: page?.id ?? null, commentId: payload.commentId ?? null,
    detail: payload.kind === "run_skipped" ? payload.detail ?? null : null, jobId: job.id,
  }))).onConflictDoNothing().returning({ userId: notifications.userId });
  for (const { userId } of created) await publish(database, { type: "notification", workspaceId, userId });
  await queueNotificationEmails(database, created.map(({ userId }) => ({
    userId, workspaceId, actorId: payload.actorId, kind: payload.kind, workItemId: item?.id ?? null, wikiPageId: page?.id ?? null, commentId: payload.commentId ?? null, jobId: job.id,
  })));
}

export const cleanupJobTypes = ["cleanup_invites", "cleanup_sessions", "cleanup_confirmations", "cleanup_ai_requests", "cleanup_exports", "cleanup_notification_emails", "cleanup_integration_deliveries", "cleanup_stale_runtimes", "cleanup_cli_device_authorizations"] as const;

/** Every job type the worker handles. */
/** Sends a signal through the job's transaction, so it goes out only if the notifications commit. */
export type SignalPublisher = (database: Database, signal: Signal) => Promise<void>;

export interface JobRuntime {
  /** The provider seam an `agent_run` job executes Runs on; without it a started Run fails as `model_not_configured`. */
  runModel?: RunModel;
  /** Test seam for the clock the Confirmation expiry check reads. */
  now?: () => Date;
  /** Where the `export_build` job writes Export files; defaults to the S3 storage. */
  exportStorage?: ExportStorage;
  /** Test seam for the Export size bound. */
  maxExportBytes?: () => number;
  /** Sends the email digest. Without one (SMTP not set) the digest job does nothing and no email rows are read. */
  mailer?: Mailer | null;
  /** Base of the links in digest emails; defaults to WEB_ORIGIN. */
  webOrigin?: string;
  /** The instance default language for people without a saved one (DEFAULT_LANGUAGE). */
  defaultLocale?: MailLocale | null;
}

export function createJobHandlers(publish: SignalPublisher = publishSignal, runtime: JobRuntime = {}): JobHandlers {
  return {
    // Registered only while outbound webhooks are on; with the flag off no delivery job is ever queued or handled.
    ...(outboundWebhooksEnabled() ? { [outboundJobType]: outboundDeliveryJobHandler() } : {}),
    notify: (database, payload, job) => fanOut(database, payload as NotifyPayload, job, publish),
    agent_run: (database, payload) => handleAgentRunJob(database, payload as { runId: string }, { model: runtime.runModel }),
    agent_run_expire: (database, payload) => handleRunExpiryJob(database, payload as { runId: string; confirmationId: string }, { now: runtime.now }),
    schedule_trigger: (database, payload) => fireScheduleTrigger(database, { ...(payload as { triggerId: string }), now: runtime.now?.() }),
    schedule_recurrence: (database, payload) => fireScheduleRecurrence(database, { ...(payload as { recurrenceId: string }), now: runtime.now?.() }),
    [exportJobType]: (database, payload, job) => handleExportJob(database, payload as { exportId: string }, job, { storage: runtime.exportStorage, now: runtime.now, maxBytes: runtime.maxExportBytes }),
    [autoRulesJobType]: (database) => applyAutoRules(database, runtime.now?.() ?? new Date()).then(() => undefined),
    cleanup_invites: async (database) => { await database.delete(workspaceInvites).where(lt(workspaceInvites.expiresAt, new Date())); },
    cleanup_sessions: async (database) => { await database.delete(sessions).where(lt(sessions.expiresAt, new Date())); },
    cleanup_confirmations: async (database) => { await database.delete(confirmations).where(lt(confirmations.expiresAt, new Date())); },
    // The rate-limit window is one minute; a day of history is plenty.
    cleanup_ai_requests: async (database) => { await database.delete(aiRequests).where(lt(aiRequests.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))); },
    // The Export link lasts 7 days; the stored file is deleted and the row marked expired after that.
    cleanup_exports: (database) => handleExportCleanup(database, { storage: runtime.exportStorage, now: runtime.now }),
    // The digest is scheduled only when email is set up (see the worker); a run here sends whatever is queued and marks it.
    email_digest: async (database) => {
      if (!runtime.mailer) return;
      await sendNotificationDigests(database, { mailer: runtime.mailer, webOrigin: runtime.webOrigin ?? webOriginFromEnv(), defaultLocale: runtime.defaultLocale ?? null, now: runtime.now?.() });
    },
    cleanup_notification_emails: (database) => purgeNotificationEmails(database, runtime.now?.()),
    cleanup_integration_deliveries: (database) => purgeIntegrationDeliveries(database, runtime.now?.()),
    // Hourly: removes Runtimes offline for more than seven days with no enabled Agent bound and no unfinished Run (see purgeStaleRuntimes).
    cleanup_stale_runtimes: async (database) => { await purgeStaleRuntimes(database, runtime.now?.() ?? new Date()); },
    // Device authorization records are audit history. Expired candidates are revoked, while the records remain.
    cleanup_cli_device_authorizations: async (database) => { await expireCliDeviceAuthorizations(database, runtime.now?.() ?? new Date()); },
    ...(outboundWebhooksEnabled() ? { cleanup_outbound_webhook_deliveries: async (database: Database) => { await purgeOutboundDeliveries(database, runtime.now?.()); } } : {}),
  };
}

/** Revoke unfinalized credentials at their authorization deadline without changing completed device credentials. */
export async function expireCliDeviceAuthorizations(database: Database, now = new Date(), onlyId?: string) {
  let count = 0;
  for (;;) {
    const expired = await database.select({ id: cliDeviceAuthorizations.id, userId: cliDeviceAuthorizations.userId, deviceId: cliDeviceAuthorizations.deviceId })
      .from(cliDeviceAuthorizations)
      .where(and(lte(cliDeviceAuthorizations.expiresAt, now), inArray(cliDeviceAuthorizations.status, ["pending", "approved", "exchanged", "rotating"]), ...(onlyId ? [eq(cliDeviceAuthorizations.id, onlyId)] : [])))
      .limit(500);
    if (!expired.length) break;
    for (const item of expired) {
      await database.transaction(async (transaction) => {
        if (item.userId) await lockCliDeviceLifecycle(transaction as unknown as Database, item.userId, item.deviceId);
        const [authorization] = await transaction.select({ id: cliDeviceAuthorizations.id, tokenId: cliDeviceAuthorizations.tokenId })
          .from(cliDeviceAuthorizations).where(and(
            eq(cliDeviceAuthorizations.id, item.id), lte(cliDeviceAuthorizations.expiresAt, now),
            inArray(cliDeviceAuthorizations.status, ["pending", "approved", "exchanged", "rotating"]),
          )).for("update");
        if (!authorization) return;
        if (authorization.tokenId) await transaction.update(apiTokens).set({ revokedAt: now })
          .where(and(eq(apiTokens.id, authorization.tokenId), isNull(apiTokens.revokedAt)));
        await transaction.update(cliDeviceAuthorizations).set({ status: "expired" })
          .where(eq(cliDeviceAuthorizations.id, authorization.id));
        count++;
      });
    }
  }
  return count;
}

/** Enqueues one cleanup job per kind unless one is already open. Returns how many were added. */
export async function scheduleCleanupJobs(database: Database) {
  let added = 0;
  for (const type of [...cleanupJobTypes, ...(outboundWebhooksEnabled() ? ["cleanup_outbound_webhook_deliveries"] : [])]) if (await enqueueJob(database, { type, dedupeKey: type })) added++;
  return added;
}

const uuid = () => Type.String({ format: "uuid" });
const notificationOutput = Type.Object({
  id: Type.String(), kind: Type.Union((["mention", "assignment", "reply", "intake_accepted", "intake_rejected", "intake_duplicate", "run_confirmation", "run_skipped", "wake_skipped", "recurrence_paused", "auto_rule", "secret_output_blocked"] as const).map((kind) => Type.Literal(kind))), workItemId: Type.Union([Type.String(), Type.Null()]), runId: Type.Union([Type.String(), Type.Null()]), wikiPageId: Type.Union([Type.String(), Type.Null()]), pageTitle: Type.Union([Type.String(), Type.Null()]), projectId: Type.Union([Type.String(), Type.Null()]), recurrenceId: Type.Union([Type.String(), Type.Null()]), detail: Type.Union([Type.String(), Type.Null()]),
  displayId: Type.String(), projectKey: Type.Union([Type.String(), Type.Null()]), workItemTitle: Type.String(), commentId: Type.Union([Type.String(), Type.Null()]),
  intakeId: Type.Union([Type.String(), Type.Null()]), intakeOutcome: Type.Union([Type.String(), Type.Null()]),
  actorId: Type.String(), actorName: Type.String(), readAt: Type.Union([Type.String(), Type.Null()]), createdAt: Type.String(),
});

export function createNotificationActions(db: Database) {
  /** The caller's notifications in a workspace, minus those for work items in projects they can no longer see. */
  async function visibleRows(userId: string, workspaceId: string, unreadOnly: boolean) {
    await requireWorkspaceRole(db, userId, workspaceId, "read");
    const rows = await db.select({
      id: notifications.id, kind: notifications.kind, workItemId: notifications.workItemId, runId: notifications.runId, wikiPageId: notifications.wikiPageId, recurrenceId: notifications.recurrenceId, detail: notifications.detail,
      projectId: workItems.projectId, runProjectId: runs.projectId, runWorkspaceId: runs.workspaceId, projectKey: projects.key, sequence: workItems.sequence, title: workItems.title, deletedAt: workItems.deletedAt,
      intakeId: intakeItems.id, intakeOutcome: intakeItems.outcome,
      recurrenceProjectId: recurrences.projectId,
      pageTitle: wikiPages.title, pageDeletedAt: wikiPages.deletedAt, pageAccess: wikiPages.access, pageOwnerId: wikiPages.ownerId, pageProjectId: wikiPages.projectId,
      commentId: notifications.commentId, actorId: notifications.actorId,
      actorName: users.name, readAt: notifications.readAt, createdAt: notifications.createdAt,
    }).from(notifications)
      .leftJoin(workItems, eq(workItems.id, notifications.workItemId)).leftJoin(intakeItems, eq(intakeItems.workItemId, workItems.id)).leftJoin(wikiPages, eq(wikiPages.id, notifications.wikiPageId)).leftJoin(recurrences, eq(recurrences.id, notifications.recurrenceId)).leftJoin(runs, eq(runs.id, notifications.runId))
      .leftJoin(projects, sql`${projects.id} = coalesce(${workItems.projectId}, ${wikiPages.projectId}, ${runs.projectId})`).innerJoin(users, eq(users.id, notifications.actorId))
      .where(and(eq(notifications.userId, userId), eq(notifications.workspaceId, workspaceId), ...(unreadOnly ? [isNull(notifications.readAt)] : [])))
      .orderBy(desc(notifications.createdAt), desc(notifications.id));
    const visibleProjects = new Map<string, boolean>();
    for (const projectId of new Set(rows.flatMap((row) => row.projectId ? [row.projectId] : row.recurrenceProjectId ? [row.recurrenceProjectId] : row.runId && row.runProjectId ? [row.runProjectId] : []))) {
      visibleProjects.set(projectId, await requireProjectAccess(db, userId, projectId, "read").then(() => true, () => false));
    }
    const visibleItems = new Map<string, boolean>();
    for (const row of rows) if (row.workItemId && row.projectId && !visibleItems.has(row.workItemId)) {
      visibleItems.set(row.workItemId, await canViewNotificationItem(db, userId, row.workItemId, row.projectId));
    }
    const visiblePages = new Map<string, boolean>();
    for (const row of rows) if (row.wikiPageId) {
      const [share] = row.pageAccess === "private" && row.pageOwnerId !== userId && !row.pageProjectId
        ? await db.select({ userId: wikiPageShares.userId }).from(wikiPageShares).where(and(eq(wikiPageShares.pageId, row.wikiPageId), eq(wikiPageShares.userId, userId)))
        : [];
      if (row.pageDeletedAt || (row.pageAccess === "private" && row.pageOwnerId !== userId && !share)) visiblePages.set(row.wikiPageId, false);
      else if (!row.pageProjectId) visiblePages.set(row.wikiPageId, true);
      else {
        const [member] = await db.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, row.pageProjectId), eq(projectMembers.userId, userId)));
        visiblePages.set(row.wikiPageId, Boolean(member));
      }
    }
    return rows.filter((row) => row.kind === "secret_output_blocked" ? true : row.recurrenceId !== null ? visibleProjects.get(row.recurrenceProjectId!) : (row.workItemId
      ? row.deletedAt === null && visibleItems.get(row.workItemId)
      : row.wikiPageId ? visiblePages.get(row.wikiPageId) : row.runId ? Boolean(row.runProjectId && visibleProjects.get(row.runProjectId)) : false));
  }

  async function requireVisibleNotification(userId: string, notificationId: string) {
    const [row] = await db.select({ workspaceId: notifications.workspaceId }).from(notifications)
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId))).limit(1);
    if (!row || !(await visibleRows(userId, row.workspaceId, false)).some((notification) => notification.id === notificationId)) {
      throw new ActionError("Notification not found", 404);
    }
    return row.workspaceId;
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
            id: row.id, kind: row.kind as NotificationKind, workItemId: row.workItemId, runId: row.runId, wikiPageId: row.wikiPageId, pageTitle: row.pageTitle,
            projectId: row.projectId ?? row.pageProjectId ?? row.recurrenceProjectId ?? row.runProjectId, projectKey: row.projectKey, recurrenceId: row.recurrenceId, detail: row.detail, displayId: row.projectKey && row.sequence ? `${row.projectKey}-${row.sequence}` : "",
            workItemTitle: row.title ?? "", commentId: row.commentId, intakeId: row.intakeId, intakeOutcome: row.intakeOutcome, actorId: row.actorId, actorName: row.actorName,
            readAt: row.readAt ? row.readAt.toISOString() : null, createdAt: row.createdAt.toISOString(),
          })),
        };
      },
    },
    markNotificationRead: {
      name: "mark_notification_read", kind: "write" as const,
      input: Type.Object({ notificationId: uuid() }), output: Type.Object({ marked: Type.Boolean() }),
      handler: async (context: { userId: string }, input: { notificationId: string }) => {
        const workspaceId = await requireVisibleNotification(context.userId, input.notificationId);
        const updated = await db.update(notifications).set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
          .where(and(eq(notifications.id, input.notificationId), eq(notifications.userId, context.userId))).returning({ id: notifications.id });
        if (updated.length === 0) throw new ActionError("Notification not found", 404);
        await publishSignal(db, { type: "notification", workspaceId, userId: context.userId });
        return { marked: true };
      },
    },
    markNotificationUnread: {
      name: "mark_notification_unread", kind: "write" as const,
      input: Type.Object({ notificationId: uuid() }), output: Type.Object({ marked: Type.Boolean() }),
      handler: async (context: { userId: string }, input: { notificationId: string }) => {
        const workspaceId = await requireVisibleNotification(context.userId, input.notificationId);
        const updated = await db.update(notifications).set({ readAt: null })
          .where(and(eq(notifications.id, input.notificationId), eq(notifications.userId, context.userId))).returning({ id: notifications.id });
        if (updated.length === 0) throw new ActionError("Notification not found", 404);
        await publishSignal(db, { type: "notification", workspaceId, userId: context.userId });
        return { marked: true };
      },
    },
    markAllNotificationsRead: {
      name: "mark_all_notifications_read", kind: "write" as const,
      input: Type.Object({ workspaceId: uuid() }), output: Type.Object({ marked: Type.Integer() }),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const visible = await visibleRows(context.userId, input.workspaceId, false);
        const visibleIds = visible.map((row) => row.id);
        if (visibleIds.length === 0) return { marked: 0 };
        const updated = await db.update(notifications).set({ readAt: new Date() })
          .where(and(eq(notifications.userId, context.userId), eq(notifications.workspaceId, input.workspaceId), inArray(notifications.id, visibleIds), isNull(notifications.readAt))).returning({ id: notifications.id });
        await publishSignal(db, { type: "notification", workspaceId: input.workspaceId, userId: context.userId });
        return { marked: updated.length };
      },
    },
  };
}
