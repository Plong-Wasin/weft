import { Type } from "@sinclair/typebox";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { activeRunStatuses, activities, comments, jobs, projects, runs, workItemAssignees, workItemStates, workItems, type Database } from "@weft/db";
import { todayIso } from "./cycles";
import { ActionError } from "./members";
import { enqueueJob } from "./jobs";
import { requireProjectAccess } from "./projects";
import { assertArchivable } from "./work-item-archive";
import { logActivity, type ActivityContext } from "./work-items";

/** The one job type of the daily automatic-rules run. */
export const autoRulesJobType = "auto_rules";
/**
 * The daily run happens once per calendar day at this local hour. Weft has no workspace timezone setting, so the hour is a constant in a fixed
 * timezone: 02:00 in Asia/Bangkok (UTC+7, no daylight saving), a quiet hour for the people who use it.
 */
export const autoRulesRunHour = 2;
export const autoRulesTimezone = "Asia/Bangkok";
const autoRulesUtcOffsetMs = 7 * 60 * 60 * 1000;

/** The most recent run time (02:00 in Bangkok) at or before `now`. A day's run is due once `now` passes it. */
export function autoRulesDueAt(now: Date): Date {
  const local = now.getTime() + autoRulesUtcOffsetMs;
  const midnight = local - (((local % dayMs) + dayMs) % dayMs);
  let due = midnight + autoRulesRunHour * 60 * 60 * 1000 - autoRulesUtcOffsetMs;
  if (due > now.getTime()) due -= dayMs;
  return new Date(due);
}
const dayMs = 24 * 60 * 60 * 1000;
/**
 * What an automatic change stores as its reason (`activities.reason`, `notifications.detail`): structured data as JSON, never a sentence,
 * so the web app writes it in the reader's language. Rows written before this held an English sentence; the web app shows those as stored.
 */
export type AutoRuleReason =
  | { autoRule: "idle_close"; days: number; from: string | null; to: string | null }
  | { autoRule: "done_archive"; days: number };
export const autoRuleReason = (reason: AutoRuleReason) => JSON.stringify(reason);
/** States an item can be auto-closed out of: open ones only. */
const watchableGroups = ["backlog", "unstarted", "started"];
/** States an item can be auto-closed into: done or cancelled. */
const closingGroups = ["completed", "cancelled"];

export type AutoRules = {
  autoCloseAfterDays: number | null;
  autoCloseFromStateIds: string[];
  autoCloseToStateId: string | null;
  autoArchiveAfterDays: number | null;
};

const uuid = () => Type.String({ format: "uuid" });
const days = () => Type.Union([Type.Integer({ minimum: 1, maximum: 3650 }), Type.Null()]);
const rulesShape = {
  autoCloseAfterDays: days(),
  autoCloseFromStateIds: Type.Array(uuid(), { maxItems: 50 }),
  autoCloseToStateId: Type.Union([uuid(), Type.Null()]),
  autoArchiveAfterDays: days(),
};
const rulesOutput = Type.Object(rulesShape);
const previewOutput = Type.Object({ toClose: Type.Integer(), toArchive: Type.Integer() });

function rulesOf(project: typeof projects.$inferSelect): AutoRules {
  return {
    autoCloseAfterDays: project.autoCloseAfterDays, autoCloseFromStateIds: project.autoCloseFromStateIds ?? [],
    autoCloseToStateId: project.autoCloseToStateId, autoArchiveAfterDays: project.autoArchiveAfterDays,
  };
}

/** Only items that are not in a closed or Triage state are watched; the state group is the one rule the database cannot express per row here. */
async function assertStatesFit(database: Database, projectId: string, rules: AutoRules) {
  const stateIds = [...new Set(rules.autoCloseFromStateIds)];
  if (rules.autoCloseAfterDays !== null && (stateIds.length === 0 || !rules.autoCloseToStateId)) throw new ActionError("Choose the states to watch and the state to move idle items to", 400);
  if (stateIds.length) {
    const found = await database.select({ id: workItemStates.id, group: workItemStates.group }).from(workItemStates).where(and(eq(workItemStates.projectId, projectId), inArray(workItemStates.id, stateIds)));
    if (found.length !== stateIds.length || found.some((state) => !watchableGroups.includes(state.group))) throw new ActionError("Only open states (backlog, unstarted, started) can be watched", 400);
  }
  if (rules.autoCloseToStateId) {
    const [target] = await database.select({ group: workItemStates.group }).from(workItemStates).where(and(eq(workItemStates.projectId, projectId), eq(workItemStates.id, rules.autoCloseToStateId)));
    if (!target || !closingGroups.includes(target.group)) throw new ActionError("An idle item must move to a Done or Cancelled state", 400);
  }
}

