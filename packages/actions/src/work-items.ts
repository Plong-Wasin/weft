import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, exists, inArray, isNull, max, ne, not, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, cycleItems, cycles, moduleItems, modules, labels, projectKeyAliases, projectMembers, projects, users, workItemAssignees, workItemLabels, workItemStates, workItems } from "@weft/db";
import { assertFeatureEnabled } from "./features";
import { ActionError, requireWorkspaceRole } from "./members";
import { enqueueNotification } from "./notifications";
import { requireProjectAccess } from "./projects";

export const stateGroups = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
export type StateGroup = (typeof stateGroups)[number];
export const priorities = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof priorities)[number];
export type ActivitySource = "ui" | "ai" | "cli" | "mcp";

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
  description: Type.Any(), descriptionText: Type.String(), stateId: Type.String(), priority: prioritySchema,
  sortOrder: Type.Number(), createdBy: Type.String(), createdAt: Type.String(), updatedAt: Type.String(),
  assigneeIds: Type.Array(Type.String()), labelIds: Type.Array(Type.String()), parentId: Type.Union([Type.String(), Type.Null()]),
  startDate: Type.Union([Type.String(), Type.Null()]), dueDate: Type.Union([Type.String(), Type.Null()]),
});
const dateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const nullable = <T extends import("@sinclair/typebox").TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const fieldInput = {
  assigneeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), labelIds: Type.Optional(Type.Array(uuid())),
  parentId: Type.Optional(nullable(uuid())), startDate: Type.Optional(nullable(dateSchema)), dueDate: Type.Optional(nullable(dateSchema)),
};
type FieldInput = { assigneeIds?: string[]; labelIds?: string[]; parentId?: string | null; startDate?: string | null; dueDate?: string | null };
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
};
type ListInput = { projectId: string; stateIds?: string[]; priorities?: Priority[]; assigneeIds?: string[]; labelIds?: string[]; cycleId?: string; moduleId?: string; sort?: (typeof sortFields)[number]; direction?: "asc" | "desc" };
/** Distance between neighbours: new work items append 65536 apart, so a midpoint split has ~40 halvings before the gap collapses. */
const sortGap = 65536;
const activityOutput = Type.Object({
  id: Type.String(), field: Type.String(), oldValue: Type.Any(), newValue: Type.Any(), actorId: Type.String(), actorName: Type.String(),
  source: Type.String(), chatId: Type.Union([Type.String(), Type.Null()]), createdAt: Type.String(),
});

type Context = { userId: string; source?: ActivitySource; chatId?: string };
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
    description: item.description ?? null, descriptionText: item.descriptionText, stateId: item.stateId, priority: item.priority as Priority,
    sortOrder: item.sortOrder, createdBy: item.createdBy, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
  };
}

