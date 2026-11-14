import { Type } from "@sinclair/typebox";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { accounts, activities, apiTokens, oauthAccessToken, oauthRefreshToken, sessions, users, workspaceMembers } from "@weft/db";
import { agentUserIds } from "./agent-access";
import { auditAgentChange } from "./agent-audit";
import { csvCell } from "./exports";
import { ActionError, requireWorkspaceRole } from "./members";
import { pauseCreatorRecurrences } from "./recurrence-pause";
import { revokeMemberRuns } from "./runs";

/** Activity kinds the audit page shows: changes an Admin makes to how the workspace runs and who may use it. */
export const auditKinds = ["agent", "runtime", "trigger", "skill", "workspace", "member", "api_token"] as const;
export type AuditKind = (typeof auditKinds)[number];

type Context = { userId: string; via?: "session" | "token" | "oauth"; sessionId?: string };
const maxAuditRows = 5000;

export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Firefox\//.test(userAgent) ? "Firefox"
    : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : /curl|Bun|node/i.test(userAgent) ? "Command-line tool" : null;
  const system = /iPhone|iPad/.test(userAgent) ? "iPhone or iPad" : /Android/.test(userAgent) ? "Android" : /Windows/.test(userAgent) ? "Windows"
    : /Mac OS X|Macintosh/.test(userAgent) ? "Mac" : /Linux/.test(userAgent) ? "Linux" : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}

/** Audit values are JSON; a CSV cell holds their text form. */
function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isoDateTime(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ActionError(`${field} must be a date and time`, 400);
  return date;
}