/** Items the close rule would move now: open in a watched state, not touched since the cutoff, and no Run open or started since the cutoff (a Run still open holds the item). */
async function closeCandidates(database: Database, projectId: string, rules: AutoRules, now: Date, onlyItemId?: string) {
  if (rules.autoCloseAfterDays === null || !rules.autoCloseToStateId || rules.autoCloseFromStateIds.length === 0) return [];
  const cutoff = new Date(now.getTime() - rules.autoCloseAfterDays * dayMs);
  return database.select({ id: workItems.id, workspaceId: workItems.workspaceId, sequence: workItems.sequence, stateId: workItems.stateId, title: workItems.title }).from(workItems).where(and(
    eq(workItems.projectId, projectId), isNull(workItems.deletedAt), isNull(workItems.archivedAt),
    inArray(workItems.stateId, rules.autoCloseFromStateIds), lt(workItems.updatedAt, cutoff),
    ...(onlyItemId ? [eq(workItems.id, onlyItemId)] : []),
    sql`not exists (select 1 from ${activities} a where a.entity_type = 'work_item' and a.entity_id = ${workItems.id} and a.created_at >= ${cutoff.toISOString()}::timestamptz)`,
    // An item in a Cycle that has not ended stays where its team put it, as assertArchivable keeps it from being archived.
    sql`not exists (select 1 from cycle_items ci join cycles cy on cy.id = ci.cycle_id where ci.work_item_id = ${workItems.id} and cy.deleted_at is null and cy.end_date >= ${todayIso()}::date)`,
    sql`not exists (select 1 from ${comments} c where c.work_item_id = ${workItems.id} and c.created_at >= ${cutoff.toISOString()}::timestamptz)`,
    sql`not exists (select 1 from ${runs} r where r.work_item_id = ${workItems.id} and (r.created_at >= ${cutoff.toISOString()}::timestamptz or r.status in (${sql.join(activeRunStatuses.map((status) => sql`${status}`), sql`, `)})))`,
  ));
}

/** Done items whose completion is older than the archive rule's days and that the archive rules allow to archive now. */
async function archiveCandidates(database: Database, projectId: string, rules: AutoRules, now: Date, onlyItemId?: string) {
  if (rules.autoArchiveAfterDays === null) return [];
  const cutoff = new Date(now.getTime() - rules.autoArchiveAfterDays * dayMs);
  const rows = await database.select({ id: workItems.id, workspaceId: workItems.workspaceId, sequence: workItems.sequence, stateId: workItems.stateId, title: workItems.title }).from(workItems)
    .innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId)).where(and(
      eq(workItems.projectId, projectId), isNull(workItems.deletedAt), isNull(workItems.archivedAt),
      eq(workItemStates.group, "completed"), isNotNull(workItems.completedAt), lt(workItems.completedAt, cutoff),
      lt(workItems.updatedAt, cutoff),
      ...(onlyItemId ? [eq(workItems.id, onlyItemId)] : []),
      notExists(database.select({ id: activities.id }).from(activities).where(and(eq(activities.entityType, "work_item"), eq(activities.entityId, workItems.id), gte(activities.createdAt, cutoff)))),
      notExists(database.select({ id: comments.id }).from(comments).where(and(eq(comments.workItemId, workItems.id), gte(comments.createdAt, cutoff)))),
      notExists(database.select({ id: runs.id }).from(runs).where(and(eq(runs.workItemId, workItems.id), or(gte(runs.createdAt, cutoff), inArray(runs.status, activeRunStatuses))))),
    ));
  const allowed = [];
  for (const row of rows) {
    try { await assertArchivable(database, row.id, row.stateId); allowed.push(row); } catch (error) {
      if (!(error instanceof ActionError)) throw error;
    }
  }
  return allowed;
}

/** The rules' effect now, without writing anything. */
export async function previewAutoRules(database: Database, projectId: string, rules: AutoRules, now = new Date()) {
  return { toClose: (await closeCandidates(database, projectId, rules, now)).length, toArchive: (await archiveCandidates(database, projectId, rules, now)).length };
}

/**
 * Applies one project's rules as the system: each change is one Activity with source auto_rule and its reason,
 * and the item's assignees are notified. Each item is its own transaction and is checked again under its row lock.
 */
