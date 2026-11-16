import { afterAll, expect, test } from "bun:test";
import { accounts, createDatabase, sessions, users, workspaceMembers, workspaces } from "@weft/db";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());


/**
 * Runs one test against the isolated test database directly. Sign-in and session lookups go through better-auth, which
 * misbehaves inside a rollback transaction, so these rows are committed. Each test deletes the workspaces and people it created,
 * so no row outlives it and the shared-table tests in other files still see an empty starting state.
 */
async function withRollback<T>(_db: unknown, callback: (transaction: typeof db, created: Created) => Promise<T>): Promise<T> {
  const created: Created = { userIds: [], workspaceIds: [] };
  try {
    return await callback(db, created);
  } finally {
    for (const id of created.workspaceIds) await db.delete(workspaces).where(eq(workspaces.id, id));
    for (const id of created.userIds) await db.delete(users).where(eq(users.id, id));
  }
}
type Created = { userIds: string[]; workspaceIds: string[] };

const password = "a-secure-password";

/** Drives the real HTTP app: sign-up, sign-in, and Action calls with a cookie or a bearer token. */
function harness(transaction: Parameters<typeof createApp>[1], created: Created, mail?: Parameters<typeof createApp>[8]) {
  const app = mail ? createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, mail) : createApp(undefined, transaction);
  const call = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  const get = (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }));
  const signUp = async (name: string) => {
    const email = `${crypto.randomUUID()}@example.test`;
    const response = await call("/api/auth/sign-up/email", { name, email, password });
    created.userIds.push((await response.clone().json() as { user: { id: string } }).user.id);
    return { id: (await response.json() as { user: { id: string } }).user.id, email, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
  };
  const signIn = async (email: string) => {
    const response = await call("/api/auth/sign-in/email", { email, password });
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { app, call, get, signUp, signIn };
}

/** A workspace with an Admin and a Member, the Member accepted through an invite like a real person. */
async function workspaceWithMember(h: ReturnType<typeof harness>, created: Created) {
  const admin = await h.signUp("Admin");
  const workspace = await (await h.call("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, { cookie: admin.cookie })).json() as { id: string };
  created.workspaceIds.push(workspace.id);
  const member = await h.signUp("Member");
  const invite = await (await h.call("/actions/create_invite", { workspaceId: workspace.id, role: "Member" }, { cookie: admin.cookie })).json() as { token: string };
  expect((await h.call("/actions/accept_invite", { token: invite.token }, { cookie: member.cookie })).status).toBe(200);
  return { admin, member, workspace };
}

test.concurrent("a suspended member is refused on web and CLI at once, and gets access back on reactivation", async () => {
  await withRollback(db, async (transaction, created) => {
    const h = harness(transaction, created);
    const { admin, member, workspace } = await workspaceWithMember(h, created);
    const token = await (await h.call("/actions/create_api_token", { name: "cli" }, { cookie: member.cookie })).json() as { token: string };
    const bearer = { authorization: `Bearer ${token.token}` };
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: member.cookie })).status).toBe(200);

    expect((await h.call("/actions/suspend_member", { workspaceId: workspace.id, userId: member.id }, { cookie: admin.cookie })).status).toBe(200);
    const webRefusal = await h.call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: member.cookie });
    expect(webRefusal.status).toBe(403);
    expect(await webRefusal.json()).toMatchObject({ error: expect.stringContaining("suspended") });
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, bearer)).status).toBe(403);

    expect((await h.call("/actions/reactivate_member", { workspaceId: workspace.id, userId: member.id }, { cookie: admin.cookie })).status).toBe(200);
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, bearer)).status).toBe(200);
  });
}, 30_000);