export function createAdminConsoleActions(
  db: Database,
  now: () => Date = () => new Date(),
  options: { passwordSignInEnabled?: boolean } = {},
) {
  const passwordSignInEnabled = options.passwordSignInEnabled ?? (process.env.PASSWORD_SIGN_IN_ENABLED ?? "true").toLowerCase() !== "false";
  const workspaceInput = { workspaceId: Type.String({ format: "uuid" }) };
  const userInput = { ...workspaceInput, userId: Type.String({ minLength: 1 }) };
  const reasonInput = Type.Optional(Type.String({ maxLength: 200 }));
  const auditFilter = {
    ...workspaceInput,
    actorId: Type.Optional(Type.String({ minLength: 1 })),
    kind: Type.Optional(Type.Union(auditKinds.map((kind) => Type.Literal(kind)))),
    from: Type.Optional(Type.String({ maxLength: 40 })),
    to: Type.Optional(Type.String({ maxLength: 40 })),
  };
  type AuditFilter = { workspaceId: string; actorId?: string; kind?: AuditKind; from?: string; to?: string };

  /** The membership of a person, with the same not-found and Agent rules everywhere in the console. */
  async function personMembership(database: Database, workspaceId: string, userId: string, lock = false) {
    const query = database.select({ role: workspaceMembers.role, suspendedAt: workspaceMembers.suspendedAt }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    const [member] = lock ? await query.for("update") : await query;
    if (!member) throw new ActionError("Member not found", 404);
    if ((await agentUserIds(database, [userId])).size > 0) throw new ActionError("Agents have no sign-in to manage here; change the Agent instead", 400);
    return member;
  }

  async function activeAdmins(database: Database, workspaceId: string) {
    return (await database.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "Admin"), isNull(workspaceMembers.suspendedAt)))).length;
  }

  /** The notice is stored as a code ("notice:signed_out") with the Admin's reason on the next line; the web app words it in the reader's language. */
  function securityNoticeFor(code: "signed_out" | "password_reset", reason?: string) {
    return reason ? `notice:${code}\n${reason.replace(/[.!?]+$/, "")}` : `notice:${code}`;
  }

  /**
   * Sessions, passwords, OAuth grants and API tokens belong to the account, not to one workspace. An Admin may act on them only when
   * they administer every workspace the person belongs to; otherwise another workspace's people could be cut off by an outside Admin.
   */
  async function requireAccountWideAdmin(database: Database, callerId: string, userId: string, what: string) {
    const memberships = await database.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
    const administered = new Set((await database.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, callerId), eq(workspaceMembers.role, "Admin"), isNull(workspaceMembers.suspendedAt)))).map((row) => row.workspaceId));
    if (memberships.some((row) => !administered.has(row.workspaceId))) {
      throw new ActionError(`This person also belongs to another workspace you do not administer, so you cannot ${what}. Ask them to do it themselves, or suspend them from this workspace instead.`, 403);
    }
  }

  /** Browser sessions and OAuth grants stop at once. API tokens are managed separately by an Admin. */
  async function endAccess(database: Database, userId: string, notice: string) {
    const signedOut = await endSessions(database, userId, notice);
    const revokedAt = now();
    await database.update(oauthAccessToken).set({ revoked: revokedAt }).where(and(eq(oauthAccessToken.userId, userId), isNull(oauthAccessToken.revoked)));
    await database.update(oauthRefreshToken).set({ revoked: revokedAt }).where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)));
    return signedOut;
  }

  /** Signing a person out ends every browser session; the notice tells them why at their next sign-in. */
  async function endSessions(database: Database, userId: string, notice: string) {
    const removed = await database.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
    await database.update(users).set({ securityNotice: notice, updatedAt: now() }).where(eq(users.id, userId));
    return removed.length;
  }

  async function auditRows(database: Database, filter: AuditFilter, limit: number, offset: number) {
    const conditions = [eq(activities.workspaceId, filter.workspaceId), inArray(activities.entityType, [...auditKinds])];
    if (filter.kind) conditions.push(eq(activities.entityType, filter.kind));
    if (filter.actorId) conditions.push(eq(activities.actorId, filter.actorId));
    const from = isoDateTime(filter.from, "From");
    const to = isoDateTime(filter.to, "To");
    if (from) conditions.push(gte(activities.createdAt, from));
    if (to) conditions.push(lt(activities.createdAt, to));
    return db.select({
      id: activities.id, at: activities.createdAt, actorId: activities.actorId, actorName: users.name, kind: activities.entityType,
      entityId: activities.entityId, field: activities.field, oldValue: activities.oldValue, newValue: activities.newValue,
    }).from(activities).innerJoin(users, eq(users.id, activities.actorId)).where(and(...conditions))
      .orderBy(desc(activities.seq)).limit(limit).offset(offset);
  }

  return {
    listMemberAccounts: {
      name: "list_member_accounts", kind: "read" as const,
      input: Type.Object(workspaceInput),
      output: Type.Array(Type.Object({
        userId: Type.String(), name: Type.String(), email: Type.String(), role: Type.String(),
        status: Type.Union([Type.Literal("active"), Type.Literal("suspended")]), suspendedAt: Type.Union([Type.String(), Type.Null()]),
        lastActiveAt: Type.Union([Type.String(), Type.Null()]), forcePasswordReset: Type.Boolean(),
      })),
      handler: async (context: Context, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const rows = await db.select({
          userId: users.id, name: users.name, email: users.email, role: workspaceMembers.role, suspendedAt: workspaceMembers.suspendedAt,
          forcePasswordReset: users.forcePasswordReset,
        }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(users.isAgent, false)))
          .orderBy(users.name, users.id);
        const ids = rows.map((row) => row.userId);
        // Last activity: a change the person made in this workspace always counts. Browser sessions and token use are account-wide signals,
        // so they count only for people this Admin administers in every workspace (see requireAccountWideAdmin).
        const memberships = ids.length ? await db.select({ userId: workspaceMembers.userId, workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(inArray(workspaceMembers.userId, ids)) : [];
        const administered = new Set((await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers)
          .where(and(eq(workspaceMembers.userId, context.userId), eq(workspaceMembers.role, "Admin"), isNull(workspaceMembers.suspendedAt)))).map((row) => row.workspaceId));
        const outside = new Set(memberships.filter((row) => !administered.has(row.workspaceId)).map((row) => row.userId));
        const visibleIds = ids.filter((id) => !outside.has(id));
        const lastSession = visibleIds.length ? await db.select({ userId: sessions.userId, at: sql<Date>`max(${sessions.updatedAt})` }).from(sessions).where(inArray(sessions.userId, visibleIds)).groupBy(sessions.userId) : [];
        const lastToken = visibleIds.length ? await db.select({ userId: apiTokens.userId, at: sql<Date>`max(${apiTokens.lastUsedAt})` }).from(apiTokens).where(inArray(apiTokens.userId, visibleIds)).groupBy(apiTokens.userId) : [];
        const lastChange = ids.length ? await db.select({ userId: activities.actorId, at: sql<Date>`max(${activities.createdAt})` }).from(activities).where(and(eq(activities.workspaceId, input.workspaceId), inArray(activities.actorId, ids))).groupBy(activities.actorId) : [];
        const latest = new Map<string, Date>();
        for (const entry of [...lastSession, ...lastToken, ...lastChange]) {
          if (!entry.at) continue;
          const at = new Date(entry.at);
          const previous = latest.get(entry.userId);
          if (!previous || at > previous) latest.set(entry.userId, at);
        }
        return rows.map((row) => ({
          userId: row.userId, name: row.name, email: row.email, role: row.role,
          status: row.suspendedAt ? "suspended" as const : "active" as const,
          suspendedAt: row.suspendedAt?.toISOString() ?? null,
          lastActiveAt: latest.get(row.userId)?.toISOString() ?? null,
          forcePasswordReset: row.forcePasswordReset,
        }));
      },
    },
    suspendMember: {
      name: "suspend_member", kind: "write" as const,
      input: Type.Object(userInput),
      output: Type.Object({ userId: Type.String(), status: Type.Literal("suspended") }),
      handler: async (context: Context, input: { workspaceId: string; userId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        if (input.userId === context.userId) throw new ActionError("You cannot suspend your own account. Ask another Admin.", 400);
        return db.transaction(async (tx) => {
          const transaction = tx as unknown as Database;
          const member = await personMembership(transaction, input.workspaceId, input.userId, true);
          if (member.suspendedAt) return { userId: input.userId, status: "suspended" as const };
          if (member.role === "Admin" && (await activeAdmins(transaction, input.workspaceId)) <= 1) {
            throw new ActionError("A workspace needs at least one active Admin, so this Admin cannot be suspended.", 400);
          }
          const suspendedAt = now();
          await transaction.update(workspaceMembers).set({ suspendedAt }).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId)));
          await revokeMemberRuns(transaction, input.workspaceId, input.userId, context.userId, "The person was suspended from the workspace");
          await pauseCreatorRecurrences(transaction, input.userId, { workspaceId: input.workspaceId }, "creator is suspended from the workspace", context.userId, suspendedAt);
          await auditAgentChange(transaction, {
            workspaceId: input.workspaceId, entityType: "member", entityId: input.workspaceId, field: "suspended",
            oldValue: { userId: input.userId, status: "active" }, newValue: { userId: input.userId, status: "suspended" }, actorId: context.userId,
          });
          return { userId: input.userId, status: "suspended" as const };
        });
      },
    },
    reactivateMember: {
      name: "reactivate_member", kind: "write" as const,
      input: Type.Object(userInput),
      output: Type.Object({ userId: Type.String(), status: Type.Literal("active") }),
      handler: async (context: Context, input: { workspaceId: string; userId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        return db.transaction(async (tx) => {
          const transaction = tx as unknown as Database;
          const member = await personMembership(transaction, input.workspaceId, input.userId, true);
          if (!member.suspendedAt) return { userId: input.userId, status: "active" as const };
          await transaction.update(workspaceMembers).set({ suspendedAt: null }).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId)));
          await auditAgentChange(transaction, {
            workspaceId: input.workspaceId, entityType: "member", entityId: input.workspaceId, field: "reactivated",
            oldValue: { userId: input.userId, status: "suspended" }, newValue: { userId: input.userId, status: "active" }, actorId: context.userId,
          });
          return { userId: input.userId, status: "active" as const };
        });
      },
    },
    signOutMember: {
      name: "sign_out_member", kind: "write" as const,
      input: Type.Object({ ...userInput, reason: reasonInput }),
      output: Type.Object({ userId: Type.String(), signedOut: Type.Integer() }),
      handler: async (context: Context, input: { workspaceId: string; userId: string; reason?: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        return db.transaction(async (tx) => {
          const transaction = tx as unknown as Database;
          await personMembership(transaction, input.workspaceId, input.userId);
          await requireAccountWideAdmin(transaction, context.userId, input.userId, "sign them out of every device");
          const notice = securityNoticeFor("signed_out", input.reason);
          const signedOut = await endAccess(transaction, input.userId, notice);
          await auditAgentChange(transaction, {
            workspaceId: input.workspaceId, entityType: "member", entityId: input.workspaceId, field: "signed_out",
            oldValue: null, newValue: { userId: input.userId, sessions: signedOut, reason: input.reason ?? null }, actorId: context.userId,
          });
          return { userId: input.userId, signedOut };
        });
      },
    },
    forcePasswordReset: {
      name: "force_password_reset", kind: "write" as const,
      input: Type.Object({ ...userInput, reason: reasonInput }),
      output: Type.Object({ userId: Type.String(), signedOut: Type.Integer() }),
      handler: async (context: Context, input: { workspaceId: string; userId: string; reason?: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        return db.transaction(async (tx) => {
          const transaction = tx as unknown as Database;
          await personMembership(transaction, input.workspaceId, input.userId);
          await requireAccountWideAdmin(transaction, context.userId, input.userId, "force a password reset");
          if (!passwordSignInEnabled) throw new ActionError("Password sign-in is turned off for this Weft, so there is no password to reset. Sign them out or suspend them instead.", 400);
          const [credential] = await transaction.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, input.userId), eq(accounts.providerId, "credential"), sql`${accounts.password} is not null`));
          if (!credential) throw new ActionError("This person signs in with Microsoft and has no Weft password, so there is nothing to reset. Sign them out or suspend them instead.", 400);
          const notice = securityNoticeFor("password_reset", input.reason);
          // Browser sessions and the person's connected apps stop at once; API tokens are managed separately by an Admin.
          const signedOut = await endAccess(transaction, input.userId, notice);
          await transaction.update(users).set({ forcePasswordReset: true }).where(eq(users.id, input.userId));
          await auditAgentChange(transaction, {
            workspaceId: input.workspaceId, entityType: "member", entityId: input.workspaceId, field: "password_reset_forced",
            oldValue: null, newValue: { userId: input.userId, sessions: signedOut, reason: input.reason ?? null }, actorId: context.userId,
          });
          return { userId: input.userId, signedOut };
        });
      },
    },
    cancelForcedPasswordReset: {
      name: "cancel_forced_password_reset", kind: "write" as const,
      input: Type.Object({ ...userInput, reason: reasonInput }),
      output: Type.Object({ userId: Type.String(), cancelled: Type.Boolean() }),
      handler: async (context: Context, input: { workspaceId: string; userId: string; reason?: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        return db.transaction(async (tx) => {
          const transaction = tx as unknown as Database;
          await personMembership(transaction, input.workspaceId, input.userId);
          await requireAccountWideAdmin(transaction, context.userId, input.userId, "cancel a forced password reset");
          const [person] = await transaction.select({ forcePasswordReset: users.forcePasswordReset }).from(users).where(eq(users.id, input.userId)).for("update");
          if (!person?.forcePasswordReset) return { userId: input.userId, cancelled: false };
          await transaction.update(users).set({ forcePasswordReset: false, securityNotice: null, updatedAt: now() }).where(eq(users.id, input.userId));
          await auditAgentChange(transaction, {
            workspaceId: input.workspaceId, entityType: "member", entityId: input.workspaceId, field: "password_reset_cancelled",
            oldValue: { userId: input.userId, forced: true }, newValue: { userId: input.userId, forced: false, reason: input.reason ?? null }, actorId: context.userId,
          });
          return { userId: input.userId, cancelled: true };
        });
      },
    },
    listMemberApiTokens: {
      name: "list_member_api_tokens", kind: "read" as const,
      input: Type.Object(userInput),
      output: Type.Array(Type.Object({
        id: Type.String(), name: Type.String(), kind: Type.Union([Type.Literal("personal"), Type.Literal("daemon")]), prefix: Type.String(),
        createdAt: Type.String(), lastUsedAt: Type.Union([Type.String(), Type.Null()]), expiresAt: Type.Union([Type.String(), Type.Null()]),
        status: Type.Union([Type.Literal("active"), Type.Literal("expired"), Type.Literal("revoked")]),
      })),
      handler: async (context: Context, input: { workspaceId: string; userId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        await personMembership(db, input.workspaceId, input.userId);
        // api_tokens carry no workspace, so an Admin sees them only when they administer every workspace the person belongs to.
        await requireAccountWideAdmin(db, context.userId, input.userId, "see their API tokens");
        const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, input.userId)).orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
        const current = now();
        return rows.map((row) => ({
          id: row.id, name: row.name, kind: row.daemonOnly ? "daemon" as const : "personal" as const, prefix: row.tokenPrefix,
          createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null, expiresAt: row.expiresAt?.toISOString() ?? null,
          status: row.revokedAt ? "revoked" as const : row.expiresAt && row.expiresAt <= current ? "expired" as const : "active" as const,
        }));
      },
    },
    revokeMemberApiToken: {
      name: "revoke_member_api_token", kind: "write" as const,
      input: Type.Object({ ...userInput, tokenId: Type.String({ format: "uuid" }) }),
      output: Type.Object({ id: Type.String() }),
      handler: async (context: Context, input: { workspaceId: string; userId: string; tokenId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        return db.transaction(async (tx) => {
          const transaction = tx as unknown as Database;
          const [token] = await transaction.select().from(apiTokens).where(and(eq(apiTokens.id, input.tokenId), eq(apiTokens.userId, input.userId))).for("update");
          // A token whose owner is not in this workspace is "not found" here, so an Admin cannot probe other workspaces.
          const [owner] = token ? await transaction.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, token.userId))) : [];
          if (!token || !owner || token.revokedAt) throw new ActionError("Token not found", 404);
          await requireAccountWideAdmin(transaction, context.userId, token.userId, "revoke their API tokens");
          await transaction.update(apiTokens).set({ revokedAt: now() }).where(eq(apiTokens.id, token.id));
          await auditAgentChange(transaction, {
            workspaceId: input.workspaceId, entityType: "api_token", entityId: input.workspaceId, field: "revoked",
            oldValue: { tokenId: token.id, name: token.name, kind: token.daemonOnly ? "daemon" : "personal" }, newValue: { ownerId: token.userId, revokedBy: context.userId }, actorId: context.userId,
          });
          return { id: token.id };
        });
      },
    },
    listAuditLog: {
      name: "list_audit_log", kind: "read" as const,
      input: Type.Object({ ...auditFilter, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      output: Type.Object({
        rows: Type.Array(Type.Object({
          id: Type.String(), at: Type.String(), actorId: Type.String(), actorName: Type.String(), kind: Type.String(), entityId: Type.String(),
          field: Type.String(), oldValue: Type.Unknown(), newValue: Type.Unknown(),
        })),
        hasMore: Type.Boolean(),
      }),
      handler: async (context: Context, input: AuditFilter & { limit?: number; offset?: number }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const limit = input.limit ?? 50;
        const rows = await auditRows(db, input, limit + 1, input.offset ?? 0);
        return {
          rows: rows.slice(0, limit).map((row) => ({ ...row, at: row.at.toISOString() })),
          hasMore: rows.length > limit,
        };
      },
    },
    exportAuditLog: {
      name: "export_audit_log", kind: "read" as const,
      input: Type.Object(auditFilter),
      output: Type.Object({ csv: Type.String(), rows: Type.Integer(), truncated: Type.Boolean() }),
      handler: async (context: Context, input: AuditFilter) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const rows = await auditRows(db, input, maxAuditRows + 1, 0);
        const kept = rows.slice(0, maxAuditRows);
        const header = ["time", "person", "kind", "change", "target", "before", "after"];
        const lines = kept.map((row) => [row.at.toISOString(), row.actorName, row.kind, row.field, row.entityId, cellText(row.oldValue), cellText(row.newValue)].map(csvCell).join(","));
        return { csv: [header.join(","), ...lines].join("\r\n") + "\r\n", rows: kept.length, truncated: rows.length > maxAuditRows };
      },
    },
    listMySessions: {
      name: "list_my_sessions", kind: "read" as const,
      input: Type.Object({}),
      output: Type.Array(Type.Object({ id: Type.String(), device: Type.String(), createdAt: Type.String(), lastSeenAt: Type.String(), current: Type.Boolean() })),
      handler: async (context: Context, _input: Record<string, never>) => {
        requireSignedInSession(context);
        const rows = await db.select().from(sessions).where(and(eq(sessions.userId, context.userId), gte(sessions.expiresAt, now())))
          .orderBy(desc(sessions.updatedAt), desc(sessions.id));
        return rows.map((row) => ({
          id: row.id, device: describeDevice(row.userAgent), createdAt: row.createdAt.toISOString(), lastSeenAt: row.updatedAt.toISOString(),
          current: row.id === context.sessionId,
        }));
      },
    },
    revokeMySession: {
      name: "revoke_my_session", kind: "write" as const,
      input: Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 200 }) }),
      output: Type.Object({ id: Type.String(), current: Type.Boolean() }),
      handler: async (context: Context, input: { sessionId: string }) => {
        requireSignedInSession(context);
        const [row] = await db.delete(sessions).where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, context.userId))).returning({ id: sessions.id });
        if (!row) throw new ActionError("Session not found", 404);
        return { id: row.id, current: row.id === context.sessionId };
      },
    },
    signOutEverywhere: {
      name: "sign_out_everywhere", kind: "write" as const,
      input: Type.Object({}),
      output: Type.Object({ signedOut: Type.Integer() }),
      handler: async (context: Context, _input: Record<string, never>) => {
        requireSignedInSession(context);
        const removed = await db.delete(sessions).where(eq(sessions.userId, context.userId)).returning({ id: sessions.id });
        return { signedOut: removed.length };
      },
    },
    acknowledgeSecurityNotice: {
      name: "acknowledge_security_notice", kind: "write" as const,
      input: Type.Object({}),
      output: Type.Object({ ok: Type.Literal(true) }),
      handler: async (context: Context, _input: Record<string, never>) => {
        await db.update(users).set({ securityNotice: null }).where(eq(users.id, context.userId));
        return { ok: true as const };
      },
    },
  };
}

/** Sessions belong to a browser: an API token or OAuth grant cannot list or end them. */
function requireSignedInSession(context: Context) {
  if (context.via && context.via !== "session") throw new ActionError("Sessions can only be managed from a signed-in browser session", 403);
}
