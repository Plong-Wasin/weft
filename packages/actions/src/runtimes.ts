import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agentAccess, agents, apiTokens, cliDevices, daemons, projectMembers, projects, runs, runtimes, runtimeProfiles, users, workItems, workspaceMembers } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { revokeAgentRuns } from "./runs";
import { auditAgentChange } from "./agent-audit";
import { DAEMON_ROTATION_GRACE_MS, DEFAULT_TOKEN_MS, lockCliDeviceLifecycle, mintApiToken } from "./api-tokens";
import { initializeAgentAccess } from "./agent-access";

const freshForMs = 150_000;
/** A Runtime last seen longer ago than this is offline for good: the hourly cleanup removes it when nothing uses it. */
export const staleRuntimeMs = 7 * 24 * 60 * 60 * 1000;
/** The hourly cleanup removes at most this many stale Runtimes per round, oldest first. */
export const staleRuntimeRoundLimit = 500;
/** A round takes no new Runtime once this much time has passed, so it never holds the worker for long. */
export const staleRuntimeRoundBudgetMs = 30_000;
/** A Daemon credential is re-issued once less than this much of its lifetime is left. */
const rotateBeforeMs = 7 * 24 * 60 * 60 * 1000;
const cli = Type.Union([Type.Literal("claude"), Type.Literal("codex")]);
const daemonCapability = Type.Union([Type.Literal("runtime_environment"), Type.Literal("runtime_sandbox")]);
/** How many Session folders the Runtime list shows per Runtime, newest first. */
const sessionFolderLimit = 10;
/** Run statuses that are not final: a Runtime with one of them on it cannot be deleted. */
const unfinishedRunStatuses = ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"] as const;
type Context = { userId: string; apiTokenId?: string };

/**
 * The Daemon row a Daemon credential speaks for. A credential rotated within the grace period has no row of its own,
 * so it speaks for the row of the same owner and hostname (the credential name is `Daemon @ <hostname>`).
 */
export async function daemonForCredential(db: Database, credential: { tokenId: string; userId: string }) {
  const [direct] = await db.select({ id: daemons.id, tokenId: daemons.tokenId }).from(daemons).where(eq(daemons.tokenId, credential.tokenId));
  if (direct) return direct;
  const [token] = await db.select({ name: apiTokens.name, cliDeviceId: apiTokens.cliDeviceId }).from(apiTokens).where(eq(apiTokens.id, credential.tokenId));
  if (token?.cliDeviceId) {
    const [row] = await db.select({ id: daemons.id, tokenId: daemons.tokenId }).from(daemons)
      .where(and(eq(daemons.ownerId, credential.userId), eq(daemons.cliDeviceId, token.cliDeviceId))).limit(1);
    return row;
  }
  const prefix = "Daemon @ ";
  if (!token?.name.startsWith(prefix)) return undefined;
  const [row] = await db.select({ id: daemons.id, tokenId: daemons.tokenId }).from(daemons)
    .where(and(eq(daemons.ownerId, credential.userId), eq(daemons.hostname, token.name.slice(prefix.length)), isNull(daemons.cliDeviceId))).orderBy(desc(daemons.lastHeartbeatAt)).limit(1);
  return row;
}

/**
 * The Runtime that bound Agents move to: shared, in the same workspace, and not the one being deleted. Another workspace or a private Runtime is reported as not found to the caller.
 * Locked for share so it cannot be deleted between this check and the move.
 */
async function moveTargetOf(database: Database, runtime: { id: string; workspaceId: string }, moveTo: string) {
  if (moveTo === runtime.id) throw new ActionError("Choose another Runtime to move the Agents to", 400);
  const [target] = await database.select({ id: runtimes.id, ownerId: runtimes.ownerId, enforceSandbox: runtimes.enforceSandbox }).from(runtimes)
    .where(and(eq(runtimes.id, moveTo), eq(runtimes.workspaceId, runtime.workspaceId), eq(runtimes.shared, true))).for("share");
  if (!target) throw new ActionError("The target Runtime must be shared with this workspace", 400);
  return target;
}