test.concurrent("a forced reset ends every session at once, and the person must choose a new password before any Action", async () => {
  await withRollback(db, async (transaction, created) => {
    const h = harness(transaction, created);
    const { admin, member, workspace } = await workspaceWithMember(h, created);
    const oldSession = await h.signIn(member.email);
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: oldSession })).status).toBe(200);

    const forced = await h.call("/actions/force_password_reset", { workspaceId: workspace.id, userId: member.id, reason: "Password shared in a chat" }, { cookie: admin.cookie });
    expect(forced.status).toBe(200);
    // The old session is dead immediately, not at its next refresh.
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: oldSession })).status).toBe(401);

    // Signing in again still works with the old password, but every route is closed until a new password is saved.
    const newSession = await h.signIn(member.email);
    const gated = await h.get("/api/me", { cookie: newSession });
    expect(gated.status).toBe(403);
    expect(await gated.json()).toMatchObject({ code: "PASSWORD_RESET_REQUIRED", notice: expect.stringContaining("Password shared in a chat") });
    const closed: Array<[string, Response]> = [
      ["list_projects", await h.call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: newSession })],
      ["acknowledge_security_notice", await h.call("/actions/acknowledge_security_notice", {}, { cookie: newSession })],
      ["list_my_sessions", await h.call("/actions/list_my_sessions", {}, { cookie: newSession })],
      ["get-session", await h.get("/api/auth/get-session", { cookie: newSession })],
      ["create_api_token", await h.call("/actions/create_api_token", { name: "blocked" }, { cookie: newSession })],
    ];
    for (const [, response] of closed) expect(response.status).toBe(403);
    expect(await closed[0]![1].json()).toMatchObject({ code: "PASSWORD_RESET_REQUIRED" });
    // A second sign-in of the same person is refused too.
    const bearerSource = await h.signIn(member.email);
    expect((await h.call("/actions/create_api_token", { name: "x" }, { cookie: bearerSource })).status).toBe(403);

    // The one reset route stays open; a wrong current password is refused and nothing changes.
    const wrongCurrent = await h.call("/api/account/change-password", { currentPassword: "not-the-password", newPassword: "a-brand-new-password" }, { cookie: newSession });
    expect(wrongCurrent.status).toBe(400);
    expect((await h.get("/api/me", { cookie: newSession })).status).toBe(403);
    const changed = await h.call("/api/account/change-password", { currentPassword: password, newPassword: "a-brand-new-password" }, { cookie: newSession });
    expect(changed.status).toBe(200);
    const after = changed.headers.get("set-cookie")!.split(";")[0]!;
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: after })).status).toBe(200);
    const meAfter = await (await h.get("/api/me", { cookie: after })).json() as { account: { forcePasswordReset: boolean; securityNotice: string | null } };
    expect(meAfter.account).toEqual({ forcePasswordReset: false, securityNotice: null });
  });
}, 30_000);

test.concurrent("a person whose reset is pending can still sign out, and the reset screen's sign-out ends the session", async () => {
  await withRollback(db, async (transaction, created) => {
    const h = harness(transaction, created);
    const { admin, member, workspace } = await workspaceWithMember(h, created);
    expect((await h.call("/actions/force_password_reset", { workspaceId: workspace.id, userId: member.id }, { cookie: admin.cookie })).status).toBe(200);
    const pending = await h.signIn(member.email);
    expect((await h.call("/api/auth/sign-out", {}, { cookie: pending })).status).toBe(200);
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: pending })).status).toBe(401);
  });
}, 30_000);

test.concurrent("sign out of every device from an Admin ends all sessions and leaves a notice for the next sign-in", async () => {
  await withRollback(db, async (transaction, created) => {
    const h = harness(transaction, created);
    const { admin, member, workspace } = await workspaceWithMember(h, created);
    const first = await h.signIn(member.email);
    const second = await h.signIn(member.email);
    const result = await (await h.call("/actions/sign_out_member", { workspaceId: workspace.id, userId: member.id, reason: "Lost laptop" }, { cookie: admin.cookie })).json() as { signedOut: number };
    expect(result.signedOut).toBeGreaterThanOrEqual(2);
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: first })).status).toBe(401);
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: second })).status).toBe(401);

    const again = await h.signIn(member.email);
    const me = await (await h.get("/api/me", { cookie: again })).json() as { account: { securityNotice: string | null } };
    expect(me.account.securityNotice).toContain("Lost laptop");
    expect((await h.call("/actions/acknowledge_security_notice", {}, { cookie: again })).status).toBe(200);
    const cleared = await (await h.get("/api/me", { cookie: again })).json() as { account: { securityNotice: string | null } };
    expect(cleared.account.securityNotice).toBeNull();
  });
}, 30_000);

