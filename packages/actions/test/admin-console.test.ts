import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accounts, activities, agents, apiTokens, createDatabase, daemons, oauthAccessToken, oauthClient, runs, runtimes, sessions, users, workspaceMembers, workspaces, type Database } from "@weft/db";
import { ActionError, createAdminConsoleActions, createAgentActions, createMemberActions, createProjectActions, createRuntimeDispatchActions, createWorkItemActions, requireWorkspaceRole } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** A workspace with an Admin, a Member who owns a Daemon Runtime, and an Agent that the Member's item wakes. */
async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const agentActions = createAgentActions(transaction);
  const agent = await agentActions.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", instructions: "Be brief.", model: "default" });
  await agentActions.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const work = createWorkItemActions(transaction);
  const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Fix the login" });
  await work.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
  const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
  return { workspace, admin, member, project, agent, work, run: run!, console: createAdminConsoleActions(transaction) };
}

/** A Daemon owned by `owner` offering one Runtime in the workspace, which the Agent uses. */
async function attachDaemon(transaction: Database, workspaceId: string, ownerId: string, agentId: string) {
  const [token] = await transaction.insert(apiTokens).values({ userId: ownerId, name: "Daemon", tokenHash: crypto.randomUUID(), tokenPrefix: "weft_daemon", daemonOnly: true, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
  const [daemon] = await transaction.insert(daemons).values({ ownerId, tokenId: token!.id, hostname: "laptop", version: "1.0.0" }).returning();
  const [runtime] = await transaction.insert(runtimes).values({ workspaceId, daemonId: daemon!.id, ownerId, agentCli: "claude", shared: true, lastSeenAt: new Date() }).returning();
  await transaction.update(agents).set({ runtimeId: runtime!.id }).where(eq(agents.id, agentId));
  return { daemonId: daemon!.id, runtimeId: runtime!.id };
}

test.concurrent("suspending a member refuses their work in the workspace and cancels the Runs they started", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.console.suspendMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id });
    await expect(requireWorkspaceRole(transaction, s.member.id, s.workspace.id, "read")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("suspended") });
    const [row] = await transaction.select().from(runs).where(eq(runs.id, s.run.id));
    expect(row).toMatchObject({ status: "cancelled" });
    const members = await createMemberActions(transaction).listMembers.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id });
    expect(members.map((member) => member.userId)).toContain(s.member.id);
  });
}, 30_000);

test.concurrent("a suspended owner's Daemon gets no new work, and Runtime work already started is asked to stop", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { daemonId } = await attachDaemon(transaction, s.workspace.id, s.member.id, s.agent.id);
    const dispatch = createRuntimeDispatchActions(transaction);
    const claimed = await dispatch.claimRuns({ userId: s.member.id, daemonId }, 5);
    expect(claimed.map((run) => run.runId)).toEqual([s.run.id]);
    expect(await dispatch.authenticateRunToken("weft_run_unknown")).toBeNull();

    await s.console.suspendMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id });
    const [row] = await transaction.select().from(runs).where(eq(runs.id, s.run.id));
    expect(row?.status).toBe("cancelled");
    expect(await dispatch.claimRuns({ userId: s.member.id, daemonId }, 5)).toEqual([]);
  });
}, 30_000);

test.concurrent("reactivating a member restores their membership and the work they may do", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.console.suspendMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id });
    await s.console.reactivateMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id });
    expect((await requireWorkspaceRole(transaction, s.member.id, s.workspace.id, "write"))).toBe("Member");
  });
}, 30_000);

test.concurrent("the last working Admin cannot be suspended, demoted, or removed; nobody suspends themselves", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const members = createMemberActions(transaction);
    await expect(s.console.suspendMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.admin.id })).rejects.toMatchObject({ status: 400 });
    // A second Admin may be suspended while the first still works.
    const second = await createMemberFactory(transaction, s.workspace.id, "Admin");
    await s.console.suspendMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: second.id });
    // The first Admin is now the only working one: demoting, removing or suspending them is refused.
    await expect(members.changeMemberRole.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.admin.id, role: "Member" })).rejects.toMatchObject({ status: 400 });
    await expect(members.removeMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.admin.id })).rejects.toMatchObject({ status: 400 });
    // A suspended Admin no longer counts, so a suspended Admin cannot take the working Admin's place.
    await expect(s.console.suspendMember.handler({ userId: second.id }, { workspaceId: s.workspace.id, userId: s.admin.id })).rejects.toMatchObject({ status: 403 });
  });
}, 30_000);

