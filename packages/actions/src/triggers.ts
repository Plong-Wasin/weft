import { Type } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, projectMembers, projects, triggers, users, runs } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { enqueueJob } from "./jobs";
import { nextScheduleOccurrence, parseCron, type ScheduleKind } from "./schedules";

const eventTypes = ["work_item_created", "work_item_updated", "state_changed", "assignee_changed", "comment_added"] as const;
type Context = { userId: string };
const scheduleKinds = ["daily", "weekly", "monthly", "cron"] as const;

export function createTriggerActions(db: Database) {
  async function admin(context: Context, agentId: string, projectId?: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw new ActionError("Agent not found", 404);
    await requireWorkspaceRole(db, context.userId, agent.workspaceId, "admin");
    if (projectId) {
      const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, agent.workspaceId)));
      if (!project) throw new ActionError("Project not found", 404);
      const opened = agent.allProjects || (await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, agent.userId)))).length > 0;
      if (!opened) throw new ActionError("Agent is not opened to this project", 400);
    }
    return agent;
  }
  return {
    createTrigger: { name: "create_trigger", kind: "write" as const, input: Type.Object({ agentId: Type.String({ format: "uuid" }), projectId: Type.String({ format: "uuid" }), eventType: Type.Optional(Type.Union(eventTypes.map((e) => Type.Literal(e)))), schedule: Type.Optional(Type.Union(scheduleKinds.map((s) => Type.Literal(s)))), expression: Type.Optional(Type.String({ maxLength: 200 })) }), output: Type.Any(),
      handler: async (context: Context, input: { agentId: string; projectId: string; eventType?: typeof eventTypes[number]; schedule?: ScheduleKind; expression?: string }) => {
        await admin(context, input.agentId, input.projectId);
        if (!!input.eventType === !!input.schedule) throw new ActionError("Choose an event or a schedule", 400);
        if (input.schedule === "cron") { try { parseCron(input.expression ?? ""); } catch (error) { throw new ActionError(error instanceof Error ? error.message : "Invalid cron expression", 400); } }
        const now = new Date();
        const [row] = await db.insert(triggers).values({ agentId: input.agentId, projectId: input.projectId, creatorId: context.userId, eventType: input.eventType ?? null, schedule: input.schedule ?? null, expression: input.expression ?? null, nextRunAt: input.schedule ? nextScheduleOccurrence(input.schedule, input.expression ?? null, now) : null }).returning();
        if (row?.nextRunAt) await enqueueJob(db, { type: "schedule_trigger", payload: { triggerId: row.id }, runAt: row.nextRunAt, dedupeKey: `schedule_trigger:${row.id}:${row.nextRunAt.toISOString()}` });
        return row;
      } },
    updateTrigger: { name: "update_trigger", kind: "write" as const, input: Type.Object({ triggerId: Type.String({ format: "uuid" }), eventType: Type.Optional(Type.Union(eventTypes.map((e) => Type.Literal(e)))), schedule: Type.Optional(Type.Union(scheduleKinds.map((s) => Type.Literal(s)))), expression: Type.Optional(Type.String({ maxLength: 200 })), projectId: Type.Optional(Type.String({ format: "uuid" })) }), output: Type.Any(),
      handler: async (context: Context, input: { triggerId: string; eventType?: typeof eventTypes[number]; schedule?: ScheduleKind; expression?: string; projectId?: string }) => {
        const [row] = await db.select().from(triggers).where(eq(triggers.id, input.triggerId)); if (!row) throw new ActionError("Trigger not found", 404);
        await admin(context, row.agentId, input.projectId ?? row.projectId);
        const schedule = input.eventType ? null : input.schedule ?? row.schedule;
        const expression = schedule ? input.expression ?? row.expression : null;
        if (schedule === "cron") { try { parseCron(expression ?? ""); } catch (error) { throw new ActionError(error instanceof Error ? error.message : "Invalid cron expression", 400); } }
        const [updated] = await db.update(triggers).set({ eventType: input.eventType ?? (input.schedule ? null : row.eventType), schedule, expression, nextRunAt: schedule ? nextScheduleOccurrence(schedule as ScheduleKind, expression, new Date()) : null, projectId: input.projectId ?? row.projectId }).where(eq(triggers.id, row.id)).returning();
        if (updated?.nextRunAt && !updated.paused) await enqueueJob(db, { type: "schedule_trigger", payload: { triggerId: row.id }, runAt: updated.nextRunAt, dedupeKey: `schedule_trigger:${row.id}:${updated.nextRunAt.toISOString()}` }); return updated;
      } },
    pauseTrigger: { name: "pause_trigger", kind: "write" as const, input: Type.Object({ triggerId: Type.String({ format: "uuid" }), paused: Type.Boolean() }), output: Type.Any(), handler: async (context: Context, input: { triggerId: string; paused: boolean }) => {
      const [row] = await db.select().from(triggers).where(eq(triggers.id, input.triggerId)); if (!row) throw new ActionError("Trigger not found", 404); await admin(context, row.agentId);
      const nextRunAt = !input.paused && row.schedule ? nextScheduleOccurrence(row.schedule as ScheduleKind, row.expression, new Date()) : row.nextRunAt;
      const [updated] = await db.update(triggers).set({ paused: input.paused, nextRunAt }).where(eq(triggers.id, row.id)).returning();
      if (!input.paused && updated?.schedule && updated.nextRunAt) await enqueueJob(db, { type: "schedule_trigger", payload: { triggerId: row.id }, runAt: updated.nextRunAt, dedupeKey: `schedule_trigger:${row.id}:${updated.nextRunAt.toISOString()}` }); return updated;
    } },
    deleteTrigger: { name: "delete_trigger", kind: "write" as const, input: Type.Object({ triggerId: Type.String({ format: "uuid" }) }), output: Type.Object({ deleted: Type.Boolean() }), handler: async (context: Context, input: { triggerId: string }) => {
      const [row] = await db.select().from(triggers).where(eq(triggers.id, input.triggerId)); if (!row) throw new ActionError("Trigger not found", 404); await admin(context, row.agentId); await db.delete(triggers).where(eq(triggers.id, row.id)); return { deleted: true };
    } },
    listTriggers: { name: "list_triggers", kind: "read" as const, input: Type.Object({ agentId: Type.String({ format: "uuid" }) }), output: Type.Array(Type.Any()), handler: async (context: Context, input: { agentId: string }) => {
      await admin(context, input.agentId); return db.select().from(triggers).where(eq(triggers.agentId, input.agentId));
    } },
  };
}

