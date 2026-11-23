import { Type } from "@sinclair/typebox";
import { and, desc, eq, exists, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, apiTokens, cliDeviceAuthorizations, cliDevices, daemons, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken, runs, runtimes, workspaceMembers } from "@weft/db";
import { ActionError } from "./members";
import { revokeCliDeviceRuns } from "./run-revocation";

type Context = { userId: string; via?: "session" | "token" | "oauth" };

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

export const DEFAULT_TOKEN_MS = 30 * 24 * 60 * 60 * 1000;
export const CLI_DEVICE_INACTIVITY_MS = 90 * 24 * 60 * 60 * 1000;
export const CLI_DEVICE_ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** A rotated Daemon credential keeps working this long, so calls in flight during the rotation finish. */
export const DAEMON_ROTATION_GRACE_MS = 10 * 60 * 1000;

/** Serializes every credential lifecycle change for a device, including the first login before its row exists. */
export async function lockCliDeviceLifecycle(db: Database, ownerId: string, deviceId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${ownerId}:${deviceId}`}, 0))`);
}

/** Creates a token row and returns the plain token once; only its hash is stored. */
export async function mintApiToken(db: Database, values: { userId: string; name: string; description: string | null; expiresAt?: Date; daemonOnly?: boolean; cliDeviceId?: string | null }) {
  const token = `${values.daemonOnly ? "weft_daemon_" : "weft_"}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
  const [row] = await db.insert(apiTokens).values({
    userId: values.userId, name: values.name, description: values.description, expiresAt: values.expiresAt ?? null,
    daemonOnly: values.daemonOnly ?? false, cliDeviceId: values.cliDeviceId ?? null,
    tokenHash: await sha256(token), tokenPrefix: token.slice(0, values.daemonOnly ? 16 : 9),
  }).returning({ id: apiTokens.id });
  return { id: row!.id, token };
}

/** Personal API tokens: owned by a user, hashed at rest, no scopes, not bound to a workspace. */
export function createApiTokenActions(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const tokenOutput = Type.Object({
    id: Type.String(), name: Type.String(), prefix: Type.String(), createdAt: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]), expiresAt: Type.Union([Type.String(), Type.Null()]),
    status: Type.Union([Type.Literal("active"), Type.Literal("expired"), Type.Literal("revoked")]),
    lastUsedAt: Type.Union([Type.String(), Type.Null()]), revokedAt: Type.Union([Type.String(), Type.Null()]),
  });
  // A token must not mint, list, or revoke tokens: managing tokens needs a signed-in session.
  const requireSession = (context: Context) => {
    if (context.via && context.via !== "session") throw new ActionError("Tokens can only be managed from a signed-in session", 403);
  };
  const deviceRow = Type.Object({
    id: Type.String(), hostname: Type.String(), createdAt: Type.String(), lastActivityAt: Type.String(),
    expiresAt: Type.Union([Type.String(), Type.Null()]), revokedAt: Type.Union([Type.String(), Type.Null()]),
    status: Type.Union([Type.Literal("active"), Type.Literal("expired"), Type.Literal("revoked")]),
    daemonConnected: Type.Boolean(),
  });
  const deviceStatus = (row: { revokedAt: Date | null; expiresAt: Date | null }) => row.revokedAt ? "revoked" as const : row.expiresAt && row.expiresAt <= now() ? "expired" as const : "active" as const;
  const selectDevices = (userId: string, condition: ReturnType<typeof and>) => db.select({
    id: cliDevices.deviceId, hostname: cliDevices.hostname, createdAt: cliDevices.createdAt, lastUsedAt: cliDevices.lastUsedAt,
    expiresAt: apiTokens.expiresAt, revokedAt: apiTokens.revokedAt,
    daemonLastSeenAt: sql<Date | null>`max(${daemons.lastHeartbeatAt})`,
  }).from(cliDevices).innerJoin(apiTokens, eq(apiTokens.id, cliDevices.tokenId))
    .leftJoin(daemons, and(eq(daemons.ownerId, cliDevices.ownerId), eq(daemons.cliDeviceId, cliDevices.deviceId)))
    .where(and(eq(cliDevices.ownerId, userId), condition))
    .groupBy(cliDevices.ownerId, cliDevices.deviceId, cliDevices.hostname, cliDevices.createdAt, cliDevices.lastUsedAt, apiTokens.expiresAt, apiTokens.revokedAt)
    .orderBy(desc(sql`greatest(${cliDevices.lastUsedAt}, coalesce(max(${daemons.lastHeartbeatAt}), ${cliDevices.lastUsedAt}))`), desc(cliDevices.deviceId))
    .$dynamic();
  const authenticateWithToken = async (token: string): Promise<{ userId: string; tokenId: string } | null> => {
    if (!token.startsWith("weft_")) return null;
    const currentTime = now();
    const [row] = await db.update(apiTokens).set({ lastUsedAt: currentTime })
      .where(and(eq(apiTokens.tokenHash, await sha256(token)), eq(apiTokens.daemonOnly, false), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, currentTime)),
        or(isNull(apiTokens.cliDeviceId), exists(db.select({ id: cliDevices.deviceId }).from(cliDevices).where(and(
          eq(cliDevices.ownerId, apiTokens.userId), eq(cliDevices.deviceId, apiTokens.cliDeviceId), eq(cliDevices.tokenId, apiTokens.id), isNull(cliDevices.revokedAt),
        ))))))
      .returning({ userId: apiTokens.userId, tokenId: apiTokens.id });
    if (row) {
      // Only credentials enrolled by device sign-in get sliding inactivity expiry;
      // existing personal and pre-upgrade CLI credentials retain their current rules.
      const [device] = await db.update(cliDevices).set({ lastUsedAt: currentTime })
        .where(and(eq(cliDevices.tokenId, row.tokenId), isNull(cliDevices.revokedAt))).returning({ tokenId: cliDevices.tokenId });
      if (device) await db.update(apiTokens).set({ expiresAt: new Date(currentTime.getTime() + CLI_DEVICE_INACTIVITY_MS) }).where(eq(apiTokens.id, row.tokenId));
    }
    return row ? { userId: row.userId, tokenId: row.tokenId } : null;
  };
  const authenticateDaemonToken = async (token: string): Promise<{ userId: string; tokenId: string } | null> => {
    const [row] = await db.update(apiTokens).set({ lastUsedAt: new Date() })
      .where(and(eq(apiTokens.tokenHash, await sha256(token)), eq(apiTokens.daemonOnly, true), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date()))))
      .returning({ userId: apiTokens.userId, tokenId: apiTokens.id });
    return row ?? null;
  };
  return {
    listAuthorizedApps: {
      name: "list_authorized_apps", kind: "read" as const,
      input: Type.Object({}),
      output: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), allowedAt: Type.String(), lastUsedAt: Type.Union([Type.String(), Type.Null()]) })),
      handler: async (context: Context, _input: Record<string, never>) => {
        requireSession(context);
        const rows = await db.select({ id: oauthClient.clientId, name: oauthClient.name, allowedAt: oauthConsent.createdAt, lastUsedAt: sql<Date | null>`max(${oauthAccessToken.createdAt})` })
          .from(oauthConsent).innerJoin(oauthClient, eq(oauthConsent.clientId, oauthClient.clientId))
          .leftJoin(oauthAccessToken, and(eq(oauthAccessToken.clientId, oauthClient.clientId), eq(oauthAccessToken.userId, context.userId)))
          .where(eq(oauthConsent.userId, context.userId)).groupBy(oauthClient.clientId, oauthClient.name, oauthConsent.createdAt)
          .orderBy(desc(oauthConsent.createdAt));
        return rows.map((row) => ({ id: row.id, name: row.name ?? "An application", allowedAt: (row.allowedAt ?? new Date(0)).toISOString(), lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null }));
      },
    },
    revokeAuthorizedApp: {
      name: "revoke_authorized_app", kind: "write" as const,
      input: Type.Object({ clientId: Type.String({ minLength: 1 }) }),
      output: Type.Object({ id: Type.String() }),
      handler: async (context: Context, input: { clientId: string }) => {
        requireSession(context);
        const [consent] = await db.select({ id: oauthConsent.id }).from(oauthConsent).where(and(eq(oauthConsent.userId, context.userId), eq(oauthConsent.clientId, input.clientId))).limit(1);
        if (!consent) throw new ActionError("Authorized app not found", 404);
        const now = new Date();
        await db.update(oauthAccessToken).set({ revoked: now }).where(and(eq(oauthAccessToken.userId, context.userId), eq(oauthAccessToken.clientId, input.clientId), isNull(oauthAccessToken.revoked)));
        await db.update(oauthRefreshToken).set({ revoked: now }).where(and(eq(oauthRefreshToken.userId, context.userId), eq(oauthRefreshToken.clientId, input.clientId), isNull(oauthRefreshToken.revoked)));
        await db.delete(oauthConsent).where(and(eq(oauthConsent.userId, context.userId), eq(oauthConsent.clientId, input.clientId)));
        return { id: input.clientId };
      },
    },
    listCliDevices: {
      name: "list_cli_devices", kind: "read" as const,
      input: Type.Object({ historyOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })) }),
      output: Type.Object({
        active: Type.Array(deviceRow), history: Type.Array(deviceRow), historyCount: Type.Integer(), hasMore: Type.Boolean(),
      }),
      handler: async (context: Context, input: { historyOffset?: number }) => {
        requireSession(context);
        const current = now();
        const activeCondition = and(isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, current)))!;
        const historyCondition = or(isNotNull(apiTokens.revokedAt), lte(apiTokens.expiresAt, current))!;
        const activeRows = await selectDevices(context.userId, activeCondition);
        const [{ count: historyCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(cliDevices).innerJoin(apiTokens, eq(apiTokens.id, cliDevices.tokenId))
          .where(and(eq(cliDevices.ownerId, context.userId), historyCondition));
        const offset = input.historyOffset ?? 0;
        const historyRows = await selectDevices(context.userId, historyCondition).limit(21).offset(offset);
        const shape = (row: Awaited<ReturnType<typeof selectDevices>>[number]) => ({
          id: row.id, hostname: row.hostname, createdAt: row.createdAt.toISOString(),
          lastActivityAt: new Date(Math.max(row.lastUsedAt.getTime(), row.daemonLastSeenAt ? new Date(String(row.daemonLastSeenAt)).getTime() : 0)).toISOString(),
          expiresAt: row.expiresAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
          status: deviceStatus(row), daemonConnected: Boolean(row.daemonLastSeenAt && now().getTime() - new Date(String(row.daemonLastSeenAt)).getTime() <= 150_000),
        });
        return { active: activeRows.map(shape), history: historyRows.slice(0, 20).map(shape), historyCount, hasMore: offset + Math.min(historyRows.length, 20) < historyCount };
      },
    },
    revokeCliDevice: {
      name: "revoke_cli_device", kind: "write" as const,
      input: Type.Object({ deviceId: Type.String({ format: "uuid" }) }),
      output: Type.Object({ id: Type.String(), hostname: Type.String() }),
      handler: async (context: Context, input: { deviceId: string }) => {
        requireSession(context);
        const result = await db.transaction(async (transaction) => {
          const tx = transaction as unknown as Database;
          await lockCliDeviceLifecycle(tx, context.userId, input.deviceId);
          const [device] = await tx.select().from(cliDevices).where(and(eq(cliDevices.ownerId, context.userId), eq(cliDevices.deviceId, input.deviceId))).for("update");
          if (!device) throw new ActionError("CLI device not found", 404);
          const [token] = await tx.select({ revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.id, device.tokenId)).for("update");
          if (!token || token.revokedAt) throw new ActionError("CLI device not found", 404);
          const ownedDaemons = await tx.select({ id: daemons.id }).from(daemons)
            .where(and(eq(daemons.ownerId, context.userId), eq(daemons.cliDeviceId, input.deviceId))).for("update");
          const daemonIds = ownedDaemons.map(({ id }) => id);
          const revokedAt = now();
          const authorizations = await tx.select({ id: cliDeviceAuthorizations.id, tokenId: cliDeviceAuthorizations.tokenId }).from(cliDeviceAuthorizations)
            .where(and(eq(cliDeviceAuthorizations.userId, context.userId), eq(cliDeviceAuthorizations.deviceId, input.deviceId), inArray(cliDeviceAuthorizations.status, ["pending", "approved", "exchanged", "rotating"])));
          await tx.update(cliDeviceAuthorizations).set({ status: "revoked" }).where(and(
            eq(cliDeviceAuthorizations.userId, context.userId), eq(cliDeviceAuthorizations.deviceId, input.deviceId), inArray(cliDeviceAuthorizations.status, ["pending", "approved", "exchanged", "rotating"]),
          ));
          await tx.update(cliDevices).set({ revokedAt }).where(and(eq(cliDevices.ownerId, context.userId), eq(cliDevices.deviceId, input.deviceId)));
          await tx.update(apiTokens).set({ revokedAt }).where(and(eq(apiTokens.userId, context.userId), or(
            eq(apiTokens.id, device.tokenId), eq(apiTokens.cliDeviceId, input.deviceId),
            ...(authorizations.some(({ tokenId }) => tokenId) ? [inArray(apiTokens.id, authorizations.flatMap(({ tokenId }) => tokenId ? [tokenId] : []))] : []),
          ), isNull(apiTokens.revokedAt)));
          if (daemonIds.length) await tx.update(runtimes).set({ stopped: true }).where(inArray(runtimes.daemonId, daemonIds));
          const memberships = await tx.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, context.userId));
          for (const { workspaceId } of memberships) await tx.insert(activities).values({
            workspaceId, entityType: "cli_device", entityId: input.deviceId, field: "cli_device.revoked",
            oldValue: { hostname: device.hostname, status: "active" }, newValue: { status: "revoked" }, actorId: context.userId, source: "ui",
          });
          // Persist cancellation in the same commit as credential revocation. If cancellation
          // cannot be recorded, the credential remains usable and the owner can retry.
          await revokeCliDeviceRuns(tx, daemonIds, context.userId);
          return { id: input.deviceId, hostname: device.hostname };
        });
        return { id: result.id, hostname: result.hostname };
      },
    },
    createApiToken: {
      name: "create_api_token", kind: "write" as const,
      input: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 100 }),
        description: Type.Optional(Type.String({ maxLength: 500 })),
        expiresAt: Type.Optional(Type.String()),
      }),
      output: Type.Object({ id: Type.String(), name: Type.String(), token: Type.String() }),
      handler: async (context: Context, input: { name: string; description?: string; expiresAt?: string }) => {
        requireSession(context);
        let expiresAt: Date | undefined;
        if (input.expiresAt !== undefined) {
          expiresAt = new Date(input.expiresAt);
          const datePart = input.expiresAt.slice(0, 10);
          const validFormat = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/i.test(input.expiresAt);
          const validCalendarDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart)
            && new Date(`${datePart}T00:00:00.000Z`).toISOString().slice(0, 10) === datePart;
          if (!validFormat || !validCalendarDate || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
            throw new ActionError("Expiry must be a valid future date", 400);
          }
        }
        const { id, token } = await mintApiToken(db, { userId: context.userId, name: input.name, description: input.description ?? null, expiresAt });
        return { id, name: input.name, token };
      },
    },
    listApiTokens: {
      name: "list_api_tokens", kind: "read" as const,
      input: Type.Object({}),
      output: Type.Array(tokenOutput),
      handler: async (context: Context, _input: Record<string, never>) => {
        requireSession(context);
        const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, context.userId)).orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
        return rows.map((row) => ({
          id: row.id, name: row.name, prefix: row.tokenPrefix, createdAt: row.createdAt.toISOString(),
          description: row.description, expiresAt: row.expiresAt?.toISOString() ?? null,
          status: row.revokedAt ? "revoked" as const : row.expiresAt && row.expiresAt <= new Date() ? "expired" as const : "active" as const,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
        }));
      },
    },
    listManagedCredentials: {
      name: "list_managed_credentials", kind: "read" as const,
      input: Type.Object({ historyOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })) }),
      output: Type.Object({
        active: Type.Array(Type.Object({ ...tokenOutput.properties, kind: Type.Union([Type.Literal("personal"), Type.Literal("daemon")]) })),
        history: Type.Array(Type.Object({ ...tokenOutput.properties, kind: Type.Union([Type.Literal("personal"), Type.Literal("daemon")]) })),
        historyCount: Type.Integer(), hasMore: Type.Boolean(),
      }),
      handler: async (context: Context, input: { historyOffset?: number }) => {
        requireSession(context);
        const current = now();
        const activeCondition = and(isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, current)))!;
        const historyCondition = or(isNotNull(apiTokens.revokedAt), lte(apiTokens.expiresAt, current))!;
        const visible = and(eq(apiTokens.userId, context.userId), isNull(cliDevices.tokenId), isNull(apiTokens.cliDeviceId));
        const query = (condition: ReturnType<typeof and>) => db.select({
          id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.tokenPrefix, description: apiTokens.description,
          createdAt: apiTokens.createdAt, expiresAt: apiTokens.expiresAt, lastUsedAt: apiTokens.lastUsedAt,
          revokedAt: apiTokens.revokedAt, daemonOnly: apiTokens.daemonOnly,
        }).from(apiTokens).leftJoin(cliDevices, eq(cliDevices.tokenId, apiTokens.id)).where(and(visible, condition)).orderBy(desc(apiTokens.createdAt), desc(apiTokens.id)).$dynamic();
        const activeRows = await query(activeCondition);
        const [{ count: historyCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(apiTokens).leftJoin(cliDevices, eq(cliDevices.tokenId, apiTokens.id))
          .where(and(visible, historyCondition));
        const offset = input.historyOffset ?? 0;
        const historyRows = await query(historyCondition).limit(21).offset(offset);
        const shape = (row: (typeof activeRows)[number]) => ({
          id: row.id, name: row.name, prefix: row.prefix, description: row.description, createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt?.toISOString() ?? null, lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null, status: deviceStatus(row), kind: row.daemonOnly ? "daemon" as const : "personal" as const,
        });
        return { active: activeRows.map(shape), history: historyRows.slice(0, 20).map(shape), historyCount, hasMore: offset + Math.min(historyRows.length, 20) < historyCount };
      },
    },
    revokeApiToken: {
      name: "revoke_api_token", kind: "write" as const,
      input: Type.Object({ tokenId: Type.String({ format: "uuid" }) }),
      output: Type.Object({ id: Type.String() }),
      handler: async (context: Context, input: { tokenId: string }) => {
        requireSession(context);
        const result = await db.transaction(async (transaction) => {
          const tx = transaction as unknown as Database;
          const [token] = await tx.select().from(apiTokens).where(and(eq(apiTokens.id, input.tokenId), eq(apiTokens.userId, context.userId), isNull(apiTokens.revokedAt))).for("update");
          if (!token) throw new ActionError("Token not found", 404);
          const [enrolledDevice] = await tx.select({ id: cliDevices.deviceId }).from(cliDevices).where(eq(cliDevices.tokenId, token.id));
          if (enrolledDevice || token.cliDeviceId) throw new ActionError("Revoke the CLI device to remove its combined CLI and Daemon access", 409);
          let daemonId: string | undefined;
          if (token.daemonOnly) {
            const [direct] = await tx.select({ id: daemons.id }).from(daemons).where(and(eq(daemons.ownerId, context.userId), eq(daemons.tokenId, token.id)));
            if (direct) daemonId = direct.id;
            else if (token.name.startsWith("Daemon @ ")) {
              const [legacy] = await tx.select({ id: daemons.id }).from(daemons)
                .where(and(eq(daemons.ownerId, context.userId), eq(daemons.hostname, token.name.slice("Daemon @ ".length)), isNull(daemons.cliDeviceId)))
                .orderBy(desc(daemons.lastHeartbeatAt)).limit(1);
              daemonId = legacy?.id;
            }
          }
          const revokedAt = now();
          await tx.update(apiTokens).set({ revokedAt }).where(eq(apiTokens.id, token.id));
          if (daemonId) await tx.update(runtimes).set({ stopped: true }).where(eq(runtimes.daemonId, daemonId));
          if (daemonId) await revokeCliDeviceRuns(tx, [daemonId], context.userId, "daemon_credential_revoked");
          return { id: token.id };
        });
        return { id: result.id };
      },
    },
    /** Resolve a bearer token to its owner; revoked or unknown tokens give null. */
    authenticate: async (token: string): Promise<{ userId: string } | null> => {
      const row = await authenticateWithToken(token);
      return row ? { userId: row.userId } : null;
    },
    authenticateWithToken,
    authenticateDaemonToken,
    /** Legacy callback credentials cannot be matched to a device by hostname alone. */
    createCliToken: async (userId: string, name: string) => {
      return mintApiToken(db, { userId, name, description: "Signed in with weft login", expiresAt: new Date(Date.now() + DEFAULT_TOKEN_MS) });
    },
  };
}
