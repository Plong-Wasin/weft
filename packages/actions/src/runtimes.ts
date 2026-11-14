import { Type } from "@sinclair/typebox";
import { and, desc, eq, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, apiTokens, daemons, runtimes, runtimeProfiles, users, workspaceMembers } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { revokeAgentRuns } from "./runs";
import { auditAgentChange } from "./agent-audit";
import { DAEMON_ROTATION_GRACE_MS, DEFAULT_TOKEN_MS, mintApiToken } from "./api-tokens";

const freshForMs = 150_000;
/** A Daemon credential is re-issued once less than this much of its lifetime is left. */
const rotateBeforeMs = 7 * 24 * 60 * 60 * 1000;
const cli = Type.Union([Type.Literal("claude"), Type.Literal("codex")]);
type Context = { userId: string; apiTokenId?: string };

/**
 * The Daemon row a Daemon credential speaks for. A credential rotated within the grace period has no row of its own,
 * so it speaks for the row of the same owner and hostname (the credential name is `Daemon @ <hostname>`).
 */
export async function daemonForCredential(db: Database, credential: { tokenId: string; userId: string }) {
  const [direct] = await db.select({ id: daemons.id, tokenId: daemons.tokenId }).from(daemons).where(eq(daemons.tokenId, credential.tokenId));
  if (direct) return direct;
  const [token] = await db.select({ name: apiTokens.name }).from(apiTokens).where(eq(apiTokens.id, credential.tokenId));
  const prefix = "Daemon @ ";
  if (!token?.name.startsWith(prefix)) return undefined;
  const [row] = await db.select({ id: daemons.id, tokenId: daemons.tokenId }).from(daemons)
    .where(and(eq(daemons.ownerId, credential.userId), eq(daemons.hostname, token.name.slice(prefix.length)))).orderBy(desc(daemons.lastHeartbeatAt)).limit(1);
  return row;
}