test.concurrent("a Member cannot use any admin console action, and an Admin of another workspace cannot reach this one", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await createWorkspaceFactory(transaction);
    const otherAdmin = await createMemberFactory(transaction, other.id, "Admin");
    const denied = { status: 403 };
    await expect(s.console.listMemberAccounts.handler({ userId: s.member.id }, { workspaceId: s.workspace.id })).rejects.toMatchObject(denied);
    await expect(s.console.listAuditLog.handler({ userId: s.member.id }, { workspaceId: s.workspace.id })).rejects.toMatchObject(denied);
    await expect(s.console.suspendMember.handler({ userId: s.member.id }, { workspaceId: s.workspace.id, userId: s.admin.id })).rejects.toMatchObject(denied);
    await expect(s.console.forcePasswordReset.handler({ userId: otherAdmin.id }, { workspaceId: s.workspace.id, userId: s.member.id })).rejects.toMatchObject(denied);
    await expect(s.console.exportAuditLog.handler({ userId: otherAdmin.id }, { workspaceId: s.workspace.id })).rejects.toMatchObject(denied);
  });
}, 30_000);

test.concurrent("the audit log filters by person, kind and date, exports CSV, and guards formulas", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    // A name that spreadsheets would run as a formula, to prove the export escapes it.
    await transaction.update(users).set({ name: "=HYPERLINK(\"x\")" }).where(eq(users.id, s.admin.id));
    await s.console.suspendMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id });
    await s.console.reactivateMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id });
    const memberRow = await createMemberFactory(transaction, s.workspace.id, "Member");
    await createMemberActions(transaction).changeMemberRole.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: memberRow.id, role: "Guest" });

    const all = await s.console.listAuditLog.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, kind: "member" });
    expect(all.rows.map((row) => row.field)).toEqual(expect.arrayContaining(["suspended", "reactivated", "role"]));
    expect(all.rows.every((row) => row.kind === "member")).toBe(true);

    const byPerson = await s.console.listAuditLog.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, actorId: s.admin.id, kind: "member" });
    expect(byPerson.rows.length).toBe(all.rows.length);
    const byOther = await s.console.listAuditLog.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, actorId: s.member.id });
    expect(byOther.rows).toHaveLength(0);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000 * 2).toISOString();
    expect((await s.console.listAuditLog.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, from: future })).rows).toHaveLength(0);
    expect((await s.console.listAuditLog.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, from: past, to: future, kind: "member" })).rows.length).toBe(all.rows.length);
    await expect(s.console.listAuditLog.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, from: "not a date" })).rejects.toBeInstanceOf(ActionError);

    const exported = await s.console.exportAuditLog.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, kind: "member" });
    const [header, ...lines] = exported.csv.trim().split("\r\n");
    expect(header).toBe("time,person,kind,change,target,before,after");
    expect(exported.rows).toBe(lines.length);
    expect(exported.truncated).toBe(false);
    // The formula-looking name is written as text, never as a live formula.
    expect(lines.some((line) => line.includes("'=HYPERLINK"))).toBe(true);
    expect(lines.some((line) => line.startsWith("=") || line.includes(",=HYPERLINK"))).toBe(false);
  });
}, 30_000);

test.concurrent("the audit log has no action that edits or deletes its rows", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const names = Object.values(s.console).map((action) => action.name);
    expect(names.filter((name) => /audit|activit/.test(name)).every((name) => name.startsWith("list_") || name.startsWith("export_"))).toBe(true);
  });
});

