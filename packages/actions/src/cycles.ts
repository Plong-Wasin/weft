import { Type } from "@sinclair/typebox";
import { and, asc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, cycleItems, cycles, workItems } from "@weft/db";
import { liveWorkItems } from "./triage";
import { assertFeatureEnabled } from "./features";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import type { ActivitySource } from "./work-items";

export const cycleStatuses = ["upcoming", "active", "completed"] as const;
export type CycleStatus = (typeof cycleStatuses)[number];

const uuid = () => Type.String({ format: "uuid" });
const dateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const statusSchema = Type.Union(cycleStatuses.map((status) => Type.Literal(status)));
const cycleOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), startDate: Type.String(), endDate: Type.String(),
  status: statusSchema, createdBy: Type.String(), createdAt: Type.String(), itemCount: Type.Integer(),
});
const cycleDetailOutput = Type.Intersect([cycleOutput, Type.Object({ workItemIds: Type.Array(Type.String()) })]);
type Context = { userId: string; source?: ActivitySource; chatId?: string };
type CycleRow = typeof cycles.$inferSelect;

/** Today as a calendar date (UTC), the day a Cycle's status is computed against. */
export function todayIso(now: Date = new Date()) { return now.toISOString().slice(0, 10); }

/** A Cycle is never stored with a status: it follows the dates. Both end points are inclusive. */
export function cycleStatus(startDate: string, endDate: string, today: string = todayIso()): CycleStatus {
  if (today < startDate) return "upcoming";
  if (today > endDate) return "completed";
  return "active";
}

function assertDates(start: string, end: string) {
  for (const value of [start, end]) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ActionError("Invalid date", 400);
  }
  if (start > end) throw new ActionError("Start date must not be after end date", 400);
}

