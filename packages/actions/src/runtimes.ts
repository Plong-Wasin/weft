import { Type } from "@sinclair/typebox";
import { and, eq, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, apiTokens, daemons, runtimes, users, workspaceMembers } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { revokeAgentRuns } from "./runs";
import { auditAgentChange } from "./agent-audit";

const freshForMs = 150_000;
const cli = Type.Union([Type.Literal("claude"), Type.Literal("codex")]);
type Context = { userId: string; apiTokenId?: string };

export function createRuntimeActions(db: Database, now: () => Date = () => new Date()) {
  const output = Type.Object({
    id: Type.String({ format: "uuid" }), workspaceId: Type.String({ format: "uuid" }), ownerId: Type.String(), ownerName: Type.String(),
    daemonId: Type.String({ format: "uuid" }), hostname: Type.String(), agentCli: cli, shared: Type.Boolean(), online: Type.Boolean(), lastSeenAt: Type.String(),
  });
  async function visibleRuntimes(userId: string, workspaceId: string) {
    await requireWorkspaceRole(db, userId, workspaceId, "read");
    const freshAfter = new Date(now().getTime() - freshForMs);
    return db.select({ id: runtimes.id, workspaceId: runtimes.workspaceId, ownerId: runtimes.ownerId, ownerName: users.name,
      daemonId: daemons.id, hostname: daemons.hostname, agentCli: runtimes.agentCli, shared: runtimes.shared,
      online: sql<boolean>`${runtimes.lastSeenAt} > ${freshAfter.toISOString()}::timestamptz`, lastSeenAt: runtimes.lastSeenAt,
    }).from(runtimes).innerJoin(daemons, eq(daemons.id, runtimes.daemonId)).innerJoin(users, eq(users.id, runtimes.ownerId))
      .where(and(eq(runtimes.workspaceId, workspaceId), or(eq(runtimes.ownerId, userId), eq(runtimes.shared, true))))
      .orderBy(users.name, runtimes.agentCli);
  }
  return {
    registerDaemon: {
      name: "register_daemon", kind: "write" as const,
      input: Type.Object({ hostname: Type.String({ minLength: 1, maxLength: 255 }), version: Type.String({ minLength: 1, maxLength: 64 }), agentClis: Type.Array(cli, { uniqueItems: true }) }),
      output: Type.Object({ daemonId: Type.String({ format: "uuid" }), runtimes: Type.Array(output) }),
      handler: async (context: Context, input: { hostname: string; version: string; agentClis: Array<"claude" | "codex"> }) => {
        if (!context.apiTokenId) throw new ActionError("Daemon registration requires a Personal API token", 403);
        await db.update(apiTokens).set({ daemonOnly: true, expiresAt: new Date(now().getTime() + 30 * 24 * 60 * 60 * 1000) }).where(eq(apiTokens.id, context.apiTokenId));
        const [daemon] = await db.insert(daemons).values({ ownerId: context.userId, tokenId: context.apiTokenId, hostname: input.hostname, version: input.version, lastHeartbeatAt: now() })
          .onConflictDoUpdate({ target: daemons.tokenId, set: { hostname: input.hostname, version: input.version, lastHeartbeatAt: now() } }).returning();
        const memberships = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, context.userId));
        const timestamp = now();
        for (const { workspaceId } of memberships) for (const agentCli of input.agentClis) {
          await db.insert(runtimes).values({ workspaceId, daemonId: daemon!.id, ownerId: context.userId, agentCli, lastSeenAt: timestamp })
            .onConflictDoUpdate({ target: [runtimes.workspaceId, runtimes.daemonId, runtimes.agentCli], set: { lastSeenAt: timestamp } });
        }
        // A CLI that is no longer detected stops looking online while the Daemon keeps heartbeating.
        await db.update(runtimes).set({ lastSeenAt: new Date(0) }).where(and(eq(runtimes.daemonId, daemon!.id), input.agentClis.length ? notInArray(runtimes.agentCli, input.agentClis) : sql`true`));
        return { daemonId: daemon!.id, runtimes: (await Promise.all(memberships.map(({ workspaceId }) => visibleRuntimes(context.userId, workspaceId)))).flat().filter((runtime) => runtime.daemonId === daemon!.id) };
      },
    },
    listRuntimes: {
      name: "list_runtimes", kind: "read" as const,
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }) }), output: Type.Array(output),
      handler: async (context: Context, input: { workspaceId: string }) => visibleRuntimes(context.userId, input.workspaceId),
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
}
