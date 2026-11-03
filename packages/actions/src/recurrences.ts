import { Type } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import { activities, projects, recurrences, users, type Database } from "@weft/db";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import { enqueueJob } from "./jobs";
import { nextCalendarOccurrence, type CalendarSchedule } from "./schedules";
import { createWorkItemActions } from "./work-items";
import { pauseCreatorRecurrences } from "./recurrence-pause";

type Context = { userId: string; source?: "ui" | "ai" | "ai_autopilot" | "cli" | "mcp" | "agent" | "agent_autopilot"; agent?: { agentUserId: string; runId: string; originatorId: string; autopilot?: boolean } };
const uuid = () => Type.String({ format: "uuid" });
const calendar = Type.Object({ unit: Type.Union(["day", "week", "month", "year"].map((unit) => Type.Literal(unit))), interval: Type.Integer({ minimum: 1 }), time: Type.String(), timezone: Type.String(), anchorDate: Type.String(), weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 })),), dayOfMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })), month: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), day: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })) });

async function assertHuman(db: Database, userId: string) {
  const [user] = await db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, userId));
  if (!user || user.isAgent) throw new ActionError("Agents cannot manage Recurrences", 403);
}

export function createRecurrenceActions(db: Database) {
  const createRecurrence = { name: "create_recurrence", kind: "write" as const,
    input: Type.Object({ projectId: uuid(), name: Type.String({ minLength: 1, maxLength: 200 }), template: Type.Object({ title: Type.String({ minLength: 1, maxLength: 500 }), description: Type.Optional(Type.Any()), priority: Type.Optional(Type.Union(["urgent", "high", "medium", "low", "none"].map((value) => Type.Literal(value)))), assigneeIds: Type.Optional(Type.Array(Type.String())), labelIds: Type.Optional(Type.Array(uuid())), stateId: Type.Optional(uuid()) }), schedule: calendar }), output: Type.Any(),
    handler: async (context: Context, input: { projectId: string; name: string; template: { title: string; description?: unknown; priority?: "urgent" | "high" | "medium" | "low" | "none"; assigneeIds?: string[]; labelIds?: string[]; stateId?: string }; schedule: CalendarSchedule }) => {
      await assertHuman(db, context.userId);
      const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
      let nextRunAt: Date;
      try { nextRunAt = nextCalendarOccurrence(input.schedule, new Date()); } catch (error) { throw new ActionError(error instanceof Error ? error.message : "Invalid schedule", 400); }
      const [row] = await db.insert(recurrences).values({ workspaceId: project.workspaceId, projectId: project.id, creatorId: context.userId, name: input.name, template: input.template, schedule: JSON.stringify(input.schedule), interval: input.schedule.interval, timezone: input.schedule.timezone, nextRunAt }).returning();
      if (row) await enqueueJob(db, { type: "schedule_recurrence", payload: { recurrenceId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_recurrence:${row.id}:${nextRunAt.toISOString()}` });
      return row;
    } };
  const getRecurrence = { name: "get_recurrence", kind: "read" as const, input: Type.Object({ recurrenceId: uuid() }), output: Type.Any(), handler: async (context: Context, input: { recurrenceId: string }) => {
    const [row] = await db.select().from(recurrences).where(eq(recurrences.id, input.recurrenceId)); if (!row) throw new ActionError("Recurrence not found", 404);
    await requireProjectAccess(db, context.userId, row.projectId, "read"); return row;
  } };
  const listRecurrences = { name: "list_recurrences", kind: "read" as const, input: Type.Object({ projectId: uuid() }), output: Type.Array(Type.Any()), handler: async (context: Context, input: { projectId: string }) => {
    await requireProjectAccess(db, context.userId, input.projectId, "read"); return db.select().from(recurrences).where(eq(recurrences.projectId, input.projectId));
  } };
  return { createRecurrence, getRecurrence, listRecurrences };
}

/** Creates one due Work item and moves the schedule beyond now, so missed rounds are not replayed. */
export async function fireScheduleRecurrence(db: Database, input: { recurrenceId: string; now?: Date }) {
  const now = input.now ?? new Date();
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const [row] = await tx.select().from(recurrences).where(eq(recurrences.id, input.recurrenceId)).for("update");
    if (!row || row.status !== "active" || row.nextRunAt > now) return;
    const nextRunAt = nextCalendarOccurrence(JSON.parse(row.schedule) as CalendarSchedule, now);
    const [creator] = await tx.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, row.creatorId));
    if (!creator || creator.isAgent) { await pauseCreatorRecurrences(tx, row.creatorId, { projectId: row.projectId }, "creator is no longer able to write in the project", row.creatorId, now); return; }
    const [project] = await tx.select().from(projects).where(eq(projects.id, row.projectId));
    if (!project) return;
    const template = row.template as { title: string; description?: unknown; priority?: "urgent" | "high" | "medium" | "low" | "none"; assigneeIds?: string[]; labelIds?: string[]; stateId?: string };
    try {
      const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: row.creatorId, source: "ui" }, { projectId: row.projectId, ...template });
      await tx.insert(activities).values({ workspaceId: row.workspaceId, projectId: row.projectId, entityType: "work_item", entityId: item.id, field: "recurrence_created", oldValue: null, newValue: { recurrenceId: row.id, name: row.name }, actorId: row.creatorId, source: "ui", chatId: null, runId: null, originatorId: null });
      await tx.update(recurrences).set({ lastRunAt: now, nextRunAt }).where(eq(recurrences.id, row.id));
      await enqueueJob(tx, { type: "schedule_recurrence", payload: { recurrenceId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_recurrence:${row.id}:${nextRunAt.toISOString()}` });
    } catch (error) { if (error instanceof ActionError && (error.status === 403 || error.status === 404)) { await pauseCreatorRecurrences(tx, row.creatorId, { projectId: row.projectId }, "creator no longer has write access to the project", row.creatorId, now); return; } throw error; }
  });
}