test.concurrent("signing out a member from the console removes their sessions and only Admins can do it", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const result = await s.console.signOutMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id, reason: "Lost phone" });
    expect(result).toEqual({ userId: s.member.id, signedOut: 0 });
    const [person] = await transaction.select({ notice: users.securityNotice }).from(users).where(eq(users.id, s.member.id));
    expect(person?.notice).toBe("notice:signed_out\nLost phone");
    await expect(s.console.signOutMember.handler({ userId: s.member.id }, { workspaceId: s.workspace.id, userId: s.admin.id })).rejects.toMatchObject({ status: 403 });
    const [membership] = await transaction.select({ role: workspaceMembers.role }).from(workspaceMembers).where(eq(workspaceMembers.userId, s.member.id));
    expect(membership?.role).toBe("Member");
  });
}, 30_000);

/** A second workspace the Member also belongs to, administered by somebody else. */
async function otherWorkspace(transaction: Database, memberId: string) {
  const other = await createWorkspaceFactory(transaction);
  const otherAdmin = await createMemberFactory(transaction, other.id, "Admin");
  await transaction.insert(workspaceMembers).values({ workspaceId: other.id, userId: memberId, role: "Member" });
  return { other, otherAdmin };
}

async function giveSession(transaction: Database, userId: string) {
  await transaction.insert(sessions).values({ id: crypto.randomUUID(), token: crypto.randomUUID(), userId, expiresAt: new Date(Date.now() + 86_400_000) });
}

async function givePassword(transaction: Database, userId: string) {
  await transaction.insert(accounts).values({ id: crypto.randomUUID(), accountId: userId, providerId: "credential", userId, password: "hash" });
}

test.concurrent("an Admin cannot sign out, force a reset for, or read and revoke tokens of a person who also belongs to a workspace the Admin does not administer", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await givePassword(transaction, s.member.id);
    await giveSession(transaction, s.member.id);
    const [token] = await transaction.insert(apiTokens).values({ userId: s.member.id, name: "Mine", tokenHash: crypto.randomUUID(), tokenPrefix: "weft_abc" }).returning();
    const { other, otherAdmin } = await otherWorkspace(transaction, s.member.id);
    const input = { workspaceId: s.workspace.id, userId: s.member.id };
    await expect(s.console.signOutMember.handler({ userId: s.admin.id }, input)).rejects.toMatchObject({ status: 403, message: expect.stringContaining("another workspace") });
    await expect(s.console.forcePasswordReset.handler({ userId: s.admin.id }, input)).rejects.toMatchObject({ status: 403 });
    await expect(s.console.cancelForcedPasswordReset.handler({ userId: s.admin.id }, input)).rejects.toMatchObject({ status: 403 });
    await expect(s.console.listMemberApiTokens.handler({ userId: s.admin.id }, input)).rejects.toMatchObject({ status: 403 });
    await expect(s.console.revokeMemberApiToken.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id, tokenId: token!.id })).rejects.toMatchObject({ status: 403 });
    expect(await transaction.select().from(sessions).where(eq(sessions.userId, s.member.id))).toHaveLength(1);
    const [row] = await transaction.select({ flag: users.forcePasswordReset }).from(users).where(eq(users.id, s.member.id));
    expect(row?.flag).toBe(false);
    const [unrevoked] = await transaction.select({ revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.id, token!.id));
    expect(unrevoked?.revokedAt).toBeNull();
    // The other workspace's Admin has the same limit from their side, and suspending still works for each workspace's own Admin.
    await expect(s.console.signOutMember.handler({ userId: otherAdmin.id }, { workspaceId: other.id, userId: s.member.id })).rejects.toMatchObject({ status: 403 });
    // Once the same Admin also administers the other workspace, everything is allowed.
    await transaction.insert(workspaceMembers).values({ workspaceId: other.id, userId: s.admin.id, role: "Admin" });
    expect((await s.console.signOutMember.handler({ userId: s.admin.id }, input)).signedOut).toBe(1);
    expect((await s.console.listMemberApiTokens.handler({ userId: s.admin.id }, input)).map((row) => row.id)).toEqual([token!.id]);
    await s.console.revokeMemberApiToken.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id, tokenId: token!.id });
  });
}, 30_000);