export function createCycleActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  function out(row: CycleRow, itemCount: number) {
    return {
      id: row.id, projectId: row.projectId, name: row.name, startDate: row.startDate, endDate: row.endDate,
      status: cycleStatus(row.startDate, row.endDate), createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), itemCount,
    };
  }

  async function counts(database: Database, cycleIds: string[]) {
    const result = new Map<string, string[]>(cycleIds.map((id) => [id, []]));
    if (cycleIds.length === 0) return result;
    const rows = await database.select({ cycleId: cycleItems.cycleId, workItemId: cycleItems.workItemId }).from(cycleItems)
      .innerJoin(workItems, and(eq(workItems.id, cycleItems.workItemId), liveWorkItems)).where(inArray(cycleItems.cycleId, cycleIds));
    for (const row of rows) result.get(row.cycleId)!.push(row.workItemId);
    return result;
  }

  async function cycleAccess(context: Context, cycleId: string, requirement: "read" | "write") {
    const [cycle] = await db.select().from(cycles).where(eq(cycles.id, cycleId));
    if (!cycle) throw new ActionError("Cycle not found", 404);
    const { project } = await requireProjectAccess(db, context.userId, cycle.projectId, requirement);
    assertFeatureEnabled(project, "cycles");
    return { cycle, project };
  }

  async function logCycleChange(database: Database, context: Context, project: { id: string; workspaceId: string }, workItemId: string, oldValue: string | null, newValue: string | null) {
    await database.insert(activities).values({
      workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: workItemId, field: "cycle", oldValue, newValue,
      actorId: context.userId, source: context.source ?? "ui", chatId: context.source === "ai" ? context.chatId ?? null : null,
    });
  }

  async function overlapping(database: Database, projectId: string, start: string, end: string, exceptId?: string) {
    // Inclusive on both ends, as Plane's CycleDateCheckEndpoint: sharing a single day counts as overlap.
    const rows = await database.select().from(cycles)
      .where(and(eq(cycles.projectId, projectId), lte(cycles.startDate, end), gte(cycles.endDate, start), ...(exceptId ? [ne(cycles.id, exceptId)] : [])))
      .orderBy(asc(cycles.startDate), asc(cycles.createdAt));
    const items = await counts(database, rows.map((row) => row.id));
    return rows.map((row) => out(row, items.get(row.id)!.length));
  }

  const projectInput = { projectId: uuid() };
  const nameSchema = Type.String({ minLength: 1, maxLength: 100 });

  return {
    createCycle: {
      name: "create_cycle", kind: "write" as const,
      input: Type.Object({ ...projectInput, name: nameSchema, startDate: dateSchema, endDate: dateSchema }), output: cycleOutput,
      handler: async (context: Context, input: { projectId: string; name: string; startDate: string; endDate: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        assertFeatureEnabled(project, "cycles");
        assertDates(input.startDate, input.endDate);
        const [cycle] = await db.insert(cycles).values({
          workspaceId: project.workspaceId, projectId: project.id, name: input.name, startDate: input.startDate, endDate: input.endDate, createdBy: context.userId,
        }).returning();
        return out(cycle!, 0);
      },
    },
    updateCycle: {
      name: "update_cycle", kind: "write" as const,
      input: Type.Object({ cycleId: uuid(), name: Type.Optional(nameSchema), startDate: Type.Optional(dateSchema), endDate: Type.Optional(dateSchema) }), output: cycleOutput,
      handler: async (context: Context, input: { cycleId: string; name?: string; startDate?: string; endDate?: string }) => {
        const { cycle } = await cycleAccess(context, input.cycleId, "write");
        const startDate = input.startDate ?? cycle.startDate, endDate = input.endDate ?? cycle.endDate;
        assertDates(startDate, endDate);
        const [updated] = await db.update(cycles).set({ name: input.name ?? cycle.name, startDate, endDate }).where(eq(cycles.id, cycle.id)).returning();
        return out(updated!, (await counts(db, [cycle.id])).get(cycle.id)!.length);
      },
    },
    listCycles: {
      name: "list_cycles", kind: "read" as const,
      input: Type.Object(projectInput), output: Type.Array(cycleOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        assertFeatureEnabled(project, "cycles");
        const rows = await db.select().from(cycles).where(eq(cycles.projectId, project.id)).orderBy(asc(cycles.startDate), asc(cycles.createdAt));
        const items = await counts(db, rows.map((row) => row.id));
        return rows.map((row) => out(row, items.get(row.id)!.length));
      },
    },
    getCycle: {
      name: "get_cycle", kind: "read" as const,
      input: Type.Object({ cycleId: uuid() }), output: cycleDetailOutput,
      handler: async (context: Context, input: { cycleId: string }) => {
        const { cycle } = await cycleAccess(context, input.cycleId, "read");
        const ids = (await counts(db, [cycle.id])).get(cycle.id)!;
        return { ...out(cycle, ids.length), workItemIds: ids };
      },
    },
    /** Warning only: the UI shows the overlapping Cycles and lets the user go on. */
    checkCycleDates: {
      name: "check_cycle_dates", kind: "read" as const,
      input: Type.Object({ ...projectInput, startDate: dateSchema, endDate: dateSchema, cycleId: Type.Optional(uuid()) }),
      output: Type.Object({ overlapping: Type.Array(cycleOutput) }),
      handler: async (context: Context, input: { projectId: string; startDate: string; endDate: string; cycleId?: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        assertFeatureEnabled(project, "cycles");
        assertDates(input.startDate, input.endDate);
        return { overlapping: await overlapping(db, project.id, input.startDate, input.endDate, input.cycleId) };
      },
    },
    addCycleItems: {
      name: "add_cycle_items", kind: "write" as const,
      input: Type.Object({ cycleId: uuid(), workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }) }),
      output: Type.Object({ added: Type.Array(Type.String()), skipped: Type.Array(Type.Object({ workItemId: Type.String(), cycleId: Type.String() })) }),
      handler: async (context: Context, input: { cycleId: string; workItemIds: string[] }) => {
        const { cycle, project } = await cycleAccess(context, input.cycleId, "write");
        if (cycleStatus(cycle.startDate, cycle.endDate) === "completed") throw new ActionError("Cannot add work items to a Cycle that has ended", 400);
        const ids = [...new Set(input.workItemIds)];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const found = await database.select({ id: workItems.id }).from(workItems)
            .where(and(inArray(workItems.id, ids), eq(workItems.projectId, project.id), liveWorkItems));
          if (found.length !== ids.length) throw new ActionError("Work items must belong to this Cycle's project", 400);
          // The primary key on work_item_id decides races: the loser of a concurrent add gets no row back and is reported as skipped.
          const inserted = await database.insert(cycleItems).values(ids.map((workItemId) => ({ workItemId, cycleId: cycle.id, workspaceId: project.workspaceId, projectId: project.id })))
            .onConflictDoNothing().returning({ workItemId: cycleItems.workItemId });
          const added = new Set(inserted.map((row) => row.workItemId));
          const rest = ids.filter((id) => !added.has(id));
          const existing = rest.length ? await database.select().from(cycleItems).where(inArray(cycleItems.workItemId, rest)) : [];
          for (const workItemId of ids.filter((id) => added.has(id))) await logCycleChange(database, context, project, workItemId, null, cycle.id);
          // Already in this very Cycle is a no-op, not a skip.
          return { added: ids.filter((id) => added.has(id)), skipped: existing.filter((row) => row.cycleId !== cycle.id).map((row) => ({ workItemId: row.workItemId, cycleId: row.cycleId })) };
        });
      },
    },
    removeCycleItems: {
      name: "remove_cycle_items", kind: "write" as const,
      input: Type.Object({ cycleId: uuid(), workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }) }),
      output: Type.Object({ removed: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { cycleId: string; workItemIds: string[] }) => {
        const { cycle, project } = await cycleAccess(context, input.cycleId, "write");
        const ids = [...new Set(input.workItemIds)];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const deleted = await database.delete(cycleItems).where(and(eq(cycleItems.cycleId, cycle.id), inArray(cycleItems.workItemId, ids))).returning({ workItemId: cycleItems.workItemId });
          for (const row of deleted) await logCycleChange(database, context, project, row.workItemId, cycle.id, null);
          return { removed: deleted.map((row) => row.workItemId) };
        });
      },
    },
  };
}
