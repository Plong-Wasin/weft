import { Type } from "@sinclair/typebox";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, cycleHistory, cycleItems, cycles, estimatePoints, workItemStates, workItems } from "@weft/db";
import { pointWeight, requirePointsEstimate } from "./estimates";
import { assertNoneArchived, assertNotArchived, liveWorkItems, unarchivedWorkItems } from "./triage";
import { assertFeatureEnabled } from "./features";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import { activityActor, type ActivityContext } from "./work-items";
import { workItemMarkdownOptions, writtenDescription } from "./work-items";
import { storedDocumentOf, readWrittenFormOf } from "./written-form-pool";
import { WRITTEN_FORM_MAX_INPUT_LENGTH } from "./markdown-doc";
import { validateRichTextAssets } from "./rich-text-validation";

export const cycleStatuses = ["upcoming", "active", "completed"] as const;
export type CycleStatus = (typeof cycleStatuses)[number];

const uuid = () => Type.String({ format: "uuid" });
const dateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const statusSchema = Type.Union(cycleStatuses.map((status) => Type.Literal(status)));
const cycleOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), startDate: Type.String(), endDate: Type.String(),
  status: statusSchema, createdBy: Type.String(), createdAt: Type.String(), itemCount: Type.Integer(),
  descriptionMarkdown: Type.String(), description: Type.Optional(Type.Any()),
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
      descriptionMarkdown: row.descriptionMarkdown ?? "", description: row.descriptionDoc ?? undefined,
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

  /** Lock Cycle rows before work-item rows in every writer, using id order for multi-Cycle operations. */
  async function lockWritableCycles(database: Database, ids: string[], projectId: string) {
    const uniqueIds = [...new Set(ids)].sort();
    const rows = await database.select().from(cycles).where(and(inArray(cycles.id, uniqueIds), eq(cycles.projectId, projectId), isNull(cycles.deletedAt)))
      .orderBy(asc(cycles.id)).for("update");
    if (rows.length !== uniqueIds.length) throw new ActionError("Cycle not found", 404);
    const archived = rows.find((row) => row.archivedAt !== null);
    if (archived) throw new ActionError("Cycle is archived", 400);
    return rows;
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
      input: Type.Object({ ...projectInput, name: nameSchema, startDate: dateSchema, endDate: dateSchema, description: Type.Optional(Type.Any()), descriptionMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH })) }), output: cycleOutput,
      handler: async (context: Context, input: { projectId: string; name: string; startDate: string; endDate: string; description?: unknown; descriptionMarkdown?: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        assertFeatureEnabled(project, "cycles");
        assertDates(input.startDate, input.endDate);
        const options = await workItemMarkdownOptions(db, context.userId, project.workspaceId, project.id, input.descriptionMarkdown);
        const description = await writtenDescription(input.description, input.descriptionMarkdown, options);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [cycle] = await database.insert(cycles).values({
            workspaceId: project.workspaceId, projectId: project.id, name: input.name, startDate: input.startDate, endDate: input.endDate, createdBy: context.userId, descriptionMarkdown: description.markdown, descriptionDoc: description.document,
          }).returning();
          await validateRichTextAssets(database, description.document, "cycle", cycle!.id, context.userId);
          return out(cycle!, []);
        });
      },
    },
    updateCycle: {
      name: "update_cycle", kind: "write" as const,
      input: Type.Object({ cycleId: uuid(), name: Type.Optional(nameSchema), startDate: Type.Optional(dateSchema), endDate: Type.Optional(dateSchema), description: Type.Optional(Type.Any()), descriptionMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH })) }), output: cycleOutput,
      handler: async (context: Context, input: { cycleId: string; name?: string; startDate?: string; endDate?: string; description?: unknown; descriptionMarkdown?: string }) => {
        const { cycle, project } = await cycleAccess(context, input.cycleId, "write");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [current] = await lockWritableCycles(database, [cycle.id], project.id);
          const startDate = input.startDate ?? current!.startDate, endDate = input.endDate ?? current!.endDate;
          assertDates(startDate, endDate);
          const patch: Partial<typeof cycles.$inferInsert> = { name: input.name ?? current!.name, startDate, endDate };
          if (input.description !== undefined || input.descriptionMarkdown !== undefined) {
            const options = await workItemMarkdownOptions(database, context.userId, project.workspaceId, project.id, input.descriptionMarkdown);
            const description = await writtenDescription(input.description, input.descriptionMarkdown, options);
            await validateRichTextAssets(database, description.document, "cycle", current!.id, context.userId, current!.descriptionDoc);
            patch.descriptionMarkdown = description.markdown; patch.descriptionDoc = description.document;
          }
          const [updated] = await database.update(cycles).set(patch).where(eq(cycles.id, current!.id)).returning();
          return out(updated!, (await counts(database, [cycle.id])).get(cycle.id)!);
        });
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
        const result = out(cycle, members);
        const options = await workItemMarkdownOptions(db, context.userId, (await requireProjectAccess(db, context.userId, cycle.projectId, "read")).project.workspaceId, cycle.projectId, cycle.descriptionMarkdown ?? "");
        result.description = cycle.descriptionDoc ?? await storedDocumentOf(cycle.descriptionMarkdown ?? "", options);
        if (cycle.descriptionMarkdown === null) result.descriptionMarkdown = await readWrittenFormOf(result.description, "");
        return { ...result, workItemIds: members.map((member) => member.workItemId) };
      },
    },
    getCycleBurndown: {
      name: "get_cycle_burndown", kind: "read" as const,
      input: Type.Object({ cycleId: uuid(), unit: Type.Optional(burndownUnitSchema) }),
      output: Type.Object({
        cycleId: Type.String(), unit: burndownUnitSchema, startDate: Type.String(), endDate: Type.String(), total: Type.Union([Type.Number(), Type.Null()]),
        initialScope: Type.Union([Type.Number(), Type.Null()]), finalOutcome: Type.Union([Type.Object({ completed: Type.Union([Type.Number(), Type.Null()]), open: Type.Union([Type.Number(), Type.Null()]), cancelled: Type.Union([Type.Number(), Type.Null()]), completedPoints: Type.Union([Type.Number(), Type.Null()]), openPoints: Type.Union([Type.Number(), Type.Null()]), cancelledPoints: Type.Union([Type.Number(), Type.Null()]) }), Type.Null()]),
        outcomeDate: Type.Union([Type.String(), Type.Null()]), initialPoints: Type.Union([Type.Number(), Type.Null()]), unestimated: Type.Union([Type.Number(), Type.Null()]), coverageStart: Type.String(), dateChanges: Type.Array(Type.Object({ at: Type.String(), previousStartDate: Type.String(), previousEndDate: Type.String(), startDate: Type.String(), endDate: Type.String() })),
        scopeChanges: Type.Array(Type.Object({ date: Type.String(), added: Type.Number(), removed: Type.Number() })),
        days: Type.Array(Type.Object({ date: Type.String(), open: Type.Union([Type.Number(), Type.Null()]), completed: Type.Optional(Type.Union([Type.Number(), Type.Null()])), cancelled: Type.Optional(Type.Union([Type.Number(), Type.Null()])), pointsOpen: Type.Optional(Type.Union([Type.Number(), Type.Null()])), pointsCompleted: Type.Optional(Type.Union([Type.Number(), Type.Null()])), pointsCancelled: Type.Optional(Type.Union([Type.Number(), Type.Null()])), unestimatedOpen: Type.Optional(Type.Union([Type.Number(), Type.Null()])), ideal: Type.Union([Type.Number(), Type.Null()]), idealPoints: Type.Optional(Type.Union([Type.Number(), Type.Null()])), unknown: Type.Optional(Type.Boolean()) })),
      }),
      handler: async (context: Context, input: { cycleId: string; unit?: BurndownUnit }) => {
        const { cycle } = await cycleAccess(context, input.cycleId, "read");
        const unit = input.unit ?? "items";
        if (unit === "points") await requirePointsEstimate(db, cycle.projectId);
        const events = await db.select().from(cycleHistory).where(eq(cycleHistory.cycleId, cycle.id)).orderBy(asc(cycleHistory.occurredAt), asc(cycleHistory.sequence));
        const coverageStart = cycle.historyStartedAt.toISOString();
        // The ideal baseline is the start-of-day scope; EOD observations on the start day remain usable after coverage begins.
        const initialUnknown = dayOf(cycle.startDate) < cycle.historyStartedAt.getTime();
        const dateChanges = events.filter((event) => event.kind === "dates" && event.previousStartDate && event.previousEndDate && event.startDate && event.endDate)
          .map((event) => ({ at: event.occurredAt.toISOString(), previousStartDate: event.previousStartDate!, previousEndDate: event.previousEndDate!, startDate: event.startDate!, endDate: event.endDate! }));
        const state = new Map<string, { member: boolean; group: string; estimate: number | null; known: boolean }>();
        const numericEstimate = (value: string | null) => value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
        const snapshots = events.filter((event) => event.workItemId !== null);
        const apply = (event: (typeof snapshots)[number]) => state.set(event.workItemId!, {
          member: event.member ?? true, group: event.stateGroup ?? "unknown", estimate: numericEstimate(event.estimate), known: true,
        });
        const initialCutoff = dayOf(cycle.startDate);
        let snapshotIndex = 0;
        while (snapshotIndex < snapshots.length && snapshots[snapshotIndex]!.occurredAt.getTime() < initialCutoff) {
          const event = snapshots[snapshotIndex++]!;
          if (event.occurredAt.getTime() >= cycle.historyStartedAt.getTime()) apply(event);
        }
        const initialScope = initialUnknown ? null : [...state.values()].filter((item) => item.member).length;
        const initialPoints = initialUnknown ? null : [...state.values()].filter((item) => item.member).reduce((sum, item) => sum + (item.estimate ?? 0), 0);
        const changesByDay = new Map<string, { date: string; added: number; removed: number }>();
        for (const event of events) if (event.kind === "membership") {
          const date = event.occurredAt.toISOString().slice(0, 10), change = changesByDay.get(date) ?? { date, added: 0, removed: 0 };
          if (event.member) change.added += 1;
          else if (event.member === false) change.removed += 1;
          changesByDay.set(date, change);
        }
        const days = [] as Array<{ date: string; open: number | null; completed: number | null; cancelled: number | null; pointsOpen: number | null; pointsCompleted: number | null; pointsCancelled: number | null; unestimatedOpen: number | null; ideal: number | null; idealPoints: number | null; unknown: boolean }>;
        const span = (dayOf(cycle.endDate) - dayOf(cycle.startDate)) / dayMs;
        const today = todayIso();
        for (let offset = 0; offset <= span; offset++) {
          const date = new Date(dayOf(cycle.startDate) + offset * dayMs).toISOString().slice(0, 10), cutoff = dayOf(date) + dayMs;
          while (snapshotIndex < snapshots.length && snapshots[snapshotIndex]!.occurredAt.getTime() < cutoff) {
            const event = snapshots[snapshotIndex++]!;
            if (event.occurredAt.getTime() >= cycle.historyStartedAt.getTime()) apply(event);
          }
          const observed = [...state.values()].filter((item) => item.member && item.known);
          const open = observed.filter((item) => item.group !== "completed" && item.group !== "cancelled");
          const completed = observed.filter((item) => item.group === "completed"), cancelled = observed.filter((item) => item.group === "cancelled");
          const future = date >= today;
          const unknown = cutoff <= cycle.historyStartedAt.getTime() || future;
          days.push({ date, open: future ? null : (unknown ? null : open.length), completed: future ? null : (unknown ? null : completed.length), cancelled: future ? null : (unknown ? null : cancelled.length), pointsOpen: future || unknown ? null : open.reduce((sum, item) => sum + (item.estimate ?? 0), 0), pointsCompleted: future || unknown ? null : completed.reduce((sum, item) => sum + (item.estimate ?? 0), 0), pointsCancelled: future || unknown ? null : cancelled.reduce((sum, item) => sum + (item.estimate ?? 0), 0), unestimatedOpen: future || unknown ? null : open.filter((item) => item.estimate === null).length, ideal: initialScope === null ? null : Math.round((initialScope * (span - offset) / (span || 1)) * 100) / 100, idealPoints: initialPoints === null ? null : Math.round((initialPoints * (span - offset) / (span || 1)) * 100) / 100, unknown });
        }
        // The inclusive end date is only an outcome after its UTC calendar day has closed.
        const cycleEnded = cycle.endDate < today;
        const finalDay = cycleEnded ? days.find((day) => day.date === cycle.endDate) : undefined;
        return { cycleId: cycle.id, unit, startDate: cycle.startDate, endDate: cycle.endDate, total: unit === "points" ? initialPoints : initialScope,
          initialScope,
          initialPoints,
          finalOutcome: finalDay ? { completed: finalDay.completed, open: finalDay.open, cancelled: finalDay.cancelled, completedPoints: finalDay.pointsCompleted, openPoints: finalDay.pointsOpen, cancelledPoints: finalDay.pointsCancelled } : null,
          outcomeDate: finalDay?.date ?? null, unestimated: finalDay?.unestimatedOpen ?? null, coverageStart, dateChanges,
          scopeChanges: [...changesByDay.values()].filter((change) => change.date >= cycle.startDate && change.date <= cycle.endDate), days };
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
      input: Type.Object({
        cycleId: uuid(), workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }),
        /** Moving an item from its current Cycle is always an explicit writer choice. */
        move: Type.Optional(Type.Boolean()),
        /** Current membership shown to the writer; reject a move if the selection has since changed. */
        expectedCycleIds: Type.Optional(Type.Record(uuid(), Type.Union([uuid(), Type.Null()]))),
      }),
      output: Type.Object({ added: Type.Array(Type.String()), skipped: Type.Array(Type.Object({ workItemId: Type.String(), cycleId: Type.String() })) }),
      handler: async (context: Context, input: { cycleId: string; workItemIds: string[]; move?: boolean; expectedCycleIds?: Record<string, string | null> }) => {
        const { cycle, project } = await cycleAccess(context, input.cycleId, "write");
        if (cycle.archivedAt) throw new ActionError("Cycle is archived", 400);
        if (cycleStatus(cycle.startDate, cycle.endDate) === "completed") throw new ActionError("Cannot add work items to a Cycle that has ended", 400);
        const ids = [...new Set(input.workItemIds)];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const memberships = ids.length ? await database.select({ workItemId: cycleItems.workItemId, cycleId: cycleItems.cycleId })
            .from(cycleItems).where(inArray(cycleItems.workItemId, ids)) : [];
          const sourceIds = memberships.map((row) => row.cycleId);
          const lockedCycles = await lockWritableCycles(database, [cycle.id, ...sourceIds], project.id);
          const targetNow = lockedCycles.find((row) => row.id === cycle.id)!;
          if (cycleStatus(targetNow.startDate, targetNow.endDate) === "completed") throw new ActionError("Cannot add work items to a Cycle that has ended", 400);
          const found = await database.select({ id: workItems.id, archivedAt: workItems.archivedAt }).from(workItems)
            .where(and(inArray(workItems.id, ids), eq(workItems.projectId, project.id), liveWorkItems)).orderBy(workItems.id).for("no key update");
          if (found.length !== ids.length) throw new ActionError("Work items must belong to this Cycle's project", 400);
          found.forEach(assertNotArchived);
          // The primary key on work_item_id decides races: the loser of a concurrent add gets no row back and is reported as skipped.
          const currentMemberships = ids.length ? await database.select({ workItemId: cycleItems.workItemId, cycleId: cycleItems.cycleId })
            .from(cycleItems).where(inArray(cycleItems.workItemId, ids)) : [];
          const byItem = new Map(currentMemberships.map((row) => [row.workItemId, row]));
          const added: string[] = [];
          const skipped: Array<{ workItemId: string; cycleId: string }> = [];
          for (const workItemId of ids) {
            const current = byItem.get(workItemId);
            if (current?.cycleId === cycle.id) continue;
            if (current) {
              const expected = input.expectedCycleIds?.[workItemId];
              // Legacy callers never move. New selection callers must explicitly opt in and prove the source they displayed.
              if (!input.move || expected !== current.cycleId) {
                skipped.push({ workItemId, cycleId: current.cycleId });
                continue;
              }
              const changed = await database.update(cycleItems).set({ cycleId: cycle.id }).where(and(eq(cycleItems.workItemId, workItemId), eq(cycleItems.cycleId, current.cycleId))).returning({ workItemId: cycleItems.workItemId });
              if (!changed.length) {
                const [latest] = await database.select({ cycleId: cycleItems.cycleId }).from(cycleItems).where(eq(cycleItems.workItemId, workItemId));
                if (latest) skipped.push({ workItemId, cycleId: latest.cycleId });
                continue;
              }
              await logCycleChange(database, context, project, workItemId, current.cycleId, cycle.id);
              added.push(workItemId);
              continue;
            }
            const inserted = await database.insert(cycleItems).values({ workItemId, cycleId: cycle.id, workspaceId: project.workspaceId, projectId: project.id })
            .onConflictDoNothing().returning({ workItemId: cycleItems.workItemId });
            if (inserted.length) {
              await logCycleChange(database, context, project, workItemId, null, cycle.id);
              added.push(workItemId);
            } else {
              const [latest] = await database.select({ cycleId: cycleItems.cycleId }).from(cycleItems).where(eq(cycleItems.workItemId, workItemId));
              if (latest && latest.cycleId !== cycle.id) skipped.push({ workItemId, cycleId: latest.cycleId });
            }
          }
          // Already in this very Cycle is a no-op, not a skip.
          return { added, skipped };
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
        if (input.targetCycleId === cycle.id) throw new ActionError("Choose a different Cycle", 400);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const locked = await database.select().from(cycles).where(and(inArray(cycles.id, [cycle.id, input.targetCycleId].sort()), eq(cycles.projectId, project.id), isNull(cycles.deletedAt)))
            .orderBy(asc(cycles.id)).for("update");
          if (locked.length !== 2) throw new ActionError("Cycle not found", 404);
          const source = locked.find((row) => row.id === cycle.id)!, target = locked.find((row) => row.id === input.targetCycleId)!;
          if (source.archivedAt) throw new ActionError("Cycle is archived", 400);
          if (cycleStatus(source.startDate, source.endDate) !== "completed") throw new ActionError("Only a completed Cycle can transfer its work items", 400);
          if (target.archivedAt || cycleStatus(target.startDate, target.endDate) === "completed") throw new ActionError("Cannot transfer work items to a Cycle that has ended", 400);
          const members = await database.select({ id: cycleItems.workItemId }).from(cycleItems).where(eq(cycleItems.cycleId, source.id)).orderBy(asc(cycleItems.workItemId));
          const candidateIds = members.map((row) => row.id);
          if (candidateIds.length) await database.select({ id: workItems.id }).from(workItems).where(inArray(workItems.id, candidateIds)).orderBy(asc(workItems.id)).for("update");
          const unfinished = await database.select({ id: cycleItems.workItemId }).from(cycleItems)
            .innerJoin(workItems, and(eq(workItems.id, cycleItems.workItemId), isNull(workItems.deletedAt)))
            .innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId))
            .where(and(eq(cycleItems.cycleId, cycle.id), notInArray(workItemStates.group, ["completed", "cancelled"])));
          const ids = unfinished.map((row) => row.id);
          if (ids.length) {
            await database.update(cycleItems).set({ cycleId: target.id }).where(and(inArray(cycleItems.workItemId, ids), eq(cycleItems.cycleId, source.id)));
            for (const workItemId of ids) await logCycleChange(database, context, project, workItemId, source.id, target.id);
          }
          return { transferred: ids };
        });
      },
    },
    /** Reviewable closeout: only selected items that are still unfinished members of the source move. */
    selectiveTransferCycleItems: {
      name: "selective_transfer_cycle_items", kind: "write" as const,
      input: Type.Object({ cycleId: uuid(), targetCycleId: uuid(), workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }) }),
      output: Type.Object({ transferred: Type.Array(Type.String()), conflicts: Type.Array(Type.Object({ workItemId: Type.String(), reason: Type.Union([Type.Literal("not_in_source"), Type.Literal("ineligible")]) })) }),
      handler: async (context: Context, input: { cycleId: string; targetCycleId: string; workItemIds: string[] }) => {
        const { cycle, project } = await cycleAccess(context, input.cycleId, "write");
        if (cycle.archivedAt) throw new ActionError("Cycle is archived", 400);
        if (cycleStatus(cycle.startDate, cycle.endDate) !== "completed") throw new ActionError("Only a completed Cycle can transfer its work items", 400);
        if (input.targetCycleId === cycle.id) throw new ActionError("Choose a different Cycle", 400);
        const [target] = await db.select().from(cycles).where(and(eq(cycles.id, input.targetCycleId), eq(cycles.projectId, project.id), isNull(cycles.deletedAt)));
        if (!target) throw new ActionError("Cycle not found", 404);
        if (target.archivedAt || cycleStatus(target.startDate, target.endDate) === "completed") throw new ActionError("Cannot transfer work items to a Cycle that has ended", 400);
        const ids = [...new Set(input.workItemIds)];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const lockedCycles = await database.select().from(cycles).where(inArray(cycles.id, [cycle.id, target.id])).orderBy(asc(cycles.id)).for("update");
          const sourceNow = lockedCycles.find((row) => row.id === cycle.id);
          const targetNow = lockedCycles.find((row) => row.id === target.id);
          if (!sourceNow || sourceNow.deletedAt || sourceNow.projectId !== project.id) throw new ActionError("Cycle not found", 404);
          if (sourceNow.archivedAt) throw new ActionError("Cycle is archived", 400);
          if (cycleStatus(sourceNow.startDate, sourceNow.endDate) !== "completed") throw new ActionError("Only a completed Cycle can transfer its work items", 400);
          if (!targetNow || targetNow.deletedAt || targetNow.projectId !== project.id) throw new ActionError("Cycle not found", 404);
          if (targetNow.archivedAt || cycleStatus(targetNow.startDate, targetNow.endDate) === "completed") throw new ActionError("Cannot transfer work items to a Cycle that has ended", 400);
          // Serialize against state and membership changes before deciding eligibility.
          await database.select({ id: workItems.id }).from(workItems).where(inArray(workItems.id, ids)).orderBy(asc(workItems.id)).for("update");
          const current = await database.select({ id: cycleItems.workItemId, group: workItemStates.group }).from(cycleItems)
            .innerJoin(workItems, and(eq(workItems.id, cycleItems.workItemId), isNull(workItems.deletedAt)))
            .innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId))
            .where(and(eq(cycleItems.cycleId, cycle.id), inArray(cycleItems.workItemId, ids)));
          const byId = new Map(current.map((row) => [row.id, row.group]));
          const transferred: string[] = [], conflicts: Array<{ workItemId: string; reason: "not_in_source" | "ineligible" }> = [];
          for (const id of ids) {
            const group = byId.get(id);
            if (group === undefined) { conflicts.push({ workItemId: id, reason: "not_in_source" }); continue; }
            if (group === "completed" || group === "cancelled") { conflicts.push({ workItemId: id, reason: "ineligible" }); continue; }
            const [moved] = await database.update(cycleItems).set({ cycleId: target.id })
              .where(and(eq(cycleItems.workItemId, id), eq(cycleItems.cycleId, cycle.id))).returning({ workItemId: cycleItems.workItemId });
            if (moved) {
              await logCycleChange(database, context, project, id, cycle.id, target.id);
              transferred.push(id);
            } else conflicts.push({ workItemId: id, reason: "not_in_source" });
          }
          return { transferred, conflicts };
        });
      },
    },
    /** Admin only, and only once the Cycle has ended. Membership stays; the Cycle leaves the default list. */
    archiveCycle: {
      name: "archive_cycle", kind: "write" as const,
      input: Type.Object({ cycleId: uuid() }), output: cycleOutput,
      handler: async (context: Context, input: { cycleId: string }) => {
        const { cycle, project } = await cycleAccess(context, input.cycleId, "admin");
        const [updated] = await db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [current] = await database.select().from(cycles).where(and(eq(cycles.id, cycle.id), eq(cycles.projectId, project.id), isNull(cycles.deletedAt))).for("update");
          if (!current) throw new ActionError("Cycle not found", 404);
          if (cycleStatus(current.startDate, current.endDate) !== "completed") throw new ActionError("Only a completed Cycle can be archived", 400);
          return database.update(cycles).set({ archivedAt: current.archivedAt ?? new Date() }).where(eq(cycles.id, current.id)).returning();
        });
        return out(updated!, (await counts(db, [cycle.id])).get(cycle.id)!);
      },
    },
    /** Admin only, as archiving is. Clears the archive time and changes nothing else; the Cycle returns to the default list. */
    unarchiveCycle: {
      name: "unarchive_cycle", kind: "write" as const,
      input: Type.Object({ cycleId: uuid() }), output: cycleOutput,
      handler: async (context: Context, input: { cycleId: string }) => {
        const { cycle, project } = await cycleAccess(context, input.cycleId, "admin");
        const [updated] = await db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.id, cycle.id), eq(cycles.projectId, project.id), isNull(cycles.deletedAt))).for("update");
          return database.update(cycles).set({ archivedAt: null }).where(eq(cycles.id, cycle.id)).returning();
        });
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
          await database.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.id, cycle.id), eq(cycles.projectId, project.id), isNull(cycles.deletedAt))).for("update");
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
        if (cycle.archivedAt) throw new ActionError("Cycle is archived", 400);
        const ids = [...new Set(input.workItemIds)];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await lockWritableCycles(database, [cycle.id], project.id);
          await assertNoneArchived(database, ids);
          const deleted = await database.delete(cycleItems).where(and(eq(cycleItems.cycleId, cycle.id), inArray(cycleItems.workItemId, ids))).returning({ workItemId: cycleItems.workItemId });
          for (const row of deleted) await logCycleChange(database, context, project, row.workItemId, cycle.id, null);
          return { removed: deleted.map((row) => row.workItemId) };
        });
      },
    },
  };
}