test.concurrent("a person lists their own sessions with the current one marked, signs one out, and signs out everywhere", async () => {
  await withRollback(db, async (transaction, created) => {
    const h = harness(transaction, created);
    const person = await h.signUp("Device owner");
    const laptop = await h.signIn(person.email);
    const phone = await h.signIn(person.email);
    expect(phone).toContain("session_token");
    const listed = await (await h.call("/actions/list_my_sessions", {}, { cookie: laptop, "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15" })).json() as Array<{ id: string; device: string; current: boolean; lastSeenAt: string }>;
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed.filter((row) => row.current)).toHaveLength(1);
    expect(listed.every((row) => typeof row.device === "string" && row.lastSeenAt)).toBe(true);

    // The phone reports its own session id as current; the laptop revokes exactly that one.
    const phoneId = (await (await h.call("/actions/list_my_sessions", {}, { cookie: phone })).json() as Array<{ id: string; current: boolean }>).find((row) => row.current)!.id;
    expect((await h.call("/actions/revoke_my_session", { sessionId: phoneId }, { cookie: laptop })).status).toBe(200);
    // Checked on the rows as well as by status: the row is the thing a person relies on.
    const afterRevoke = (await transaction.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, person.id))).map((row) => row.id);
    expect(afterRevoke).not.toContain(phoneId);
    expect(afterRevoke.length).toBeGreaterThanOrEqual(1);
    expect((await h.call("/actions/sign_out_everywhere", {}, { cookie: laptop })).status).toBe(200);
    expect(await transaction.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, person.id))).toHaveLength(0);
  });
}, 30_000);

test.concurrent("session management is refused to API tokens, and an Admin token list is limited to the workspace", async () => {
  await withRollback(db, async (transaction, created) => {
    const h = harness(transaction, created);
    const { admin, member, workspace } = await workspaceWithMember(h, created);
    const token = await (await h.call("/actions/create_api_token", { name: "script" }, { cookie: member.cookie })).json() as { token: string; id: string };
    const bearer = { authorization: `Bearer ${token.token}` };
    expect((await h.call("/actions/list_my_sessions", {}, bearer)).status).toBe(403);
    expect((await h.call("/actions/sign_out_everywhere", {}, bearer)).status).toBe(403);

    const listed = await (await h.call("/actions/list_member_api_tokens", { workspaceId: workspace.id, userId: member.id }, { cookie: admin.cookie })).json() as Array<{ id: string; status: string }>;
    expect(listed).toContainEqual(expect.objectContaining({ id: token.id, status: "active" }));

    // A stranger's token is not visible to this workspace's Admin, even with the right ids.
    const stranger = await h.signUp("Stranger");
    const strangerToken = await (await h.call("/actions/create_api_token", { name: "theirs" }, { cookie: stranger.cookie })).json() as { id: string };
    expect((await h.call("/actions/revoke_member_api_token", { workspaceId: workspace.id, userId: member.id, tokenId: strangerToken.id }, { cookie: admin.cookie })).status).toBe(404);
    expect((await h.call("/actions/list_member_api_tokens", { workspaceId: workspace.id, userId: stranger.id }, { cookie: admin.cookie })).status).toBe(404);

    expect((await h.call("/actions/revoke_member_api_token", { workspaceId: workspace.id, userId: member.id, tokenId: token.id }, { cookie: admin.cookie })).status).toBe(200);
    expect((await h.call("/actions/list_projects", { workspaceId: workspace.id }, bearer)).status).toBe(401);
    const audit = await (await h.call("/actions/list_audit_log", { workspaceId: workspace.id, kind: "api_token" }, { cookie: admin.cookie })).json() as { rows: Array<{ field: string; oldValue: { tokenId: string } }> };
    expect(audit.rows.find((row) => row.field === "revoked")?.oldValue.tokenId).toBe(token.id);
  });
}, 30_000);

