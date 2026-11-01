import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, jobs, notifications, sessions, workspaceInvites, type Database } from "@weft/db";
import {
  createCommentActions, createJobHandlers, createNotificationActions, createProjectActions, createWorkItemActions,
  runNextJob, scheduleCleanupJobs,
} from "../src";
import { createMemberFactory, createUserFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const doc = (...parts: Array<string | { mention: string }>) => ({
  type: "doc",
  content: [{ type: "paragraph", content: parts.map((part) => typeof part === "string" ? { type: "text", text: part } : { type: "mention", attrs: { id: part.mention, label: "x" } }) }],
});

async function drain(transaction: Database) {
  const handlers = createJobHandlers();
  while ((await runNextJob(transaction, handlers)).status !== "idle");
}

async function setup(transaction: Database, visibility: "public" | "private" = "public") {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const author = await createMemberFactory(transaction, workspace.id, "Member");
  const other = await createMemberFactory(transaction, workspace.id, "Member");
  const third = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility });
  for (const user of [author, other, third]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: "Member" });
  const items = createWorkItemActions(transaction);
  const item = await items.createWorkItem.handler({ userId: author.id }, { projectId: project.id, title: "Item" });
  return { workspace, admin, author, other, third, project, items, item, comments: createCommentActions(transaction), inbox: createNotificationActions(transaction) };
}

test.concurrent("a mention notifies the mentioned member, not the author, and shows in their inbox", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, author, other, item, comments, inbox } = await setup(transaction);
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc("hi ", { mention: other.id }, " and me ", { mention: author.id }) });
    expect((await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id })).unreadCount).toBe(0);
    await drain(transaction);
    const list = await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id });
    expect(list.unreadCount).toBe(1);
    expect(list.notifications[0]).toMatchObject({ kind: "mention", workItemId: item.id, displayId: "MOB-1", workItemTitle: "Item", actorId: author.id, readAt: null });
    expect((await inbox.listNotifications.handler({ userId: author.id }, { workspaceId: workspace.id })).notifications).toHaveLength(0);
  });
});

test.concurrent("editing a comment notifies only newly added mentions", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, author, other, third, item, comments, inbox } = await setup(transaction);
    const comment = await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);
    await comments.updateComment.handler({ userId: author.id }, { commentId: comment.id, body: doc({ mention: other.id }, { mention: third.id }) });
    await drain(transaction);
    expect((await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id })).notifications).toHaveLength(1);
    expect((await inbox.listNotifications.handler({ userId: third.id }, { workspaceId: workspace.id })).notifications).toHaveLength(1);
  });
});

test.concurrent("assigning a member notifies them; self-assignment and unchanged assignees do not", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, author, other, third, project, items, item, inbox } = await setup(transaction);
    await items.updateWorkItem.handler({ userId: author.id }, { workItemId: item.id, assigneeIds: [author.id, other.id] });
    await drain(transaction);
    const forOther = await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id });
    expect(forOther.notifications).toHaveLength(1);
    expect(forOther.notifications[0]).toMatchObject({ kind: "assignment", actorId: author.id, displayId: "MOB-1" });
    expect((await inbox.listNotifications.handler({ userId: author.id }, { workspaceId: workspace.id })).notifications).toHaveLength(0);
    await items.updateWorkItem.handler({ userId: author.id }, { workItemId: item.id, assigneeIds: [author.id, other.id, third.id] });
    await drain(transaction);
    expect((await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id })).notifications).toHaveLength(1);
    expect((await inbox.listNotifications.handler({ userId: third.id }, { workspaceId: workspace.id })).notifications).toHaveLength(1);
    const created = await items.createWorkItem.handler({ userId: author.id }, { projectId: project.id, title: "Second", assigneeIds: [third.id] });
    await drain(transaction);
    const list = await inbox.listNotifications.handler({ userId: third.id }, { workspaceId: workspace.id });
    expect(list.notifications.map((n) => n.workItemId)).toContain(created.id);
  });
});

