import { and, eq } from "drizzle-orm";
import { projectMembers, recurrences, workspaceMembers, type Database } from "@weft/db";
import { enqueueJob } from "./jobs";

export async function pauseCreatorRecurrences(db: Database, creatorId: string, scope: { projectId: string } | { workspaceId: string }, reason: string, actorId: string, now = new Date(), onlyRecurrenceId?: string) {
  const rows = await db.select().from(recurrences).where(and(
    eq(recurrences.creatorId, creatorId), eq(recurrences.status, "active"), ...(onlyRecurrenceId ? [eq(recurrences.id, onlyRecurrenceId)] : []),
    "projectId" in scope ? eq(recurrences.projectId, scope.projectId) : eq(recurrences.workspaceId, scope.workspaceId),
  ));
  for (const row of rows) {
    await db.update(recurrences).set({ status: "paused", pausedReason: reason, pausedAt: now }).where(eq(recurrences.id, row.id));
    const admins = await db.select({ userId: projectMembers.userId }).from(projectMembers)
      .where(and(eq(projectMembers.projectId, row.projectId), eq(projectMembers.role, "Admin")));
    const workspaceAdmins = await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, row.workspaceId), eq(workspaceMembers.role, "Admin")));
    const recipientIds = [...new Set([...admins, ...workspaceAdmins].map(({ userId }) => userId))];
    if (recipientIds.length) await enqueueJob(db, { type: "notify", payload: { kind: "recurrence_paused", actorId, recipientIds, recurrenceId: row.id, recurrenceName: row.name, reason, projectId: row.projectId } });
  }
}
