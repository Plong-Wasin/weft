import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { activities, agents, confirmations, projects, runs, runtimes, type Database, workspaceMembers } from "@weft/db";
import { lockRuntimeRun, scrubRunMessages } from "./runtime-secret-comments";

/** Revokes active Runs; running Runtime work remains stopping until its Daemon cooperatively acknowledges cancellation (the server does not hard-kill the external process). */
export async function revokeAgentRuns(database: Database, agentId: string, actorId: string, reason: string, originatorId?: string, options: { runtimeId?: string | null; projectId?: string; executingOnly?: boolean; excludeStopping?: boolean; followUp?: boolean; notifyDetail?: string } = {}) {
  const statuses = options.executingOnly ? ["dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"] : ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"];
  const eligibleStatuses = options.excludeStopping ? statuses.filter((status) => status !== "stopping") : statuses;
  const active = await database.select().from(runs).where(and(eq(runs.agentId, agentId), ...(originatorId ? [eq(runs.originatorId, originatorId)] : []), ...(options.runtimeId !== undefined ? [options.runtimeId === null ? isNull(runs.runtimeId) : eq(runs.runtimeId, options.runtimeId)] : []), ...(options.projectId ? [eq(runs.projectId, options.projectId)] : []), inArray(runs.status, eligibleStatuses)));
  const now = new Date();
  for (const run of active) {
    await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await lockRuntimeRun(tx, run.id);
      const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
      if (!current || !eligibleStatuses.includes(current.status)) return;
      const running = ["running", "awaiting_input", "stopping"].includes(current.status);
      if (!running) await scrubRunMessages(tx, run.id, current.runtimeEnvironmentSecrets);
      const [updated] = await tx.update(runs).set({ status: running ? "stopping" : "failed", failureReason: reason, ...(running ? {} : { finishedAt: now, runtimeEnvironmentSecrets: null }) })
        .where(eq(runs.id, run.id)).returning();
      if (!updated) return;
      if (!running) {
        await tx.update(confirmations).set({ status: "rejected", result: { withdrawn: true, reason: "run_cancelled" }, resolvedAt: new Date() })
          .where(and(eq(confirmations.runId, run.id), eq(confirmations.status, "pending")));
        const { emitRunFinished } = await import("./outbound-webhooks");
        await emitRunFinished(tx, run.id);
        if (options.followUp && run.workItemId) {
          const { startFollowUpRun } = await import("./runs");
          await startFollowUpRun(tx, agentId, run.workItemId);
        }
      }
      if (run.workItemId) await tx.insert(activities).values({
        workspaceId: run.workspaceId, projectId: run.projectId, entityType: "work_item", entityId: run.workItemId,
        field: "run_revoked", oldValue: { status: current.status }, newValue: { status: updated.status, reason }, actorId, source: "ui",
      });
      if (options.notifyDetail) {
        const { enqueueNotification } = await import("./notifications");
        await enqueueNotification(tx, { kind: "run_skipped", ...(run.workItemId ? { workItemId: run.workItemId } : { runId: run.id }), commentId: run.commentId ?? undefined, actorId, recipientIds: [run.originatorId], detail: options.notifyDetail });
      }
    });
  }
}