async function logActivity(database: Database, context: Context, entry: { workspaceId: string; projectId: string; entityType: "work_item" | "state" | "label"; entityId: string; field: string; oldValue?: unknown; newValue?: unknown }) {
  await database.insert(activities).values({
    workspaceId: entry.workspaceId, projectId: entry.projectId, entityType: entry.entityType, entityId: entry.entityId, field: entry.field,
    oldValue: entry.oldValue ?? null, newValue: entry.newValue ?? null, actorId: context.userId, source: context.source ?? "ui", chatId: context.source === "ai" ? context.chatId ?? null : null,
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
    const [item] = await db.select().from(workItems).where(and(eq(workItems.id, workItemId), isNull(workItems.deletedAt)));
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
        if (members.length !== added.length) throw new ActionError("Assignees must be project members", 400);
      }
      if (JSON.stringify(next) !== JSON.stringify(current.assigneeIds)) {
        await database.delete(workItemAssignees).where(eq(workItemAssignees.workItemId, item.id));
        if (next.length > 0) await database.insert(workItemAssignees).values(next.map((userId) => ({ workItemId: item.id, userId })));
        entries.push({ field: "assignees", oldValue: current.assigneeIds, newValue: next });
        await enqueueNotification(database, { kind: "assignment", workItemId: item.id, actorId: context.userId, recipientIds: next.filter((id) => !current.assigneeIds.includes(id)) });
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
        const [parent] = await database.select().from(workItems).where(and(eq(workItems.id, input.parentId), eq(workItems.projectId, project.id), isNull(workItems.deletedAt)));
        if (!parent) throw new ActionError("Parent must be a work item of this project", 400);
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

  async function orderedStates(database: Database, projectId: string) {
    const rows = await database.select().from(workItemStates).where(eq(workItemStates.projectId, projectId)).orderBy(asc(workItemStates.sortOrder));
    return stateGroups.flatMap((group) => rows.filter((row) => row.group === group));
  }

  async function stateOfProject(database: Database, projectId: string, stateId: string) {
    const [state] = await database.select().from(workItemStates).where(and(eq(workItemStates.id, stateId), eq(workItemStates.projectId, projectId)));
    if (!state) throw new ActionError("State not found in this project", 400);
    return state;
  }

  async function stateForAdmin(context: Context, stateId: string) {
    const [state] = await db.select().from(workItemStates).where(eq(workItemStates.id, stateId));
    if (!state) throw new ActionError("State not found", 404);
    const { project } = await requireProjectAccess(db, context.userId, state.projectId, "admin");
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
          const [used] = await database.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.stateId, state.id), isNull(workItems.deletedAt))).limit(1);
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
        ...projectInput, title: Type.String({ minLength: 1, maxLength: 500 }), description: Type.Optional(Type.Any()),
        stateId: Type.Optional(uuid()), priority: Type.Optional(prioritySchema), ...fieldInput,
      }),
      output: workItemOutput,
      handler: async (context: Context, input: { projectId: string; title: string; description?: unknown; stateId?: string; priority?: Priority } & FieldInput) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const state = input.stateId ? await stateOfProject(database, project.id, input.stateId) : (await orderedStates(database, project.id))[0];
          if (!state) throw new ActionError("Project has no states", 400);
          // The row lock taken by this UPDATE serialises creators per project, and the counter rolls back with the transaction: no gaps.
          const [counter] = await database.update(projects).set({ workItemSequence: sql`${projects.workItemSequence} + 1` }).where(eq(projects.id, project.id)).returning({ sequence: projects.workItemSequence, key: projects.key });
          const [{ value }] = await database.select({ value: max(workItems.sortOrder) }).from(workItems).where(eq(workItems.projectId, project.id));
          const [item] = await database.insert(workItems).values({
            workspaceId: project.workspaceId, projectId: project.id, sequence: counter!.sequence, title: input.title,
            description: input.description ?? null, descriptionText: plainText(input.description), stateId: state.id,
            priority: input.priority ?? "none", sortOrder: (value ?? 0) + 65536, createdBy: context.userId,
            startDate: input.startDate ?? null, dueDate: input.dueDate ?? null,
          }).returning();
          assertDateOrder(input.startDate ?? null, input.dueDate ?? null);
          const applied = await applyRelations(database, context, project, item!, { assigneeIds: [], labelIds: [] }, { ...input, parentId: input.parentId ?? undefined });
          const created = Object.keys(applied.column).length > 0 ? (await database.update(workItems).set(applied.column).where(eq(workItems.id, item!.id)).returning())[0]! : item!;
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item!.id, field: "created", newValue: input.title });
          const dateEntries = [["startDate", input.startDate], ["dueDate", input.dueDate]].filter(([, value]) => value) as Array<[string, string]>;
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
        const conditions = [eq(workItems.projectId, project.id), isNull(workItems.deletedAt)];
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
          const [cycle] = await db.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.id, input.cycleId), eq(cycles.projectId, project.id)));
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
        const rows = await db.select().from(workItems).where(and(...conditions)).orderBy(...order, direction(workItems.sequence));
        return hydrate(db, rows, project.key);
      },
    },
    moveWorkItem: {
      name: "move_work_item", kind: "write" as const,
      /** Drop a card into a column: `beforeId` is the card it lands above, omitted means the end of the column. */
      input: Type.Object({ workItemId: uuid(), stateId: uuid(), beforeId: Type.Optional(uuid()) }), output: workItemOutput,
      handler: async (context: Context, input: { workItemId: string; stateId: string; beforeId?: string }) => {
        const existing = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, existing.projectId, "write");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`moves:${project.id}`}))`);
          const [item] = await database.select().from(workItems).where(and(eq(workItems.id, existing.id), isNull(workItems.deletedAt))).for("update");
          if (!item) throw new ActionError("Work item not found", 404);
          await stateOfProject(database, project.id, input.stateId);
          const column = () => database.select().from(workItems)
            .where(and(eq(workItems.projectId, project.id), eq(workItems.stateId, input.stateId), isNull(workItems.deletedAt), ne(workItems.id, item.id)))
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
        const [item] = await db.select().from(workItems).where(and(eq(workItems.projectId, project.id), eq(workItems.sequence, sequence), isNull(workItems.deletedAt)));
        if (!item) throw new ActionError("Work item not found", 404);
        return (await hydrate(db, [item], project.key))[0]!;
      },
    },
    updateWorkItem: {
      name: "update_work_item", kind: "write" as const,
      input: Type.Object({
        workItemId: uuid(), title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), description: Type.Optional(Type.Any()),
        stateId: Type.Optional(uuid()), priority: Type.Optional(prioritySchema), ...fieldInput,
      }),
      output: workItemOutput,
      handler: async (context: Context, input: { workItemId: string; title?: string; description?: unknown; stateId?: string; priority?: Priority } & FieldInput) => {
        const existing = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, existing.projectId, "write");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [item] = await database.select().from(workItems).where(and(eq(workItems.id, existing.id), isNull(workItems.deletedAt))).for("update");
          if (!item) throw new ActionError("Work item not found", 404);
          if (input.stateId) await stateOfProject(database, project.id, input.stateId);
          const changes: Array<{ field: string; column: Partial<typeof workItems.$inferInsert>; oldValue: unknown; newValue: unknown }> = [];
          if (input.title !== undefined && input.title !== item.title) changes.push({ field: "title", column: { title: input.title }, oldValue: item.title, newValue: input.title });
          if (input.stateId !== undefined && input.stateId !== item.stateId) changes.push({ field: "state", column: { stateId: input.stateId }, oldValue: item.stateId, newValue: input.stateId });
          if (input.priority !== undefined && input.priority !== item.priority) changes.push({ field: "priority", column: { priority: input.priority }, oldValue: item.priority, newValue: input.priority });
          if (input.description !== undefined && JSON.stringify(input.description) !== JSON.stringify(item.description)) {
            changes.push({ field: "description", column: { description: input.description, descriptionText: plainText(input.description) }, oldValue: item.descriptionText, newValue: plainText(input.description) });
          }
          if (input.startDate !== undefined && input.startDate !== item.startDate) changes.push({ field: "startDate", column: { startDate: input.startDate }, oldValue: item.startDate, newValue: input.startDate });
          if (input.dueDate !== undefined && input.dueDate !== item.dueDate) changes.push({ field: "dueDate", column: { dueDate: input.dueDate }, oldValue: item.dueDate, newValue: input.dueDate });
          assertDateOrder(input.startDate !== undefined ? input.startDate : item.startDate, input.dueDate !== undefined ? input.dueDate : item.dueDate);
          const current = (await relationsOf(database, [item.id])).get(item.id)!;
          const applied = await applyRelations(database, context, project, item, current, input);
          const entries = [...changes.map(({ field, oldValue, newValue }) => ({ field, oldValue, newValue })), ...applied.entries];
          if (entries.length === 0) return itemOut(item, project.key, current);
          const [updated] = await database.update(workItems).set({ ...Object.assign({}, ...changes.map((change) => change.column), applied.column), updatedAt: new Date() }).where(eq(workItems.id, item.id)).returning();
          for (const entry of entries) {
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, ...entry });
          }
          return (await hydrate(database, [updated!], project.key))[0]!;
        });
      },
    },
    deleteWorkItem: {
      name: "delete_work_item", kind: "write" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Object({ removed: Type.Boolean() }),
      handler: async (context: Context, input: { workItemId: string }) => {
        const existing = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, existing.projectId, "write");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [deleted] = await database.update(workItems).set({ deletedAt: new Date() }).where(and(eq(workItems.id, existing.id), isNull(workItems.deletedAt))).returning({ id: workItems.id });
          if (!deleted) throw new ActionError("Work item not found", 404);
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: existing.id, field: "deleted", oldValue: existing.title });
          return { removed: true };
        });
      },
    },
    listSubWorkItems: {
      name: "list_sub_work_items", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(workItemOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const parent = await loadItem(input.workItemId);
        const { project } = await requireProjectAccess(db, context.userId, parent.projectId, "read");
        const rows = await db.select().from(workItems).where(and(eq(workItems.parentId, parent.id), isNull(workItems.deletedAt))).orderBy(asc(workItems.sortOrder), asc(workItems.sequence));
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
    listWorkItemActivities: {
      name: "list_work_item_activities", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(activityOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const item = await loadItem(input.workItemId);
        await requireProjectAccess(db, context.userId, item.projectId, "read");
        const rows = (await db.select({ activity: activities, actorName: users.name }).from(activities).innerJoin(users, eq(users.id, activities.actorId))
          .where(and(eq(activities.entityType, "work_item"), eq(activities.entityId, item.id))).orderBy(asc(activities.seq))).map((row) => ({ ...row.activity, actorName: row.actorName }));
        return rows.map((row) => ({ actorName: row.actorName, id: row.id, field: row.field, oldValue: row.oldValue ?? null, newValue: row.newValue ?? null, actorId: row.actorId, source: row.source, chatId: row.chatId, createdAt: row.createdAt.toISOString() }));
      },
    },
  };
}
