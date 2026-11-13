import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, max, ne, not, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@weft/db";
import { activities, agents, comments, cycleItems, cycles, estimatePoints, estimates, moduleItems, modules, labels, projectKeyAliases, projectMembers, projects, users, workItemAssignees, workItemDescriptionVersions, workItemLabels, workItemStates, workItems } from "@weft/db";
import { assertNotArchived, liveWorkItems, triageGroup, unarchivedWorkItems } from "./triage";
import { assertFeatureEnabled } from "./features";
import { ActionError, requireWorkspaceRole } from "./members";
import { enqueueNotification } from "./notifications";
import { accessibleProjects, requireProjectAccess } from "./projects";
import { disabledAgentUserIds } from "./agent-access";
import { queueRunsForAssignees } from "./runs";
import { fireEventTriggers } from "./triggers";
import { builtinViewKinds } from "./builtin-views";
import { listableWorkItem } from "./listable";
import { compilePql, pqlLimits, pqlSyntaxHelp, weftPqlRegistry } from "./pql";
import { richTextInput, richTextMarkdown } from "./rich-markdown";

export const stateGroups = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
export type StateGroup = (typeof stateGroups)[number];
export const descriptionVersionIntervalMs = 5 * 60_000;
export const priorities = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof priorities)[number];
/** "auto_rule": a project's automatic close or archive rule, written as the system with the rule's reason. */
export type ActivitySource = "ui" | "ai" | "ai_autopilot" | "cli" | "mcp" | "agent" | "agent_autopilot" | "integration" | "auto_rule";

/** Who made a change on a Run: the Agent (the actor shown), the Run, and the Originator whose permissions the change used. */
export interface AgentAttribution { agentUserId: string; runId: string; originatorId: string; autopilot?: boolean }

/** The context of an Action call; `userId` is whose permissions apply. */
export type ActivityContext = { userId: string; source?: ActivitySource; chatId?: string; agent?: AgentAttribution };

/** The Activity columns that say who acted. A change by a Run is logged as the Agent, with the Run and the Originator. */
export function activityActor(context: ActivityContext) {
  const agent = context.source === "agent" || context.source === "agent_autopilot" ? context.agent : undefined;
  return {
    actorId: agent?.agentUserId ?? context.userId, source: agent?.autopilot || context.source === "agent_autopilot" ? "agent_autopilot" : context.source ?? "ui",
    chatId: context.source === "ai" || context.source === "ai_autopilot" ? context.chatId ?? null : null, runId: agent?.runId ?? null, originatorId: agent?.originatorId ?? null,
  };
}

export const defaultStates: ReadonlyArray<{ name: string; group: StateGroup }> = [
  { name: "Backlog", group: "backlog" },
  { name: "Todo", group: "unstarted" },
  { name: "In Progress", group: "started" },
  { name: "Done", group: "completed" },
  { name: "Cancelled", group: "cancelled" },
];

const groupSchema = Type.Union(stateGroups.map((group) => Type.Literal(group)));
const prioritySchema = Type.Union(priorities.map((priority) => Type.Literal(priority)));
const uuid = () => Type.String({ format: "uuid" });
const stateOutput = Type.Object({ id: Type.String(), projectId: Type.String(), name: Type.String(), group: groupSchema, sortOrder: Type.Integer() });
const workItemOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), sequence: Type.Integer(), displayId: Type.String(), title: Type.String(),
  description: Type.Any(), descriptionText: Type.String(), descriptionMarkdown: Type.String(), descriptionMarkdownWarnings: Type.Array(Type.String()), stateId: Type.String(), priority: prioritySchema, estimatePointId: Type.Union([Type.String(), Type.Null()]),
  sortOrder: Type.Number(), createdBy: Type.String(), createdAt: Type.String(), updatedAt: Type.String(), archivedAt: Type.Union([Type.String(), Type.Null()]), completedAt: Type.Union([Type.String(), Type.Null()]),
  assigneeIds: Type.Array(Type.String()), labelIds: Type.Array(Type.String()), parentId: Type.Union([Type.String(), Type.Null()]),
  startDate: Type.Union([Type.String(), Type.Null()]), dueDate: Type.Union([Type.String(), Type.Null()]),
});
const dateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const nullable = <T extends import("@sinclair/typebox").TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const fieldInput = {
  assigneeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), labelIds: Type.Optional(Type.Array(uuid())),
  estimatePointId: Type.Optional(nullable(uuid())), parentId: Type.Optional(nullable(uuid())), startDate: Type.Optional(nullable(dateSchema)), dueDate: Type.Optional(nullable(dateSchema)),
};
type FieldInput = { estimatePointId?: string | null; assigneeIds?: string[]; labelIds?: string[]; parentId?: string | null; startDate?: string | null; dueDate?: string | null };
const labelOutput = Type.Object({ id: Type.String(), projectId: Type.String(), name: Type.String(), color: Type.String() });
const colorSchema = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });
const sortFields = ["manual", "priority", "title", "created", "updated", "dueDate"] as const;
const listInput = {
  ...{ projectId: uuid() },
  stateIds: Type.Optional(Type.Array(uuid())), priorities: Type.Optional(Type.Array(prioritySchema)),
  /** Assignee ids; the literal "none" matches work items with no assignee. */
  assigneeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), labelIds: Type.Optional(Type.Array(uuid())),
  /** Only the work items of this Cycle (it must belong to the project). */
  cycleId: Type.Optional(uuid()),
  /** Only the work items of this Module (it must belong to the project and not be deleted). */
  moduleId: Type.Optional(uuid()),
  sort: Type.Optional(Type.Union(sortFields.map((field) => Type.Literal(field)))), direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  /** A Weft query (PQL); it ANDs with the other filters and its ORDER BY replaces sort. */
  query: Type.Optional(Type.String({ maxLength: pqlLimits.maxLength, description: pqlSyntaxHelp })),
  /** true lists only archived work items; the default lists only work items that are not archived. */
  archived: Type.Optional(Type.Boolean({ description: "true lists only archived work items; the default lists only work items that are not archived" })),
};
type ListInput = { projectId: string; stateIds?: string[]; priorities?: Priority[]; assigneeIds?: string[]; labelIds?: string[]; cycleId?: string; moduleId?: string; sort?: (typeof sortFields)[number]; direction?: "asc" | "desc"; query?: string; archived?: boolean };
/** Distance between neighbours: new work items append 65536 apart, so a midpoint split has ~40 halvings before the gap collapses. */
const sortGap = 65536;
const activityOutput = Type.Object({
  id: Type.String(), field: Type.String(), oldValue: Type.Any(), newValue: Type.Any(), actorId: Type.String(), actorName: Type.String(), actorIsAgent: Type.Boolean(), actorCodeCapable: Type.Boolean(),
  source: Type.String(), chatId: Type.Union([Type.String(), Type.Null()]),
  /** Set on a change made by an Agent: its Run, and the person whose permissions it used. */
  runId: Type.Union([Type.String(), Type.Null()]), originatorId: Type.Union([Type.String(), Type.Null()]), originatorName: Type.Union([Type.String(), Type.Null()]),
  /** Set on every Activity of one Bulk edit. */
  bulkEditId: Type.Union([Type.String(), Type.Null()]),
  /** Set on a change made by an automatic rule: why it happened. */
  reason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

type Context = ActivityContext;
type StateRow = typeof workItemStates.$inferSelect;
type ItemRow = typeof workItems.$inferSelect;

/** Plain text of a Tiptap document, used for search and the AI. */
export function plainText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const { type, text, content } = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof text === "string") return text;
  const parts = (content ?? []).map(plainText);
  return type === "doc" ? parts.filter(Boolean).join("\n") : parts.join("");
}

