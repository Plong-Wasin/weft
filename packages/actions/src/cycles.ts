import { Type } from "@sinclair/typebox";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, cycleItems, cycles, estimatePoints, workItemStates, workItems } from "@weft/db";
import { pointWeight, requirePointsEstimate } from "./estimates";
import { assertNoneArchived, assertNotArchived, liveWorkItems, unarchivedWorkItems } from "./triage";
import { assertFeatureEnabled } from "./features";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import { activityActor, type ActivityContext } from "./work-items";

export const cycleStatuses = ["upcoming", "active", "completed"] as const;
export type CycleStatus = (typeof cycleStatuses)[number];

const uuid = () => Type.String({ format: "uuid" });
const dateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const statusSchema = Type.Union(cycleStatuses.map((status) => Type.Literal(status)));
const cycleOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), startDate: Type.String(), endDate: Type.String(),
  status: statusSchema, createdBy: Type.String(), createdAt: Type.String(), itemCount: Type.Integer(),
  /** completed over total, where total leaves out cancelled work items. */
  progress: Type.Object({ completed: Type.Integer(), total: Type.Integer() }), archived: Type.Boolean(),
});
const cycleDetailOutput = Type.Intersect([cycleOutput, Type.Object({ workItemIds: Type.Array(Type.String()) })]);
type Context = ActivityContext;
type CycleRow = typeof cycles.$inferSelect;
type Member = { workItemId: string; group: string };

/** Today as a calendar date (UTC), the day a Cycle's status is computed against. */
export function todayIso(now: Date = new Date()) { return now.toISOString().slice(0, 10); }

/** A Cycle is never stored with a status: it follows the dates. Both end points are inclusive. */
export function cycleStatus(startDate: string, endDate: string, today: string = todayIso()): CycleStatus {
  if (today < startDate) return "upcoming";
  if (today > endDate) return "completed";
  return "active";
}

/** Progress is the completed count over the work items that are not cancelled. */
export function cycleProgress(groups: string[]) {
  const live = groups.filter((group) => group !== "cancelled");
  return { completed: live.filter((group) => group === "completed").length, total: live.length };
}

function assertDates(start: string, end: string) {
  for (const value of [start, end]) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ActionError("Invalid date", 400);
  }
  if (start > end) throw new ActionError("Start date must not be after end date", 400);
}

/** What a burndown counts: work items, or the Estimate point values of the items (projects with a points Estimate only). */
export const burndownUnitSchema = Type.Union([Type.Literal("items"), Type.Literal("points")]);
export type BurndownUnit = "items" | "points";

const dayMs = 86_400_000;
const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * One point per calendar day from start to end. `open` is the number of items not yet done by the end of that day (UTC), null after today;
 * `ideal` falls in a straight line from the total on the start day to 0 on the end day, by calendar day and not by array position.
 */
export function burndownSeries(startDate: string, endDate: string, completedAt: Array<Date | null>, today: string = todayIso(), weights?: number[]) {
  const weight = (index: number) => weights?.[index] ?? 1;
  const total = completedAt.reduce((sum, _at, index) => sum + weight(index), 0);
  const span = (dayOf(endDate) - dayOf(startDate)) / dayMs;
  const days: Array<{ date: string; open: number | null; ideal: number }> = [];
  for (let offset = 0; offset <= span; offset++) {
    const date = new Date(dayOf(startDate) + offset * dayMs).toISOString().slice(0, 10);
    const dayEnd = dayOf(date) + dayMs;
    days.push({
      date,
      open: date > today ? null : completedAt.reduce((sum, at, index) => sum + (at === null || at.getTime() >= dayEnd ? weight(index) : 0), 0),
      ideal: span === 0 ? 0 : Math.round((total * (span - offset) / span) * 100) / 100,
    });
  }
  return { total, days };
}

