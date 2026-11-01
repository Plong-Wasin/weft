import { Type } from "@sinclair/typebox";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, moduleItems, moduleMembers, modules, projectMembers, workItemStates, workItems, workspaceMembers } from "@weft/db";
import { assertFeatureEnabled } from "./features";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import type { ActivitySource } from "./work-items";

/** Set by hand, never computed from dates or work items. */
export const moduleStatuses = ["backlog", "planned", "in-progress", "paused", "completed", "cancelled"] as const;
export type ModuleStatus = (typeof moduleStatuses)[number];
/** A Module can be archived only once it is over. */
const archivableStatuses: readonly ModuleStatus[] = ["completed", "cancelled"];

const uuid = () => Type.String({ format: "uuid" });
const dateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const statusSchema = Type.Union(moduleStatuses.map((status) => Type.Literal(status)));
const nameSchema = Type.String({ minLength: 1, maxLength: 100 });
const progressSchema = Type.Object({ total: Type.Integer(), completed: Type.Integer(), cancelled: Type.Integer(), percent: Type.Integer() });
const moduleOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), status: statusSchema, leadId: Type.Union([Type.String(), Type.Null()]),
  memberIds: Type.Array(Type.String()), startDate: Type.Union([Type.String(), Type.Null()]), endDate: Type.Union([Type.String(), Type.Null()]),
  archived: Type.Boolean(), createdBy: Type.String(), createdAt: Type.String(), itemCount: Type.Integer(), progress: progressSchema,
});
const moduleDetailOutput = Type.Intersect([moduleOutput, Type.Object({ workItemIds: Type.Array(Type.String()) })]);
type Context = { userId: string; source?: ActivitySource; chatId?: string };
type ModuleRow = typeof modules.$inferSelect;
type Progress = { total: number; completed: number; cancelled: number; percent: number };

function assertDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ActionError("Invalid date", 400);
}
function assertDates(start: string | null, end: string | null) {
  for (const value of [start, end]) if (value) assertDate(value);
  if (start && end && start > end) throw new ActionError("Start date must not be after end date", 400);
}

