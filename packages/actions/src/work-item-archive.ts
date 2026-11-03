import { Type } from "@sinclair/typebox";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "@weft/db";
import { cycleItems, cycles, moduleItems, modules, workItemStates, workItems } from "@weft/db";
import { cycleStatus } from "./cycles";
import { ActionError } from "./members";
import { archivableModuleStatuses } from "./modules";
import { requireProjectAccess } from "./projects";
import { triageGroup } from "./triage";
import { logActivity, type ActivityContext } from "./work-items";

const uuid = () => Type.String({ format: "uuid" });
const output = Type.Object({ id: Type.String(), archivedAt: Type.Union([Type.String(), Type.Null()]) });

/** Archive and restore of a work item. Visibility and the read-only rule live in triage.ts (`unarchivedWorkItems`, `assertNotArchived`). */
export function createWorkItemArchiveActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  /** The work item for an archive or restore: Triage items are found too, so that their refusal can name the reason. */
  async function load(context: ActivityContext, workItemId: string) {
    const [found] = await db.select().from(workItems).where(and(eq(workItems.id, workItemId), isNull(workItems.deletedAt)));
    if (!found) throw new ActionError("Work item not found", 404);
    const { project } = await requireProjectAccess(db, context.userId, found.projectId, "write");
    return { found, project };
  }

  async function assertArchivable(database: Database, itemId: string, stateId: string) {
    const [state] = await database.select({ group: workItemStates.group }).from(workItemStates).where(eq(workItemStates.id, stateId));
    if (state?.group === triageGroup) throw new ActionError("A work item in Triage cannot be archived", 400);
    if (state?.group !== "completed" && state?.group !== "cancelled") throw new ActionError("Only a completed or cancelled work item can be archived", 400);
    const [cycle] = await database.select({ startDate: cycles.startDate, endDate: cycles.endDate }).from(cycleItems)
      .innerJoin(cycles, and(eq(cycles.id, cycleItems.cycleId), isNull(cycles.deletedAt))).where(eq(cycleItems.workItemId, itemId));
    if (cycle && cycleStatus(cycle.startDate, cycle.endDate) !== "completed") throw new ActionError("A work item in a Cycle that has not completed cannot be archived", 400);
    const open = await database.select({ status: modules.status }).from(moduleItems)
      .innerJoin(modules, and(eq(modules.id, moduleItems.moduleId), isNull(modules.deletedAt))).where(eq(moduleItems.workItemId, itemId));
    if (open.some((row) => !archivableModuleStatuses.includes(row.status as never))) throw new ActionError("A work item in a Module that is not completed or cancelled cannot be archived", 400);
  }

  return {
    archiveWorkItem: {
      name: "archive_work_item", kind: "write" as const,
      input: Type.Object({ workItemId: uuid() }), output,
      handler: async (context: ActivityContext, input: { workItemId: string }) => {
        const { found, project } = await load(context, input.workItemId);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [item] = await database.select().from(workItems).where(and(eq(workItems.id, found.id), isNull(workItems.deletedAt))).for("update");
          if (!item) throw new ActionError("Work item not found", 404);
          // Idempotent: an archived work item keeps its first archive time and writes no second Activity row.
          if (item.archivedAt) return { id: item.id, archivedAt: item.archivedAt.toISOString() };
          await assertArchivable(database, item.id, item.stateId);
          const [updated] = await database.update(workItems).set({ archivedAt: new Date() }).where(eq(workItems.id, item.id)).returning({ archivedAt: workItems.archivedAt });
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: "archived", newValue: updated!.archivedAt!.toISOString() });
          return { id: item.id, archivedAt: updated!.archivedAt!.toISOString() };
        });
      },
    },
    bulkArchiveWorkItems: {
      name: "bulk_archive_work_items", kind: "write" as const,
      input: Type.Object({ projectId: uuid(), workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }) }),
      output: Type.Object({ bulkEditId: Type.String(), archived: Type.Number() }),
      handler: async (context: ActivityContext, input: { projectId: string; workItemIds: string[] }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        const ids = [...new Set(input.workItemIds)];
        if (ids.length === 0) throw new ActionError("Select at least one work item", 400);
        const bulkEditId = crypto.randomUUID();
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const rows = await database.select().from(workItems).where(and(inArray(workItems.id, ids), eq(workItems.projectId, project.id), isNull(workItems.deletedAt))).orderBy(asc(workItems.id)).for("update");
          if (rows.length !== ids.length) throw new ActionError("Work items must belong to this project", 400);
          let archived = 0;
          for (const row of rows.sort((a, b) => a.sequence - b.sequence)) {
            // Already archived is a no-op, as in a single archive.
            if (row.archivedAt) continue;
            try { await assertArchivable(database, row.id, row.stateId); } catch (error) {
              if (error instanceof ActionError) throw new ActionError(`${project.key}-${row.sequence}: ${error.message}`, error.status);
              throw error;
            }
            const [updated] = await database.update(workItems).set({ archivedAt: new Date() }).where(eq(workItems.id, row.id)).returning({ archivedAt: workItems.archivedAt });
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: row.id, field: "archived", newValue: updated!.archivedAt!.toISOString(), bulkEditId });
            archived += 1;
          }
          return { bulkEditId, archived };
        });
      },
    },
    restoreWorkItem: {
      name: "restore_work_item", kind: "write" as const,
      input: Type.Object({ workItemId: uuid() }), output,
      handler: async (context: ActivityContext, input: { workItemId: string }) => {
        const { found, project } = await load(context, input.workItemId);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [item] = await database.select().from(workItems).where(and(eq(workItems.id, found.id), isNull(workItems.deletedAt))).for("update");
          if (!item) throw new ActionError("Work item not found", 404);
          if (!item.archivedAt) return { id: item.id, archivedAt: null };
          // Only the archive time changes: state, Cycle, Modules and every field stay as they were (updatedAt too).
          await database.update(workItems).set({ archivedAt: null }).where(eq(workItems.id, item.id));
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: "restored", oldValue: item.archivedAt.toISOString() });
          return { id: item.id, archivedAt: null };
        });
      },
    },
  };
}
