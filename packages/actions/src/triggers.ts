import { Type } from "@sinclair/typebox";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, projectMembers, projects, triggers, users, runs, workItemAssignees, workItemStates, workItems } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { enqueueJob } from "./jobs";
import { nextScheduleOccurrence, parseCron, type ScheduleKind } from "./schedules";
import { decideAndStartWake, enforceHourlyRunLimits, loadWakeStep, wakerOf } from "./runs";
import { hasAgentAccess } from "./agent-access";
import { auditAgentChange } from "./agent-audit";

const eventTypes = ["work_item_created", "work_item_updated", "state_changed", "assignee_changed", "comment_added", "sub_items_closed"] as const;
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
        const agent = await admin(context, input.agentId, input.projectId);
        if (!(await hasAgentAccess(db, agent.id, context.userId))) throw new ActionError("You do not have Agent access to this Agent", 403);
        if (!!input.eventType === !!input.schedule) throw new ActionError("Choose an event or a schedule", 400);
        if (input.schedule === "cron") { try { parseCron(input.expression ?? ""); } catch (error) { throw new ActionError(error instanceof Error ? error.message : "Invalid cron expression", 400); } }
        const now = new Date();
        const [row] = await db.insert(triggers).values({ agentId: input.agentId, projectId: input.projectId, creatorId: context.userId, eventType: input.eventType ?? null, schedule: input.schedule ?? null, expression: input.expression ?? null, nextRunAt: input.schedule ? nextScheduleOccurrence(input.schedule, input.expression ?? null, now) : null }).returning();
        if (row?.nextRunAt) await enqueueJob(db, { type: "schedule_trigger", payload: { triggerId: row.id }, runAt: row.nextRunAt, dedupeKey: `schedule_trigger:${row.id}:${row.nextRunAt.toISOString()}` });
        await auditAgentChange(db, { workspaceId: agent.workspaceId, entityType: "trigger", entityId: row!.id, field: "created", oldValue: null, newValue: { agentId: agent.id, projectId: row!.projectId, eventType: row!.eventType, schedule: row!.schedule }, actorId: context.userId });
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
        await auditAgentChange(db, { workspaceId: (await db.select({ workspaceId: agents.workspaceId }).from(agents).where(eq(agents.id, row.agentId)))[0]!.workspaceId, entityType: "trigger", entityId: row.id, field: "configuration", oldValue: { eventType: row.eventType, schedule: row.schedule, expression: row.expression, projectId: row.projectId }, newValue: { eventType: updated!.eventType, schedule: updated!.schedule, expression: updated!.expression, projectId: updated!.projectId }, actorId: context.userId });
        if (updated?.nextRunAt && !updated.paused) await enqueueJob(db, { type: "schedule_trigger", payload: { triggerId: row.id }, runAt: updated.nextRunAt, dedupeKey: `schedule_trigger:${row.id}:${updated.nextRunAt.toISOString()}` }); return updated;
      } },
    pauseTrigger: { name: "pause_trigger", kind: "write" as const, input: Type.Object({ triggerId: Type.String({ format: "uuid" }), paused: Type.Boolean() }), output: Type.Any(), handler: async (context: Context, input: { triggerId: string; paused: boolean }) => {
      const [row] = await db.select().from(triggers).where(eq(triggers.id, input.triggerId)); if (!row) throw new ActionError("Trigger not found", 404); await admin(context, row.agentId);
      const nextRunAt = !input.paused && row.schedule ? nextScheduleOccurrence(row.schedule as ScheduleKind, row.expression, new Date()) : row.nextRunAt;
      const [updated] = await db.update(triggers).set({ paused: input.paused, nextRunAt }).where(eq(triggers.id, row.id)).returning();
      const agent = (await db.select({ workspaceId: agents.workspaceId }).from(agents).where(eq(agents.id, row.agentId)))[0]!;
      await auditAgentChange(db, { workspaceId: agent.workspaceId, entityType: "trigger", entityId: row.id, field: "paused", oldValue: row.paused, newValue: input.paused, actorId: context.userId });
      if (!input.paused && updated?.schedule && updated.nextRunAt) await enqueueJob(db, { type: "schedule_trigger", payload: { triggerId: row.id }, runAt: updated.nextRunAt, dedupeKey: `schedule_trigger:${row.id}:${updated.nextRunAt.toISOString()}` }); return updated;
    } },
    deleteTrigger: { name: "delete_trigger", kind: "write" as const, input: Type.Object({ triggerId: Type.String({ format: "uuid" }) }), output: Type.Object({ deleted: Type.Boolean() }), handler: async (context: Context, input: { triggerId: string }) => {
      const [row] = await db.select().from(triggers).where(eq(triggers.id, input.triggerId)); if (!row) throw new ActionError("Trigger not found", 404); const agent = await admin(context, row.agentId); await db.delete(triggers).where(eq(triggers.id, row.id)); await auditAgentChange(db, { workspaceId: agent.workspaceId, entityType: "trigger", entityId: row.id, field: "deleted", oldValue: { eventType: row.eventType, schedule: row.schedule }, newValue: null, actorId: context.userId }); return { deleted: true };
    } },
    listTriggers: { name: "list_triggers", kind: "read" as const, input: Type.Object({ agentId: Type.String({ format: "uuid" }) }), output: Type.Array(Type.Any()), handler: async (context: Context, input: { agentId: string }) => {
      await admin(context, input.agentId); return db.select().from(triggers).where(eq(triggers.agentId, input.agentId));
    } },
  };
}