export function createModuleActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  /** Items of each Module (not deleted) with the state group of each, from which the item list and progress are built. */
  async function itemsOf(database: Database, moduleIds: string[]) {
    const result = new Map<string, Array<{ id: string; group: string }>>(moduleIds.map((id) => [id, []]));
    if (moduleIds.length === 0) return result;
    const rows = await database.select({ moduleId: moduleItems.moduleId, id: moduleItems.workItemId, group: workItemStates.group }).from(moduleItems)
      .innerJoin(workItems, and(eq(workItems.id, moduleItems.workItemId), isNull(workItems.deletedAt)))
      .innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId)).where(inArray(moduleItems.moduleId, moduleIds));
    for (const row of rows) result.get(row.moduleId)!.push({ id: row.id, group: row.group });
    return result;
  }

  /** Progress counts completed work items against all work items that are not cancelled. */
  function progressOf(items: Array<{ group: string }>): Progress {
    const completed = items.filter((item) => item.group === "completed").length, cancelled = items.filter((item) => item.group === "cancelled").length;
    const open = items.length - cancelled;
    return { total: items.length, completed, cancelled, percent: open === 0 ? 0 : Math.round((completed / open) * 100) };
  }

  async function membersOf(database: Database, moduleIds: string[]) {
    const result = new Map<string, string[]>(moduleIds.map((id) => [id, []]));
    if (moduleIds.length === 0) return result;
    for (const row of await database.select().from(moduleMembers).where(inArray(moduleMembers.moduleId, moduleIds))) result.get(row.moduleId)!.push(row.userId);
    return result;
  }

  async function present(database: Database, rows: ModuleRow[]) {
    const ids = rows.map((row) => row.id);
    const [items, members] = await Promise.all([itemsOf(database, ids), membersOf(database, ids)]);
    return rows.map((row) => {
      const found = items.get(row.id)!;
      return {
        id: row.id, projectId: row.projectId, name: row.name, status: row.status as ModuleStatus, leadId: row.leadId, memberIds: members.get(row.id)!.sort(),
        startDate: row.startDate, endDate: row.endDate, archived: row.archivedAt !== null, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(),
        itemCount: found.length, progress: progressOf(found), workItemIds: found.map((item) => item.id),
      };
    });
  }
  const strip = ({ workItemIds: _ids, ...rest }: Awaited<ReturnType<typeof present>>[number]) => rest;

  async function moduleAccess(context: Context, moduleId: string, requirement: "read" | "write" | "admin") {
    const [found] = await db.select().from(modules).where(and(eq(modules.id, moduleId), isNull(modules.deletedAt)));
    if (!found) throw new ActionError("Module not found", 404);
    const { project } = await requireProjectAccess(db, context.userId, found.projectId, requirement);
    assertFeatureEnabled(project, "modules");
    return { module: found, project };
  }

  /** Lead and members must be able to work in the project: a project member or a workspace Admin. */
  async function assertPeople(database: Database, project: { id: string; workspaceId: string }, userIds: string[]) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    const inProject = await database.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, project.id), inArray(projectMembers.userId, ids)));
    const admins = await database.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.role, "Admin"), inArray(workspaceMembers.userId, ids)));
    const ok = new Set([...inProject, ...admins].map((row) => row.userId));
    if (ids.some((id) => !ok.has(id))) throw new ActionError("Lead and members must belong to this project", 400);
  }

  function assertOpen(found: ModuleRow) {
    if (found.archivedAt) throw new ActionError("Module is archived", 400);
  }

  async function logModuleChange(database: Database, context: Context, project: { id: string; workspaceId: string }, workItemId: string, oldValue: string | null, newValue: string | null) {
    await database.insert(activities).values({
      workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: workItemId, field: "module", oldValue, newValue,
      actorId: context.userId, source: context.source ?? "ui", chatId: context.source === "ai" ? context.chatId ?? null : null,
    });
  }

  const nullableDate = Type.Union([dateSchema, Type.Null()]);
  const people = Type.Array(Type.String({ minLength: 1 }), { maxItems: 200 });
  type CreateInput = { projectId: string; name: string; status?: ModuleStatus; leadId?: string | null; memberIds?: string[]; startDate?: string | null; endDate?: string | null };
  type UpdateInput = Partial<Omit<CreateInput, "projectId">> & { moduleId: string };

  return {
    createModule: {
      name: "create_module", kind: "write" as const,
      input: Type.Object({
        projectId: uuid(), name: nameSchema, status: Type.Optional(statusSchema), leadId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
        memberIds: Type.Optional(people), startDate: Type.Optional(nullableDate), endDate: Type.Optional(nullableDate),
      }), output: moduleOutput,
      handler: async (context: Context, input: CreateInput) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        assertFeatureEnabled(project, "modules");
        assertDates(input.startDate ?? null, input.endDate ?? null);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await assertPeople(database, project, [...(input.leadId ? [input.leadId] : []), ...(input.memberIds ?? [])]);
          const [row] = await database.insert(modules).values({
            workspaceId: project.workspaceId, projectId: project.id, name: input.name, status: input.status ?? "backlog", leadId: input.leadId ?? null,
            startDate: input.startDate ?? null, endDate: input.endDate ?? null, createdBy: context.userId,
          }).returning();
          const memberIds = [...new Set(input.memberIds ?? [])];
          if (memberIds.length) await database.insert(moduleMembers).values(memberIds.map((userId) => ({ moduleId: row!.id, userId })));
          return strip((await present(database, [row!]))[0]!);
        });
      },
    },
    updateModule: {
      name: "update_module", kind: "write" as const,
      input: Type.Object({
        moduleId: uuid(), name: Type.Optional(nameSchema), status: Type.Optional(statusSchema), leadId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
        memberIds: Type.Optional(people), startDate: Type.Optional(nullableDate), endDate: Type.Optional(nullableDate),
      }), output: moduleOutput,
      handler: async (context: Context, input: UpdateInput) => {
        const { module: current, project } = await moduleAccess(context, input.moduleId, "write");
        assertOpen(current);
        const startDate = input.startDate === undefined ? current.startDate : input.startDate, endDate = input.endDate === undefined ? current.endDate : input.endDate;
        assertDates(startDate, endDate);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const leadId = input.leadId === undefined ? current.leadId : input.leadId;
          await assertPeople(database, project, [...(input.leadId ? [input.leadId] : []), ...(input.memberIds ?? [])]);
          const [row] = await database.update(modules).set({ name: input.name ?? current.name, status: input.status ?? current.status, leadId, startDate, endDate }).where(eq(modules.id, current.id)).returning();
          if (input.memberIds) {
            const memberIds = [...new Set(input.memberIds)];
            await database.delete(moduleMembers).where(eq(moduleMembers.moduleId, current.id));
            if (memberIds.length) await database.insert(moduleMembers).values(memberIds.map((userId) => ({ moduleId: current.id, userId })));
          }
          return strip((await present(database, [row!]))[0]!);
        });
      },
    },
    /** Archived Modules are hidden unless `archived` is true, which lists only them. */
    listModules: {
      name: "list_modules", kind: "read" as const,
      input: Type.Object({ projectId: uuid(), archived: Type.Optional(Type.Boolean()) }), output: Type.Array(moduleOutput),
      handler: async (context: Context, input: { projectId: string; archived?: boolean }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        assertFeatureEnabled(project, "modules");
        const rows = await db.select().from(modules)
          .where(and(eq(modules.projectId, project.id), isNull(modules.deletedAt), input.archived ? isNotNull(modules.archivedAt) : isNull(modules.archivedAt)))
          .orderBy(asc(modules.createdAt), asc(modules.id));
        return (await present(db, rows)).map(strip);
      },
    },
    getModule: {
      name: "get_module", kind: "read" as const,
      input: Type.Object({ moduleId: uuid() }), output: moduleDetailOutput,
      handler: async (context: Context, input: { moduleId: string }) => {
        const { module: found } = await moduleAccess(context, input.moduleId, "read");
        return (await present(db, [found]))[0]!;
      },
    },
    addModuleItems: {
      name: "add_module_items", kind: "write" as const,
      input: Type.Object({ moduleId: uuid(), workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }) }),
      output: Type.Object({ added: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { moduleId: string; workItemIds: string[] }) => {
        const { module: found, project } = await moduleAccess(context, input.moduleId, "write");
        assertOpen(found);
        const ids = [...new Set(input.workItemIds)];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const known = await database.select({ id: workItems.id }).from(workItems).where(and(inArray(workItems.id, ids), eq(workItems.projectId, project.id), isNull(workItems.deletedAt)));
          if (known.length !== ids.length) throw new ActionError("Work items must belong to this Module's project", 400);
          // Already in this Module is a no-op: the primary key decides races and only new rows are reported and logged.
          const inserted = await database.insert(moduleItems).values(ids.map((workItemId) => ({ moduleId: found.id, workItemId, workspaceId: project.workspaceId, projectId: project.id })))
            .onConflictDoNothing().returning({ workItemId: moduleItems.workItemId });
          for (const row of inserted) await logModuleChange(database, context, project, row.workItemId, null, found.id);
          return { added: inserted.map((row) => row.workItemId) };
        });
      },
    },
    removeModuleItems: {
      name: "remove_module_items", kind: "write" as const,
      input: Type.Object({ moduleId: uuid(), workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }) }),
      output: Type.Object({ removed: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { moduleId: string; workItemIds: string[] }) => {
        const { module: found, project } = await moduleAccess(context, input.moduleId, "write");
        assertOpen(found);
        const ids = [...new Set(input.workItemIds)];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const deleted = await database.delete(moduleItems).where(and(eq(moduleItems.moduleId, found.id), inArray(moduleItems.workItemId, ids))).returning({ workItemId: moduleItems.workItemId });
          for (const row of deleted) await logModuleChange(database, context, project, row.workItemId, found.id, null);
          return { removed: deleted.map((row) => row.workItemId) };
        });
      },
    },
    archiveModule: {
      name: "archive_module", kind: "write" as const,
      input: Type.Object({ moduleId: uuid() }), output: moduleOutput,
      handler: async (context: Context, input: { moduleId: string }) => {
        const { module: found } = await moduleAccess(context, input.moduleId, "admin");
        if (!archivableStatuses.includes(found.status as ModuleStatus)) throw new ActionError("Only a completed or cancelled Module can be archived", 400);
        const [row] = await db.update(modules).set({ archivedAt: found.archivedAt ?? new Date() }).where(eq(modules.id, found.id)).returning();
        return strip((await present(db, [row!]))[0]!);
      },
    },
    unarchiveModule: {
      name: "unarchive_module", kind: "write" as const,
      input: Type.Object({ moduleId: uuid() }), output: moduleOutput,
      handler: async (context: Context, input: { moduleId: string }) => {
        const { module: found } = await moduleAccess(context, input.moduleId, "admin");
        const [row] = await db.update(modules).set({ archivedAt: null }).where(eq(modules.id, found.id)).returning();
        return strip((await present(db, [row!]))[0]!);
      },
    },
    /** Soft delete: the Module vanishes and its membership rows go; the work items are untouched. */
    deleteModule: {
      name: "delete_module", kind: "write" as const,
      input: Type.Object({ moduleId: uuid() }), output: Type.Object({ deleted: Type.Literal(true) }),
      handler: async (context: Context, input: { moduleId: string }) => {
        const { module: found, project } = await moduleAccess(context, input.moduleId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.update(modules).set({ deletedAt: new Date() }).where(eq(modules.id, found.id));
          const removed = await database.delete(moduleItems).where(eq(moduleItems.moduleId, found.id)).returning({ workItemId: moduleItems.workItemId });
          for (const row of removed) await logModuleChange(database, context, project, row.workItemId, found.id, null);
          return { deleted: true as const };
        });
      },
    },
  };
}
