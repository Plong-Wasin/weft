import { Type } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import { activities, projects, recurrences, users, type Database } from "@weft/db";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import { enqueueJob } from "./jobs";
import { nextCalendarOccurrence, type CalendarSchedule } from "./schedules";
import { createWorkItemActions } from "./work-items";

type Context = { userId: string; source?: "ui" | "ai" | "ai_autopilot" | "cli" | "mcp" | "agent" | "agent_autopilot"; agent?: { agentUserId: string; runId: string; originatorId: string; autopilot?: boolean } };
const uuid = () => Type.String({ format: "uuid" });
const calendar = Type.Object({ unit: Type.Union(["day", "week", "month", "year"].map((unit) => Type.Literal(unit))), interval: Type.Integer({ minimum: 1 }), time: Type.String(), timezone: Type.String(), anchorDate: Type.String(), weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 })),), dayOfMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })), month: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), day: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })) });
const dateInput = Type.Union([Type.String({ format: "date" }), Type.Null()]);

async function assertHuman(db: Database, userId: string) {
  const [user] = await db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, userId));
  if (!user || user.isAgent) throw new ActionError("Agents cannot manage Recurrences", 403);
}

export function createRecurrenceActions(db: Database) {
  async function writable(context: Context, recurrenceId: string) {
    await assertHuman(db, context.userId);
    const [row] = await db.select().from(recurrences).where(eq(recurrences.id, recurrenceId));
    if (!row) throw new ActionError("Recurrence not found", 404);
    await requireProjectAccess(db, context.userId, row.projectId, "write");
    return row;
  }
  const createRecurrence = { name: "create_recurrence", kind: "write" as const,
    input: Type.Object({ projectId: uuid(), name: Type.String({ minLength: 1, maxLength: 200 }), template: Type.Object({ title: Type.String({ minLength: 1, maxLength: 500 }), description: Type.Optional(Type.Any()), priority: Type.Optional(Type.Union(["urgent", "high", "medium", "low", "none"].map((value) => Type.Literal(value)))), assigneeIds: Type.Optional(Type.Array(Type.String())), labelIds: Type.Optional(Type.Array(uuid())), stateId: Type.Optional(uuid()) }), schedule: calendar, endDate: Type.Optional(dateInput) }), output: Type.Any(),
    handler: async (context: Context, input: { projectId: string; name: string; template: { title: string; description?: unknown; priority?: "urgent" | "high" | "medium" | "low" | "none"; assigneeIds?: string[]; labelIds?: string[]; stateId?: string }; schedule: CalendarSchedule; endDate?: string | null }) => {
      await assertHuman(db, context.userId);
      const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
      let nextRunAt: Date;
      try { nextRunAt = nextCalendarOccurrence(input.schedule, new Date()); } catch (error) { throw new ActionError(error instanceof Error ? error.message : "Invalid schedule", 400); }
      const [row] = await db.insert(recurrences).values({ workspaceId: project.workspaceId, projectId: project.id, creatorId: context.userId, name: input.name, template: input.template, schedule: JSON.stringify(input.schedule), interval: input.schedule.interval, timezone: input.schedule.timezone, nextRunAt, endDate: input.endDate ?? null }).returning();
      if (row) await enqueueJob(db, { type: "schedule_recurrence", payload: { recurrenceId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_recurrence:${row.id}:${nextRunAt.toISOString()}` });
      return row;
    } };
  const getRecurrence = { name: "get_recurrence", kind: "read" as const, input: Type.Object({ recurrenceId: uuid() }), output: Type.Any(), handler: async (context: Context, input: { recurrenceId: string }) => {
    const [row] = await db.select().from(recurrences).where(eq(recurrences.id, input.recurrenceId)); if (!row) throw new ActionError("Recurrence not found", 404);
    await requireProjectAccess(db, context.userId, row.projectId, "read");
    if (row.status === "active" && endedOn(row.endDate, row.timezone, new Date())) { const [ended] = await db.update(recurrences).set({ status: "ended" }).where(eq(recurrences.id, row.id)).returning(); return ended; }
    return row;
  } };
  const listRecurrences = { name: "list_recurrences", kind: "read" as const, input: Type.Object({ projectId: uuid() }), output: Type.Array(Type.Any()), handler: async (context: Context, input: { projectId: string }) => {
    await requireProjectAccess(db, context.userId, input.projectId, "read");
    const rows = await db.select().from(recurrences).where(eq(recurrences.projectId, input.projectId));
    return Promise.all(rows.map(async (row) => {
      if (row.status !== "active" || !endedOn(row.endDate, row.timezone, new Date())) return row;
      const [ended] = await db.update(recurrences).set({ status: "ended" }).where(eq(recurrences.id, row.id)).returning(); return ended ?? row;
    }));
  } };
  const updateRecurrence = { name: "update_recurrence", kind: "write" as const,
    input: Type.Object({ recurrenceId: uuid(), name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), template: Type.Optional(createRecurrence.input.properties.template), schedule: Type.Optional(calendar), endDate: Type.Optional(dateInput) }), output: Type.Any(),
    handler: async (context: Context, input: { recurrenceId: string; name?: string; template?: unknown; schedule?: CalendarSchedule; endDate?: string | null }) => {
      const row = await writable(context, input.recurrenceId);
      let nextRunAt = row.nextRunAt;
      if (input.schedule) { try { nextRunAt = nextCalendarOccurrence(input.schedule, new Date()); } catch (error) { throw new ActionError(error instanceof Error ? error.message : "Invalid schedule", 400); } }
      const endDate = input.endDate === undefined ? row.endDate : input.endDate;
      const status = endedOn(endDate, input.schedule?.timezone ?? row.timezone, new Date()) ? "ended" : row.status;
      const [updated] = await db.update(recurrences).set({ name: input.name ?? row.name, template: input.template ?? row.template, schedule: input.schedule ? JSON.stringify(input.schedule) : row.schedule, interval: input.schedule?.interval ?? row.interval, timezone: input.schedule?.timezone ?? row.timezone, endDate, status, nextRunAt }).where(eq(recurrences.id, row.id)).returning();
      if (updated && updated.status === "active") await enqueueJob(db, { type: "schedule_recurrence", payload: { recurrenceId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_recurrence:${row.id}:${nextRunAt.toISOString()}` });
      return updated;
    } };
  const pauseRecurrence = { name: "pause_recurrence", kind: "write" as const, input: Type.Object({ recurrenceId: uuid() }), output: Type.Any(), handler: async (context: Context, input: { recurrenceId: string }) => { const row = await writable(context, input.recurrenceId); if (row.status === "ended") return row; const [updated] = await db.update(recurrences).set({ status: "paused" }).where(eq(recurrences.id, row.id)).returning(); return updated; } };
  const resumeRecurrence = { name: "resume_recurrence", kind: "write" as const, input: Type.Object({ recurrenceId: uuid() }), output: Type.Any(), handler: async (context: Context, input: { recurrenceId: string }) => {
    const row = await writable(context, input.recurrenceId); if (row.status === "ended") return row;
    const now = new Date(); if (endedOn(row.endDate, row.timezone, now)) { const [updated] = await db.update(recurrences).set({ status: "ended" }).where(eq(recurrences.id, row.id)).returning(); return updated; }
    const nextRunAt = nextCalendarOccurrence(JSON.parse(row.schedule) as CalendarSchedule, now);
    const [updated] = await db.update(recurrences).set({ status: "active", nextRunAt }).where(eq(recurrences.id, row.id)).returning();
    if (updated) await enqueueJob(db, { type: "schedule_recurrence", payload: { recurrenceId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_recurrence:${row.id}:${nextRunAt.toISOString()}` }); return updated;
  } };
  const deleteRecurrence = { name: "delete_recurrence", kind: "write" as const, input: Type.Object({ recurrenceId: uuid() }), output: Type.Object({ deleted: Type.Boolean() }), handler: async (context: Context, input: { recurrenceId: string }) => { const row = await writable(context, input.recurrenceId); await db.delete(recurrences).where(eq(recurrences.id, row.id)); return { deleted: true }; } };
  const runRecurrenceNow = { name: "run_recurrence_now", kind: "write" as const, input: Type.Object({ recurrenceId: uuid() }), output: Type.Any(), handler: async (context: Context, input: { recurrenceId: string }) => { const row = await writable(context, input.recurrenceId); return db.transaction(async (transaction) => { const tx = transaction as unknown as Database; const now = new Date(); const item = await createRecurrenceItem(tx, row, now); await tx.update(recurrences).set({ lastRunAt: now }).where(eq(recurrences.id, row.id)); return item; }); } };
  return { createRecurrence, getRecurrence, listRecurrences, updateRecurrence, pauseRecurrence, resumeRecurrence, deleteRecurrence, runRecurrenceNow };
}

function endedOn(endDate: string | null, timezone: string, now: Date) {
  if (!endDate) return false;
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now) > endDate; }
  catch { return now.toISOString().slice(0, 10) > endDate; }
}

async function createRecurrenceItem(db: Database, row: typeof recurrences.$inferSelect, now: Date) {
  const template = row.template as { title: string; description?: unknown; priority?: "urgent" | "high" | "medium" | "low" | "none"; assigneeIds?: string[]; labelIds?: string[]; stateId?: string };
  const item = await createWorkItemActions(db).createWorkItem.handler({ userId: row.creatorId, source: "ui" }, { projectId: row.projectId, ...template });
  await db.insert(activities).values({ workspaceId: row.workspaceId, projectId: row.projectId, entityType: "work_item", entityId: item.id, field: "recurrence_created", oldValue: null, newValue: { recurrenceId: row.id, name: row.name }, actorId: row.creatorId, source: "ui", chatId: null, runId: null, originatorId: null });
  return item;
}

/** Creates one due Work item and moves the schedule beyond now, so missed rounds are not replayed. */
export async function fireScheduleRecurrence(db: Database, input: { recurrenceId: string; now?: Date }) {
  const now = input.now ?? new Date();
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const [row] = await tx.select().from(recurrences).where(eq(recurrences.id, input.recurrenceId)).for("update");
    if (!row || row.status !== "active" || row.nextRunAt > now) return;
    if (endedOn(row.endDate, row.timezone, now)) { await tx.update(recurrences).set({ status: "ended" }).where(eq(recurrences.id, row.id)); return; }
    const nextRunAt = nextCalendarOccurrence(JSON.parse(row.schedule) as CalendarSchedule, now);
    const [creator] = await tx.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, row.creatorId));
    if (!creator || creator.isAgent) { await tx.update(recurrences).set({ status: "paused" }).where(eq(recurrences.id, row.id)); return; }
    const [project] = await tx.select().from(projects).where(eq(projects.id, row.projectId));
    if (!project) return;
    try {
      await createRecurrenceItem(tx, row, now);
      await tx.update(recurrences).set({ lastRunAt: now, nextRunAt }).where(eq(recurrences.id, row.id));
      await enqueueJob(tx, { type: "schedule_recurrence", payload: { recurrenceId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_recurrence:${row.id}:${nextRunAt.toISOString()}` });
    } catch (error) { if (error instanceof ActionError && error.status === 403) { await tx.update(recurrences).set({ status: "paused" }).where(eq(recurrences.id, row.id)); return; } throw error; }
  });
}
