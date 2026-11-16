import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { agents, notificationEmails, projectMembers, projects, users, wikiPages, workItems, workspaceMembers, workspaces, type Database } from "@weft/db";
import { requireProjectAccess } from "./projects";
import { requireWikiPageAccess } from "./wiki";
import { digestEmail, type DigestItem, type MailLocale } from "./email-templates";
import { MailDeliveryError, type Mailer } from "./mail";

/** The notification kinds that can be sent by email. Other kinds stay in the app only. */
export const emailNotificationKinds = ["assignment", "mention", "reply", "run_result"] as const;
export type EmailNotificationKind = (typeof emailNotificationKinds)[number];
export const defaultEmailNotificationKinds: EmailNotificationKind[] = [...emailNotificationKinds];

/** Rows older than this are dropped, sent or not: a digest that never went out is not worth sending late. */
const retentionMs = 7 * 24 * 60 * 60 * 1000;

const isEmailKind = (kind: string): kind is EmailNotificationKind => (emailNotificationKinds as readonly string[]).includes(kind);

interface QueuedNotification {
  userId: string;
  workspaceId: string;
  actorId: string;
  kind: string;
  workItemId: string | null;
  wikiPageId: string | null;
  commentId: string | null;
  jobId: string | null;
  detail?: string | null;
}

/** Queues email rows for recipients who chose this kind. Called after the in-app rows were written, inside the notify job's transaction. */
export async function queueNotificationEmails(database: Database, rows: QueuedNotification[]) {
  if (rows.length === 0) return;
  const recipients = await database.select({ id: users.id, isAgent: users.isAgent, kinds: users.emailNotificationKinds }).from(users)
    .where(inArray(users.id, [...new Set(rows.map((row) => row.userId))]));
  const wanted = new Map(recipients.map((user) => [user.id, user]));
  const queued = rows.filter((row) => {
    const user = wanted.get(row.userId);
    return Boolean(user && !user.isAgent && isEmailKind(row.kind) && user.kinds.includes(row.kind));
  });
  if (queued.length === 0) return;
  await database.insert(notificationEmails).values(queued.map((row) => ({
    workspaceId: row.workspaceId, userId: row.userId, actorId: row.actorId, kind: row.kind,
    workItemId: row.workItemId, wikiPageId: row.wikiPageId, commentId: row.commentId, detail: row.detail ?? null, jobId: row.jobId,
  }))).onConflictDoNothing();
}

/**
 * Queues the email for a Run's final result, for the person who started it. Only Runs on a work item get one.
 * A failure that is about to be retried automatically is not a result yet, so the caller passes `retrying` and nothing is queued.
 */
export async function queueRunResultEmail(database: Database, run: { workspaceId: string; originatorId: string; agentId: string | null; workItemId: string | null; status: "completed" | "failed"; retrying?: boolean }) {
  if (!run.workItemId || !run.agentId || run.retrying) return;
  const [agent] = await database.select({ userId: agents.userId }).from(agents).where(eq(agents.id, run.agentId));
  if (!agent) return;
  await queueNotificationEmails(database, [{
    userId: run.originatorId, workspaceId: run.workspaceId, actorId: agent.userId, kind: "run_result",
    workItemId: run.workItemId, wikiPageId: null, commentId: null, jobId: null, detail: run.status,
  }]);
}

export interface DigestOptions {
  mailer: Mailer;
  webOrigin: string;
  defaultLocale: MailLocale | null;
  now?: Date;
  /** How many people one digest run looks at; the rest wait for the next run. */
  maxUsers?: number;
}

/** Sends one email per person with everything waiting for them. Preferences and access are checked again at send time. */
export async function sendNotificationDigests(database: Database, options: DigestOptions): Promise<{ people: number; sent: number }> {
  const pending = await database.selectDistinct({ userId: notificationEmails.userId }).from(notificationEmails)
    .where(isNull(notificationEmails.sentAt)).limit(options.maxUsers ?? 50);
  let sent = 0;
  for (const { userId } of pending) {
    try {
      if (await sendUserDigest(database, userId, options)) sent += 1;
    } catch (error) {
      // Rows stay pending and the next run retries. Only the failure class is logged: never the address or the content.
      console.error(`Email digest not sent: ${error instanceof MailDeliveryError ? error.code : "unexpected error"}`);
    }
  }
  return { people: pending.length, sent };
}

