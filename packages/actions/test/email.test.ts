import { afterAll, expect, spyOn, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { createDatabase, notificationEmails, notifications, projectMembers, users, workspaceMembers, type Database } from "@weft/db";
import {
  createAgentActions, createCommentActions, createEmailPreferenceActions, createJobHandlers, createProjectActions, createSmtpMailer,
  createWikiActions, createWorkItemActions, MailDeliveryError, mailSettingsFromEnv, purgeNotificationEmails, queueRunResultEmail, runNextJob, sendNotificationDigests,
  type Mailer,
} from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { startSmtpSink, type SmtpSink } from "./smtp-sink";

const { client, db } = createDatabase();
const sinks: SmtpSink[] = [];
// Tests run concurrently and share nothing but the database, so sinks close only when the file is done.
afterAll(() => { for (const sink of sinks.splice(0)) sink.close(); });
afterAll(async () => client.end());

const doc = (...parts: Array<string | { mention: string }>) => ({
  type: "doc",
  content: [{ type: "paragraph", content: parts.map((part) => typeof part === "string" ? { type: "text", text: part } : { type: "mention", attrs: { id: part.mention, label: "x" } }) }],
});

/** Starts a local SMTP sink and a mailer that delivers to it, the same path production uses. */
function smtp() {
  const sink = startSmtpSink();
  sinks.push(sink);
  const mailer = createSmtpMailer({ host: "127.0.0.1", port: sink.port, secure: false, from: "Weft <noreply@weft.test>" });
  return { sink, mailer };
}

/** Queued rows that have not been sent yet. Sent rows stay until the retention purge, so checks look at these. */
function pendingEmails(transaction: Database, userId: string) {
  return transaction.select().from(notificationEmails).where(and(eq(notificationEmails.userId, userId), isNull(notificationEmails.sentAt)));
}

async function drain(transaction: Database) {
  const handlers = createJobHandlers();
  while ((await runNextJob(transaction, handlers)).status !== "idle");
}

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction, { slug: `mail-${crypto.randomUUID().slice(0, 8)}` });
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const author = await createMemberFactory(transaction, workspace.id, "Member");
  const other = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  for (const user of [author, other]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: "Member" });
  const items = createWorkItemActions(transaction);
  const item = await items.createWorkItem.handler({ userId: author.id }, { projectId: project.id, title: "Login page" });
  return { workspace, admin, author, other, project, items, item, comments: createCommentActions(transaction), prefs: createEmailPreferenceActions(transaction) };
}

test("email is off unless SMTP_HOST and SMTP_FROM are set", () => {
  expect(mailSettingsFromEnv({})).toBeNull();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(mailSettingsFromEnv({ SMTP_HOST: "smtp.example.test" })).toBeNull();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
  }
  expect(mailSettingsFromEnv({ SMTP_HOST: "smtp.example.test", SMTP_FROM: "Weft <noreply@example.test>" })).toEqual({ host: "smtp.example.test", port: 587, secure: false, from: "Weft <noreply@example.test>" });
  expect(mailSettingsFromEnv({ SMTP_HOST: "smtp.example.test", SMTP_FROM: "f", SMTP_SECURE: "true", SMTP_USERNAME: "u", SMTP_PASSWORD: "p" })).toEqual({ host: "smtp.example.test", port: 465, secure: true, from: "f", username: "u", password: "p" });
  const invalidPort = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(mailSettingsFromEnv({ SMTP_HOST: "h", SMTP_FROM: "f", SMTP_PORT: "70000" })).toBeNull();
  } finally {
    invalidPort.mockRestore();
  }
});

