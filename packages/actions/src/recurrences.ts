import { Type } from "@sinclair/typebox";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { activities, cycleItems, cycles, estimatePoints, estimates, labels, moduleItems, modules, projectMembers, projects, recurrences, users, workItemStates, workItems, type Database } from "@weft/db";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import { enqueueJob } from "./jobs";
import { nextCalendarOccurrence, type CalendarSchedule } from "./schedules";
import { createWorkItemActions } from "./work-items";

type Context = { userId: string; source?: "ui" | "ai" | "ai_autopilot" | "cli" | "mcp" | "agent" | "agent_autopilot"; agent?: { agentUserId: string; runId: string; originatorId: string; autopilot?: boolean } };
const uuid = () => Type.String({ format: "uuid" });
const calendar = Type.Object({ unit: Type.Union(["day", "week", "month", "year"].map((unit) => Type.Literal(unit))), interval: Type.Integer({ minimum: 1 }), time: Type.String(), timezone: Type.String(), anchorDate: Type.String(), weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 })),), dayOfMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })), month: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), day: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })) });

async function assertHuman(db: Database, userId: string) {
  const [user] = await db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, userId));
  if (!user || user.isAgent) throw new ActionError("Agents cannot manage Recurrences", 403);
}

export function createRecurrenceActions(db: Database) {
  const createRecurrence = { name: "create_recurrence", kind: "write" as const,
    input: Type.Object({ projectId: uuid(), name: Type.String({ minLength: 1, maxLength: 200 }), template: Type.Object({ title: Type.String({ minLength: 1, maxLength: 500 }), description: Type.Optional(Type.Any()), priority: Type.Optional(Type.Union(["urgent", "high", "medium", "low", "none"].map((value) => Type.Literal(value)))), assigneeIds: Type.Optional(Type.Array(Type.String())), labelIds: Type.Optional(Type.Array(uuid())), stateId: Type.Optional(uuid()), estimatePointId: Type.Optional(uuid()), moduleIds: Type.Optional(Type.Array(uuid())), parentId: Type.Optional(uuid()), dueDateOffsetDays: Type.Optional(Type.Integer({ minimum: 0 })), addToActiveCycle: Type.Optional(Type.Boolean()) }), schedule: calendar }), output: Type.Any(),
    handler: async (context: Context, input: { projectId: string; name: string; template: Template; schedule: CalendarSchedule }) => {
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

type Template = { title: string; description?: unknown; priority?: "urgent" | "high" | "medium" | "low" | "none"; assigneeIds?: string[]; labelIds?: string[]; stateId?: string; estimatePointId?: string; moduleIds?: string[]; parentId?: string; dueDateOffsetDays?: number; addToActiveCycle?: boolean };

/** Creates one due Work item and moves the schedule beyond now, so missed rounds are not replayed. */
export async function fireScheduleRecurrence(db: Database, input: { recurrenceId: string; now?: Date }) {
  const now = input.now ?? new Date();
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const [row] = await tx.select().from(recurrences).where(eq(recurrences.id, input.recurrenceId)).for("update");
    if (!row || row.status !== "active" || row.nextRunAt > now) return;
    const nextRunAt = nextCalendarOccurrence(JSON.parse(row.schedule) as CalendarSchedule, now);
    const [creator] = await tx.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, row.creatorId));
    if (!creator || creator.isAgent) { await tx.update(recurrences).set({ status: "paused" }).where(eq(recurrences.id, row.id)); return; }
    const [project] = await tx.select().from(projects).where(eq(projects.id, row.projectId));
    if (!project) return;
    const template = row.template as Template;
    try {
      const warnings: string[] = [];
      const [state] = template.stateId ? await tx.select({ id: workItemStates.id }).from(workItemStates).where(and(eq(workItemStates.id, template.stateId), eq(workItemStates.projectId, row.projectId))) : [];
      if (template.stateId && !state) warnings.push("state was removed; used the project default state");
      const members = template.assigneeIds?.length ? await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, row.projectId), inArray(projectMembers.userId, template.assigneeIds))) : [];
      const assigneeIds = members.map((member) => member.userId);
      if (assigneeIds.length !== (template.assigneeIds ?? []).length) warnings.push("one or more assignees were removed");
      const validLabels = template.labelIds?.length ? await tx.select({ id: labels.id }).from(labels).where(and(eq(labels.projectId, row.projectId), inArray(labels.id, template.labelIds))) : [];
      const labelIds = validLabels.map((label) => label.id);
      if (labelIds.length !== (template.labelIds ?? []).length) warnings.push("one or more labels were removed");
      const validModules = template.moduleIds?.length ? await tx.select({ id: modules.id }).from(modules).where(and(eq(modules.projectId, row.projectId), inArray(modules.id, template.moduleIds), isNull(modules.deletedAt))) : [];
      const moduleIds = validModules.map((module) => module.id);
      if (moduleIds.length !== (template.moduleIds ?? []).length) warnings.push("one or more Modules were removed");
      const [parent] = template.parentId ? await tx.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.id, template.parentId), eq(workItems.projectId, row.projectId), isNull(workItems.deletedAt))) : [];
      if (template.parentId && !parent) warnings.push("parent Work item was removed");
      const [estimatePoint] = template.estimatePointId ? await tx.select({ id: estimatePoints.id }).from(estimatePoints).innerJoin(estimates, eq(estimatePoints.estimateId, estimates.id)).where(and(eq(estimatePoints.id, template.estimatePointId), eq(estimates.projectId, row.projectId))) : [];
      if (template.estimatePointId && !estimatePoint) warnings.push("Estimate point was removed");
      const dueDate = template.dueDateOffsetDays === undefined ? undefined : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + template.dueDateOffsetDays)).toISOString().slice(0, 10);
      const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: row.creatorId, source: "ui" }, { projectId: row.projectId, title: template.title, description: template.description, priority: template.priority, stateId: state?.id, assigneeIds, labelIds, estimatePointId: estimatePoint?.id, parentId: parent?.id, dueDate });
      if (moduleIds.length) await tx.insert(moduleItems).values(moduleIds.map((moduleId) => ({ moduleId, workItemId: item.id, workspaceId: row.workspaceId, projectId: row.projectId })));
      if (template.addToActiveCycle) {
        const day = now.toISOString().slice(0, 10);
        const [cycle] = await tx.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.projectId, row.projectId), isNull(cycles.deletedAt), isNull(cycles.archivedAt), sql`${cycles.startDate} <= ${day}`, sql`${cycles.endDate} >= ${day}`)).limit(1);
        if (cycle) await tx.insert(cycleItems).values({ cycleId: cycle.id, workItemId: item.id, workspaceId: row.workspaceId, projectId: row.projectId });
      }
      await tx.insert(activities).values({ workspaceId: row.workspaceId, projectId: row.projectId, entityType: "work_item", entityId: item.id, field: "recurrence_created", oldValue: null, newValue: { recurrenceId: row.id, name: row.name }, actorId: row.creatorId, source: "ui", chatId: null, runId: null, originatorId: null });
      await tx.update(recurrences).set({ lastRunAt: now, nextRunAt, lastWarning: warnings.length ? warnings.join("; ") : null }).where(eq(recurrences.id, row.id));
      await enqueueJob(tx, { type: "schedule_recurrence", payload: { recurrenceId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_recurrence:${row.id}:${nextRunAt.toISOString()}` });
    } catch (error) { if (error instanceof ActionError && error.status === 403) { await tx.update(recurrences).set({ status: "paused" }).where(eq(recurrences.id, row.id)); return; } throw error; }
  });
}