async function sendUserDigest(database: Database, userId: string, options: DigestOptions): Promise<boolean> {
  const now = options.now ?? new Date();
  const [user] = await database.select({ id: users.id, email: users.email, locale: users.locale, isAgent: users.isAgent, kinds: users.emailNotificationKinds })
    .from(users).where(eq(users.id, userId));
  const rows = await database.select().from(notificationEmails)
    .where(and(eq(notificationEmails.userId, userId), isNull(notificationEmails.sentAt)))
    .orderBy(asc(notificationEmails.createdAt)).limit(100);
  const items: DigestItem[] = [];
  const settled: string[] = [];
  for (const row of rows) {
    settled.push(row.id);
    if (!user || user.isAgent || !user.kinds.includes(row.kind) || !isEmailKind(row.kind)) continue;
    const item = await resolveItem(database, userId, row, options.webOrigin);
    if (item) items.push(item);
  }
  let delivered = false;
  if (items.length > 0 && user) {
    const locale = (user.locale ?? options.defaultLocale ?? "en") as MailLocale;
    const message = digestEmail(locale, items, `${options.webOrigin}/account/notifications`);
    await options.mailer.send({ to: user.email, subject: message.subject, text: message.text });
    delivered = true;
  }
  if (settled.length > 0) await database.update(notificationEmails).set({ sentAt: now }).where(inArray(notificationEmails.id, settled));
  return delivered;
}

type PendingRow = typeof notificationEmails.$inferSelect;

/** Turns a queued row into a digest line, or null when the person may no longer see the item (or it was deleted). */
async function resolveItem(database: Database, userId: string, row: PendingRow, webOrigin: string): Promise<DigestItem | null> {
  const [member] = await database.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, row.workspaceId), eq(workspaceMembers.userId, userId), isNull(workspaceMembers.suspendedAt)));
  if (!member) return null;
  const [workspace] = await database.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, row.workspaceId));
  const [actor] = await database.select({ name: users.name }).from(users).where(eq(users.id, row.actorId));
  if (!workspace) return null;
  const slug = encodeURIComponent(workspace.slug);
  const actorName = actor?.name ?? null;
  const kind = row.kind as DigestItem["kind"];

  if (row.workItemId) {
    const [item] = await database.select({ projectId: workItems.projectId, key: projects.key, sequence: workItems.sequence, title: workItems.title, deletedAt: workItems.deletedAt })
      .from(workItems).innerJoin(projects, eq(projects.id, workItems.projectId)).where(eq(workItems.id, row.workItemId));
    if (!item || item.deletedAt) return null;
    try {
      await requireProjectAccess(database, userId, item.projectId, "read");
    } catch {
      return null;
    }
    const displayId = `${item.key}-${item.sequence}`;
    return {
      kind, actorName, target: `${displayId} ${item.title}`, status: row.detail ?? undefined,
      url: `${webOrigin}/${slug}/browse/${encodeURIComponent(displayId)}`,
    };
  }
  if (row.wikiPageId) {
    const [page] = await database.select({ title: wikiPages.title, projectId: wikiPages.projectId, deletedAt: wikiPages.deletedAt })
      .from(wikiPages).where(eq(wikiPages.id, row.wikiPageId));
    if (!page || page.deletedAt) return null;
    // The same check as opening the page: private pages, shares, collections and project membership all count.
    try {
      await requireWikiPageAccess(database, userId, row.wikiPageId, "read");
    } catch {
      return null;
    }
    if (page.projectId) {
      const [project] = await database.select({ key: projects.key }).from(projects).where(eq(projects.id, page.projectId));
      return { kind, actorName, target: page.title, url: `${webOrigin}/${slug}/projects/${encodeURIComponent(project?.key ?? "")}/pages/${row.wikiPageId}` };
    }
    return { kind, actorName, target: page.title, url: `${webOrigin}/${slug}/wiki/${row.wikiPageId}` };
  }
  return null;
}

/** Drops queued rows older than the retention window. Runs from the hourly cleanup. */
export async function purgeNotificationEmails(database: Database, now: Date = new Date()) {
  await database.delete(notificationEmails).where(lt(notificationEmails.createdAt, new Date(now.getTime() - retentionMs)));
}