/** Queue one event-triggered Run after checking the Trigger creator still has write access. */
/** An Agent only works in projects it is opened to, however old the Trigger is. */
async function agentOpenTo(db: Database, agent: { allProjects: boolean; userId: string }, projectId: string) {
  if (agent.allProjects) return true;
  const [member] = await db.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, agent.userId)));
  return Boolean(member);
}

export async function fireEventTriggers(db: Database, input: { eventType: typeof eventTypes[number]; projectId: string; workItemId: string; actorId: string; source?: string; wakingRunId?: string | null }) {
  const matching = await db.select({ trigger: triggers, agent: agents, agentName: users.name }).from(triggers).innerJoin(agents, eq(agents.id, triggers.agentId)).innerJoin(users, eq(users.id, agents.userId))
    .where(and(eq(triggers.projectId, input.projectId), eq(triggers.eventType, input.eventType), eq(triggers.paused, false), eq(agents.enabled, true))).orderBy(triggers.creatorId, triggers.id);
  if (matching.length === 0) return;
  const [actor] = await db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, input.actorId));
  // An Agent's or Autopilot's change is decided by the same wake decision as a person's, through the chain of its Run (ADR 0013).
  const waker = !actor || actor.isAgent ? "agent" : wakerOf(input.source);
  // An Agent's change wakes through its Run's chain: the Originator is the chain's, and the wake is checked against it (ADR 0013).
  const step = waker === "agent" ? await loadWakeStep(db, input.wakingRunId) : null;
  // "Sub-items closed" wakes only an Agent that is an assignee of the parent (the work item of this call).
  const parentAssignees = input.eventType === "sub_items_closed"
    ? new Set((await db.select({ userId: workItemAssignees.userId }).from(workItemAssignees).where(eq(workItemAssignees.workItemId, input.workItemId))).map((row) => row.userId))
    : null;
  for (const { trigger, agent, agentName } of matching) {
    if (parentAssignees && !parentAssignees.has(agent.userId)) continue;
    if (!(await agentOpenTo(db, agent, input.projectId))) continue;
    if (waker === "person") {
      if (!(await hasAgentAccess(db, agent.id, input.actorId))) continue;
      if (!(await hasAgentAccess(db, agent.id, trigger.creatorId))) continue;
      try { await requireProjectAccess(db, trigger.creatorId, input.projectId, "write"); }
      catch (error) { if (error instanceof ActionError) continue; throw error; }
    }
    try {
      await decideAndStartWake(db, {
        waker, step, target: { id: agent.id, userId: agent.userId, name: agentName, budget: agent.monthlyTokenBudget, runtimeId: agent.runtimeId }, workspaceId: agent.workspaceId, projectId: input.projectId,
        // The person who closed the last sub-item is the Originator of this Trigger, not the Trigger's creator (ADR 0013).
        workItemId: input.workItemId, originatorId: input.eventType === "sub_items_closed" && waker === "person" ? input.actorId : trigger.creatorId, triggerId: trigger.id,
      });
    } catch (error) { if (error instanceof ActionError && error.status === 429) continue; throw error; }
  }
}