export function createCycleActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  function out(row: CycleRow, members: Member[]) {
    return {
      id: row.id, projectId: row.projectId, name: row.name, startDate: row.startDate, endDate: row.endDate,
      status: cycleStatus(row.startDate, row.endDate), createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), itemCount: members.length,
      progress: cycleProgress(members.map((member) => member.group)), archived: row.archivedAt !== null,
    };
  }

  async function counts(database: Database, cycleIds: string[]) {
    const result = new Map<string, Member[]>(cycleIds.map((id) => [id, []]));
    if (cycleIds.length === 0) return result;
    const rows = await database.select({ cycleId: cycleItems.cycleId, workItemId: cycleItems.workItemId, group: workItemStates.group }).from(cycleItems)
      .innerJoin(workItems, and(eq(workItems.id, cycleItems.workItemId), unarchivedWorkItems))
      .innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId)).where(inArray(cycleItems.cycleId, cycleIds));
    for (const row of rows) result.get(row.cycleId)!.push({ workItemId: row.workItemId, group: row.group });
    return result;
  }

  async function cycleAccess(context: Context, cycleId: string, requirement: "read" | "write" | "admin") {
    const [cycle] = await db.select().from(cycles).where(and(eq(cycles.id, cycleId), isNull(cycles.deletedAt)));
    if (!cycle) throw new ActionError("Cycle not found", 404);
    const { project } = await requireProjectAccess(db, context.userId, cycle.projectId, requirement);
    assertFeatureEnabled(project, "cycles");
    return { cycle, project };
  }

  async function logCycleChange(database: Database, context: Context, project: { id: string; workspaceId: string }, workItemId: string, oldValue: string | null, newValue: string | null) {
    await database.insert(activities).values({
      workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: workItemId, field: "cycle", oldValue, newValue,
      ...activityActor(context),
    });
  }

  async function overlapping(database: Database, projectId: string, start: string, end: string, exceptId?: string) {
    // Inclusive on both ends, as Plane's CycleDateCheckEndpoint: sharing a single day counts as overlap.
    const rows = await database.select().from(cycles)
      .where(and(eq(cycles.projectId, projectId), isNull(cycles.deletedAt), lte(cycles.startDate, end), gte(cycles.endDate, start), ...(exceptId ? [ne(cycles.id, exceptId)] : [])))
      .orderBy(asc(cycles.startDate), asc(cycles.createdAt));
    const items = await counts(database, rows.map((row) => row.id));
    return rows.map((row) => out(row, items.get(row.id)!));
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
        return out(cycle!, []);
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
        return out(updated!, (await counts(db, [cycle.id])).get(cycle.id)!);
      },
    },
    listCycles: {
      name: "list_cycles", kind: "read" as const,
      input: Type.Object({ ...projectInput, archived: Type.Optional(Type.Boolean({ description: "true lists only archived Cycles; the default lists only Cycles that are not archived" })) }), output: Type.Array(cycleOutput),
      handler: async (context: Context, input: { projectId: string; archived?: boolean }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        assertFeatureEnabled(project, "cycles");
        const rows = await db.select().from(cycles).where(and(eq(cycles.projectId, project.id), isNull(cycles.deletedAt), input.archived ? isNotNull(cycles.archivedAt) : isNull(cycles.archivedAt)))
          .orderBy(asc(cycles.startDate), asc(cycles.createdAt));
        const items = await counts(db, rows.map((row) => row.id));
        return rows.map((row) => out(row, items.get(row.id)!));
      },
    },
    getCycle: {
      name: "get_cycle", kind: "read" as const,
      input: Type.Object({ cycleId: uuid() }), output: cycleDetailOutput,
      handler: async (context: Context, input: { cycleId: string }) => {
        const { cycle } = await cycleAccess(context, input.cycleId, "read");
        const members = (await counts(db, [cycle.id])).get(cycle.id)!;
        return { ...out(cycle, members), workItemIds: members.map((member) => member.workItemId) };
      },
    },
    getCycleBurndown: {
      name: "get_cycle_burndown", kind: "read" as const,
      input: Type.Object({ cycleId: uuid(), unit: Type.Optional(burndownUnitSchema) }),
      output: Type.Object({
        cycleId: Type.String(), unit: burndownUnitSchema, startDate: Type.String(), endDate: Type.String(), total: Type.Number(),
        days: Type.Array(Type.Object({ date: Type.String(), open: Type.Union([Type.Number(), Type.Null()]), ideal: Type.Number() })),
      }),
      handler: async (context: Context, input: { cycleId: string; unit?: BurndownUnit }) => {
        const { cycle } = await cycleAccess(context, input.cycleId, "read");
        const unit = input.unit ?? "items";
        if (unit === "points") await requirePointsEstimate(db, cycle.projectId);
        const rows = await db.select({ completedAt: workItems.completedAt, point: estimatePoints.value }).from(cycleItems)
          .innerJoin(workItems, and(eq(workItems.id, cycleItems.workItemId), unarchivedWorkItems))
          // Cancelled work is neither open nor done, so it leaves the chart (as it leaves a Cycle's progress).
          .innerJoin(workItemStates, and(eq(workItemStates.id, workItems.stateId), ne(workItemStates.group, "cancelled")))
          .leftJoin(estimatePoints, eq(estimatePoints.id, workItems.estimatePointId)).where(eq(cycleItems.cycleId, cycle.id));
        const weights = unit === "points" ? rows.map((row) => pointWeight(row.point)) : undefined;
        return { cycleId: cycle.id, unit, startDate: cycle.startDate, endDate: cycle.endDate, ...burndownSeries(cycle.startDate, cycle.endDate, rows.map((row) => row.completedAt), todayIso(), weights) };
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
          const found = await database.select({ id: workItems.id, archivedAt: workItems.archivedAt }).from(workItems)
            .where(and(inArray(workItems.id, ids), eq(workItems.projectId, project.id), liveWorkItems)).orderBy(workItems.id).for("no key update");
          if (found.length !== ids.length) throw new ActionError("Work items must belong to this Cycle's project", 400);
          found.forEach(assertNotArchived);
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
    /** Nothing moves by itself when a Cycle ends: someone picks the target and the unfinished items follow. */
    transferCycleItems: {
      name: "transfer_cycle_items", kind: "write" as const,
      input: Type.Object({ cycleId: uuid(), targetCycleId: uuid() }),
      output: Type.Object({ transferred: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { cycleId: string; targetCycleId: string }) => {
        const { cycle, project } = await cycleAccess(context, input.cycleId, "write");
        if (cycleStatus(cycle.startDate, cycle.endDate) !== "completed") throw new ActionError("Only a completed Cycle can transfer its work items", 400);
        if (input.targetCycleId === cycle.id) throw new ActionError("Choose a different Cycle", 400);
        const [target] = await db.select().from(cycles).where(and(eq(cycles.id, input.targetCycleId), eq(cycles.projectId, project.id), isNull(cycles.deletedAt)));
        if (!target) throw new ActionError("Cycle not found", 404);
        if (target.archivedAt || cycleStatus(target.startDate, target.endDate) === "completed") throw new ActionError("Cannot transfer work items to a Cycle that has ended", 400);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const unfinished = await database.select({ id: cycleItems.workItemId }).from(cycleItems)
            .innerJoin(workItems, and(eq(workItems.id, cycleItems.workItemId), isNull(workItems.deletedAt)))
            .innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId))
            .where(and(eq(cycleItems.cycleId, cycle.id), notInArray(workItemStates.group, ["completed", "cancelled"])));
          const ids = unfinished.map((row) => row.id);
          if (ids.length) {
            await database.update(cycleItems).set({ cycleId: target.id }).where(inArray(cycleItems.workItemId, ids));
            for (const workItemId of ids) await logCycleChange(database, context, project, workItemId, cycle.id, target.id);
          }
          return { transferred: ids };
        });
      },
    },
    /** Admin only, and only once the Cycle has ended. Membership stays; the Cycle leaves the default list. */
    archiveCycle: {
      name: "archive_cycle", kind: "write" as const,
      input: Type.Object({ cycleId: uuid() }), output: cycleOutput,
      handler: async (context: Context, input: { cycleId: string }) => {
        const { cycle } = await cycleAccess(context, input.cycleId, "admin");
        if (cycleStatus(cycle.startDate, cycle.endDate) !== "completed") throw new ActionError("Only a completed Cycle can be archived", 400);
        const [updated] = await db.update(cycles).set({ archivedAt: cycle.archivedAt ?? new Date() }).where(eq(cycles.id, cycle.id)).returning();
        return out(updated!, (await counts(db, [cycle.id])).get(cycle.id)!);
      },
    },
    /** Admin only, as archiving is. Clears the archive time and changes nothing else; the Cycle returns to the default list. */
    unarchiveCycle: {
      name: "unarchive_cycle", kind: "write" as const,
      input: Type.Object({ cycleId: uuid() }), output: cycleOutput,
      handler: async (context: Context, input: { cycleId: string }) => {
        const { cycle } = await cycleAccess(context, input.cycleId, "admin");
        const [updated] = await db.update(cycles).set({ archivedAt: null }).where(eq(cycles.id, cycle.id)).returning();
        return out(updated!, (await counts(db, [cycle.id])).get(cycle.id)!);
      },
    },
    /** Soft delete: the Cycle row stays but its membership goes; the work items themselves are untouched. */
    deleteCycle: {
      name: "delete_cycle", kind: "write" as const,
      input: Type.Object({ cycleId: uuid() }), output: Type.Object({ id: Type.String(), released: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { cycleId: string }) => {
        const { cycle, project } = await cycleAccess(context, input.cycleId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.update(cycles).set({ deletedAt: new Date() }).where(eq(cycles.id, cycle.id));
          const released = await database.delete(cycleItems).where(eq(cycleItems.cycleId, cycle.id)).returning({ workItemId: cycleItems.workItemId });
          for (const row of released) await logCycleChange(database, context, project, row.workItemId, cycle.id, null);
          return { id: cycle.id, released: released.map((row) => row.workItemId) };
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
          await assertNoneArchived(database, ids);
          const deleted = await database.delete(cycleItems).where(and(eq(cycleItems.cycleId, cycle.id), inArray(cycleItems.workItemId, ids))).returning({ workItemId: cycleItems.workItemId });
          for (const row of deleted) await logCycleChange(database, context, project, row.workItemId, cycle.id, null);
          return { removed: deleted.map((row) => row.workItemId) };
        });
      },
    },
  };
}