/** The starting profile of an Agent on a Runtime, by the same rule as binding an Agent in the Agent editor: the restricted one when the Runtime enforces a sandbox, otherwise Full access. */
async function startingProfileOf(database: Database, runtime: { id: string; enforceSandbox: boolean }) {
  const profiles = await database.select({ id: runtimeProfiles.id, sandbox: runtimeProfiles.sandbox }).from(runtimeProfiles).where(eq(runtimeProfiles.runtimeId, runtime.id));
  if (runtime.enforceSandbox) {
    const restricted = profiles.find((profile) => profile.sandbox === "run-folder") ?? profiles.find((profile) => profile.sandbox === "read-only");
    if (!restricted) throw new ActionError("This Runtime requires a sandbox but has no restricted profile. Ask the Runtime owner to add one.", 400);
    return restricted.id;
  }
  return profiles.find((profile) => profile.sandbox === "full")?.id ?? profiles[0]?.id ?? null;
}

/** Runs that are not finished and belong to this Runtime: claimed by it, or of an Agent bound to it. */
async function unfinishedRunsOf(database: Database, runtimeId: string) {
  const [row] = await database.select({ count: sql<number>`count(*)::int` }).from(runs)
    .where(and(inArray(runs.status, [...unfinishedRunStatuses]), or(eq(runs.runtimeId, runtimeId), inArray(runs.agentId, database.select({ id: agents.id }).from(agents).where(eq(agents.runtimeId, runtimeId))))));
  return row!.count;
}

/** What an Admin chose for the Agents still bound to a Runtime being deleted: back to the Weft server, or moved to another shared Runtime. */
type BoundAgentsChoice = "unbind" | { moveTo: string };

/**
 * Deletes one Runtime under its row lock, once no unfinished Run waits on it and, unless an Admin chose what happens to the bound
 * Agents, no enabled Agent is bound to it. `authorize` runs under the same lock, before those checks. A null actor is the system
 * (the hourly cleanup), which never chooses for the bound Agents.
 */
async function deleteRuntimeLocked(transaction: Database, runtimeId: string, actorId: string | null, options: {
  boundAgents?: BoundAgentsChoice; authorize: (runtime: { id: string; workspaceId: string; ownerId: string; lastSeenAt: Date }) => Promise<void>;
}) {
  // Binding moves and deletes that move Agents may touch two Runtimes; lock both in the same stable order as update_agent.
  const [observed] = await transaction.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtimeId));
  if (!observed) throw new ActionError("Runtime not found", 404);
  const lockIds = [...new Set([runtimeId, ...(typeof options.boundAgents === "object" ? [options.boundAgents.moveTo] : [])])].sort();
  await transaction.select({ id: runtimes.id }).from(runtimes).where(inArray(runtimes.id, lockIds)).orderBy(runtimes.id).for("update");
  const [runtime] = await transaction.select({ id: runtimes.id, workspaceId: runtimes.workspaceId, ownerId: runtimes.ownerId, agentCli: runtimes.agentCli, daemonId: runtimes.daemonId, lastSeenAt: runtimes.lastSeenAt })
    .from(runtimes).where(eq(runtimes.id, runtimeId));
  if (!runtime) throw new ActionError("Runtime not found", 404);
  await options.authorize(runtime);
  const [daemon] = await transaction.select({ hostname: daemons.hostname }).from(daemons).where(eq(daemons.id, runtime.daemonId));
  const bound = await transaction.select({ id: agents.id, enabled: agents.enabled }).from(agents).where(eq(agents.runtimeId, runtime.id));
  const unfinished = await unfinishedRunsOf(transaction, runtime.id);
  const inUse = () => new ActionError("This Runtime is still in use: an enabled Agent is bound to it, or a Run of it is not finished.", 409, "runtime_in_use");
  // Unfinished Runs refuse every option: the Admin cancels them or waits for them first.
  if (unfinished > 0) throw inUse();
  if (options.boundAgents === undefined && bound.some((agent) => agent.enabled)) throw inUse();
  const target = typeof options.boundAgents === "object" ? await moveTargetOf(transaction, runtime, options.boundAgents.moveTo) : null;
  const targetProfileId = target ? await startingProfileOf(transaction, target) : null;
  for (const agent of bound) {
    if (target) {
      // The Agent keeps running on the target. Its previous Session belongs to the old Runtime, so its next Run starts a new one there.
      await transaction.update(agents).set({ runtimeId: target.id, runtimeEnvironment: null, runtimeProfileId: targetProfileId, autopilot: true }).where(eq(agents.id, agent.id));
      // The people allowed to assign or mention the Agent reset to the target's owner alone when the owner changes; the same owner keeps the list.
      if (target.ownerId !== runtime.ownerId) {
        await transaction.delete(agentAccess).where(eq(agentAccess.agentId, agent.id));
        await transaction.insert(agentAccess).values({ agentId: agent.id, userId: target.ownerId });
      }
    } else {
      // A disabled Agent does not block: its binding goes, and its Autopilot with it, so enabling it later never starts a server-side Autopilot Agent.
      // Its access list resets the way the Agent editor resets it when the Runtime is cleared.
      await transaction.update(agents).set({ runtimeId: null, runtimeEnvironment: null, runtimeProfileId: null, autopilot: false }).where(eq(agents.id, agent.id));
      await transaction.delete(agentAccess).where(eq(agentAccess.agentId, agent.id));
      await initializeAgentAccess(transaction, agent.id);
    }
    await auditAgentChange(transaction, { workspaceId: runtime.workspaceId, entityType: "agent", entityId: agent.id, field: "runtime", oldValue: runtime.id, newValue: target?.id ?? null, actorId });
  }
  // Profiles cascade with the row, and sharing ends with it. Session folders on the computer are left to the Daemon's own sweep.
  await transaction.delete(runtimes).where(eq(runtimes.id, runtime.id));
  await auditAgentChange(transaction, { workspaceId: runtime.workspaceId, entityType: "runtime", entityId: runtime.id, field: "deleted", oldValue: { ownerId: runtime.ownerId, agentCli: runtime.agentCli, hostname: daemon?.hostname ?? null }, newValue: null, actorId });
}