async function applyProjectRules(database: Database, project: typeof projects.$inferSelect, now: Date) {
  const rules = rulesOf(project);
  // The rule's own changes are written as the project's creator, shown as "Automatic rule" in the timeline.
  const context: ActivityContext = { userId: project.createdBy, source: "auto_rule" };
  let changed = 0;
  for (const candidate of await closeCandidates(database, project.id, rules, now)) {
    const did = await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const [locked] = await tx.select().from(workItems).where(eq(workItems.id, candidate.id)).for("update");
      if (!locked || !(await closeCandidates(tx, project.id, rules, now, locked.id)).length) return false;
      const [from] = await tx.select({ name: workItemStates.name }).from(workItemStates).where(eq(workItemStates.id, locked.stateId));
      const [to] = await tx.select({ name: workItemStates.name }).from(workItemStates).where(eq(workItemStates.id, rules.autoCloseToStateId!));
      const reason = autoRuleReason({ autoRule: "idle_close", days: rules.autoCloseAfterDays!, from: from?.name ?? null, to: to?.name ?? null });
      await tx.update(workItems).set({ stateId: rules.autoCloseToStateId!, updatedAt: now }).where(eq(workItems.id, locked.id));
      await logActivity(tx, context, { workspaceId: locked.workspaceId, projectId: project.id, entityType: "work_item", entityId: locked.id, field: "state", oldValue: locked.stateId, newValue: rules.autoCloseToStateId, reason });
      await notifyAssignees(tx, project, locked.id, reason);
      return true;
    });
    if (did) changed += 1;
  }
  for (const candidate of await archiveCandidates(database, project.id, rules, now)) {
    const did = await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const [locked] = await tx.select().from(workItems).where(eq(workItems.id, candidate.id)).for("update");
      if (!locked || locked.archivedAt || !(await archiveCandidates(tx, project.id, rules, now, locked.id)).length) return false;
      const reason = autoRuleReason({ autoRule: "done_archive", days: rules.autoArchiveAfterDays! });
      await tx.update(workItems).set({ archivedAt: now }).where(eq(workItems.id, locked.id));
      await logActivity(tx, context, { workspaceId: locked.workspaceId, projectId: project.id, entityType: "work_item", entityId: locked.id, field: "archived", newValue: now.toISOString(), reason });
      await notifyAssignees(tx, project, locked.id, reason);
      return true;
    });
    if (did) changed += 1;
  }
  return changed;
}

async function notifyAssignees(database: Database, project: typeof projects.$inferSelect, workItemId: string, reason: string) {
  const assignees = await database.select({ userId: workItemAssignees.userId }).from(workItemAssignees).where(eq(workItemAssignees.workItemId, workItemId));
  const recipientIds = [...new Set(assignees.map((row) => row.userId))];
  // Not enqueueNotification: the rule's author may be an assignee too, and must still hear about the change.
  if (recipientIds.length) await enqueueJob(database, { type: "notify", payload: { kind: "auto_rule", workItemId, actorId: project.createdBy, recipientIds, detail: reason } });
}

/** Runs every project's automatic rules once, as of `now`. Returns how many items changed. */
export async function applyAutoRules(database: Database, now = new Date()) {
  const rows = await database.select().from(projects).where(and(isNull(projects.archivedAt), or(isNotNull(projects.autoCloseAfterDays), isNotNull(projects.autoArchiveAfterDays))));
  let changed = 0;
  for (const project of rows) changed += await applyProjectRules(database, project, now);
  return changed;
}

/** Enqueues one permanently deduped daily run key (02:00 Bangkok); completion does not release the date key. */
export async function scheduleAutoRules(database: Database, now = new Date()) {
  const dueAt = autoRulesDueAt(now);
  const day = new Date(dueAt.getTime() + autoRulesUtcOffsetMs).toISOString().slice(0, 10);
  const dayStart = new Date(Date.parse(`${day}T00:00:00.000Z`) - autoRulesUtcOffsetMs);
  const nextDay = new Date(dayStart.getTime() + dayMs);
  const [legacy] = await database.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.type, autoRulesJobType), gte(jobs.createdAt, dayStart), lt(jobs.createdAt, nextDay), or(eq(jobs.dedupeKey, autoRulesJobType), isNull(jobs.dedupeKey)))).limit(1);
  if (legacy) return null;
  return enqueueJob(database, { type: autoRulesJobType, dedupeKey: `${autoRulesJobType}:${day}` });
}