/** Queue one event-triggered Run after checking the Trigger creator still has write access. */
export async function fireEventTriggers(db: Database, input: { eventType: typeof eventTypes[number]; projectId: string; workItemId: string; actorId: string }) {
  const matching = await db.select({ trigger: triggers, agent: agents }).from(triggers).innerJoin(agents, eq(agents.id, triggers.agentId))
    .where(and(eq(triggers.projectId, input.projectId), eq(triggers.eventType, input.eventType), eq(triggers.paused, false), eq(agents.enabled, true)));
  if (matching.length === 0) return;
  const [actor] = await db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, input.actorId)); if (!actor || actor.isAgent) return;
  for (const { trigger, agent } of matching) {
    try { await requireProjectAccess(db, trigger.creatorId, input.projectId, "write"); }
    catch (error) { if (error instanceof ActionError) continue; throw error; }
    const [created] = await db.insert(runs).values({ workspaceId: agent.workspaceId, projectId: input.projectId, workItemId: input.workItemId, agentId: agent.id, originatorId: trigger.creatorId, triggerId: trigger.id })
      .onConflictDoNothing().returning({ id: runs.id });
    if (created) await enqueueJob(db, { type: "agent_run", payload: { runId: created.id }, dedupeKey: `agent_run:${created.id}` });
  }
}

/** Runs one due occurrence and advances directly to a future date so downtime never replays every missed interval. */
export async function fireScheduleTrigger(db: Database, input: { triggerId: string; now?: Date }) {
  const now = input.now ?? new Date();
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const [row] = await tx.select().from(triggers).where(eq(triggers.id, input.triggerId)).for("update");
    if (!row || row.paused || !row.schedule || !row.nextRunAt || row.nextRunAt > now) return;
    const nextRunAt = nextScheduleOccurrence(row.schedule as ScheduleKind, row.expression, now);
    await tx.update(triggers).set({ nextRunAt }).where(eq(triggers.id, row.id));
    const [agent] = await tx.select().from(agents).where(eq(agents.id, row.agentId));
    if (agent?.enabled) {
      try {
        await requireProjectAccess(tx, row.creatorId, row.projectId, "write");
        const [created] = await tx.insert(runs).values({ workspaceId: agent.workspaceId, projectId: row.projectId, workItemId: null, agentId: agent.id, originatorId: row.creatorId, triggerId: row.id }).returning({ id: runs.id });
        if (created) await enqueueJob(tx, { type: "agent_run", payload: { runId: created.id }, dedupeKey: `agent_run:${created.id}` });
      } catch (error) { if (!(error instanceof ActionError)) throw error; }
    }
    await enqueueJob(tx, { type: "schedule_trigger", payload: { triggerId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_trigger:${row.id}:${nextRunAt.toISOString()}` });
  });
}