/** Cancel work assigned to a revoked CLI device while keeping remote stop confirmation explicit. */
export async function revokeCliDeviceRuns(database: Database, daemonIds: string[], actorId: string, reason = "cli_device_revoked") {
  if (daemonIds.length === 0) return;
  const runtimeIds = database.select({ id: runtimes.id }).from(runtimes).where(inArray(runtimes.daemonId, daemonIds));
  const boundAgentIds = database.select({ id: agents.id }).from(agents).where(inArray(agents.runtimeId, runtimeIds));
  const active = await database.select().from(runs).where(and(
    inArray(runs.status, ["queued", "dispatched", "running", "waiting_confirmation", "awaiting_input", "follow_up", "stopping"]),
    or(inArray(runs.runtimeId, runtimeIds), inArray(runs.agentId, boundAgentIds)),
  ));
  for (const run of active) {
    await lockRuntimeRun(database, run.id);
    const [current] = await database.select().from(runs).where(eq(runs.id, run.id)).for("update");
    if (!current || !["queued", "dispatched", "running", "waiting_confirmation", "awaiting_input", "follow_up", "stopping"].includes(current.status)) continue;
    const remoteMayBeRunning = ["dispatched", "running", "waiting_confirmation", "awaiting_input", "stopping"].includes(current.status);
    if (!remoteMayBeRunning) await scrubRunMessages(database, run.id, current.runtimeEnvironmentSecrets);
    const [updated] = await database.update(runs).set({
      status: remoteMayBeRunning ? "stopping" : "cancelled",
      failureReason: reason,
      ...(remoteMayBeRunning ? {} : { finishedAt: new Date(), runtimeEnvironmentSecrets: null }),
    }).where(eq(runs.id, run.id)).returning({ status: runs.status });
    if (!updated) continue;
    if (!remoteMayBeRunning) {
      await database.update(confirmations).set({ status: "rejected", result: { withdrawn: true, reason: "run_cancelled" }, resolvedAt: new Date() })
        .where(and(eq(confirmations.runId, run.id), eq(confirmations.status, "pending")));
      const { emitRunFinished } = await import("./outbound-webhooks");
      await emitRunFinished(database, run.id);
    }
    if (run.workItemId) await database.insert(activities).values({
      workspaceId: run.workspaceId, projectId: run.projectId, entityType: "work_item", entityId: run.workItemId,
      field: "run_revoked", oldValue: { status: current.status }, newValue: { status: updated.status, reason }, actorId, source: "ui",
    });
  }
}

/** Revokes only Runs whose Originator or Member-Agent creator just lost workspace write access. */
export async function revokeWorkspaceMemberRuns(database: Database, workspaceId: string, userId: string, actorId: string) {
  const active = await database.select({ agentId: runs.agentId, projectId: runs.projectId, originatorId: runs.originatorId, createdBy: agents.createdBy, memberOwned: agents.memberOwned })
    .from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(eq(runs.workspaceId, workspaceId), inArray(runs.status, ["queued", "dispatched", "running", "waiting_confirmation", "awaiting_input", "follow_up"])));
  const scopeKey = (agentId: string, projectId: string) => JSON.stringify([agentId, projectId]);
  const creatorScope = new Set(active.flatMap((run) => run.agentId && run.memberOwned && run.createdBy === userId ? [scopeKey(run.agentId, run.projectId)] : []));
  const originatorScope = new Set(active.flatMap((run) => run.agentId && run.originatorId === userId ? [scopeKey(run.agentId, run.projectId)] : []));
  for (const scope of creatorScope) {
    const [agentId, projectId] = JSON.parse(scope) as [string, string];
    await revokeAgentRuns(database, agentId, actorId, "Workspace write access was revoked", undefined, { projectId, excludeStopping: true, notifyDetail: "project_access_revoked" });
  }
  for (const scope of originatorScope) {
    if (creatorScope.has(scope)) continue;
    const [agentId, projectId] = JSON.parse(scope) as [string, string];
    await revokeAgentRuns(database, agentId, actorId, "Workspace write access was revoked", userId, { projectId, excludeStopping: true, notifyDetail: "project_access_revoked" });
  }
}

/** Stops active work for a person who just lost Project write access as its Originator or Member-Agent creator. */
export async function revokeProjectMemberRuns(database: Database, projectId: string, userId: string, actorId: string) {
  const [project] = await database.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, projectId));
  if (!project) return;
  const [member] = await database.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.userId, userId)));
  // A Workspace Admin retains Project write access regardless of its Project membership row.
  if (member?.role === "Admin") return;
  const active = await database.select({ agentId: runs.agentId, originatorId: runs.originatorId, createdBy: agents.createdBy, memberOwned: agents.memberOwned })
    .from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(eq(runs.projectId, projectId), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"])));
  const agentWide = new Set(active.flatMap((run) => run.agentId && run.memberOwned && run.createdBy === userId ? [run.agentId] : []));
  const originatorRuns = new Set(active.flatMap((run) => run.agentId && run.originatorId === userId && !agentWide.has(run.agentId) ? [run.agentId] : []));
  for (const agentId of agentWide) await revokeAgentRuns(database, agentId, actorId, "Project write access was revoked", undefined, { projectId, notifyDetail: "project_access_revoked" });
  for (const agentId of originatorRuns) await revokeAgentRuns(database, agentId, actorId, "Project write access was revoked", userId, { projectId, notifyDetail: "project_access_revoked" });
}