test.concurrent("a mention is emailed once as a digest, in the recipient's language, with the item link and no comment text", async () => {
  await withRollback(db, async (transaction) => {
    const { sink, mailer } = smtp();
    const { workspace, author, other, item, comments } = await setup(transaction);
    await transaction.update(users).set({ locale: "th" }).where(eq(users.id, other.id));
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc("secret wording ", { mention: other.id }) });
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }, " again") });
    await drain(transaction);

    expect((await sendNotificationDigests(transaction, { mailer, webOrigin: "https://weft.test", defaultLocale: null })).sent).toBe(1);
    const [message] = await sink.waitFor(1);
    expect(message!.to).toEqual([other.email]);
    expect(message!.subject).toBe("มีการแจ้งเตือนใหม่ 2 รายการใน Weft");
    expect(message!.text).toContain("MOB-1 Login page");
    expect(message!.text).toContain(`https://weft.test/${workspace.slug}/browse/MOB-1`);
    expect(message!.text).toContain("/account/notifications");
    expect(message!.text).not.toContain("secret wording");

    // Nothing left to send: the next digest run is silent.
    await sendNotificationDigests(transaction, { mailer, webOrigin: "https://weft.test", defaultLocale: null });
    expect(sink.messages).toHaveLength(1);
  });
});

test.concurrent("turning kinds off stops their emails, including ones already queued, and turning everything off stops all", async () => {
  await withRollback(db, async (transaction) => {
    const { mailer, sink } = smtp();
    const { other, author, item, comments, prefs } = await setup(transaction);
    expect(await prefs.getMyEmailPreferences.handler({ userId: other.id }, {})).toEqual({ email: other.email, emailVerified: false, kinds: ["assignment", "mention", "reply", "run_result"] });

    // Off before the event: nothing is queued at all.
    await prefs.setMyEmailPreferences.handler({ userId: other.id }, { kinds: [] });
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);
    expect(await pendingEmails(transaction, other.id)).toHaveLength(0);

    // Mention queued, then only "reply" wanted: the queued mention is dropped without sending.
    await prefs.setMyEmailPreferences.handler({ userId: other.id }, { kinds: ["assignment", "mention"] });
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);
    await prefs.setMyEmailPreferences.handler({ userId: other.id }, { kinds: ["reply"] });
    await sendNotificationDigests(transaction, { mailer, webOrigin: "https://weft.test", defaultLocale: null });
    expect(sink.messages).toHaveLength(0);
    expect(await pendingEmails(transaction, other.id)).toHaveLength(0);

    // Everything off after a mention was queued: still nothing is sent.
    await prefs.setMyEmailPreferences.handler({ userId: other.id }, { kinds: ["mention"] });
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);
    await prefs.setMyEmailPreferences.handler({ userId: other.id }, { kinds: [] });
    await sendNotificationDigests(transaction, { mailer, webOrigin: "https://weft.test", defaultLocale: null });
    expect(sink.messages).toHaveLength(0);
  });
});

test.concurrent("a failed send keeps the queued email for the next digest, and logs only the failure class", async () => {
  await withRollback(db, async (transaction) => {
    const { sink, mailer: working } = smtp();
    const { author, other, item, comments } = await setup(transaction);
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);

    const refusing: Mailer = { send: async () => { throw new MailDeliveryError("ECONNREFUSED"); } };
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await sendNotificationDigests(transaction, { mailer: refusing, webOrigin: "https://weft.test", defaultLocale: null })).sent).toBe(0);
      expect(errors).toHaveBeenCalledWith("Email digest not sent: ECONNREFUSED");
      expect(JSON.stringify(errors.mock.calls)).not.toContain(other.email);
    } finally {
      errors.mockRestore();
    }
    expect(await pendingEmails(transaction, other.id)).toHaveLength(1);

    expect((await sendNotificationDigests(transaction, { mailer: working, webOrigin: "https://weft.test", defaultLocale: null })).sent).toBe(1);
    expect((await sink.waitFor(1))[0]!.subject).toBe("1 new notification in Weft");
  });
});

test.concurrent("a removed workspace member and a deleted item get no email about them", async () => {
  await withRollback(db, async (transaction) => {
    const { mailer, sink } = smtp();
    const { workspace, author, other, item, comments } = await setup(transaction);
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);
    await transaction.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, other.id)));
    await sendNotificationDigests(transaction, { mailer, webOrigin: "https://weft.test", defaultLocale: null });
    expect(sink.messages).toHaveLength(0);
    expect(await pendingEmails(transaction, other.id)).toHaveLength(0);
  });
});