export interface StaleRuntimeRound {
  deleted: number;
  /** Refused at the locked re-check (in use, or seen again) or already gone. */
  skipped: number;
  /** Failed with an error other than a refusal: logged, and the round went on. */
  failed: number;
}

/**
 * The hourly cleanup: deletes Runtimes last seen more than `staleRuntimeMs` before `now`, with no enabled Agent bound and no
 * unfinished Run, oldest first. Each candidate is re-checked under its row lock in its own transaction, so one failure or
 * refusal never stops the round. The epoch marks a Runtime whose offline time is unknown: it is never removed.
 * `beforeRecheck` is a test seam that runs after a candidate is picked and before its locked re-check.
 */
export async function purgeStaleRuntimes(database: Database, now: Date, options: { limit?: number; budgetMs?: number; beforeRecheck?: (runtimeId: string) => Promise<void> } = {}): Promise<StaleRuntimeRound> {
  const started = Date.now();
  const threshold = new Date(now.getTime() - staleRuntimeMs);
  const epoch = new Date(1000);
  const candidates = await database.select({ id: runtimes.id }).from(runtimes)
    // A Runtime kept by an enabled Agent is left out here, so a pile of old kept ones cannot use up the round's limit; the locked re-check below still decides.
    .where(and(lt(runtimes.lastSeenAt, threshold), gt(runtimes.lastSeenAt, epoch), sql`not exists (select 1 from agents where agents.runtime_id = ${runtimes.id} and agents.enabled = true)`))
    .orderBy(asc(runtimes.lastSeenAt), asc(runtimes.id)).limit(options.limit ?? staleRuntimeRoundLimit);
  const round: StaleRuntimeRound = { deleted: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    if (Date.now() - started >= (options.budgetMs ?? staleRuntimeRoundBudgetMs)) break;
    try {
      await options.beforeRecheck?.(candidate.id);
      await database.transaction(async (transaction) => deleteRuntimeLocked(transaction as unknown as Database, candidate.id, null, {
        authorize: async (runtime) => {
          // A heartbeat may have seen the Runtime again since it was picked: then it is not stale any more.
          if (runtime.lastSeenAt >= threshold || runtime.lastSeenAt <= epoch) throw new ActionError("Runtime was seen again", 409, "runtime_seen_again");
        },
      }));
      round.deleted += 1;
    } catch (error) {
      if (error instanceof ActionError && (error.status === 409 || error.status === 404)) { round.skipped += 1; continue; }
      round.failed += 1;
      console.error(`Stale Runtime ${candidate.id} was not removed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return round;
}

export function createRuntimeActions(db: Database, now: () => Date = () => new Date()) {
  const output = Type.Object({
    id: Type.String({ format: "uuid" }), workspaceId: Type.String({ format: "uuid" }), ownerId: Type.String(), ownerName: Type.String(),
    daemonId: Type.String({ format: "uuid" }), hostname: Type.String(), agentCli: cli, shared: Type.Boolean(), enforceSandbox: Type.Boolean(), online: Type.Boolean(), lastSeenAt: Type.String(),
    /** Seconds since the Runtime was last seen; null while it is online, and when the time is unknown (the Daemon reset it to the epoch). */
    offlineSeconds: Type.Union([Type.Integer(), Type.Null()]),
    agents: Type.Array(Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String(), enabled: Type.Boolean() })),
    /** Queued Runs of the Agents bound to this Runtime: they wait for it. */
    waitingRuns: Type.Integer(),
    /** Runs of this Runtime, or of the Agents bound to it, that are not finished: the Runtime cannot be deleted while any is. */
    unfinishedRuns: Type.Integer(),
    /** The newest Session folders of this Runtime's Runs, that the viewer may see the work item of. */
    sessionFolders: Type.Array(Type.Object({
      folder: Type.String(), workItem: Type.Object({ id: Type.String({ format: "uuid" }), displayId: Type.String(), title: Type.String() }), lastUsedAt: Type.String(),
    })),
  });
  async function visibleRuntimes(userId: string, workspaceId: string) {
    const workspaceRole = await requireWorkspaceRole(db, userId, workspaceId, "read");
    const freshAfter = new Date(now().getTime() - freshForMs);
    const rows = await db.select({ id: runtimes.id, workspaceId: runtimes.workspaceId, ownerId: runtimes.ownerId, ownerName: users.name,
      daemonId: daemons.id, hostname: daemons.hostname, agentCli: runtimes.agentCli, shared: runtimes.shared, enforceSandbox: runtimes.enforceSandbox,
      online: sql<boolean>`${runtimes.lastSeenAt} > ${freshAfter.toISOString()}::timestamptz and not ${runtimes.stopped}`, lastSeenAt: runtimes.lastSeenAt,
    }).from(runtimes).innerJoin(daemons, eq(daemons.id, runtimes.daemonId)).innerJoin(users, eq(users.id, runtimes.ownerId))
      .where(and(eq(runtimes.workspaceId, workspaceId), or(eq(runtimes.ownerId, userId), eq(runtimes.shared, true))))
      .orderBy(users.name, runtimes.agentCli);
    // Work item titles reach the viewer only from projects the viewer can read: all for an Admin, otherwise public ones and the private ones they belong to.
    const projectIds = workspaceRole === "Admin" ? undefined : await readableProjectIds(userId, workspaceId);
    return Promise.all(rows.map(async (row) => {
      const bound = await db.select({ id: agents.id, name: users.name, enabled: agents.enabled }).from(agents).innerJoin(users, eq(users.id, agents.userId))
        .where(eq(agents.runtimeId, row.id)).orderBy(users.name);
      const [waiting] = await db.select({ count: sql<number>`count(*)::int` }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
        .where(and(eq(agents.runtimeId, row.id), eq(runs.status, "queued")));
      const folderRows = projectIds && projectIds.length === 0 ? [] : await db.select({
        folder: runs.sessionFolder, workItemId: workItems.id, title: workItems.title, sequence: workItems.sequence, projectKey: projects.key,
        lastUsedAt: sql<Date>`max(coalesce(${runs.dispatchedAt}, ${runs.createdAt}))`,
      }).from(runs).innerJoin(workItems, eq(workItems.id, runs.workItemId)).innerJoin(projects, eq(projects.id, workItems.projectId))
        .where(and(eq(runs.runtimeId, row.id), isNotNull(runs.sessionFolder), ...(projectIds ? [inArray(workItems.projectId, projectIds)] : [])))
        .groupBy(runs.sessionFolder, workItems.id, workItems.title, workItems.sequence, projects.key)
        .orderBy(desc(sql`max(coalesce(${runs.dispatchedAt}, ${runs.createdAt}))`), desc(workItems.id)).limit(sessionFolderLimit);
      // A Runtime whose last-seen time is the epoch went offline before its time was kept: that time is unknown, and no cleanup may treat it as old.
      const offlineSeconds = row.online || row.lastSeenAt.getTime() <= 1000 ? null : Math.max(0, Math.floor((now().getTime() - row.lastSeenAt.getTime()) / 1000));
      const { lastSeenAt, ...rest } = row;
      return {
        ...rest, lastSeenAt: lastSeenAt.toISOString(), offlineSeconds, agents: bound, waitingRuns: waiting?.count ?? 0, unfinishedRuns: await unfinishedRunsOf(db, row.id),
        sessionFolders: folderRows.map((folder) => ({ folder: folder.folder!, workItem: { id: folder.workItemId, displayId: `${folder.projectKey}-${folder.sequence}`, title: folder.title }, lastUsedAt: new Date(folder.lastUsedAt).toISOString() })),
      };
    }));
  }
  return {
    registerDaemon: {
      name: "register_daemon", kind: "write" as const,
      input: Type.Object({
        hostname: Type.String({ minLength: 1, maxLength: 255 }), version: Type.String({ minLength: 1, maxLength: 64 }), agentClis: Type.Array(cli, { uniqueItems: true }),
        /** Optional for old Daemons; omission means they support no negotiated features. */
        capabilities: Type.Optional(Type.Array(daemonCapability, { uniqueItems: true })),
        /** Set when the Daemon has no local credential file, or a Daemon credential was refused: the server then issues a new one even if the active one is fine. */
        rotate: Type.Optional(Type.Boolean()),
      }),
      output: Type.Object({ daemonId: Type.String({ format: "uuid" }), runtimes: Type.Array(output), daemonToken: Type.Optional(Type.String()) }),
      handler: async (context: Context, input: { hostname: string; version: string; agentClis: Array<"claude" | "codex">; capabilities?: Array<"runtime_environment" | "runtime_sandbox">; rotate?: boolean }) => {
        if (!context.apiTokenId) throw new ActionError("Daemon registration requires a Personal API token", 403);
        const [caller] = await db.select({ daemonOnly: apiTokens.daemonOnly, cliDeviceId: cliDevices.deviceId }).from(apiTokens)
          .leftJoin(cliDevices, and(eq(cliDevices.tokenId, apiTokens.id), eq(cliDevices.ownerId, context.userId))).where(eq(apiTokens.id, context.apiTokenId));
        if (!caller || caller.daemonOnly) throw new ActionError("Daemon registration requires a Personal API token", 403);
        const timestamp = now();
        const registered = await db.transaction(async (tx) => {
          if (caller.cliDeviceId) {
            await lockCliDeviceLifecycle(tx as unknown as Database, context.userId, caller.cliDeviceId);
            const [device] = await tx.select({ tokenId: cliDevices.tokenId }).from(cliDevices).where(and(
              eq(cliDevices.ownerId, context.userId), eq(cliDevices.deviceId, caller.cliDeviceId), eq(cliDevices.tokenId, context.apiTokenId!), isNull(cliDevices.revokedAt),
            )).for("update");
            if (!device) throw new ActionError("CLI device was revoked; run `weft login` to sign in again", 403);
          }
          // Enrolled devices have independent Daemon identities, even when two devices report the same hostname.
          const identity = caller.cliDeviceId ? `device:${caller.cliDeviceId}` : `hostname:${input.hostname}`;
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${context.userId}:${identity}`}))`);
          // Legacy registrations keep their hostname identity; an enrolled device keeps its own row and Runtimes.
          const [current] = await tx.select({ id: daemons.id, tokenId: daemons.tokenId, expiresAt: apiTokens.expiresAt, revokedAt: apiTokens.revokedAt, daemonOnly: apiTokens.daemonOnly })
            .from(daemons).innerJoin(apiTokens, eq(apiTokens.id, daemons.tokenId))
            .where(and(eq(daemons.ownerId, context.userId), caller.cliDeviceId ? eq(daemons.cliDeviceId, caller.cliDeviceId) : and(eq(daemons.hostname, input.hostname), isNull(daemons.cliDeviceId)))).orderBy(desc(daemons.lastHeartbeatAt)).limit(1);
          const activeLeftMs = current && current.daemonOnly && !current.revokedAt && current.expiresAt ? current.expiresAt.getTime() - timestamp.getTime() : -1;
          let daemonToken: string | undefined;
          let daemonId: string;
          let activeTokenId: string;
          if (current && !input.rotate && activeLeftMs >= rotateBeforeMs) {
            const [daemon] = await tx.update(daemons).set({ version: input.version, capabilities: input.capabilities ?? [], lastHeartbeatAt: timestamp }).where(eq(daemons.id, current.id)).returning({ id: daemons.id });
            daemonId = daemon!.id;
            activeTokenId = current.tokenId;
          } else {
            const minted = await mintApiToken(tx as unknown as Database, { userId: context.userId, name: `Daemon @ ${input.hostname}`, description: "Restricted Daemon credential", daemonOnly: true, cliDeviceId: caller.cliDeviceId, expiresAt: new Date(timestamp.getTime() + DEFAULT_TOKEN_MS) });
            daemonToken = minted.token;
            activeTokenId = minted.id;
            if (current) {
              const [daemon] = await tx.update(daemons).set({ tokenId: minted.id, cliDeviceId: caller.cliDeviceId, version: input.version, capabilities: input.capabilities ?? [], lastHeartbeatAt: timestamp }).where(eq(daemons.id, current.id)).returning({ id: daemons.id });
              daemonId = daemon!.id;
              // The previous credential stays usable for the grace period, never past its own expiry.
              const graceEnd = new Date(timestamp.getTime() + DAEMON_ROTATION_GRACE_MS);
              const graceExpiry = current.expiresAt && current.expiresAt < graceEnd ? current.expiresAt : graceEnd;
              await tx.update(apiTokens).set({ expiresAt: graceExpiry }).where(and(eq(apiTokens.id, current.tokenId), isNull(apiTokens.revokedAt)));
            } else {
              const [daemon] = await tx.insert(daemons).values({ ownerId: context.userId, tokenId: minted.id, cliDeviceId: caller.cliDeviceId, hostname: input.hostname, version: input.version, capabilities: input.capabilities ?? [], lastHeartbeatAt: timestamp }).returning({ id: daemons.id });
              daemonId = daemon!.id;
            }
          }
          // Rotated credentials of this owner and hostname whose grace has passed are revoked here.
          await tx.update(apiTokens).set({ revokedAt: timestamp }).where(and(eq(apiTokens.userId, context.userId), eq(apiTokens.daemonOnly, true), eq(apiTokens.name, `Daemon @ ${input.hostname}`),
            isNull(apiTokens.revokedAt), ne(apiTokens.id, activeTokenId), lte(apiTokens.expiresAt, timestamp)));
          const memberships = await tx.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, context.userId));
          for (const { workspaceId } of memberships) for (const agentCli of input.agentClis) {
            const [runtime] = await tx.insert(runtimes).values({ workspaceId, daemonId, ownerId: context.userId, agentCli, lastSeenAt: timestamp })
              .onConflictDoUpdate({ target: [runtimes.workspaceId, runtimes.daemonId, runtimes.agentCli], set: { lastSeenAt: timestamp, stopped: false } }).returning({ id: runtimes.id });
            // The Full access profile is the starting profile of a new Runtime only. An owner who deleted or renamed it must not get it back at every registration.
            if (runtime) {
              const [existing] = await tx.select({ id: runtimeProfiles.id }).from(runtimeProfiles).where(eq(runtimeProfiles.runtimeId, runtime.id)).limit(1);
              if (!existing) await tx.insert(runtimeProfiles).values({ runtimeId: runtime.id, name: "Full access", sandbox: "full" }).onConflictDoNothing();
            }
          }
          // A CLI that is no longer detected stops looking online while the Daemon keeps heartbeating.
          await tx.update(runtimes).set({ stopped: true }).where(and(eq(runtimes.daemonId, daemonId), input.agentClis.length ? notInArray(runtimes.agentCli, input.agentClis) : sql`true`));
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
        const profile = await db.transaction(async (transaction) => {
          const database = transaction as unknown as Database;
          const [locked] = await database.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtime.id)).for("update");
          if (!locked) throw new ActionError("Runtime not found", 404);
          const [created] = await database.insert(runtimeProfiles).values({ ...input }).returning();
          await auditAgentChange(database, { workspaceId: runtime.workspaceId, entityType: "runtime", entityId: runtime.id, field: "profile_created", oldValue: null, newValue: { id: created!.id, name: input.name, sandbox: input.sandbox }, actorId: context.userId });
          return created!;
        });
        return profile!;
      },
    },
    updateRuntimeProfile: {
      name: "update_runtime_profile", kind: "write" as const,
      input: Type.Object({ profileId: Type.String({ format: "uuid" }), name: Type.String({ minLength: 1, maxLength: 80 }), sandbox: Type.Union([Type.Literal("full"), Type.Literal("read-only"), Type.Literal("run-folder")]), filesystemAllowlist: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 30 }), networkAllowlist: Type.Array(Type.String({ maxLength: 253 }), { maxItems: 100 }) }),
      output: Type.Object({ id: Type.String({ format: "uuid" }), runtimeId: Type.String({ format: "uuid" }), name: Type.String(), sandbox: Type.String(), filesystemAllowlist: Type.Array(Type.String()), networkAllowlist: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { profileId: string; name: string; sandbox: "full" | "read-only" | "run-folder"; filesystemAllowlist: string[]; networkAllowlist: string[] }) => {
        const [found] = await db.select().from(runtimeProfiles).where(eq(runtimeProfiles.id, input.profileId));
        if (!found) throw new ActionError("Runtime profile not found", 404);
        const runtime = await ownedRuntime(context.userId, found.runtimeId);
        if (input.sandbox === "full" && (input.filesystemAllowlist.length || input.networkAllowlist.length)) throw new ActionError("Full access profiles do not use allowlists", 400);
        return db.transaction(async (transaction) => {
          const database = transaction as unknown as Database;
          await database.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtime.id)).for("update");
          const [prior] = await database.select().from(runtimeProfiles).where(and(eq(runtimeProfiles.id, input.profileId), eq(runtimeProfiles.runtimeId, runtime.id)));
          if (!prior) throw new ActionError("Runtime profile not found", 404);
          const [updated] = await database.update(runtimeProfiles).set({ name: input.name, sandbox: input.sandbox, filesystemAllowlist: input.filesystemAllowlist, networkAllowlist: input.networkAllowlist }).where(eq(runtimeProfiles.id, prior.id)).returning();
          await auditAgentChange(database, { workspaceId: runtime.workspaceId, entityType: "runtime", entityId: runtime.id, field: "profile_updated", oldValue: { name: prior.name, sandbox: prior.sandbox, filesystemAllowlist: prior.filesystemAllowlist, networkAllowlist: prior.networkAllowlist }, newValue: { name: input.name, sandbox: input.sandbox, filesystemAllowlist: input.filesystemAllowlist, networkAllowlist: input.networkAllowlist }, actorId: context.userId });
          return updated!;
        });
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
    deleteRuntime: {
      name: "delete_runtime", kind: "write" as const,
      input: Type.Object({
        runtimeId: Type.String({ format: "uuid" }),
        /** Workspace Admins only. Omitted: the delete is refused while an enabled Agent is bound. "unbind" sends each bound Agent back to the Weft server; `moveTo` keeps each one on another shared Runtime of the workspace, in a new Session. */
        boundAgents: Type.Optional(Type.Union([Type.Literal("unbind"), Type.Object({ moveTo: Type.String({ format: "uuid" }) })])),
      }),
      output: Type.Object({ deleted: Type.Boolean() }),
      handler: async (context: Context, input: { runtimeId: string; boundAgents?: BoundAgentsChoice }) => {
        await db.transaction(async (transaction) => deleteRuntimeLocked(transaction as unknown as Database, input.runtimeId, context.userId, {
          boundAgents: input.boundAgents,
          authorize: async (runtime) => {
            const role = await requireWorkspaceRole(transaction as unknown as Database, context.userId, runtime.workspaceId, "read");
            if (runtime.ownerId !== context.userId && role !== "Admin") throw new ActionError("Only the Runtime owner or a workspace Admin can delete a Runtime", 403);
            if (input.boundAgents !== undefined && role !== "Admin") throw new ActionError("Only a workspace Admin can unbind or move Agents when deleting a Runtime", 403);
          },
        }));
        return { deleted: true };
      },
    },
    setRuntimeSandboxEnforcement: {
      name: "set_runtime_sandbox_enforcement", kind: "write" as const,
      input: Type.Object({ runtimeId: Type.String({ format: "uuid" }), enforceSandbox: Type.Boolean() }), output: Type.Object({ id: Type.String(), enforceSandbox: Type.Boolean() }),
      handler: async (context: Context, input: { runtimeId: string; enforceSandbox: boolean }) => db.transaction(async (transaction) => {
        const database = transaction as unknown as Database;
        const [prior] = await database.select({ id: runtimes.id, ownerId: runtimes.ownerId, workspaceId: runtimes.workspaceId, enforceSandbox: runtimes.enforceSandbox })
          .from(runtimes).where(eq(runtimes.id, input.runtimeId)).for("update");
        if (!prior) throw new ActionError("Runtime not found", 404);
        if (prior.ownerId !== context.userId) throw new ActionError("Only the Runtime owner can change profiles", 403);
        await requireWorkspaceRole(database, context.userId, prior.workspaceId, "read");
        await database.update(runtimes).set({ enforceSandbox: input.enforceSandbox }).where(eq(runtimes.id, prior.id));
        await auditAgentChange(database, { workspaceId: prior.workspaceId, entityType: "runtime", entityId: prior.id, field: "enforce_sandbox", oldValue: prior.enforceSandbox, newValue: input.enforceSandbox, actorId: context.userId });
        return { id: prior.id, enforceSandbox: input.enforceSandbox };
      }),
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
    /** `runtimeIds` are the Runtimes the Daemon holds; the answer names those of them that no longer exist for this Daemon, so it can forget them. */
    heartbeat: async (context: Context, daemonId: string, runtimeIds: string[] = []) => {
      const [daemon] = await db.update(daemons).set({ lastHeartbeatAt: now() }).where(and(eq(daemons.id, daemonId), eq(daemons.ownerId, context.userId))).returning({ id: daemons.id });
      if (!daemon) throw new ActionError("Daemon not found", 404);
      // A stopped Runtime stays offline until its CLI is registered again; a row still at the epoch has an unknown time and is not revived either.
      await db.update(runtimes).set({ lastSeenAt: now() }).where(and(eq(runtimes.daemonId, daemon.id), eq(runtimes.stopped, false), sql`${runtimes.lastSeenAt} > to_timestamp(1)`));
      const named = [...new Set(runtimeIds)];
      if (named.length === 0) return { goneRuntimeIds: [] as string[] };
      const present = await db.select({ id: runtimes.id }).from(runtimes).where(and(eq(runtimes.daemonId, daemon.id), inArray(runtimes.id, named)));
      const presentIds = new Set(present.map((row) => row.id));
      return { goneRuntimeIds: named.filter((id) => !presentIds.has(id)) };
    },
    markTokenDaemonsOffline: async (tokenId: string) => {
      const [daemon] = await db.select({ id: daemons.id }).from(daemons).where(eq(daemons.tokenId, tokenId));
      // The last-seen time is kept: the Runtimes are offline since then, and the list can say for how long.
      if (daemon) await db.update(runtimes).set({ stopped: true }).where(eq(runtimes.daemonId, daemon.id));
    },
  };

  /** The projects a workspace member may read: the public ones and the private ones they belong to. */
  async function readableProjectIds(userId: string, workspaceId: string) {
    const member = await db.select({ projectId: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, userId));
    const mine = new Set(member.map((row) => row.projectId));
    const rows = await db.select({ id: projects.id, visibility: projects.visibility }).from(projects).where(eq(projects.workspaceId, workspaceId));
    return rows.filter((project) => project.visibility === "public" || mine.has(project.id)).map((project) => project.id);
  }

  async function setShared(userId: string, runtimeId: string, shared: boolean) {
    return db.transaction(async (transaction) => {
      const database = transaction as unknown as Database;
      const [runtime] = await database.select({ id: runtimes.id, workspaceId: runtimes.workspaceId, ownerId: runtimes.ownerId, shared: runtimes.shared }).from(runtimes).where(eq(runtimes.id, runtimeId)).for("update");
      if (!runtime) throw new ActionError("Runtime not found", 404);
      if (runtime.ownerId !== userId) throw new ActionError("Only the Runtime owner can change sharing", 403);
      await requireWorkspaceRole(database, userId, runtime.workspaceId, shared ? "write" : "read");
      if (runtime.shared === shared) return { id: runtimeId, shared };
      await database.update(runtimes).set({ shared }).where(eq(runtimes.id, runtimeId));
      await auditAgentChange(database, { workspaceId: runtime.workspaceId, entityType: "runtime", entityId: runtime.id, field: "shared", oldValue: runtime.shared, newValue: shared, actorId: userId });
      if (!shared) {
        const bound = await database.select({ id: agents.id }).from(agents).where(eq(agents.runtimeId, runtime.id));
        for (const agent of bound) await revokeAgentRuns(database, agent.id, userId, "Runtime sharing was revoked");
      }
      return { id: runtimeId, shared };
    });
  }

  async function ownedRuntime(userId: string, runtimeId: string) {
    const [runtime] = await db.select({ id: runtimes.id, workspaceId: runtimes.workspaceId, ownerId: runtimes.ownerId, enforceSandbox: runtimes.enforceSandbox }).from(runtimes).where(eq(runtimes.id, runtimeId));
    if (!runtime) throw new ActionError("Runtime not found", 404);
    if (runtime.ownerId !== userId) throw new ActionError("Only the Runtime owner can change profiles", 403);
    await requireWorkspaceRole(db, userId, runtime.workspaceId, "read");
    return runtime;
  }
}
