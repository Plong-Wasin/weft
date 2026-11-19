import { Type } from "@sinclair/typebox";
import { and, asc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { assertNoneArchived, assertNotArchived, liveWorkItems, unarchivedWorkItems } from "./triage";
import { activities, moduleHistory, moduleItems, moduleMembers, modules, projectMembers, workItemAssignees, workItemLabels, workItemRelations, labels, users, workItemStates, workItems, workspaceMembers } from "@weft/db";
import { assertFeatureEnabled } from "./features";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import { agentUserIds } from "./agent-access";
import { activityActor, type ActivityContext } from "./work-items";
import { burndownUnitSchema, todayIso, type BurndownUnit } from "./cycles";
import { requirePointsEstimate } from "./estimates";
import { workItemMarkdownOptions, writtenDescription } from "./work-items";
import { WRITTEN_FORM_MAX_INPUT_LENGTH } from "./markdown-doc";
import { validateRichTextAssets } from "./rich-text-validation";

/** Set by hand, never computed from dates or work items. */
export const moduleStatuses = ["backlog", "planned", "in-progress", "paused", "completed", "cancelled"] as const;
export type ModuleStatus = (typeof moduleStatuses)[number];
/** A Module can be archived only once it is over. */
export const archivableModuleStatuses: readonly ModuleStatus[] = ["completed", "cancelled"];

const uuid = () => Type.String({ format: "uuid" });
const userId = Type.String({ minLength: 1 });
const dateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const statusSchema = Type.Union(moduleStatuses.map((status) => Type.Literal(status)));
const nameSchema = Type.String({ minLength: 1, maxLength: 100 });
const progressSchema = Type.Object({ total: Type.Integer(), completed: Type.Integer(), cancelled: Type.Integer(), percent: Type.Integer() });
const moduleOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), status: statusSchema, leadId: Type.Union([Type.String(), Type.Null()]),
  memberIds: Type.Array(Type.String()), startDate: Type.Union([Type.String(), Type.Null()]), endDate: Type.Union([Type.String(), Type.Null()]),
  descriptionMarkdown: Type.String(), description: Type.Optional(Type.Any()),
  archived: Type.Boolean(), createdBy: Type.String(), createdAt: Type.String(), itemCount: Type.Integer(), progress: progressSchema,
});
const moduleDetailOutput = Type.Intersect([moduleOutput, Type.Object({ workItemIds: Type.Array(Type.String()) })]);
type Context = ActivityContext;
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
      .innerJoin(workItems, and(eq(workItems.id, moduleItems.workItemId), unarchivedWorkItems))
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
        descriptionMarkdown: row.descriptionMarkdown ?? "", description: row.descriptionDoc ?? undefined,
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

  /** Module rows are the first locks in all Module writers; membership work-item locks follow. */
  async function lockOpenModule(database: Database, id: string, projectId: string) {
    const [row] = await database.select().from(modules).where(and(eq(modules.id, id), eq(modules.projectId, projectId), isNull(modules.deletedAt))).for("update");
    if (!row) throw new ActionError("Module not found", 404);
    assertOpen(row);
    return row;
  }

  async function logModuleChange(database: Database, context: Context, project: { id: string; workspaceId: string }, workItemId: string, oldValue: string | null, newValue: string | null) {
    await database.insert(activities).values({
      workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: workItemId, field: "module", oldValue, newValue,
      ...activityActor(context),
    });
  }

  /** A Module lead is accountable, so it is always a person: an Agent can be a member but never the lead. */
  async function assertLeadIsPerson(database: Database, leadId: string | null | undefined) {
    if (leadId && (await agentUserIds(database, [leadId])).size > 0) throw new ActionError("An Agent cannot be a Module lead", 400);
  }

  const nullableDate = Type.Union([dateSchema, Type.Null()]);
  const people = Type.Array(Type.String({ minLength: 1 }), { maxItems: 200 });
  type CreateInput = { projectId: string; name: string; status?: ModuleStatus; leadId?: string | null; memberIds?: string[]; startDate?: string | null; endDate?: string | null; description?: unknown; descriptionMarkdown?: string };
  type UpdateInput = Partial<Omit<CreateInput, "projectId">> & { moduleId: string };

  return {
    createModule: {
      name: "create_module", kind: "write" as const,
      input: Type.Object({
        projectId: uuid(), name: nameSchema, status: Type.Optional(statusSchema), leadId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
        memberIds: Type.Optional(people), startDate: Type.Optional(nullableDate), endDate: Type.Optional(nullableDate), description: Type.Optional(Type.Any()), descriptionMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH })),
      }), output: moduleOutput,
      handler: async (context: Context, input: CreateInput) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        assertFeatureEnabled(project, "modules");
        assertDates(input.startDate ?? null, input.endDate ?? null);
        const options = await workItemMarkdownOptions(db, context.userId, project.workspaceId, project.id, input.descriptionMarkdown);
        const description = await writtenDescription(input.description, input.descriptionMarkdown, options);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await assertPeople(database, project, [...(input.leadId ? [input.leadId] : []), ...(input.memberIds ?? [])]);
          await assertLeadIsPerson(database, input.leadId);
          const [row] = await database.insert(modules).values({
            workspaceId: project.workspaceId, projectId: project.id, name: input.name, status: input.status ?? "backlog", leadId: input.leadId ?? null,
            startDate: input.startDate ?? null, endDate: input.endDate ?? null, createdBy: context.userId, descriptionMarkdown: description.markdown, descriptionDoc: description.document,
          }).returning();
          await validateRichTextAssets(database, description.document, "module", row!.id, context.userId);
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
        memberIds: Type.Optional(people), startDate: Type.Optional(nullableDate), endDate: Type.Optional(nullableDate), description: Type.Optional(Type.Any()), descriptionMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH })),
      }), output: moduleOutput,
      handler: async (context: Context, input: UpdateInput) => {
        const { module, project } = await moduleAccess(context, input.moduleId, "write");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const current = await lockOpenModule(database, module.id, project.id);
          const startDate = input.startDate === undefined ? current.startDate : input.startDate, endDate = input.endDate === undefined ? current.endDate : input.endDate;
          assertDates(startDate, endDate);
          const descriptionPatch: Partial<typeof modules.$inferInsert> = {};
          if (input.description !== undefined || input.descriptionMarkdown !== undefined) {
            const options = await workItemMarkdownOptions(database, context.userId, project.workspaceId, project.id, input.descriptionMarkdown);
            const description = await writtenDescription(input.description, input.descriptionMarkdown, options);
            await validateRichTextAssets(database, description.document, "module", current.id, context.userId, current.descriptionDoc);
            descriptionPatch.descriptionMarkdown = description.markdown; descriptionPatch.descriptionDoc = description.document;
          }
          const leadId = input.leadId === undefined ? current.leadId : input.leadId;
          await assertPeople(database, project, [...(input.leadId ? [input.leadId] : []), ...(input.memberIds ?? [])]);
          await assertLeadIsPerson(database, input.leadId);
          const [row] = await database.update(modules).set({ name: input.name ?? current.name, status: input.status ?? current.status, leadId, startDate, endDate, ...descriptionPatch }).where(eq(modules.id, current.id)).returning();
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
      input: Type.Object({ projectId: uuid(), archived: Type.Optional(Type.Boolean()), search: Type.Optional(Type.String({ maxLength: 200 })), status: Type.Optional(statusSchema), leadId: Type.Optional(userId), memberId: Type.Optional(userId), dateFrom: Type.Optional(dateSchema), dateTo: Type.Optional(dateSchema) }), output: Type.Array(moduleOutput),
      handler: async (context: Context, input: { projectId: string; archived?: boolean; search?: string; status?: ModuleStatus; leadId?: string; memberId?: string; dateFrom?: string; dateTo?: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        assertFeatureEnabled(project, "modules");
        assertDates(input.dateFrom ?? null, input.dateTo ?? null);
        if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) throw new ActionError("Start date must not be after end date", 400);
        const matchingMembers = input.memberId ? (await db.select({ moduleId: moduleMembers.moduleId }).from(moduleMembers).where(eq(moduleMembers.userId, input.memberId))).map((row) => row.moduleId) : undefined;
        if (matchingMembers && matchingMembers.length === 0) return [];
        const filters = [eq(modules.projectId, project.id), isNull(modules.deletedAt), input.archived ? isNotNull(modules.archivedAt) : isNull(modules.archivedAt)];
        if (input.search?.trim()) filters.push(ilike(modules.name, `%${input.search.trim().replace(/[\\%_]/g, "\\$&")}%`));
        if (input.status) filters.push(eq(modules.status, input.status));
        if (input.leadId) filters.push(eq(modules.leadId, input.leadId));
        if (matchingMembers) filters.push(inArray(modules.id, matchingMembers));
        if (input.dateTo) filters.push(lte(modules.startDate, input.dateTo));
        if (input.dateFrom) filters.push(gte(modules.endDate, input.dateFrom));
        const rows = await db.select().from(modules)
          .where(and(...filters))
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
    getModuleInsights: {
      name: "get_module_insights", kind: "read" as const,
      input: Type.Object({ moduleId: uuid() }),
      output: Type.Object({ blocked: Type.Array(Type.Object({ id: Type.String(), displayId: Type.String(), title: Type.String() })), overdue: Type.Array(Type.Object({ id: Type.String(), displayId: Type.String(), title: Type.String() })), breakdowns: Type.Record(Type.String(), Type.Array(Type.Object({ key: Type.String(), label: Type.String(), items: Type.Array(Type.Object({ id: Type.String(), displayId: Type.String(), title: Type.String() })) }))) }),
      handler: async (context: Context, input: { moduleId: string }) => {
        const { module: found, project } = await moduleAccess(context, input.moduleId, "read");
        const base = await db.select({ id: workItems.id, sequence: workItems.sequence, title: workItems.title, dueDate: workItems.dueDate, priority: workItems.priority, stateId: workItems.stateId, state: workItemStates.name, group: workItemStates.group })
          .from(moduleItems).innerJoin(workItems, and(eq(workItems.id, moduleItems.workItemId), unarchivedWorkItems)).innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId))
          .where(and(eq(moduleItems.moduleId, found.id), sql`${workItemStates.group} <> 'triage'`)).orderBy(asc(workItems.sequence));
        const liveIds = base.filter((item) => item.group !== "completed" && item.group !== "cancelled").map((item) => item.id);
        const blockers = liveIds.length ? await db.select({ id: workItemRelations.workItemId }).from(workItemRelations)
          .innerJoin(workItems, and(eq(workItems.id, workItemRelations.relatedWorkItemId), unarchivedWorkItems))
          .innerJoin(workItemStates, and(eq(workItemStates.id, workItems.stateId), ne(workItemStates.group, "completed"), ne(workItemStates.group, "cancelled")))
          .where(and(eq(workItemRelations.projectId, project.id), eq(workItemRelations.type, "blocked_by"), inArray(workItemRelations.workItemId, liveIds))) : [];
        const blockedSet = new Set(blockers.map((row) => row.id));
        const today = todayIso();
        const items = base.map((item) => ({ id: item.id, displayId: `${project.key}-${item.sequence}`, title: item.title }));
        const byId = new Map(items.map((item) => [item.id, item]));
        const assigneeRows = await db.select({ itemId: workItemAssignees.workItemId, id: users.id, name: users.name }).from(workItemAssignees).innerJoin(users, eq(users.id, workItemAssignees.userId)).where(inArray(workItemAssignees.workItemId, base.map((item) => item.id)));
        const labelRows = await db.select({ itemId: workItemLabels.workItemId, id: labels.id, name: labels.name }).from(workItemLabels).innerJoin(labels, eq(labels.id, workItemLabels.labelId)).where(inArray(workItemLabels.workItemId, base.map((item) => item.id)));
        const groupBy = (entries: Array<{ key: string; label: string; itemId: string }>) => {
          const map = new Map<string, { key: string; label: string; items: Array<{ id: string; displayId: string; title: string }> }>();
          for (const entry of entries) { const group = map.get(entry.key) ?? { key: entry.key, label: entry.label, items: [] }; const item = byId.get(entry.itemId); if (item) group.items.push(item); map.set(entry.key, group); }
          return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
        };
        const assigned = new Set(assigneeRows.map((row) => row.itemId)), labelled = new Set(labelRows.map((row) => row.itemId));
        return {
          blocked: items.filter((item) => blockedSet.has(item.id)),
          overdue: items.filter((item) => { const source = base.find((row) => row.id === item.id)!; return source.dueDate !== null && source.dueDate < today && source.group !== "completed" && source.group !== "cancelled"; }),
          breakdowns: {
            state: groupBy(base.map((row) => ({ key: row.stateId, label: row.state, itemId: row.id }))),
            assignee: groupBy([...assigneeRows.map((row) => ({ key: row.id, label: row.name, itemId: row.itemId })), ...base.filter((row) => !assigned.has(row.id)).map((row) => ({ key: "none", label: "Unassigned", itemId: row.id }))]),
            label: groupBy([...labelRows.map((row) => ({ key: row.id, label: row.name, itemId: row.itemId })), ...base.filter((row) => !labelled.has(row.id)).map((row) => ({ key: "none", label: "Unlabelled", itemId: row.id }))]),
            priority: groupBy(base.map((row) => ({ key: row.priority, label: row.priority, itemId: row.id }))),
          },
        };
      },
    },
    /** Reconstructs each day from Module history, including history recorded before dates were set. */
    getModuleBurndown: {
      name: "get_module_burndown", kind: "read" as const,
      input: Type.Object({ moduleId: uuid(), unit: Type.Optional(burndownUnitSchema) }),
      output: Type.Object({
        moduleId: Type.String(), unit: burndownUnitSchema, startDate: Type.Union([Type.String(), Type.Null()]), endDate: Type.Union([Type.String(), Type.Null()]), total: Type.Number(),
        reason: Type.Union([Type.Literal("missing_start_date"), Type.Literal("missing_target_date"), Type.Literal("no_work_items"), Type.Null()]),
        coverageStart: Type.String(), unestimated: Type.Union([Type.Number(), Type.Null()]),
        days: Type.Array(Type.Object({ date: Type.String(), open: Type.Union([Type.Number(), Type.Null()]), completed: Type.Union([Type.Number(), Type.Null()]), cancelled: Type.Union([Type.Number(), Type.Null()]), pointsOpen: Type.Union([Type.Number(), Type.Null()]), pointsCompleted: Type.Union([Type.Number(), Type.Null()]), pointsCancelled: Type.Union([Type.Number(), Type.Null()]), unestimatedOpen: Type.Union([Type.Number(), Type.Null()]), ideal: Type.Union([Type.Number(), Type.Null()]), idealPoints: Type.Union([Type.Number(), Type.Null()]), unknown: Type.Boolean() })),
      }),
      handler: async (context: Context, input: { moduleId: string; unit?: BurndownUnit }) => {
        const { module: found } = await moduleAccess(context, input.moduleId, "read");
        const unit = input.unit ?? "items";
        if (unit === "points") await requirePointsEstimate(db, found.projectId);
        const events = await db.select().from(moduleHistory).where(eq(moduleHistory.moduleId, found.id)).orderBy(asc(moduleHistory.occurredAt), asc(moduleHistory.sequence));
        const coverageStart = found.historyStartedAt.toISOString();
        const base = { moduleId: found.id, unit, startDate: found.startDate, endDate: found.endDate, total: 0, coverageStart, unestimated: null as number | null };
        if (!found.startDate) return { ...base, reason: "missing_start_date" as const, days: [] };
        if (!found.endDate) return { ...base, reason: "missing_target_date" as const, days: [] };
        if (events.length === 0) return { ...base, reason: "no_work_items" as const, days: [] };

        const dayMs = 86_400_000, dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`);
        const initialUnknown = dayOf(found.startDate) < found.historyStartedAt.getTime();
        const state = new Map<string, { member: boolean; group: string; estimate: number | null }>();
        const estimateValue = (value: string | null) => value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
        const snapshots = events.filter((event) => event.workItemId !== null);
        let cursor = 0;
        const apply = (event: (typeof snapshots)[number]) => state.set(event.workItemId!, {
          member: event.member ?? true, group: event.stateGroup ?? "unknown", estimate: estimateValue(event.estimate),
        });
        const start = dayOf(found.startDate);
        while (cursor < snapshots.length && snapshots[cursor]!.occurredAt.getTime() < start) {
          const event = snapshots[cursor++]!;
          if (event.occurredAt.getTime() >= found.historyStartedAt.getTime()) apply(event);
        }
        const initialItems = [...state.values()].filter((item) => item.member);
        const initialScope = initialUnknown ? null : initialItems.length;
        const initialPoints = initialUnknown ? null : initialItems.reduce((sum, item) => sum + (item.estimate ?? 0), 0);
        const span = (dayOf(found.endDate) - start) / dayMs, today = todayIso();
        const days = [] as Array<{ date: string; open: number | null; completed: number | null; cancelled: number | null; pointsOpen: number | null; pointsCompleted: number | null; pointsCancelled: number | null; unestimatedOpen: number | null; ideal: number | null; idealPoints: number | null; unknown: boolean }>;
        for (let offset = 0; offset <= span; offset++) {
          const date = new Date(start + offset * dayMs).toISOString().slice(0, 10), cutoff = dayOf(date) + dayMs;
          while (cursor < snapshots.length && snapshots[cursor]!.occurredAt.getTime() < cutoff) apply(snapshots[cursor++]!);
          const observed = [...state.values()].filter((item) => item.member);
          const open = observed.filter((item) => item.group !== "completed" && item.group !== "cancelled");
          const completed = observed.filter((item) => item.group === "completed"), cancelled = observed.filter((item) => item.group === "cancelled");
          const future = date >= today, unknown = cutoff <= found.historyStartedAt.getTime() || future;
          days.push({ date, open: unknown ? null : open.length, completed: unknown ? null : completed.length, cancelled: unknown ? null : cancelled.length,
            pointsOpen: unknown ? null : open.reduce((sum, item) => sum + (item.estimate ?? 0), 0),
            pointsCompleted: unknown ? null : completed.reduce((sum, item) => sum + (item.estimate ?? 0), 0),
            pointsCancelled: unknown ? null : cancelled.reduce((sum, item) => sum + (item.estimate ?? 0), 0),
            unestimatedOpen: unknown ? null : open.filter((item) => item.estimate === null).length,
            ideal: initialScope === null ? null : Math.round((initialScope * (span - offset) / (span || 1)) * 100) / 100,
            idealPoints: initialPoints === null ? null : Math.round((initialPoints * (span - offset) / (span || 1)) * 100) / 100, unknown });
        }
        const lastKnown = [...days].reverse().find((day) => day.unestimatedOpen !== null);
        const total = Math.max(0, ...days.flatMap((day) => [day.open, day.completed, day.cancelled].filter((value): value is number => value !== null)));
        return { ...base, total: initialScope ?? total, unestimated: lastKnown?.unestimatedOpen ?? null, reason: null, days };
      },
    },
    addModuleItems: {
      name: "add_module_items", kind: "write" as const,
      input: Type.Object({ moduleId: uuid(), workItemIds: Type.Array(uuid(), { minItems: 1, maxItems: 500 }) }),
      output: Type.Object({ added: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { moduleId: string; workItemIds: string[] }) => {
        const { module: found, project } = await moduleAccess(context, input.moduleId, "write");
        const ids = [...new Set(input.workItemIds)];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await lockOpenModule(database, found.id, project.id);
          const known = await database.select({ id: workItems.id, archivedAt: workItems.archivedAt }).from(workItems).where(and(inArray(workItems.id, ids), eq(workItems.projectId, project.id), liveWorkItems)).orderBy(workItems.id).for("no key update");
          if (known.length !== ids.length) throw new ActionError("Work items must belong to this Module's project", 400);
          known.forEach(assertNotArchived);
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
        const ids = [...new Set(input.workItemIds)];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await lockOpenModule(database, found.id, project.id);
          await assertNoneArchived(database, ids);
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
        const { module: found, project } = await moduleAccess(context, input.moduleId, "admin");
        const [row] = await db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [current] = await database.select().from(modules).where(and(eq(modules.id, found.id), eq(modules.projectId, project.id), isNull(modules.deletedAt))).for("update");
          if (!current) throw new ActionError("Module not found", 404);
          if (!archivableModuleStatuses.includes(current.status as ModuleStatus)) throw new ActionError("Only a completed or cancelled Module can be archived", 400);
          return database.update(modules).set({ archivedAt: current.archivedAt ?? new Date() }).where(eq(modules.id, current.id)).returning();
        });
        return strip((await present(db, [row!]))[0]!);
      },
    },
    unarchiveModule: {
      name: "unarchive_module", kind: "write" as const,
      input: Type.Object({ moduleId: uuid() }), output: moduleOutput,
      handler: async (context: Context, input: { moduleId: string }) => {
        const { module: found, project } = await moduleAccess(context, input.moduleId, "admin");
        const [row] = await db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.select({ id: modules.id }).from(modules).where(and(eq(modules.id, found.id), eq(modules.projectId, project.id), isNull(modules.deletedAt))).for("update");
          return database.update(modules).set({ archivedAt: null }).where(eq(modules.id, found.id)).returning();
        });
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
          await database.select({ id: modules.id }).from(modules).where(and(eq(modules.id, found.id), eq(modules.projectId, project.id), isNull(modules.deletedAt))).for("update");
          await database.update(modules).set({ deletedAt: new Date() }).where(eq(modules.id, found.id));
          const removed = await database.delete(moduleItems).where(eq(moduleItems.moduleId, found.id)).returning({ workItemId: moduleItems.workItemId });
          for (const row of removed) await logModuleChange(database, context, project, row.workItemId, found.id, null);
          return { deleted: true as const };
        });
      },
    },
  };
}