test.concurrent("a suspended member gets no notification and no email, and a wiki page they may not read is dropped from a queued digest", async () => {
  await withRollback(db, async (transaction) => {
    const { mailer, sink } = smtp();
    const { workspace, author, other, item, comments } = await setup(transaction);
    // A private page of the author's that was never shared with the colleague: a stale queued row must not leak its title.
    const page = await createWikiActions(transaction).createWikiPage.handler({ userId: author.id }, { workspaceId: workspace.id, title: "Private plans", access: "private" });
    await transaction.insert(notificationEmails).values({ workspaceId: workspace.id, userId: other.id, actorId: author.id, kind: "mention", wikiPageId: page.id });
    await sendNotificationDigests(transaction, { mailer, webOrigin: "https://weft.test", defaultLocale: null });
    expect(sink.messages).toHaveLength(0);

    await transaction.update(workspaceMembers).set({ suspendedAt: new Date() }).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, other.id)));
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);
    expect(await transaction.select().from(notifications).where(eq(notifications.userId, other.id))).toHaveLength(0);
    expect(await pendingEmails(transaction, other.id)).toHaveLength(0);
    // Already queued before the suspension: still not sent.
    await transaction.insert(notificationEmails).values({ workspaceId: workspace.id, userId: other.id, actorId: author.id, kind: "mention", workItemId: item.id });
    await sendNotificationDigests(transaction, { mailer, webOrigin: "https://weft.test", defaultLocale: null });
    expect(sink.messages).toHaveLength(0);
  });
});

test.concurrent("a direct wiki page share authorizes the digest without project membership", async () => {
  await withRollback(db, async (transaction) => {
    const { mailer, sink } = smtp();
    const { workspace, author, other, project } = await setup(transaction);
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: author.id }, { workspaceId: workspace.id, title: "Shared roadmap" });
    await wiki.shareWikiPage.handler({ userId: author.id }, { pageId: page.id, userId: other.id, role: "view" });
    await transaction.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, other.id)));
    await transaction.insert(notificationEmails).values({ workspaceId: workspace.id, userId: other.id, actorId: author.id, kind: "mention", wikiPageId: page.id });
    await sendNotificationDigests(transaction, { mailer, webOrigin: "https://weft.test", defaultLocale: null });
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]!.text).toContain("Shared roadmap");
  });
});

test.concurrent("a Run result is emailed to the person who started it; a failure that will be retried is not", async () => {
  await withRollback(db, async (transaction) => {
    const { sink, mailer } = smtp();
    const { workspace, admin, author, item } = await setup(transaction);
    const agent = await createAgentActions(transaction).createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Helper", instructions: "", model: "default" });
    const run = { workspaceId: workspace.id, originatorId: author.id, agentId: agent.id, workItemId: item.id };

    await queueRunResultEmail(transaction, { ...run, status: "failed", retrying: true });
    expect(await pendingEmails(transaction, author.id)).toHaveLength(0);

    await queueRunResultEmail(transaction, { ...run, status: "completed" });
    await sendNotificationDigests(transaction, { mailer, webOrigin: "https://weft.test", defaultLocale: null });
    const [message] = await sink.waitFor(1);
    expect(message!.to).toEqual([author.email]);
    expect(message!.text).toContain("The Agent finished its run on MOB-1 Login page");
  });
});

test.concurrent("queued email older than a week is purged even if it was never sent", async () => {
  await withRollback(db, async (transaction) => {
    const { author, other, item, comments } = await setup(transaction);
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);
    await purgeNotificationEmails(transaction, new Date(Date.now() + 1000));
    expect(await pendingEmails(transaction, other.id)).toHaveLength(1);
    await purgeNotificationEmails(transaction, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect(await pendingEmails(transaction, other.id)).toHaveLength(0);
  });
});