export function createAutoRuleActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;
  const rulesInput = Type.Object({ projectId: uuid(), ...rulesShape });

  return {
    getAutoRules: {
      name: "get_auto_rules", kind: "read" as const,
      input: Type.Object({ projectId: uuid() }), output: rulesOutput,
      handler: async (context: ActivityContext, input: { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        return rulesOf(project);
      },
    },
    previewAutoRules: {
      name: "preview_auto_rules", kind: "read" as const,
      /** Dry run: how many items the given rules would change right now. Writes nothing. */
      input: rulesInput, output: previewOutput,
      handler: async (context: ActivityContext, input: AutoRules & { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        const rules = { ...input };
        await assertStatesFit(db, project.id, rules);
        return previewAutoRules(db, project.id, rules);
      },
    },
    updateAutoRules: {
      name: "update_auto_rules", kind: "write" as const,
      input: rulesInput, output: rulesOutput,
      handler: async (context: ActivityContext, input: AutoRules & { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        const rules: AutoRules = { autoCloseAfterDays: input.autoCloseAfterDays, autoCloseFromStateIds: [...new Set(input.autoCloseFromStateIds)], autoCloseToStateId: input.autoCloseToStateId, autoArchiveAfterDays: input.autoArchiveAfterDays };
        await assertStatesFit(db, project.id, rules);
        const [updated] = await db.update(projects).set({
          autoCloseAfterDays: rules.autoCloseAfterDays, autoCloseFromStateIds: rules.autoCloseFromStateIds, autoCloseToStateId: rules.autoCloseToStateId, autoArchiveAfterDays: rules.autoArchiveAfterDays,
        }).where(eq(projects.id, project.id)).returning();
        return rulesOf(updated!);
      },
    },
    undoAutoRuleChange: {
      name: "undo_auto_rule_change", kind: "write" as const,
      /** Puts back the state or archive status an automatic rule changed, when that change is still the item's latest one. */
      input: Type.Object({ activityId: uuid() }), output: Type.Object({ id: Type.String(), undone: Type.Literal(true) }),
      handler: async (context: ActivityContext, input: { activityId: string }) => {
        const [change] = await db.select().from(activities).where(eq(activities.id, input.activityId));
        if (!change || change.source !== "auto_rule" || change.entityType !== "work_item") throw new ActionError("Automatic change not found", 404);
        const [found] = await db.select().from(workItems).where(and(eq(workItems.id, change.entityId), isNull(workItems.deletedAt)));
        if (!found) throw new ActionError("Work item not found", 404);
        const { project } = await requireProjectAccess(db, context.userId, found.projectId, "write");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [item] = await database.select().from(workItems).where(eq(workItems.id, found.id)).for("update");
          if (item!.archivedAt && change.field === "state") throw new ActionError("The work item is archived. Restore the work item first, then undo this automatic change", 400);
          const fields = change.field === "archived" ? ["archived", "restored"] : [change.field];
          const [latest] = await database.select({ id: activities.id }).from(activities)
            .where(and(eq(activities.entityType, "work_item"), eq(activities.entityId, found.id), inArray(activities.field, fields)))
            .orderBy(desc(activities.seq)).limit(1);
          if (!latest || latest.id !== change.id) throw new ActionError("A later change was made to this field, so this automatic change cannot be undone", 400);
          if (change.field === "state") {
            if (item!.stateId !== change.newValue) throw new ActionError("The work item moved after the automatic change, so it cannot be undone", 400);
            const [previous] = await database.select({ id: workItemStates.id }).from(workItemStates).where(and(eq(workItemStates.id, String(change.oldValue)), eq(workItemStates.projectId, project.id)));
            if (!previous) throw new ActionError("The previous state no longer exists", 400);
            await database.update(workItems).set({ stateId: previous.id, updatedAt: new Date() }).where(eq(workItems.id, found.id));
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: found.id, field: "state", oldValue: item!.stateId, newValue: previous.id });
          } else if (change.field === "archived") {
            if (!item!.archivedAt) throw new ActionError("The work item is no longer archived", 400);
            await database.update(workItems).set({ archivedAt: null }).where(eq(workItems.id, found.id));
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: found.id, field: "restored", oldValue: item!.archivedAt.toISOString() });
          } else throw new ActionError("This change cannot be undone", 400);
          return { id: found.id, undone: true as const };
        });
      },
    },
  };
}