function stateOut(state: StateRow) {
  return { id: state.id, projectId: state.projectId, name: state.name, group: state.group as StateGroup, sortOrder: state.sortOrder };
}

type Relations = { assigneeIds: string[]; labelIds: string[] };

function itemOut(item: ItemRow, key: string, relations: Relations = { assigneeIds: [], labelIds: [] }) {
  return {
    ...relations, parentId: item.parentId, startDate: item.startDate, dueDate: item.dueDate,
    id: item.id, projectId: item.projectId, sequence: item.sequence, displayId: `${key}-${item.sequence}`, title: item.title,
    description: item.description ?? null, descriptionText: item.descriptionText,
    descriptionMarkdown: richTextMarkdown(item.description ?? null).markdown, descriptionMarkdownWarnings: richTextMarkdown(item.description ?? null).markdownWarnings,
    stateId: item.stateId, priority: item.priority as Priority, estimatePointId: item.estimatePointId,
    sortOrder: item.sortOrder, createdBy: item.createdBy, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(), archivedAt: item.archivedAt?.toISOString() ?? null, completedAt: item.completedAt?.toISOString() ?? null,
  };
}

export async function logActivity(database: Database, context: Context, entry: { workspaceId: string; projectId: string; entityType: "work_item" | "state" | "label"; entityId: string; field: string; oldValue?: unknown; newValue?: unknown; bulkEditId?: string; reason?: string }) {
  await database.insert(activities).values({
    workspaceId: entry.workspaceId, projectId: entry.projectId, entityType: entry.entityType, entityId: entry.entityId, field: entry.field,
    oldValue: entry.oldValue ?? null, newValue: entry.newValue ?? null, bulkEditId: entry.bulkEditId ?? null, reason: entry.reason ?? null, ...activityActor(context),
  });
}

function isRealDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertDateOrder(start: string | null, due: string | null) {
  for (const value of [start, due]) {
    if (value !== null && !isRealDate(value)) throw new ActionError("Invalid date", 400);
  }
  if (start && due && start > due) throw new ActionError("Start date must not be after due date", 400);
}