test.concurrent("an Admin cannot revoke another member's token through the wrong member identity", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await createMemberFactory(transaction, s.workspace.id, "Guest");
    const [token] = await transaction.insert(apiTokens).values({ userId: other.id, name: "Other's token", tokenHash: crypto.randomUUID(), tokenPrefix: "weft_other" }).returning();
    await expect(s.console.revokeMemberApiToken.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id, tokenId: token!.id })).rejects.toMatchObject({ status: 404 });
    const [unchanged] = await transaction.select({ revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.id, token!.id));
    expect(unchanged?.revokedAt).toBeNull();
  });
}, 30_000);

test.concurrent("last active shows account-wide signals only for people this Admin administers everywhere, and this workspace's changes for everyone", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await giveSession(transaction, s.member.id);
    const lastActive = async () => (await s.console.listMemberAccounts.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id })).find((row) => row.userId === s.member.id)!.lastActiveAt;
    expect(await lastActive()).not.toBeNull();
    await otherWorkspace(transaction, s.member.id);
    // The member's own changes in this workspace (the work item in setup) still show; the session no longer counts.
    const [change] = await transaction.select({ at: activities.createdAt }).from(activities).where(eq(activities.actorId, s.member.id)).orderBy(activities.createdAt).limit(1);
    const shown = await lastActive();
    expect(new Date(shown!).getTime()).toBeLessThanOrEqual(Date.now());
    await transaction.delete(activities).where(eq(activities.actorId, s.member.id));
    expect(change).toBeDefined();
    expect(await lastActive()).toBeNull();
  });
}, 30_000);

test.concurrent("signing out a member also ends their connected apps, like a forced reset", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const clientId = crypto.randomUUID();
    await transaction.insert(oauthClient).values({ id: clientId, clientId, name: "App", redirectUris: [], createdAt: new Date() });
    await transaction.insert(oauthAccessToken).values({ id: crypto.randomUUID(), clientId, userId: s.member.id, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), scopes: [] });
    await s.console.signOutMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.member.id });
    const rows = await transaction.select({ revoked: oauthAccessToken.revoked }).from(oauthAccessToken).where(eq(oauthAccessToken.userId, s.member.id));
    expect(rows.map((row) => row.revoked !== null)).toEqual([true]);
  });
}, 30_000);

test.concurrent("a forced reset is refused for a person with no Weft password and when password sign-in is off; a cancel clears it and is audited", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const input = { workspaceId: s.workspace.id, userId: s.member.id };
    // A Microsoft-only person has no credential account.
    await transaction.insert(accounts).values({ id: crypto.randomUUID(), accountId: "ms-1", providerId: "microsoft-entra-id", userId: s.member.id });
    await expect(s.console.forcePasswordReset.handler({ userId: s.admin.id }, input)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Microsoft") });
    const [untouched] = await transaction.select({ flag: users.forcePasswordReset }).from(users).where(eq(users.id, s.member.id));
    expect(untouched?.flag).toBe(false);

    await givePassword(transaction, s.member.id);
    const off = createAdminConsoleActions(transaction, undefined, { passwordSignInEnabled: false });
    await expect(off.forcePasswordReset.handler({ userId: s.admin.id }, input)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("turned off") });

    await s.console.forcePasswordReset.handler({ userId: s.admin.id }, input);
    const [forced] = await transaction.select({ flag: users.forcePasswordReset }).from(users).where(eq(users.id, s.member.id));
    expect(forced?.flag).toBe(true);
    await expect(s.console.cancelForcedPasswordReset.handler({ userId: s.member.id }, { workspaceId: s.workspace.id, userId: s.admin.id })).rejects.toMatchObject({ status: 403 });
    expect(await s.console.cancelForcedPasswordReset.handler({ userId: s.admin.id }, { ...input, reason: "Asked by mistake" })).toEqual({ userId: s.member.id, cancelled: true });
    const [cleared] = await transaction.select({ flag: users.forcePasswordReset, notice: users.securityNotice }).from(users).where(eq(users.id, s.member.id));
    expect(cleared).toEqual({ flag: false, notice: null });
    const audit = await s.console.listAuditLog.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, kind: "member" });
    expect(audit.rows.map((row) => row.field)).toContain("password_reset_cancelled");
    expect(await s.console.cancelForcedPasswordReset.handler({ userId: s.admin.id }, input)).toEqual({ userId: s.member.id, cancelled: false });
  });
}, 30_000);