test.concurrent("a member marks one notification read, then all; others cannot touch it", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, author, other, third, item, comments, inbox } = await setup(transaction);
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);
    const list = await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id });
    expect(list.unreadCount).toBe(2);
    await expect(inbox.markNotificationRead.handler({ userId: third.id }, { notificationId: list.notifications[0]!.id })).rejects.toMatchObject({ status: 404 });
    await inbox.markNotificationRead.handler({ userId: other.id }, { notificationId: list.notifications[0]!.id });
    const afterOne = await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id });
    expect(afterOne.unreadCount).toBe(1);
    expect(afterOne.notifications.find((n) => n.id === list.notifications[0]!.id)!.readAt).not.toBeNull();
    expect((await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id, unreadOnly: true })).notifications).toHaveLength(1);
    await inbox.markAllNotificationsRead.handler({ userId: other.id }, { workspaceId: workspace.id });
    expect((await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id })).unreadCount).toBe(0);
  });
});

test.concurrent("a non-member cannot read a workspace inbox", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, inbox } = await setup(transaction);
    const stranger = await createUserFactory(transaction);
    await expect(inbox.listNotifications.handler({ userId: stranger.id }, { workspaceId: workspace.id })).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("running the fan-out job twice does not duplicate notifications", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, author, other, item, comments, inbox } = await setup(transaction);
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    const handlers = createJobHandlers();
    const [job] = await transaction.select().from(jobs).where(eq(jobs.type, "notify"));
    await handlers.notify!(transaction, job!.payload, { id: job!.id, type: "notify" });
    await handlers.notify!(transaction, job!.payload, { id: job!.id, type: "notify" });
    expect(await transaction.select().from(notifications).where(eq(notifications.userId, other.id))).toHaveLength(1);
    expect((await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id })).unreadCount).toBe(1);
  });
});

test.concurrent("a notification for a private project disappears once the member loses access", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, author, other, project, item, comments, inbox } = await setup(transaction, "private");
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc({ mention: other.id }) });
    await drain(transaction);
    expect((await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id })).notifications).toHaveLength(1);
    await createProjectActions(transaction).removeProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: other.id });
    const list = await inbox.listNotifications.handler({ userId: other.id }, { workspaceId: workspace.id });
    expect(list.notifications).toHaveLength(0);
    expect(list.unreadCount).toBe(0);
  });
});

test.concurrent("cleanup jobs remove expired invites and sessions only", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin } = await setup(transaction);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);
    const invite = (expiresAt: Date) => ({ workspaceId: workspace.id, tokenHash: crypto.randomUUID(), role: "Member", createdBy: admin.id, expiresAt });
    await transaction.insert(workspaceInvites).values([invite(past), invite(future)]);
    const session = (expiresAt: Date) => ({ id: crypto.randomUUID(), token: crypto.randomUUID(), userId: admin.id, expiresAt });
    await transaction.insert(sessions).values([session(past), session(future)]);
    expect(await scheduleCleanupJobs(transaction)).toBe(3);
    // Re-scheduling while the jobs are open adds nothing.
    expect(await scheduleCleanupJobs(transaction)).toBe(0);
    const handlers = createJobHandlers();
    let ran = 0;
    for (;;) { const result = await runNextJob(transaction, handlers); if (result.status === "idle") break; expect(result.status).toBe("succeeded"); ran++; }
    expect(ran).toBeGreaterThanOrEqual(3);
    expect((await transaction.select().from(workspaceInvites).where(eq(workspaceInvites.workspaceId, workspace.id))).map((row) => row.expiresAt.getTime())).toEqual([future.getTime()]);
    expect((await transaction.select().from(sessions).where(eq(sessions.userId, admin.id))).map((row) => row.expiresAt.getTime())).toEqual([future.getTime()]);
  });
});

test.concurrent("fan-out signals each notified member, and only those who got a notification", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, author, other, item, comments } = await setup(transaction);
    await comments.createComment.handler({ userId: author.id }, { workItemId: item.id, body: doc("hi ", { mention: other.id }) });
    const signals: Array<{ type: string; workspaceId: string; userId?: string }> = [];
    const handlers = createJobHandlers(async (_database, signal) => { signals.push(signal); });
    while ((await runNextJob(transaction, handlers)).status !== "idle");
    expect(signals).toEqual([{ type: "notification", workspaceId: workspace.id, userId: other.id }]);
  });
});
