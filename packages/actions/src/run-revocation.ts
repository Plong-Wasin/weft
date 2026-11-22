import { and, eq, inArray } from "drizzle-orm";
import { activities, confirmations, runs, type Database } from "@weft/db";
import { lockRuntimeRun, scrubRunMessages } from "./runtime-secret-comments";

/** Revokes every active Run, leaving running Runtime work in stopping until its Daemon acknowledges cancellation. */
export async function revokeAgentRuns(database: Database, agentId: string, actorId: string, reason: string, originatorId?: string) {
  const active = await database.select().from(runs).where(and(eq(runs.agentId, agentId), ...(originatorId ? [eq(runs.originatorId, originatorId)] : []), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"])));
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
      }
      if (run.workItemId) await tx.insert(activities).values({
        workspaceId: run.workspaceId, projectId: run.projectId, entityType: "work_item", entityId: run.workItemId,
        field: "run_revoked", oldValue: { status: current.status }, newValue: { status: updated.status, reason }, actorId, source: "ui",
      });
    });
  }
}