export function createRuntimeActions(db: Database, now: () => Date = () => new Date()) {
  const output = Type.Object({
    id: Type.String({ format: "uuid" }), workspaceId: Type.String({ format: "uuid" }), ownerId: Type.String(), ownerName: Type.String(),
    daemonId: Type.String({ format: "uuid" }), hostname: Type.String(), agentCli: cli, shared: Type.Boolean(), enforceSandbox: Type.Boolean(), online: Type.Boolean(), lastSeenAt: Type.String(),
  });
  async function visibleRuntimes(userId: string, workspaceId: string) {
    await requireWorkspaceRole(db, userId, workspaceId, "read");
    const freshAfter = new Date(now().getTime() - freshForMs);
    return db.select({ id: runtimes.id, workspaceId: runtimes.workspaceId, ownerId: runtimes.ownerId, ownerName: users.name,
      daemonId: daemons.id, hostname: daemons.hostname, agentCli: runtimes.agentCli, shared: runtimes.shared, enforceSandbox: runtimes.enforceSandbox,
      online: sql<boolean>`${runtimes.lastSeenAt} > ${freshAfter.toISOString()}::timestamptz`, lastSeenAt: runtimes.lastSeenAt,
    }).from(runtimes).innerJoin(daemons, eq(daemons.id, runtimes.daemonId)).innerJoin(users, eq(users.id, runtimes.ownerId))
      .where(and(eq(runtimes.workspaceId, workspaceId), or(eq(runtimes.ownerId, userId), eq(runtimes.shared, true))))
      .orderBy(users.name, runtimes.agentCli);
  }
  return {
    registerDaemon: {
      name: "register_daemon", kind: "write" as const,
      input: Type.Object({
        hostname: Type.String({ minLength: 1, maxLength: 255 }), version: Type.String({ minLength: 1, maxLength: 64 }), agentClis: Type.Array(cli, { uniqueItems: true }),
        /** Set when the Daemon has no local credential file, or a Daemon credential was refused: the server then issues a new one even if the active one is fine. */
        rotate: Type.Optional(Type.Boolean()),
      }),
      output: Type.Object({ daemonId: Type.String({ format: "uuid" }), runtimes: Type.Array(output), daemonToken: Type.Optional(Type.String()) }),
      handler: async (context: Context, input: { hostname: string; version: string; agentClis: Array<"claude" | "codex">; rotate?: boolean }) => {
        if (!context.apiTokenId) throw new ActionError("Daemon registration requires a Personal API token", 403);
        const [caller] = await db.select({ daemonOnly: apiTokens.daemonOnly }).from(apiTokens).where(eq(apiTokens.id, context.apiTokenId));
        if (!caller || caller.daemonOnly) throw new ActionError("Daemon registration requires a Personal API token", 403);
        const timestamp = now();
        const registered = await db.transaction(async (tx) => {
          // One lock per owner and hostname: concurrent registrations queue here, and each later one sees the earlier one's row.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${context.userId}:${input.hostname}`}))`);
          // The Daemon row of this owner and hostname keeps its id (Runtimes hang off it); only its credential changes.
          const [current] = await tx.select({ id: daemons.id, tokenId: daemons.tokenId, expiresAt: apiTokens.expiresAt, revokedAt: apiTokens.revokedAt, daemonOnly: apiTokens.daemonOnly })
            .from(daemons).innerJoin(apiTokens, eq(apiTokens.id, daemons.tokenId))
            .where(and(eq(daemons.ownerId, context.userId), eq(daemons.hostname, input.hostname))).orderBy(desc(daemons.lastHeartbeatAt)).limit(1);
          const activeLeftMs = current && current.daemonOnly && !current.revokedAt && current.expiresAt ? current.expiresAt.getTime() - timestamp.getTime() : -1;
          let daemonToken: string | undefined;
          let daemonId: string;
          let activeTokenId: string;
          if (current && !input.rotate && activeLeftMs >= rotateBeforeMs) {
            const [daemon] = await tx.update(daemons).set({ version: input.version, lastHeartbeatAt: timestamp }).where(eq(daemons.id, current.id)).returning({ id: daemons.id });
            daemonId = daemon!.id;
            activeTokenId = current.tokenId;
          } else {
            const minted = await mintApiToken(tx as unknown as Database, { userId: context.userId, name: `Daemon @ ${input.hostname}`, description: "Restricted Daemon credential", daemonOnly: true, expiresAt: new Date(timestamp.getTime() + DEFAULT_TOKEN_MS) });
            daemonToken = minted.token;
            activeTokenId = minted.id;
            if (current) {
              const [daemon] = await tx.update(daemons).set({ tokenId: minted.id, version: input.version, lastHeartbeatAt: timestamp }).where(eq(daemons.id, current.id)).returning({ id: daemons.id });
              daemonId = daemon!.id;
              // The previous credential stays usable for the grace period, never past its own expiry.
              const graceEnd = new Date(timestamp.getTime() + DAEMON_ROTATION_GRACE_MS);
              const graceExpiry = current.expiresAt && current.expiresAt < graceEnd ? current.expiresAt : graceEnd;
              await tx.update(apiTokens).set({ expiresAt: graceExpiry }).where(and(eq(apiTokens.id, current.tokenId), isNull(apiTokens.revokedAt)));
            } else {
              const [daemon] = await tx.insert(daemons).values({ ownerId: context.userId, tokenId: minted.id, hostname: input.hostname, version: input.version, lastHeartbeatAt: timestamp }).returning({ id: daemons.id });
              daemonId = daemon!.id;
            }
          }
          // Rotated credentials of this owner and hostname whose grace has passed are revoked here.
          await tx.update(apiTokens).set({ revokedAt: timestamp }).where(and(eq(apiTokens.userId, context.userId), eq(apiTokens.daemonOnly, true), eq(apiTokens.name, `Daemon @ ${input.hostname}`),
            isNull(apiTokens.revokedAt), ne(apiTokens.id, activeTokenId), lte(apiTokens.expiresAt, timestamp)));
          const memberships = await tx.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, context.userId));
          for (const { workspaceId } of memberships) for (const agentCli of input.agentClis) {
            const [runtime] = await tx.insert(runtimes).values({ workspaceId, daemonId, ownerId: context.userId, agentCli, lastSeenAt: timestamp })
              .onConflictDoUpdate({ target: [runtimes.workspaceId, runtimes.daemonId, runtimes.agentCli], set: { lastSeenAt: timestamp } }).returning({ id: runtimes.id });
            // The Full access profile is the starting profile of a new Runtime only. An owner who deleted or renamed it must not get it back at every registration.
            if (runtime) {
              const [existing] = await tx.select({ id: runtimeProfiles.id }).from(runtimeProfiles).where(eq(runtimeProfiles.runtimeId, runtime.id)).limit(1);
              if (!existing) await tx.insert(runtimeProfiles).values({ runtimeId: runtime.id, name: "Full access", sandbox: "full" }).onConflictDoNothing();
            }
          }
          // A CLI that is no longer detected stops looking online while the Daemon keeps heartbeating.
          await tx.update(runtimes).set({ lastSeenAt: new Date(0) }).where(and(eq(runtimes.daemonId, daemonId), input.agentClis.length ? notInArray(runtimes.agentCli, input.agentClis) : sql`true`));
          return { daemonId, daemonToken, workspaceIds: memberships.map((membership) => membership.workspaceId) };
        });
        const visible = (await Promise.all(registered.workspaceIds.map((workspaceId) => visibleRuntimes(context.userId, workspaceId)))).flat().filter((runtime) => runtime.daemonId === registered.daemonId);
        return { daemonId: registered.daemonId, runtimes: visible, ...(registered.daemonToken ? { daemonToken: registered.daemonToken } : {}) };
      },
    },
    listRuntimes: {
      name: "list_runtimes", kind: "read" as const,
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }) }), output: Type.Array(output),
      handler: async (context: Context, input: { workspaceId: string }) => visibleRuntimes(context.userId, input.workspaceId),
    },
    listRuntimeProfiles: {
      name: "list_runtime_profiles", kind: "read" as const,
      input: Type.Object({ runtimeId: Type.String({ format: "uuid" }) }),
      output: Type.Array(Type.Object({ id: Type.String({ format: "uuid" }), runtimeId: Type.String({ format: "uuid" }), name: Type.String(), sandbox: Type.String(), filesystemAllowlist: Type.Array(Type.String()), networkAllowlist: Type.Array(Type.String()) })),
      handler: async (context: Context, input: { runtimeId: string }) => {
        const [runtime] = await db.select({ workspaceId: runtimes.workspaceId, ownerId: runtimes.ownerId, shared: runtimes.shared }).from(runtimes).where(eq(runtimes.id, input.runtimeId));
        if (!runtime) throw new ActionError("Runtime not found", 404);
        if (runtime.ownerId !== context.userId && !runtime.shared) throw new ActionError("Runtime not found", 404);
        const role = await requireWorkspaceRole(db, context.userId, runtime.workspaceId, "read");
        const rows = await db.select().from(runtimeProfiles).where(eq(runtimeProfiles.runtimeId, input.runtimeId)).orderBy(runtimeProfiles.name);
        // Folder paths on the owner's computer are shown to the owner and to workspace Admins only.
        const mayReadPaths = runtime.ownerId === context.userId || role === "Admin";
        return mayReadPaths ? rows : rows.map((row) => ({ ...row, filesystemAllowlist: [] }));
      },
    },
    createRuntimeProfile: {
      name: "create_runtime_profile", kind: "write" as const,
      input: Type.Object({ runtimeId: Type.String({ format: "uuid" }), name: Type.String({ minLength: 1, maxLength: 80 }), sandbox: Type.Union([Type.Literal("full"), Type.Literal("read-only"), Type.Literal("run-folder")]), filesystemAllowlist: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 30 }), networkAllowlist: Type.Array(Type.String({ maxLength: 253 }), { maxItems: 100 }) }),
      output: Type.Object({ id: Type.String({ format: "uuid" }), runtimeId: Type.String({ format: "uuid" }), name: Type.String(), sandbox: Type.String(), filesystemAllowlist: Type.Array(Type.String()), networkAllowlist: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { runtimeId: string; name: string; sandbox: "full" | "read-only" | "run-folder"; filesystemAllowlist: string[]; networkAllowlist: string[] }) => {
        const runtime = await ownedRuntime(context.userId, input.runtimeId);
        if (input.sandbox === "full" && (input.filesystemAllowlist.length || input.networkAllowlist.length)) throw new ActionError("Full access profiles do not use allowlists", 400);
        const [profile] = await db.insert(runtimeProfiles).values({ ...input }).returning();
        await auditAgentChange(db, { workspaceId: runtime.workspaceId, entityType: "runtime", entityId: runtime.id, field: "profile_created", oldValue: null, newValue: { id: profile!.id, name: input.name, sandbox: input.sandbox }, actorId: context.userId });
        return profile!;
      },
    },
    updateRuntimeProfile: {
      name: "update_runtime_profile", kind: "write" as const,
      input: Type.Object({ profileId: Type.String({ format: "uuid" }), name: Type.String({ minLength: 1, maxLength: 80 }), sandbox: Type.Union([Type.Literal("full"), Type.Literal("read-only"), Type.Literal("run-folder")]), filesystemAllowlist: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 30 }), networkAllowlist: Type.Array(Type.String({ maxLength: 253 }), { maxItems: 100 }) }),
      output: Type.Object({ id: Type.String({ format: "uuid" }), runtimeId: Type.String({ format: "uuid" }), name: Type.String(), sandbox: Type.String(), filesystemAllowlist: Type.Array(Type.String()), networkAllowlist: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { profileId: string; name: string; sandbox: "full" | "read-only" | "run-folder"; filesystemAllowlist: string[]; networkAllowlist: string[] }) => {
        const [prior] = await db.select().from(runtimeProfiles).where(eq(runtimeProfiles.id, input.profileId));
        if (!prior) throw new ActionError("Runtime profile not found", 404);
        const runtime = await ownedRuntime(context.userId, prior.runtimeId);
        if (input.sandbox === "full" && (input.filesystemAllowlist.length || input.networkAllowlist.length)) throw new ActionError("Full access profiles do not use allowlists", 400);
        const [updated] = await db.update(runtimeProfiles).set({ name: input.name, sandbox: input.sandbox, filesystemAllowlist: input.filesystemAllowlist, networkAllowlist: input.networkAllowlist }).where(eq(runtimeProfiles.id, prior.id)).returning();
        await auditAgentChange(db, { workspaceId: runtime.workspaceId, entityType: "runtime", entityId: runtime.id, field: "profile_updated", oldValue: { name: prior.name, sandbox: prior.sandbox, filesystemAllowlist: prior.filesystemAllowlist, networkAllowlist: prior.networkAllowlist }, newValue: { name: input.name, sandbox: input.sandbox, filesystemAllowlist: input.filesystemAllowlist, networkAllowlist: input.networkAllowlist }, actorId: context.userId });
        return updated!;
      },
    },
    deleteRuntimeProfile: {
      name: "delete_runtime_profile", kind: "write" as const,
      input: Type.Object({ profileId: Type.String({ format: "uuid" }) }), output: Type.Object({ deleted: Type.Boolean() }),
      handler: async (context: Context, input: { profileId: string }) => {
        const { prior, runtime } = await db.transaction(async (transaction) => {
          const database = transaction as unknown as Database;
          const [found] = await database.select().from(runtimeProfiles).where(eq(runtimeProfiles.id, input.profileId));
          if (!found) throw new ActionError("Runtime profile not found", 404);
          const owned = await ownedRuntime(context.userId, found.runtimeId);
          await database.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, owned.id)).for("update");
          const [count] = await database.select({ count: sql<number>`count(*)::int` }).from(runtimeProfiles).where(eq(runtimeProfiles.runtimeId, owned.id));
          if (count!.count < 2) throw new ActionError("A Runtime must keep at least one profile", 400);
          const [bound] = await database.select({ count: sql<number>`count(*)::int` }).from(agents).where(eq(agents.runtimeProfileId, found.id));
          if (bound!.count > 0) throw new ActionError("Move every Agent to another profile before deleting this one", 400);
          await database.delete(runtimeProfiles).where(eq(runtimeProfiles.id, found.id));
          return { prior: found, runtime: owned };
        });
        await auditAgentChange(db, { workspaceId: runtime.workspaceId, entityType: "runtime", entityId: runtime.id, field: "profile_deleted", oldValue: { id: prior.id, name: prior.name, sandbox: prior.sandbox }, newValue: null, actorId: context.userId });
        return { deleted: true };
      },
    },
    setRuntimeSandboxEnforcement: {
      name: "set_runtime_sandbox_enforcement", kind: "write" as const,
      input: Type.Object({ runtimeId: Type.String({ format: "uuid" }), enforceSandbox: Type.Boolean() }), output: Type.Object({ id: Type.String(), enforceSandbox: Type.Boolean() }),
      handler: async (context: Context, input: { runtimeId: string; enforceSandbox: boolean }) => {
        const prior = await ownedRuntime(context.userId, input.runtimeId);
        await db.update(runtimes).set({ enforceSandbox: input.enforceSandbox }).where(eq(runtimes.id, prior.id));
        await auditAgentChange(db, { workspaceId: prior.workspaceId, entityType: "runtime", entityId: prior.id, field: "enforce_sandbox", oldValue: prior.enforceSandbox, newValue: input.enforceSandbox, actorId: context.userId });
        return { id: prior.id, enforceSandbox: input.enforceSandbox };
      },
    },
    shareRuntime: {
      name: "share_runtime", kind: "write" as const,
      input: Type.Object({ runtimeId: Type.String({ format: "uuid" }) }), output: Type.Object({ id: Type.String({ format: "uuid" }), shared: Type.Boolean() }),
      handler: async (context: Context, input: { runtimeId: string }) => setShared(context.userId, input.runtimeId, true),
    },
    unshareRuntime: {
      name: "unshare_runtime", kind: "write" as const,
      input: Type.Object({ runtimeId: Type.String({ format: "uuid" }) }), output: Type.Object({ id: Type.String({ format: "uuid" }), shared: Type.Boolean() }),
      handler: async (context: Context, input: { runtimeId: string }) => setShared(context.userId, input.runtimeId, false),
    },
    heartbeat: async (context: Context, daemonId: string) => {
      const [daemon] = await db.update(daemons).set({ lastHeartbeatAt: now() }).where(and(eq(daemons.id, daemonId), eq(daemons.ownerId, context.userId))).returning({ id: daemons.id });
      if (!daemon) throw new ActionError("Daemon not found", 404);
      await db.update(runtimes).set({ lastSeenAt: now() }).where(and(eq(runtimes.daemonId, daemon.id), sql`${runtimes.lastSeenAt} > to_timestamp(1)`));
    },
    markTokenDaemonsOffline: async (tokenId: string) => {
      const [daemon] = await db.select({ id: daemons.id }).from(daemons).where(eq(daemons.tokenId, tokenId));
      if (daemon) await db.update(runtimes).set({ lastSeenAt: new Date(0) }).where(eq(runtimes.daemonId, daemon.id));
    },
  };

  async function setShared(userId: string, runtimeId: string, shared: boolean) {
    const [runtime] = await db.select({ id: runtimes.id, workspaceId: runtimes.workspaceId, ownerId: runtimes.ownerId, shared: runtimes.shared }).from(runtimes).where(eq(runtimes.id, runtimeId));
    if (!runtime) throw new ActionError("Runtime not found", 404);
    if (runtime.ownerId !== userId) throw new ActionError("Only the Runtime owner can change sharing", 403);
    await requireWorkspaceRole(db, userId, runtime.workspaceId, shared ? "write" : "read");
    if (runtime.shared === shared) return { id: runtimeId, shared };
    await db.update(runtimes).set({ shared }).where(eq(runtimes.id, runtimeId));
    await auditAgentChange(db, { workspaceId: runtime.workspaceId, entityType: "runtime", entityId: runtime.id, field: "shared", oldValue: runtime.shared, newValue: shared, actorId: userId });
    if (!shared) {
      const bound = await db.select({ id: agents.id }).from(agents).where(eq(agents.runtimeId, runtime.id));
      for (const agent of bound) await revokeAgentRuns(db, agent.id, userId, "Runtime sharing was revoked");
    }
    return { id: runtimeId, shared };
  }

  async function ownedRuntime(userId: string, runtimeId: string) {
    const [runtime] = await db.select({ id: runtimes.id, workspaceId: runtimes.workspaceId, ownerId: runtimes.ownerId, enforceSandbox: runtimes.enforceSandbox }).from(runtimes).where(eq(runtimes.id, runtimeId));
    if (!runtime) throw new ActionError("Runtime not found", 404);
    if (runtime.ownerId !== userId) throw new ActionError("Only the Runtime owner can change profiles", 403);
    await requireWorkspaceRole(db, userId, runtime.workspaceId, "read");
    return runtime;
  }
}