/** The state groups that count as closed for a sub-item. */
export const closedStateGroups = ["completed", "cancelled"];

/**
 * Call after a work item's state changed. When that change closed (Done or Cancelled) the last open sub-item of a parent, fires the parent's
 * "sub-items closed" Triggers. A change between two closed states, a sub-item with no parent, or a sibling still open fires nothing.
 */
export async function fireSubItemsClosed(db: Database, input: { workItemId: string; previousStateId: string; projectId: string; actorId: string; source?: string; wakingRunId?: string | null }) {
  const [item] = await db.select({ parentId: workItems.parentId, stateId: workItems.stateId }).from(workItems).where(eq(workItems.id, input.workItemId));
  if (!item?.parentId) return;
  const groupOf = async (stateId: string) => (await db.select({ group: workItemStates.group }).from(workItemStates).where(eq(workItemStates.id, stateId)))[0]?.group;
  if (!closedStateGroups.includes((await groupOf(item.stateId)) ?? "")) return;
  if (closedStateGroups.includes((await groupOf(input.previousStateId)) ?? "")) return;
  // Two sub-items closed in two transactions at once would each see the other still open and neither would fire: the parent's row serialises them.
  await db.select({ id: workItems.id }).from(workItems).where(eq(workItems.id, item.parentId)).for("update");
  const [open] = await db.select({ id: workItems.id }).from(workItems).innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId))
    .where(and(eq(workItems.parentId, item.parentId), isNull(workItems.deletedAt), ne(workItems.id, input.workItemId), sql`${workItemStates.group} not in ('completed', 'cancelled')`)).limit(1);
  if (open) return;
  await fireEventTriggers(db, { eventType: "sub_items_closed", projectId: input.projectId, workItemId: item.parentId, actorId: input.actorId, source: input.source, wakingRunId: input.wakingRunId });
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
    if (agent?.enabled && await agentOpenTo(tx, agent, row.projectId)) {
      if (!(await hasAgentAccess(tx, agent.id, row.creatorId))) {
        await enqueueJob(tx, { type: "schedule_trigger", payload: { triggerId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_trigger:${row.id}:${nextRunAt.toISOString()}` });
        return;
      }
      try {
        await requireProjectAccess(tx, row.creatorId, row.projectId, "write");
        await enforceHourlyRunLimits(tx, { workspaceId: agent.workspaceId, originatorId: row.creatorId, agentId: agent.id }, now);
        const [created] = await tx.insert(runs).values({ workspaceId: agent.workspaceId, projectId: row.projectId, workItemId: null, agentId: agent.id, originatorId: row.creatorId, triggerId: row.id }).returning({ id: runs.id });
        if (created) await enqueueJob(tx, { type: "agent_run", payload: { runId: created.id }, dedupeKey: `agent_run:${created.id}` });
      } catch (error) { if (!(error instanceof ActionError)) throw error; }
    }
    await enqueueJob(tx, { type: "schedule_trigger", payload: { triggerId: row.id }, runAt: nextRunAt, dedupeKey: `schedule_trigger:${row.id}:${nextRunAt.toISOString()}` });
  });
}
