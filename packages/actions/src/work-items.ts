import { Type } from "@sinclair/typebox";
import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, projectKeyAliases, projects, workItemStates, workItems } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
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
});
const activityOutput = Type.Object({
  id: Type.String(), field: Type.String(), oldValue: Type.Any(), newValue: Type.Any(), actorId: Type.String(),
  source: Type.String(), chatId: Type.Union([Type.String(), Type.Null()]), createdAt: Type.String(),
});

type Context = { userId: string; source?: ActivitySource };
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

function itemOut(item: ItemRow, key: string) {
  return {
    id: item.id, projectId: item.projectId, sequence: item.sequence, displayId: `${key}-${item.sequence}`, title: item.title,
    description: item.description ?? null, descriptionText: item.descriptionText, stateId: item.stateId, priority: item.priority as Priority,
    sortOrder: item.sortOrder, createdBy: item.createdBy, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
  };
}

async function logActivity(database: Database, context: Context, entry: { workspaceId: string; projectId: string; entityType: "work_item" | "state"; entityId: string; field: string; oldValue?: unknown; newValue?: unknown }) {
  await database.insert(activities).values({
    workspaceId: entry.workspaceId, projectId: entry.projectId, entityType: entry.entityType, entityId: entry.entityId, field: entry.field,
    oldValue: entry.oldValue ?? null, newValue: entry.newValue ?? null, actorId: context.userId, source: context.source ?? "ui",
  });
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
        stateId: Type.Optional(uuid()), priority: Type.Optional(prioritySchema),
      }),
      output: workItemOutput,
      handler: async (context: Context, input: { projectId: string; title: string; description?: unknown; stateId?: string; priority?: Priority }) => {
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
          }).returning();
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item!.id, field: "created", newValue: input.title });
          return itemOut(item!, counter!.key);
        });
      },
    },
    listWorkItems: {
      name: "list_work_items", kind: "read" as const,
      input: Type.Object(projectInput), output: Type.Array(workItemOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        const rows = await db.select().from(workItems).where(and(eq(workItems.projectId, project.id), isNull(workItems.deletedAt))).orderBy(asc(workItems.sortOrder), asc(workItems.sequence));
        return rows.map((row) => itemOut(row, project.key));
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
        return itemOut(item, project.key);
      },
    },
    updateWorkItem: {
      name: "update_work_item", kind: "write" as const,
      input: Type.Object({
        workItemId: uuid(), title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), description: Type.Optional(Type.Any()),
        stateId: Type.Optional(uuid()), priority: Type.Optional(prioritySchema),
      }),
      output: workItemOutput,
      handler: async (context: Context, input: { workItemId: string; title?: string; description?: unknown; stateId?: string; priority?: Priority }) => {
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
          if (changes.length === 0) return itemOut(item, project.key);
          const [updated] = await database.update(workItems).set({ ...Object.assign({}, ...changes.map((change) => change.column)), updatedAt: new Date() }).where(eq(workItems.id, item.id)).returning();
          for (const change of changes) {
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: change.field, oldValue: change.oldValue, newValue: change.newValue });
          }
          return itemOut(updated!, project.key);
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
    listWorkItemActivities: {
      name: "list_work_item_activities", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(activityOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const item = await loadItem(input.workItemId);
        await requireProjectAccess(db, context.userId, item.projectId, "read");
        const rows = await db.select().from(activities).where(and(eq(activities.entityType, "work_item"), eq(activities.entityId, item.id))).orderBy(asc(activities.seq));
        return rows.map((row) => ({ id: row.id, field: row.field, oldValue: row.oldValue ?? null, newValue: row.newValue ?? null, actorId: row.actorId, source: row.source, chatId: row.chatId, createdAt: row.createdAt.toISOString() }));
      },
    },
  };
}
