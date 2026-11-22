import { and, eq, inArray, isNull } from "drizzle-orm";
import { activities, agents, confirmations, projects, runs, type Database, workspaceMembers } from "@weft/db";
import { lockRuntimeRun, scrubRunMessages } from "./runtime-secret-comments";

/** Revokes every active Run, leaving running Runtime work in stopping until its Daemon acknowledges cancellation. */
export async function revokeAgentRuns(database: Database, agentId: string, actorId: string, reason: string, originatorId?: string, options: { runtimeId?: string | null; projectId?: string; executingOnly?: boolean; followUp?: boolean; notifyDetail?: string } = {}) {
  const statuses = options.executingOnly ? ["dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"] : ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"];
  const active = await database.select().from(runs).where(and(eq(runs.agentId, agentId), ...(originatorId ? [eq(runs.originatorId, originatorId)] : []), ...(options.runtimeId !== undefined ? [options.runtimeId === null ? isNull(runs.runtimeId) : eq(runs.runtimeId, options.runtimeId)] : []), ...(options.projectId ? [eq(runs.projectId, options.projectId)] : []), inArray(runs.status, statuses)));
  const now = new Date();
  for (const run of active) {
    await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await lockRuntimeRun(tx, run.id);
      const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
      if (!current || !["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"].includes(current.status)) return;
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