test.concurrent("members cannot reach the admin console over HTTP", async () => {
  await withRollback(db, async (transaction, created) => {
    const h = harness(transaction, created);
    const { member, workspace, admin } = await workspaceWithMember(h, created);
    for (const [action, body] of [
      ["list_member_accounts", { workspaceId: workspace.id }],
      ["list_audit_log", { workspaceId: workspace.id }],
      ["export_audit_log", { workspaceId: workspace.id }],
      ["suspend_member", { workspaceId: workspace.id, userId: admin.id }],
      ["force_password_reset", { workspaceId: workspace.id, userId: admin.id }],
    ] as const) {
      expect((await h.call(`/actions/${action}`, body, { cookie: member.cookie })).status).toBe(403);
    }
    // The refused calls changed nothing about the Admin.
    const [row] = await transaction.select({ suspendedAt: workspaceMembers.suspendedAt }).from(workspaceMembers).where(eq(workspaceMembers.userId, admin.id));
    expect(row?.suspendedAt).toBeNull();
    const [user] = await transaction.select({ flag: users.forcePasswordReset }).from(users).where(eq(users.id, admin.id));
    expect(user?.flag).toBe(false);
  });
}, 30_000);

test.concurrent("finishing the emailed reset link ends a forced reset without the current password, and the person is let in with the new one", async () => {
  await withRollback(db, async (transaction, created) => {
    const sent: Array<{ to: string; text: string }> = [];
    const h = harness(transaction, created, { send: async (message: { to: string; text: string }) => { sent.push(message); } } as never);
    const { admin, member, workspace } = await workspaceWithMember(h, created);
    expect((await h.call("/actions/force_password_reset", { workspaceId: workspace.id, userId: member.id }, { cookie: admin.cookie })).status).toBe(200);
    const gatedSession = await h.signIn(member.email);
    expect((await h.get("/api/me", { cookie: gatedSession })).status).toBe(403);
    sent.length = 0;
    expect((await h.call("/api/auth/request-password-reset", { email: member.email, redirectTo: "http://localhost:5173/reset-password" }, { cookie: gatedSession })).status).toBe(200);
    await Bun.sleep(100);
    const message = sent.find((entry) => entry.to === member.email && /reset-password\//.test(entry.text))!;
    const token = message.text.match(/reset-password\/([^?\s]+)/)![1]!;
    expect((await h.call("/api/auth/reset-password", { newPassword: "a-fresh-password-9", token }, { cookie: gatedSession })).status).toBe(200);
    const [row] = await transaction.select({ flag: users.forcePasswordReset, notice: users.securityNotice }).from(users).where(eq(users.id, member.id));
    expect(row).toEqual({ flag: false, notice: null });
    const response = await h.call("/api/auth/sign-in/email", { email: member.email, password: "a-fresh-password-9" });
    expect((await h.get("/api/me", { cookie: response.headers.get("set-cookie")!.split(";")[0]! })).status).toBe(200);
  });
}, 30_000);

test.concurrent("an Admin refuses to force a reset for a Microsoft-only person over HTTP with a plain message", async () => {
  await withRollback(db, async (transaction, created) => {
    const h = harness(transaction, created);
    const { admin, member, workspace } = await workspaceWithMember(h, created);
    await transaction.delete(accounts).where(eq(accounts.userId, member.id));
    const refused = await h.call("/actions/force_password_reset", { workspaceId: workspace.id, userId: member.id }, { cookie: admin.cookie });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("Microsoft");
  });
}, 30_000);

test.concurrent("change-password refuses a new password equal to the current one and throttles wrong current-password guesses like sign-in", async () => {
  await withRollback(db, async (transaction, created) => {
    const h = harness(transaction, created);
    const { admin, member, workspace } = await workspaceWithMember(h, created);
    expect((await h.call("/actions/force_password_reset", { workspaceId: workspace.id, userId: member.id }, { cookie: admin.cookie })).status).toBe(200);
    const session = await h.signIn(member.email);
    const same = await h.call("/api/account/change-password", { currentPassword: password, newPassword: password }, { cookie: session });
    expect(same.status).toBe(400);
    expect(JSON.stringify(await same.json())).toContain("different");
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await h.call("/api/account/change-password", { currentPassword: `wrong-guess-${attempt}-xx`, newPassword: "a-brand-new-password" }, { cookie: session })).status).toBe(400);
    }
    // After three misses the next try waits, even with the right current password.
    const waiting = await h.call("/api/account/change-password", { currentPassword: password, newPassword: "a-brand-new-password" }, { cookie: session });
    expect(waiting.status).toBe(429);
    expect(await waiting.json()).toMatchObject({ code: "SIGN_IN_WAIT" });
    const [row] = await transaction.select({ flag: users.forcePasswordReset }).from(users).where(eq(users.id, member.id));
    expect(row?.flag).toBe(true);
  });
}, 30_000);