export function createWorkItemActions(db: Database) {
  const projectInput = { projectId: uuid() };
  const tx = (transaction: unknown) => transaction as Database;

  async function loadItem(workItemId: string) {
    const [item] = await db.select().from(workItems).where(and(eq(workItems.id, workItemId), liveWorkItems));
    if (!item) throw new ActionError("Work item not found", 404);
    return item;
  }

  async function projectKey(projectId: string) {
    const [project] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, projectId));
    return project!.key;
  }

  async function relationsOf(database: Database, itemIds: string[]) {
    const result = new Map<string, Relations>(itemIds.map((id) => [id, { assigneeIds: [], labelIds: [] }]));
    if (itemIds.length === 0) return result;
    const assignees = await database.select().from(workItemAssignees).where(inArray(workItemAssignees.workItemId, itemIds));
    for (const row of assignees) result.get(row.workItemId)!.assigneeIds.push(row.userId);
    const tags = await database.select().from(workItemLabels).where(inArray(workItemLabels.workItemId, itemIds));
    for (const row of tags) result.get(row.workItemId)!.labelIds.push(row.labelId);
    for (const relations of result.values()) { relations.assigneeIds.sort(); relations.labelIds.sort(); }
    return result;
  }

  /** The value of an Estimate point of this project's enabled Estimate; refuses any other point (another project, a turned-off or missing Estimate). */
  async function estimateValueOf(database: Database, projectId: string, pointId: string) {
    const [point] = await database.select({ value: estimatePoints.value }).from(estimatePoints).innerJoin(estimates, eq(estimates.id, estimatePoints.estimateId))
      .where(and(eq(estimatePoints.id, pointId), eq(estimates.projectId, projectId), eq(estimates.enabled, true))).for("share", { of: estimates });
    if (!point) throw new ActionError("Estimate point not found in this project's Estimate", 400);
    return point.value;
  }

  async function estimateValueOrNull(database: Database, pointId: string | null) {
    if (!pointId) return null;
    const [point] = await database.select({ value: estimatePoints.value }).from(estimatePoints).where(eq(estimatePoints.id, pointId));
    return point?.value ?? null;
  }

  async function hydrate(database: Database, rows: ItemRow[], key: string) {
    const relations = await relationsOf(database, rows.map((row) => row.id));
    return rows.map((row) => itemOut(row, key, relations.get(row.id)));
  }

  /** Validates and applies assignees, labels and parent, returning the Activity entries for what changed. */
  async function applyRelations(database: Database, context: Context, project: { id: string; workspaceId: string }, item: ItemRow, current: Relations, input: FieldInput) {
    const entries: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    const column: Partial<typeof workItems.$inferInsert> = {};
    if (input.assigneeIds !== undefined) {
      const next = [...new Set(input.assigneeIds)].sort();
      // Only newly added assignees must be project members: someone already assigned who has since left can still be unassigned.
      const added = next.filter((id) => !current.assigneeIds.includes(id));
      if (added.length > 0) {
        const members = await database.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, project.id), inArray(projectMembers.userId, added)));
        if (members.length !== added.length) {
          const memberIds = new Set(members.map((row) => row.userId));
          const notMembers = added.filter((id) => !memberIds.has(id));
          // The most common slip: an Agent's agent id (from list_agents' `id`) instead of its user id (`userId`).
          const [asAgent] = await database.select({ userId: agents.userId }).from(agents).where(and(inArray(agents.id, notMembers), eq(agents.workspaceId, project.workspaceId)));
          if (asAgent) throw new ActionError(`Use the Agent's user id, not its agent id: pass assigneeIds with ${asAgent.userId} (the userId field from list_agents).`, 400);
          throw new ActionError(`Assignees must be project members. Add these user ids to the project with add_project_member first: ${notMembers.join(", ")}`, 400);
        }
        if ((await disabledAgentUserIds(database, added)).size > 0) throw new ActionError("A disabled Agent cannot be assigned", 400);
      }
      if (JSON.stringify(next) !== JSON.stringify(current.assigneeIds)) {
        await database.delete(workItemAssignees).where(eq(workItemAssignees.workItemId, item.id));
        if (next.length > 0) await database.insert(workItemAssignees).values(next.map((userId) => ({ workItemId: item.id, userId })));
        entries.push({ field: "assignees", oldValue: current.assigneeIds, newValue: next });
        await enqueueNotification(database, { kind: "assignment", workItemId: item.id, actorId: context.userId, recipientIds: next.filter((id) => !current.assigneeIds.includes(id)) });
        // A change made by an Agent's Run (even one the Originator confirmed) never wakes another Agent (ADR 0007).
        if (context.source !== "agent" && context.source !== "ai_autopilot") await queueRunsForAssignees(database, { originatorId: context.userId, project, workItemId: item.id, assigneeUserIds: added });
      }
    }
    if (input.labelIds !== undefined) {
      const next = [...new Set(input.labelIds)].sort();
      if (next.length > 0) {
        const found = await database.select({ id: labels.id }).from(labels).where(and(eq(labels.projectId, project.id), inArray(labels.id, next)));
        if (found.length !== next.length) throw new ActionError("Labels must belong to this project", 400);
      }
      if (JSON.stringify(next) !== JSON.stringify(current.labelIds)) {
        await database.delete(workItemLabels).where(eq(workItemLabels.workItemId, item.id));
        if (next.length > 0) await database.insert(workItemLabels).values(next.map((labelId) => ({ workItemId: item.id, labelId })));
        entries.push({ field: "labels", oldValue: current.labelIds, newValue: next });
      }
    }
    if (input.parentId !== undefined && input.parentId !== item.parentId) {
      if (input.parentId !== null) {
        // Serialise parent changes per project so two concurrent moves cannot close a loop together.
        await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`parents:${project.id}`}))`);
        if (input.parentId === item.id) throw new ActionError("A work item cannot be its own parent", 400);
        const [parent] = await database.select().from(workItems).where(and(eq(workItems.id, input.parentId), eq(workItems.projectId, project.id), liveWorkItems));
        if (!parent) throw new ActionError("Parent must be a work item of this project", 400);
        assertNotArchived(parent);
        let cursor: string | null = parent.parentId;
        const seen = new Set<string>([parent.id]);
        while (cursor) {
          if (cursor === item.id) throw new ActionError("Parent would create a cycle", 400);
          if (seen.has(cursor)) break;
          seen.add(cursor);
          const [ancestor] = await database.select({ parentId: workItems.parentId }).from(workItems).where(eq(workItems.id, cursor));
          cursor = ancestor?.parentId ?? null;
        }
      }
      column.parentId = input.parentId;
      entries.push({ field: "parent", oldValue: item.parentId, newValue: input.parentId });
    }
    return { entries, column };
  }

  type BulkUpdateInput = { projectId: string; workItemIds: string[]; stateId?: string; priority?: Priority; estimatePointId?: string | null; startDate?: string | null; dueDate?: string | null; addAssigneeIds?: string[]; removeAssigneeIds?: string[]; addLabelIds?: string[]; removeLabelIds?: string[] };
  type UpdateInput = { title?: string; description?: unknown; stateId?: string; priority?: Priority } & FieldInput;

  /** Applies one update to a work item inside the caller's transaction: validation, Activities, Triggers. `bulkEditId` links the Activities of one Bulk edit. */
  async function applyItemUpdate(database: Database, context: Context, project: { id: string; workspaceId: string; key: string }, existing: ItemRow, input: UpdateInput, bulkEditId?: string) {
    // Lock order is Estimate before work item, the same as switching or deleting an Estimate, so the two cannot deadlock.
    if (input.estimatePointId) await database.select({ id: estimates.id }).from(estimates).where(eq(estimates.projectId, project.id)).for("share");
    const [item] = await database.select().from(workItems).where(and(eq(workItems.id, existing.id), liveWorkItems)).for("update");
    if (!item) throw new ActionError("Work item not found", 404);
    assertNotArchived(item);
    if (input.stateId) await stateOfProject(database, project.id, input.stateId);
    const changes: Array<{ field: string; column: Partial<typeof workItems.$inferInsert>; oldValue: unknown; newValue: unknown }> = [];
    if (input.title !== undefined && input.title !== item.title) changes.push({ field: "title", column: { title: input.title }, oldValue: item.title, newValue: input.title });
    if (input.stateId !== undefined && input.stateId !== item.stateId) changes.push({ field: "state", column: { stateId: input.stateId }, oldValue: item.stateId, newValue: input.stateId });
    if (input.priority !== undefined && input.priority !== item.priority) changes.push({ field: "priority", column: { priority: input.priority }, oldValue: item.priority, newValue: input.priority });
    if (input.description !== undefined && JSON.stringify(input.description) !== JSON.stringify(item.description)) {
      const [latestVersion] = await database.select({ createdAt: workItemDescriptionVersions.createdAt }).from(workItemDescriptionVersions)
        .where(eq(workItemDescriptionVersions.workItemId, item.id)).orderBy(desc(workItemDescriptionVersions.createdAt), desc(workItemDescriptionVersions.id)).limit(1);
      if (item.descriptionText && (!latestVersion || Date.now() - latestVersion.createdAt.getTime() >= descriptionVersionIntervalMs)) {
        await database.insert(workItemDescriptionVersions).values({ workItemId: item.id, content: item.description, contentText: item.descriptionText, createdBy: context.userId });
      }
      changes.push({ field: "description", column: { description: input.description, descriptionText: plainText(input.description) }, oldValue: item.descriptionText, newValue: plainText(input.description) });
    }
    if (input.estimatePointId !== undefined && input.estimatePointId !== item.estimatePointId) {
      const newValue = input.estimatePointId ? await estimateValueOf(database, project.id, input.estimatePointId) : null;
      if (!input.estimatePointId) {
        const [own] = await database.select({ enabled: estimates.enabled }).from(estimates).where(eq(estimates.projectId, project.id));
        if (own && !own.enabled) throw new ActionError("The Estimate is turned off", 400);
      }
      changes.push({ field: "estimate", column: { estimatePointId: input.estimatePointId }, oldValue: await estimateValueOrNull(database, item.estimatePointId), newValue });
    }
    if (input.startDate !== undefined && input.startDate !== item.startDate) changes.push({ field: "startDate", column: { startDate: input.startDate }, oldValue: item.startDate, newValue: input.startDate });
    if (input.dueDate !== undefined && input.dueDate !== item.dueDate) changes.push({ field: "dueDate", column: { dueDate: input.dueDate }, oldValue: item.dueDate, newValue: input.dueDate });
    assertDateOrder(input.startDate !== undefined ? input.startDate : item.startDate, input.dueDate !== undefined ? input.dueDate : item.dueDate);
    const current = (await relationsOf(database, [item.id])).get(item.id)!;
    const applied = await applyRelations(database, context, project, item, current, input);
    const entries = [...changes.map(({ field, oldValue, newValue }) => ({ field, oldValue, newValue })), ...applied.entries];
    if (entries.length === 0) return itemOut(item, project.key, current);
    const [updated] = await database.update(workItems).set({ ...Object.assign({}, ...changes.map((change) => change.column), applied.column), updatedAt: new Date() }).where(eq(workItems.id, item.id)).returning();
    if (context.source !== "agent" && context.source !== "ai_autopilot") {
      await fireEventTriggers(database, { eventType: "work_item_updated", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source });
      if (changes.some((change) => change.field === "state")) await fireEventTriggers(database, { eventType: "state_changed", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source });
      if (entries.some((entry) => entry.field === "assignees")) await fireEventTriggers(database, { eventType: "assignee_changed", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source });
    }
    for (const entry of entries) {
      if (entry.field === "description" && context.source !== "ai" && context.source !== "ai_autopilot" && context.source !== "agent" && context.source !== "agent_autopilot") {
        const [latest] = await database.select().from(activities)
          .where(and(eq(activities.entityType, "work_item"), eq(activities.entityId, item.id)))
          .orderBy(desc(activities.seq)).limit(1);
        const now = new Date();
        if (latest?.field === "description" && latest.actorId === activityActor(context).actorId && latest.source === (context.source ?? "ui")
          && now.getTime() - latest.createdAt.getTime() <= descriptionVersionIntervalMs) {
          await database.update(activities).set({ newValue: entry.newValue as never, createdAt: now }).where(eq(activities.id, latest.id));
          continue;
        }
      }
      await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, ...entry, ...(bulkEditId ? { bulkEditId } : {}) });
    }
    return (await hydrate(database, [updated!], project.key))[0]!;
  }

  /** Loads and locks the work items of one Bulk edit; refuses unless every id is a live work item of the project. Locked in id order so two Bulk edits cannot deadlock. */
  async function lockBulkItems(database: Database, projectId: string, workItemIds: string[]) {
    const ids = [...new Set(workItemIds)];
    if (ids.length === 0) throw new ActionError("Select at least one work item", 400);
    const rows = await database.select().from(workItems).where(and(inArray(workItems.id, ids), eq(workItems.projectId, projectId), liveWorkItems)).orderBy(asc(workItems.id)).for("update");
    if (rows.length !== ids.length) throw new ActionError("Work items must belong to this project", 400);
    return rows;
  }

  /** Runs `step` for each work item of a Bulk edit and names the first one that fails, so the all-or-nothing refusal says which item blocked it. */
  async function eachBulkItem<T>(rows: ItemRow[], key: string, step: (row: ItemRow) => Promise<T>) {
    const results: T[] = [];
    for (const row of rows.sort((a, b) => a.sequence - b.sequence)) {
      try { results.push(await step(row)); } catch (error) {
        if (error instanceof ActionError) throw new ActionError(`${key}-${row.sequence}: ${error.message}`, error.status);
        throw error;
      }
    }
    return results;
  }

  async function orderedStates(database: Database, projectId: string) {
    const rows = await database.select().from(workItemStates).where(eq(workItemStates.projectId, projectId)).orderBy(asc(workItemStates.sortOrder));
    return stateGroups.flatMap((group) => rows.filter((row) => row.group === group));
  }

  async function stateOfProject(database: Database, projectId: string, stateId: string) {
    const [state] = await database.select().from(workItemStates).where(and(eq(workItemStates.id, stateId), eq(workItemStates.projectId, projectId)));
    if (!state) throw new ActionError("State not found in this project", 400);
    if (state.group === triageGroup) throw new ActionError("The Triage state cannot be assigned", 400);
    return state;
  }

  async function stateForAdmin(context: Context, stateId: string) {
    const [state] = await db.select().from(workItemStates).where(eq(workItemStates.id, stateId));
    if (!state) throw new ActionError("State not found", 404);
    const { project } = await requireProjectAccess(db, context.userId, state.projectId, "admin");
    if (state.group === triageGroup) throw new ActionError("The Triage state is managed by the system", 400);
    return { state, project };
  }

  async function assertNameFree(database: Database, projectId: string, name: string, exceptId?: string) {
    const [clash] = await database.select({ id: workItemStates.id }).from(workItemStates).where(and(eq(workItemStates.projectId, projectId), eq(workItemStates.name, name)));
    if (clash && clash.id !== exceptId) throw new ActionError("State name is already used", 400);
  }

  return {
    listStates: {
      name: "list_states", kind: "read" as const,
      input: Type.Object(projectInput), output: Type.Array(stateOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "read");
        return (await orderedStates(db, input.projectId)).map(stateOut);
      },
    },
    createState: {
      name: "create_state", kind: "write" as const,
      input: Type.Object({ ...projectInput, group: groupSchema, name: Type.String({ minLength: 1, maxLength: 60 }) }), output: stateOutput,
      handler: async (context: Context, input: { projectId: string; group: StateGroup; name: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        if ((input.group as string) === triageGroup) throw new ActionError("The Triage state group is managed by the system", 400);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`states:${project.id}`}))`);
          await assertNameFree(database, project.id, input.name);
          const [{ value }] = await database.select({ value: max(workItemStates.sortOrder) }).from(workItemStates).where(eq(workItemStates.projectId, project.id));
          const [state] = await database.insert(workItemStates).values({ workspaceId: project.workspaceId, projectId: project.id, name: input.name, group: input.group, sortOrder: (value ?? -1) + 1 }).returning();
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "state", entityId: state!.id, field: "created", newValue: input.name });
          return stateOut(state!);
        });
      },
    },
    updateState: {
      name: "update_state", kind: "write" as const,
      input: Type.Object({ stateId: uuid(), name: Type.String({ minLength: 1, maxLength: 60 }) }), output: stateOutput,
      handler: async (context: Context, input: { stateId: string; name: string }) => {
        const { state, project } = await stateForAdmin(context, input.stateId);
        if (state.name === input.name) return stateOut(state);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await assertNameFree(database, project.id, input.name, state.id);
          const [updated] = await database.update(workItemStates).set({ name: input.name }).where(eq(workItemStates.id, state.id)).returning();
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "state", entityId: state.id, field: "name", oldValue: state.name, newValue: input.name });
          return stateOut(updated!);
        });
      },
    },
    reorderStates: {
      name: "reorder_states", kind: "write" as const,
      input: Type.Object({ ...projectInput, group: groupSchema, stateIds: Type.Array(uuid()) }), output: Type.Array(stateOutput),
      handler: async (context: Context, input: { projectId: string; group: StateGroup; stateIds: string[] }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        if ((input.group as string) === triageGroup) throw new ActionError("The Triage state group is managed by the system", 400);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`states:${project.id}`}))`);
          const current = (await orderedStates(database, project.id)).filter((state) => state.group === input.group);
          const sameSet = input.stateIds.length === current.length && new Set(input.stateIds).size === current.length && current.every((state) => input.stateIds.includes(state.id));
          if (!sameSet) throw new ActionError("Reorder must list every state of the group exactly once", 400);
          const slots = current.map((state) => state.sortOrder).sort((a, b) => a - b);
          for (const [index, stateId] of input.stateIds.entries()) {
            const before = current.findIndex((state) => state.id === stateId);
            if (before === index) continue;
            await database.update(workItemStates).set({ sortOrder: slots[index]! }).where(eq(workItemStates.id, stateId));
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "state", entityId: stateId, field: "position", oldValue: before, newValue: index });
          }
          return (await orderedStates(database, project.id)).map(stateOut);
        });
      },
    },
    deleteState: {
      name: "delete_state", kind: "write" as const,
      input: Type.Object({ stateId: uuid() }), output: Type.Object({ removed: Type.Boolean() }),
      handler: async (context: Context, input: { stateId: string }) => {
        const { state, project } = await stateForAdmin(context, input.stateId);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`states:${project.id}`}))`);
          const [used] = await database.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.stateId, state.id), liveWorkItems)).limit(1);
          if (used) throw new ActionError("State is used by work items", 400);
          if ((await orderedStates(database, project.id)).length <= 1) throw new ActionError("A project needs at least one state", 400);
          // Soft-deleted items still point at the state, so move them to the first remaining state first.
          const [fallback] = (await orderedStates(database, project.id)).filter((row) => row.id !== state.id);
          await database.update(workItems).set({ stateId: fallback!.id }).where(eq(workItems.stateId, state.id));
          await database.delete(workItemStates).where(eq(workItemStates.id, state.id));
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "state", entityId: state.id, field: "deleted", oldValue: state.name });
          return { removed: true };
        });
      },
    },
    createWorkItem: {
      name: "create_work_item", kind: "write" as const,
      input: Type.Object({
        ...projectInput, title: Type.String({ minLength: 1, maxLength: 500 }), descriptionMarkdown: Type.Optional(Type.String({ description: "Markdown work item description, for example ## Plan followed by - First step. Use instead of description." })), description: Type.Optional(Type.Any()),
        stateId: Type.Optional(uuid()), priority: Type.Optional(prioritySchema), ...fieldInput,
      }),
      output: workItemOutput,
      handler: async (context: Context, input: { projectId: string; title: string; description?: unknown; descriptionMarkdown?: string; stateId?: string; priority?: Priority } & FieldInput) => {
        input.description = richTextInput(input.description, (input as typeof input & { descriptionMarkdown?: string }).descriptionMarkdown, "description", "descriptionMarkdown");
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const state = input.stateId ? await stateOfProject(database, project.id, input.stateId) : (await orderedStates(database, project.id))[0];
          if (!state) throw new ActionError("Project has no states", 400);
          // The row lock taken by this UPDATE serialises creators per project, and the counter rolls back with the transaction: no gaps.
          const [counter] = await database.update(projects).set({ workItemSequence: sql`${projects.workItemSequence} + 1` }).where(eq(projects.id, project.id)).returning({ sequence: projects.workItemSequence, key: projects.key });
          const [{ value }] = await database.select({ value: max(workItems.sortOrder) }).from(workItems).where(eq(workItems.projectId, project.id));
          if (input.estimatePointId) await estimateValueOf(database, project.id, input.estimatePointId);
          const [item] = await database.insert(workItems).values({
            workspaceId: project.workspaceId, projectId: project.id, sequence: counter!.sequence, title: input.title, estimatePointId: input.estimatePointId ?? null,
            description: input.description ?? null, descriptionText: plainText(input.description), stateId: state.id,
            priority: input.priority ?? "none", sortOrder: (value ?? 0) + 65536, createdBy: context.userId,
            startDate: input.startDate ?? null, dueDate: input.dueDate ?? null,
          }).returning();
          assertDateOrder(input.startDate ?? null, input.dueDate ?? null);
          const applied = await applyRelations(database, context, project, item!, { assigneeIds: [], labelIds: [] }, { ...input, parentId: input.parentId ?? undefined });
          const created = Object.keys(applied.column).length > 0 ? (await database.update(workItems).set(applied.column).where(eq(workItems.id, item!.id)).returning())[0]! : item!;
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item!.id, field: "created", newValue: input.title });
          await fireEventTriggers(database, { eventType: "work_item_created", projectId: project.id, workItemId: item!.id, actorId: context.userId, source: context.source });
          const dateEntries = [["startDate", input.startDate], ["dueDate", input.dueDate], ["estimate", input.estimatePointId ? await estimateValueOf(database, project.id, input.estimatePointId) : null]].filter(([, value]) => value) as Array<[string, string]>;
          for (const [field, value] of dateEntries) applied.entries.push({ field, oldValue: null, newValue: value });
          for (const entry of applied.entries) await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item!.id, ...entry });
          return (await hydrate(database, [created], counter!.key))[0]!;
        });
      },
    },
    listWorkItems: {
      name: "list_work_items", kind: "read" as const,
      input: Type.Object(listInput), output: Type.Array(workItemOutput),
      handler: async (context: Context, input: ListInput) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        const conditions = [eq(workItems.projectId, project.id), listableWorkItem({ archived: input.archived })];
        if (input.stateIds?.length) conditions.push(inArray(workItems.stateId, input.stateIds));
        if (input.priorities?.length) conditions.push(inArray(workItems.priority, input.priorities));
        if (input.assigneeIds?.length) {
          const ids = input.assigneeIds.filter((id) => id !== "none");
          const parts = [];
          if (ids.length) parts.push(exists(db.select({ one: sql`1` }).from(workItemAssignees).where(and(eq(workItemAssignees.workItemId, workItems.id), inArray(workItemAssignees.userId, ids)))));
          if (input.assigneeIds.includes("none")) parts.push(not(exists(db.select({ one: sql`1` }).from(workItemAssignees).where(eq(workItemAssignees.workItemId, workItems.id)))));
          conditions.push(or(...parts)!);
        }
        if (input.labelIds?.length) conditions.push(exists(db.select({ one: sql`1` }).from(workItemLabels).where(and(eq(workItemLabels.workItemId, workItems.id), inArray(workItemLabels.labelId, input.labelIds)))));
        if (input.cycleId) {
          assertFeatureEnabled(project, "cycles");
          const [cycle] = await db.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.id, input.cycleId), eq(cycles.projectId, project.id), isNull(cycles.deletedAt)));
          if (!cycle) throw new ActionError("Cycle not found", 404);
          conditions.push(exists(db.select({ one: sql`1` }).from(cycleItems).where(and(eq(cycleItems.workItemId, workItems.id), eq(cycleItems.cycleId, cycle.id)))));
        }
        if (input.moduleId) {
          assertFeatureEnabled(project, "modules");
          const [module] = await db.select({ id: modules.id }).from(modules).where(and(eq(modules.id, input.moduleId), eq(modules.projectId, project.id), isNull(modules.deletedAt)));
          if (!module) throw new ActionError("Module not found", 404);
          conditions.push(exists(db.select({ one: sql`1` }).from(moduleItems).where(and(eq(moduleItems.workItemId, workItems.id), eq(moduleItems.moduleId, module.id)))));
        }
        const direction = input.direction === "desc" ? desc : asc;
        const priorityRank = sql`case ${workItems.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;
        const order = {
          manual: [direction(workItems.sortOrder)], priority: [direction(priorityRank), asc(workItems.sortOrder)], title: [direction(sql`lower(${workItems.title})`)],
          created: [direction(workItems.createdAt)], updated: [direction(workItems.updatedAt)], dueDate: [sql`${workItems.dueDate} is null`, direction(workItems.dueDate)],
        }[input.sort ?? "manual"];
        const source = input.query;
        if (source?.trim()) {
          const compiled = await compilePql(db, { workspaceId: project.workspaceId, projectId: project.id, projectKey: project.key, userId: context.userId }, source, { registry: weftPqlRegistry });
          if (compiled.where) conditions.push(compiled.where);
          const rows = await db.select().from(workItems).where(and(...conditions))
            .orderBy(...(compiled.orderBy.length ? compiled.orderBy : order), asc(workItems.sequence)).limit(compiled.limit);
          return hydrate(db, rows, project.key);
        }
        const rows = await db.select().from(workItems).where(and(...conditions)).orderBy(...order, direction(workItems.sequence));
        return hydrate(db, rows, project.key);
      },
    },
    /** Work items across every project the caller can access in the workspace; a private project the caller is not in never contributes a row. */
    listWorkspaceWorkItems: {
      name: "list_workspace_work_items", kind: "read" as const,
      input: Type.Object({
        workspaceId: uuid(),
        /** One of Plane's built-in views: all, assigned to me, created by me, subscribed (created by, assigned to, or commented on by me). */
        builtin: Type.Optional(Type.Union(builtinViewKinds.map((kind) => Type.Literal(kind)))),
        sort: Type.Optional(Type.Union(sortFields.map((field) => Type.Literal(field)))), direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
        /** A Weft query (PQL), compiled in each project (names such as states and labels are per project); a project where it does not apply contributes nothing. */
        query: Type.Optional(Type.String({ maxLength: pqlLimits.maxLength, description: pqlSyntaxHelp })),
      }),
      output: Type.Array(Type.Intersect([workItemOutput, Type.Object({ projectKey: Type.String(), projectName: Type.String() })])),
      handler: async (context: Context, input: { workspaceId: string; builtin?: (typeof builtinViewKinds)[number]; sort?: (typeof sortFields)[number]; direction?: "asc" | "desc"; query?: string }) => {
        const accessible = await accessibleProjects(db, context.userId, input.workspaceId);
        if (accessible.length === 0) return [];
        const conditions = [inArray(workItems.projectId, accessible.map((project) => project.id)), listableWorkItem()];
        const me = context.userId;
        const assigned = exists(db.select({ one: sql`1` }).from(workItemAssignees).where(and(eq(workItemAssignees.workItemId, workItems.id), eq(workItemAssignees.userId, me))));
        if (input.builtin === "assigned") conditions.push(assigned);
        if (input.builtin === "created") conditions.push(eq(workItems.createdBy, me));
        if (input.builtin === "subscribed") {
          const commented = exists(db.select({ one: sql`1` }).from(comments).where(and(eq(comments.workItemId, workItems.id), eq(comments.authorId, me), isNull(comments.deletedAt))));
          conditions.push(or(eq(workItems.createdBy, me), assigned, commented)!);
        }
        if (input.query?.trim()) {
          const parts: ReturnType<typeof and>[] = [];
          let firstError: unknown = null;
          for (const project of accessible) {
            try {
              const compiled = await compilePql(db, { workspaceId: input.workspaceId, projectId: project.id, projectKey: project.key, userId: me }, input.query, { registry: weftPqlRegistry });
              parts.push(compiled.where ? and(eq(workItems.projectId, project.id), compiled.where) : eq(workItems.projectId, project.id));
            } catch (error) { firstError ??= error; }
          }
          if (parts.length === 0) throw firstError;
          conditions.push(or(...parts)!);
        }
        const direction = input.direction === "desc" ? desc : asc;
        const priorityRank = sql`case ${workItems.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;
        const order = {
          manual: [direction(workItems.createdAt)], priority: [direction(priorityRank), asc(workItems.createdAt)], title: [direction(sql`lower(${workItems.title})`)],
          created: [direction(workItems.createdAt)], updated: [direction(workItems.updatedAt)], dueDate: [sql`${workItems.dueDate} is null`, direction(workItems.dueDate)],
        }[input.sort ?? "manual"];
        const rows = await db.select().from(workItems).where(and(...conditions)).orderBy(...order, asc(workItems.projectId), asc(workItems.sequence)).limit(2000);
        const relations = await relationsOf(db, rows.map((row) => row.id));
        const byProject = new Map(accessible.map((project) => [project.id, project]));
        return rows.map((row) => ({ ...itemOut(row, byProject.get(row.projectId)!.key, relations.get(row.id)), projectKey: byProject.get(row.projectId)!.key, projectName: byProject.get(row.projectId)!.name }));
      },
    },
    moveWorkItem: {
      name: "move_work_item", kind: "write" as const,
      /** Drop a card into a column: `beforeId` is the card it lands above, omitted means the end of the column. */
      input: Type.Object({ workItemId: uuid(), stateId: uuid(), beforeId: Type.Optional(uuid()) }), output: workItemOutput,
      handler: async (context: Context, input: { workItemId: string; stateId: string; beforeId?: string }) => {
        const existing = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, existing.projectId, "write");
        assertNotArchived(existing);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`moves:${project.id}`}))`);
          const [item] = await database.select().from(workItems).where(and(eq(workItems.id, existing.id), liveWorkItems)).for("update");
          if (!item) throw new ActionError("Work item not found", 404);
          assertNotArchived(item);
          await stateOfProject(database, project.id, input.stateId);
          const column = () => database.select().from(workItems)
            .where(and(eq(workItems.projectId, project.id), eq(workItems.stateId, input.stateId), unarchivedWorkItems, ne(workItems.id, item.id)))
            .orderBy(asc(workItems.sortOrder), asc(workItems.sequence));
          let siblings = await column();
          let index = siblings.length;
          if (input.beforeId !== undefined) {
            if (input.beforeId === item.id) throw new ActionError("A card cannot be dropped before itself", 400);
            index = siblings.findIndex((sibling) => sibling.id === input.beforeId);
            if (index < 0) throw new ActionError("Neighbour must be a work item of the target state", 400);
          }
          const place = () => {
            const above = siblings[index - 1]?.sortOrder, below = siblings[index]?.sortOrder;
            if (above === undefined && below === undefined) return sortGap;
            if (above === undefined) return below! - sortGap;
            if (below === undefined) return above + sortGap;
            const middle = above + (below - above) / 2;
            return middle > above && middle < below ? middle : null;
          };
          let sortOrder = place();
          if (sortOrder === null) {
            // The gap is used up (only after ~40 drops into the same slot): spread this one column, once.
            for (const [position, sibling] of siblings.entries()) await database.update(workItems).set({ sortOrder: (position + 1) * sortGap }).where(eq(workItems.id, sibling.id));
            siblings = await column();
            sortOrder = place()!;
          }
          const [updated] = await database.update(workItems).set({ stateId: input.stateId, sortOrder, ...(input.stateId !== item.stateId ? { updatedAt: new Date() } : {}) }).where(eq(workItems.id, item.id)).returning();
          if (input.stateId !== item.stateId) {
            await fireEventTriggers(database, { eventType: "state_changed", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source });
            await fireEventTriggers(database, { eventType: "work_item_updated", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source });
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: "state", oldValue: item.stateId, newValue: input.stateId });
          }
          return (await hydrate(database, [updated!], project.key))[0]!;
        });
      },
    },
    getWorkItem: {
      name: "get_work_item", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid(), displayId: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9]{1,11}-[0-9]+$" }) }), output: workItemOutput,
      handler: async (context: Context, input: { workspaceId: string; displayId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(input.displayId);
        if (!match) throw new ActionError("Work item not found", 404);
        const key = match[1]!.toUpperCase();
        const sequence = Number(match[2]);
        let [project] = await db.select().from(projects).where(and(eq(projects.workspaceId, input.workspaceId), eq(projects.key, key)));
        if (!project) {
          const [alias] = await db.select({ projectId: projectKeyAliases.projectId }).from(projectKeyAliases).where(and(eq(projectKeyAliases.workspaceId, input.workspaceId), eq(projectKeyAliases.key, key)));
          if (alias) [project] = await db.select().from(projects).where(eq(projects.id, alias.projectId));
        }
        if (!project) throw new ActionError("Work item not found", 404);
        await requireProjectAccess(db, context.userId, project.id, "read");
        const [item] = await db.select().from(workItems).where(and(eq(workItems.projectId, project.id), eq(workItems.sequence, sequence), liveWorkItems));
        if (!item) throw new ActionError("Work item not found", 404);
        return (await hydrate(db, [item], project.key))[0]!;
      },
    },
    updateWorkItem: {
      name: "update_work_item", kind: "write" as const,
      input: Type.Object({
        workItemId: uuid(), title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), descriptionMarkdown: Type.Optional(Type.String({ description: "Markdown work item description, for example ## Plan followed by - First step. Use instead of description." })), description: Type.Optional(Type.Any()),
        stateId: Type.Optional(uuid()), priority: Type.Optional(prioritySchema), ...fieldInput,
      }),
      output: workItemOutput,
      handler: async (context: Context, input: { workItemId: string; title?: string; description?: unknown; descriptionMarkdown?: string; stateId?: string; priority?: Priority } & FieldInput) => {
        input.description = richTextInput(input.description, (input as typeof input & { descriptionMarkdown?: string }).descriptionMarkdown, "description", "descriptionMarkdown");
        const existing = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, existing.projectId, "write");
        assertNotArchived(existing);
        return db.transaction(async (transaction) => applyItemUpdate(tx(transaction), context, project, existing, input));
      },
    },
    deleteWorkItem: {
      name: "delete_work_item", kind: "write" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Object({ removed: Type.Boolean() }),
      handler: async (context: Context, input: { workItemId: string }) => {
        const existing = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, existing.projectId, "write");
        assertNotArchived(existing);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [deleted] = await database.update(workItems).set({ deletedAt: new Date() }).where(and(eq(workItems.id, existing.id), liveWorkItems, isNull(workItems.archivedAt))).returning({ id: workItems.id });
          if (!deleted) throw new ActionError("Work item not found or archived", 404);
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: existing.id, field: "deleted", oldValue: existing.title });
          return { removed: true };
        });
      },
    },
    bulkUpdateWorkItems: {
      name: "bulk_update_work_items", kind: "write" as const,
      input: Type.Object({
        ...projectInput, workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }),
        stateId: Type.Optional(uuid()), priority: Type.Optional(prioritySchema), estimatePointId: Type.Optional(nullable(uuid())),
        startDate: Type.Optional(nullable(dateSchema)), dueDate: Type.Optional(nullable(dateSchema)),
        addAssigneeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), removeAssigneeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        addLabelIds: Type.Optional(Type.Array(uuid())), removeLabelIds: Type.Optional(Type.Array(uuid())),
      }),
      output: Type.Object({ bulkEditId: Type.String(), workItemIds: Type.Array(Type.String()), changed: Type.Number() }),
      handler: async (context: Context, input: BulkUpdateInput) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        const { projectId: _projectId, workItemIds, addAssigneeIds, removeAssigneeIds, addLabelIds, removeLabelIds, ...fields } = input;
        const touches = Object.values(fields).some((value) => value !== undefined) || [addAssigneeIds, removeAssigneeIds, addLabelIds, removeLabelIds].some((list) => list && list.length > 0);
        if (!touches) throw new ActionError("Nothing to change", 400);
        const bulkEditId = crypto.randomUUID();
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          // Estimate before work items, as in a single update.
          if (input.estimatePointId) await database.select({ id: estimates.id }).from(estimates).where(eq(estimates.projectId, project.id)).for("share");
          const rows = await lockBulkItems(database, project.id, workItemIds);
          const relations = await relationsOf(database, rows.map((row) => row.id));
          let changed = 0;
          await eachBulkItem(rows, project.key, async (row) => {
            assertNotArchived(row);
            const current = relations.get(row.id)!;
            const patch: UpdateInput = { ...fields };
            if (addAssigneeIds?.length || removeAssigneeIds?.length) patch.assigneeIds = current.assigneeIds.filter((id) => !removeAssigneeIds?.includes(id)).concat(addAssigneeIds ?? []);
            if (addLabelIds?.length || removeLabelIds?.length) patch.labelIds = current.labelIds.filter((id) => !removeLabelIds?.includes(id)).concat(addLabelIds ?? []);
            const updated = await applyItemUpdate(database, context, project, row, patch, bulkEditId);
            if (updated.updatedAt !== row.updatedAt.toISOString()) changed += 1;
          });
          return { bulkEditId, workItemIds: rows.map((row) => row.id), changed };
        });
      },
    },
    deleteWorkItems: {
      name: "delete_work_items", kind: "write" as const,
      input: Type.Object({ ...projectInput, workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }) }),
      output: Type.Object({ bulkEditId: Type.String(), removed: Type.Number() }),
      handler: async (context: Context, input: { projectId: string; workItemIds: string[] }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        const bulkEditId = crypto.randomUUID();
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const rows = await lockBulkItems(database, project.id, input.workItemIds);
          await eachBulkItem(rows, project.key, async (row) => {
            assertNotArchived(row);
            await database.update(workItems).set({ deletedAt: new Date() }).where(eq(workItems.id, row.id));
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: row.id, field: "deleted", oldValue: row.title, bulkEditId });
          });
          return { bulkEditId, removed: rows.length };
        });
      },
    },
    listSubWorkItems: {
      name: "list_sub_work_items", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(workItemOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const parent = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, parent.projectId, "read");
        const rows = await db.select().from(workItems).where(and(eq(workItems.parentId, parent.id), unarchivedWorkItems)).orderBy(asc(workItems.sortOrder), asc(workItems.sequence));
        return hydrate(db, rows, project.key);
      },
    },
    listLabels: {
      name: "list_labels", kind: "read" as const,
      input: Type.Object(projectInput), output: Type.Array(labelOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "read");
        const rows = await db.select().from(labels).where(eq(labels.projectId, input.projectId)).orderBy(asc(labels.name));
        return rows.map((row) => ({ id: row.id, projectId: row.projectId, name: row.name, color: row.color }));
      },
    },
    createLabel: {
      name: "create_label", kind: "write" as const,
      input: Type.Object({ ...projectInput, name: Type.String({ minLength: 1, maxLength: 60 }), color: Type.Optional(colorSchema) }), output: labelOutput,
      handler: async (context: Context, input: { projectId: string; name: string; color?: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`labels:${project.id}`}))`);
          const [clash] = await database.select({ id: labels.id }).from(labels).where(and(eq(labels.projectId, project.id), eq(labels.name, input.name)));
          if (clash) throw new ActionError("Label name is already used", 400);
          const [label] = await database.insert(labels).values({ workspaceId: project.workspaceId, projectId: project.id, name: input.name, ...(input.color ? { color: input.color } : {}) }).returning();
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "label", entityId: label!.id, field: "created", newValue: input.name });
          return { id: label!.id, projectId: label!.projectId, name: label!.name, color: label!.color };
        });
      },
    },
    updateLabel: {
      name: "update_label", kind: "write" as const,
      input: Type.Object({ labelId: uuid(), name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })), color: Type.Optional(colorSchema) }), output: labelOutput,
      handler: async (context: Context, input: { labelId: string; name?: string; color?: string }) => {
        const [label] = await db.select().from(labels).where(eq(labels.id, input.labelId));
        if (!label) throw new ActionError("Label not found", 404);
        const { project } = await requireProjectAccess(db, context.userId, label.projectId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          if (input.name !== undefined && input.name !== label.name) {
            const [clash] = await database.select({ id: labels.id }).from(labels).where(and(eq(labels.projectId, project.id), eq(labels.name, input.name)));
            if (clash) throw new ActionError("Label name is already used", 400);
          }
          const [updated] = await database.update(labels).set({ name: input.name ?? label.name, color: input.color ?? label.color }).where(eq(labels.id, label.id)).returning();
          if (updated!.name !== label.name) await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "label", entityId: label.id, field: "name", oldValue: label.name, newValue: updated!.name });
          if (updated!.color !== label.color) await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "label", entityId: label.id, field: "color", oldValue: label.color, newValue: updated!.color });
          return { id: updated!.id, projectId: updated!.projectId, name: updated!.name, color: updated!.color };
        });
      },
    },
    deleteLabel: {
      name: "delete_label", kind: "write" as const,
      input: Type.Object({ labelId: uuid() }), output: Type.Object({ removed: Type.Boolean() }),
      handler: async (context: Context, input: { labelId: string }) => {
        const [label] = await db.select().from(labels).where(eq(labels.id, input.labelId));
        if (!label) throw new ActionError("Label not found", 404);
        const { project } = await requireProjectAccess(db, context.userId, label.projectId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const tagged = await database.select({ workItemId: workItemLabels.workItemId }).from(workItemLabels).where(eq(workItemLabels.labelId, label.id));
          const before = await relationsOf(database, tagged.map((row) => row.workItemId));
          await database.delete(labels).where(eq(labels.id, label.id));
          for (const [workItemId, relations] of before) {
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: workItemId, field: "labels", oldValue: relations.labelIds, newValue: relations.labelIds.filter((id) => id !== label.id) });
          }
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "label", entityId: label.id, field: "deleted", oldValue: label.name });
          return { removed: true };
        });
      },
    },
    listWorkItemDescriptionVersions: {
      name: "list_work_item_description_versions", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }),
      output: Type.Array(Type.Object({ id: Type.String(), content: Type.Any(), contentText: Type.String(), createdBy: Type.String(), createdByName: Type.String(), createdAt: Type.String() })),
      handler: async (context: Context, input: { workItemId: string }) => {
        const item = await loadItem(input.workItemId);
        await requireProjectAccess(db, context.userId, item.projectId, "read");
        const rows = await db.select({ version: workItemDescriptionVersions, createdByName: users.name }).from(workItemDescriptionVersions)
          .innerJoin(users, eq(users.id, workItemDescriptionVersions.createdBy)).where(eq(workItemDescriptionVersions.workItemId, item.id))
          .orderBy(desc(workItemDescriptionVersions.createdAt), desc(workItemDescriptionVersions.id));
        return rows.map(({ version, createdByName }) => ({ id: version.id, content: version.content, contentText: version.contentText, createdBy: version.createdBy, createdByName, createdAt: version.createdAt.toISOString() }));
      },
    },
    restoreWorkItemDescriptionVersion: {
      name: "restore_work_item_description_version", kind: "write" as const,
      input: Type.Object({ workItemId: uuid(), versionId: uuid() }), output: workItemOutput,
      handler: async (context: Context, input: { workItemId: string; versionId: string }) => {
        const item = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, item.projectId, "write");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [current] = await database.select().from(workItems).where(and(eq(workItems.id, item.id), liveWorkItems)).for("update");
          if (!current) throw new ActionError("Work item not found", 404);
          assertNotArchived(current);
          const [version] = await database.select().from(workItemDescriptionVersions).where(and(eq(workItemDescriptionVersions.id, input.versionId), eq(workItemDescriptionVersions.workItemId, current.id)));
          if (!version) throw new ActionError("Version not found", 404);
          if (current.descriptionText) await database.insert(workItemDescriptionVersions).values({ workItemId: current.id, content: current.description, contentText: current.descriptionText, createdBy: context.userId });
          const [updated] = await database.update(workItems).set({ description: version.content, descriptionText: version.contentText, updatedAt: new Date() }).where(eq(workItems.id, current.id)).returning();
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: current.id, field: "description_restored", oldValue: current.descriptionText, newValue: version.contentText });
          return (await hydrate(database, [updated!], project.key))[0]!;
        });
      },
    },
    listWorkItemActivities: {
      name: "list_work_item_activities", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(activityOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const item = await loadItem(input.workItemId);
        await requireProjectAccess(db, context.userId, item.projectId, "read");
        const originator = alias(users, "originator");
        const rows = (await db.select({ activity: activities, actorName: users.name, actorIsAgent: users.isAgent, originatorName: originator.name }).from(activities).innerJoin(users, eq(users.id, activities.actorId)).leftJoin(originator, eq(originator.id, activities.originatorId))
          .where(and(eq(activities.entityType, "work_item"), eq(activities.entityId, item.id))).orderBy(asc(activities.seq))).map((row) => ({ ...row.activity, actorName: row.actorName, actorIsAgent: row.actorIsAgent, originatorName: row.originatorName }));
        const agentIds = rows.filter((row) => row.actorIsAgent).map((row) => row.actorId);
        const codeAgents = new Set(agentIds.length ? (await db.select({ userId: agents.userId }).from(agents).where(and(inArray(agents.userId, agentIds), isNotNull(agents.runtimeId)))).map((agent) => agent.userId) : []);
        return rows.map((row) => ({ actorName: row.actorName, actorIsAgent: row.actorIsAgent, actorCodeCapable: codeAgents.has(row.actorId), id: row.id, field: row.field, oldValue: row.oldValue ?? null, newValue: row.newValue ?? null, actorId: row.actorId, source: row.source, chatId: row.chatId, runId: row.runId, originatorId: row.originatorId, originatorName: row.originatorName, bulkEditId: row.bulkEditId, reason: row.reason ?? null, createdAt: row.createdAt.toISOString() }));
      },
    },
  };
}
