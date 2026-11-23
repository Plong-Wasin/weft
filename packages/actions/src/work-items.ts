import { Type } from "@sinclair/typebox";
import { plainTextWrittenForm } from "./rich-markdown";
import { writtenFormOf } from "./written-form-pool";
import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, lt, max, ne, not, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@weft/db";
import { activities, agents, comments, cycleItems, cycles, estimatePoints, estimates, intakeItems, moduleItems, modules, labels, projectKeyAliases, projectMembers, projects, runs, users, workItemAssignees, workItemDescriptionVersions, workItemLabels, workItemPropertyValues, workItemStates, workItemTypes, workItems } from "@weft/db";
import { assertNotArchived, liveWorkItems, triageGroup, unarchivedWorkItems } from "./triage";
import { assertFeatureEnabled, featureOffMessage } from "./features";
import { assertRequiredFilled, coerceValue, defaultTypeOf, hasValue, loadProperties, loadPropertyValues, loadTypeRow, parsePropertyActivityField, propertyActivityField, publicActivityField, type PropertyDef } from "./work-item-properties";
import { ActionError, requireWorkspaceRole } from "./members";
import { enqueueNotification } from "./notifications";
import { accessibleProjects, requireProjectAccess } from "./projects";
import { disabledAgentUserIds } from "./agent-access";
import { loadWakingRuns, queueRunsForAssignees, wakeOutcomeOutput, wakerOf, type WakeOutcome } from "./runs";
import { fireEventTriggers, fireSubItemsClosed } from "./triggers";
import { emitOutboundEvent, workItemSnapshot } from "./outbound-webhooks";
import { builtinViewKinds } from "./builtin-views";
import { listableWorkItem } from "./listable";
import { compileFilterQuery, filterQueryLimits, filterQuerySyntaxHelp, weftFilterQueryRegistry } from "./filter-query";
import { richTextMarkdown } from "./rich-markdown";
import { PAGE_MARKDOWN_BUDGET, prepareRichTextGuarded, readWrittenFormOf, storedDocumentOf, storedDocumentsWithWarnings } from "./written-form-pool";
import { markdownToDoc, resolverFromReferences, storedMarkdownToDoc, type MarkdownOptions, type ResolvedReference, WRITTEN_FORM_MAX_INPUT_LENGTH } from "./markdown-doc";
import { existingStableReferences, setOutlinksFromDocument, syncLegacyPageLinks } from "./outlinks";
import { validateRichTextAssets } from "./rich-text-validation";
import { makeUnavailableReferencesPlainText } from "./outlinks";
import { requireWikiPageAccess } from "./wiki";
import { currentAgentProjectScope } from "./agent-project-scope";

export const stateGroups = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
export type StateGroup = (typeof stateGroups)[number];
export const descriptionVersionIntervalMs = 5 * 60_000;
const workItemNotFound = () => currentAgentProjectScope() ? "Not found" : "Work item not found";
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
  description: Type.Optional(Type.Any({ description: "The parsed editor document. Present when one work item is read or written; list results omit it and carry descriptionMarkdown and descriptionText instead." })), descriptionText: Type.String(), descriptionMarkdown: Type.String(), descriptionMarkdownWarnings: Type.Array(Type.String()), descriptionMarkdownWarningDetails: Type.Array(Type.Object({ code: Type.String(), message: Type.String() })), stateId: Type.String(), priority: prioritySchema, estimatePointId: Type.Union([Type.String(), Type.Null()]),
  sortOrder: Type.Number(), createdBy: Type.String(), createdAt: Type.String(), updatedAt: Type.String(), archivedAt: Type.Union([Type.String(), Type.Null()]), completedAt: Type.Union([Type.String(), Type.Null()]),
  assigneeIds: Type.Array(Type.String()), labelIds: Type.Array(Type.String()), parentId: Type.Union([Type.String(), Type.Null()]),
  startDate: Type.Union([Type.String(), Type.Null()]), dueDate: Type.Union([Type.String(), Type.Null()]),
  /** The Work item type (every work item has one; a project starts with Task). */
  typeId: Type.String(),
  /** Custom property values of the work item: only the properties of its type that have a value. */
  properties: Type.Array(Type.Object({ propertyId: Type.String(), value: Type.Any() })),
});
const propertyValueInput = Type.Object({ propertyId: uuid(), value: Type.Any({ description: "The value for the property's kind: text, a number, YYYY-MM-DD, true or false, a web address, an option id or label, a list of them (multi-select), or a member's user id (person). null clears it." }) });
/** Type and property fields of create and update. Changing type drops the values of properties the new type lacks only when dropPropertyValues is true. */
const typeFieldInput = {
  typeId: Type.Optional(uuid()),
  properties: Type.Optional(Type.Array(propertyValueInput, { maxItems: 100 })),
  dropPropertyValues: Type.Optional(Type.Boolean({ description: "true confirms dropping the values of properties that the new type does not have. Without it a type change that would drop values is refused." })),
};
type TypeInput = { typeId?: string; properties?: Array<{ propertyId: string; value: unknown }>; dropPropertyValues?: boolean };
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
  /** Only the work items of these Work item types. */
  typeIds: Type.Optional(Type.Array(uuid())),
  /** Only the work items of this Cycle (it must belong to the project). */
  cycleId: Type.Optional(uuid()),
  /** Only the work items of this Module (it must belong to the project and not be deleted). */
  moduleId: Type.Optional(uuid()),
  sort: Type.Optional(Type.Union(sortFields.map((field) => Type.Literal(field)))), direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  /** A Weft filter query; it ANDs with the other filters and its ORDER BY replaces sort. */
  query: Type.Optional(Type.String({ maxLength: filterQueryLimits.maxLength, description: filterQuerySyntaxHelp })),
  /** true lists only archived work items; the default lists only work items that are not archived. */
  archived: Type.Optional(Type.Boolean({ description: "true lists only archived work items; the default lists only work items that are not archived" })),
};
type ListInput = { projectId: string; stateIds?: string[]; priorities?: Priority[]; assigneeIds?: string[]; labelIds?: string[]; typeIds?: string[]; cycleId?: string; moduleId?: string; sort?: (typeof sortFields)[number]; direction?: "asc" | "desc"; query?: string; archived?: boolean };
const workspaceListInput = {
  workspaceId: uuid(),
  /** One of Plane's built-in views: all, assigned to me, created by me, subscribed (created by, assigned to, or commented on by me). */
  builtin: Type.Optional(Type.Union(builtinViewKinds.map((kind) => Type.Literal(kind)))),
  sort: Type.Optional(Type.Union(sortFields.map((field) => Type.Literal(field)))), direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  /** A Weft filter query, compiled in each project (names such as states and labels are per project); a project where it does not apply contributes nothing. */
  query: Type.Optional(Type.String({ maxLength: filterQueryLimits.maxLength, description: filterQuerySyntaxHelp })),
};
type WorkspaceListInput = { workspaceId: string; builtin?: (typeof builtinViewKinds)[number]; sort?: (typeof sortFields)[number]; direction?: "asc" | "desc"; query?: string };
/** Distance between neighbours: new work items append 65536 apart, so a midpoint split has ~40 halvings before the gap collapses. */
const sortGap = 65536;
/** A property value as a timeline reads it: the option label, the member's name, or the labels of a list joined by commas. */
export function readablePropertyValue(property: PropertyDef, value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (!hasValue(value)) return null;
  const labelOf = (id: unknown) => property.options.find((option) => option.id === id)?.label;
  if (property.kind === "dropdown") return labelOf(value) ?? null;
  if (property.kind === "multi_select") return (Array.isArray(value) ? value : []).flatMap((id) => { const label = labelOf(id); return label ? [label] : []; }).join(", ") || null;
  if (property.kind === "person") return typeof value === "string" ? names.get(value) ?? null : null;
  return value;
}

const activityOutput = Type.Object({
  id: Type.String(), field: Type.String(), oldValue: Type.Any(), newValue: Type.Any(), actorId: Type.String(), actorName: Type.String(), actorIsAgent: Type.Boolean(), actorCodeCapable: Type.Boolean(),
  source: Type.String(), chatId: Type.Union([Type.String(), Type.Null()]),
  /** Set on a change made by an Agent: its Run, and the person whose permissions it used. */
  runId: Type.Union([Type.String(), Type.Null()]), originatorId: Type.Union([Type.String(), Type.Null()]), originatorName: Type.Union([Type.String(), Type.Null()]),
  /** Set on every Activity of one Bulk edit. */
  bulkEditId: Type.Union([Type.String(), Type.Null()]),
  /** Set on a run_started entry of a Run a wake started: the Agent's Run that woke it and its depth. `runId` is null when the viewer may not open that Run. */
  wokenBy: Type.Union([Type.Object({ runId: Type.Union([Type.String(), Type.Null()]), agentName: Type.String(), depth: Type.Integer() }), Type.Null()]),
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
  const { type, text, attrs, content } = node as { type?: string; text?: string; attrs?: { label?: unknown }; content?: unknown[] };
  if (typeof text === "string") return text;
  if (type === "mention") return typeof attrs?.label === "string" ? attrs.label : "";
  const parts = (content ?? []).map(plainText);
  return type === "doc" ? parts.filter(Boolean).join("\n") : parts.join("");
}

function descriptionPlainText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const { type, text, content, attrs } = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
  if (typeof text === "string") return text;
  if (type === "mention") return String(attrs?.label ?? attrs?.name ?? attrs?.id ?? "");
  const parts = (content ?? []).map(descriptionPlainText);
  return type === "doc" ? parts.filter(Boolean).join("\n") : parts.join("");
}

export async function writtenDescription(document: unknown, markdown?: string, options: MarkdownOptions = {}) {
  const prepared = await prepareRichTextGuarded(document, markdown, "description", "descriptionMarkdown", options, "verbatim");
  return { ...prepared, text: descriptionPlainText(prepared.document) };
}

/** Visible Work item keys include each current Project key and its retained old-key aliases. */
export async function workItemMarkdownOptions(database: Database, userId: string, workspaceId: string, currentProjectId?: string, markdown = ""): Promise<MarkdownOptions> {
  const visible = await accessibleProjects(database, userId, workspaceId);
  const projectIds = [...new Set([...visible.map(({ id }) => id), ...(currentProjectId ? [currentProjectId] : [])])];
  const bracketReferences = [...markdown.matchAll(/(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)].flatMap(([, label, identity]) => {
    const stable = /^(?:work-item|page|wiki):[0-9a-f-]{36}$/i.test(identity?.trim() ?? "");
    return stable ? [] : [(label ?? "").trim()].filter(Boolean);
  });
  const plainReferenceText = markdown.replace(/(?<!!)\[\[[^\]|]+\|(?:work-item|page|wiki):[0-9a-f-]{36}\]\]/gi, "");
  const bareKeys = [...plainReferenceText.matchAll(/(?<![A-Z0-9_])([A-Z][A-Z0-9]{1,11}-\d+)(?![A-Z0-9_-])/g)].map((match) => match[1]!);
  const mentioned = [...new Set([...bracketReferences, ...bareKeys])];
  const keyReferences = mentioned.flatMap((label) => {
    const match = /^([A-Za-z][A-Za-z0-9]{1,11})-(\d+)$/.exec(label);
    return match ? [{ label, key: match[1]!.toUpperCase(), sequence: Number(match[2]) }] : [];
  });
  const titleReferences = mentioned.filter((label) => !/^([A-Za-z][A-Za-z0-9]{1,11})-(\d+)$/.test(label));
  const keyPrefixes = [...new Set(keyReferences.map(({ key }) => key))];
  const aliases = projectIds.length && keyPrefixes.length ? await database.select({ projectId: projectKeyAliases.projectId, key: projectKeyAliases.key }).from(projectKeyAliases)
    .where(and(inArray(projectKeyAliases.projectId, projectIds), inArray(projectKeyAliases.key, keyPrefixes))) : [];
  const projectIdsByKey = new Map<string, string[]>();
  for (const project of visible) projectIdsByKey.set(project.key.toLocaleUpperCase(), [...(projectIdsByKey.get(project.key.toLocaleUpperCase()) ?? []), project.id]);
  if (currentProjectId && !visible.some(({ id }) => id === currentProjectId)) {
    const [current] = await database.select({ id: projects.id, key: projects.key }).from(projects).where(and(eq(projects.id, currentProjectId), eq(projects.workspaceId, workspaceId)));
    if (current) projectIdsByKey.set(current.key.toLocaleUpperCase(), [...(projectIdsByKey.get(current.key.toLocaleUpperCase()) ?? []), current.id]);
  }
  for (const alias of aliases) projectIdsByKey.set(alias.key.toLocaleUpperCase(), [...(projectIdsByKey.get(alias.key.toLocaleUpperCase()) ?? []), alias.projectId]);
  const keyClauses = keyReferences.flatMap((reference) => {
    const ids = [...new Set(projectIdsByKey.get(reference.key) ?? [])];
    return ids.length ? [and(eq(workItems.sequence, reference.sequence), inArray(workItems.projectId, ids))] : [];
  });
  const titleClause = titleReferences.length ? inArray(sql`lower(${workItems.title})`, titleReferences.map((title) => title.toLocaleLowerCase())) : undefined;
  const matchingClause = [...keyClauses, ...(titleClause ? [titleClause] : [])];
  const items = projectIds.length && matchingClause.length ? await database.select({ id: workItems.id, sequence: workItems.sequence, title: workItems.title, projectId: projects.id, key: projects.key })
    .from(workItems).innerJoin(projects, eq(projects.id, workItems.projectId)).where(and(inArray(workItems.projectId, projectIds), isNull(workItems.deletedAt), or(...matchingClause))) : [];
  const keysByProject = new Map<string, string[]>();
  for (const alias of aliases) keysByProject.set(alias.projectId, [...(keysByProject.get(alias.projectId) ?? []), alias.key]);
  const references: ResolvedReference[] = items.flatMap((item) => mentioned.filter((label) => {
    const key = /^([A-Za-z][A-Za-z0-9]{1,11})-(\d+)$/.exec(label);
    if (!key) return label.toLocaleLowerCase() === item.title.toLocaleLowerCase();
    return Number(key[2]) === item.sequence && [item.key, ...(keysByProject.get(item.projectId) ?? [])].some((candidate) => candidate.toLocaleUpperCase() === key[1]!.toUpperCase());
  }).map((label) => ({ kind: "work-item" as const, id: item.id, label })));
  const stable = [...markdown.matchAll(/\[\[([^\]|]+)\|(work-item|page|wiki):([0-9a-f-]{36})\]\]/gi)];
  const stableItems = stable.filter((match) => match[2]!.toLowerCase() === "work-item");
  if (stableItems.length && projectIds.length) {
    const rows = await database.select({ id: workItems.id }).from(workItems)
      .where(and(inArray(workItems.id, [...new Set(stableItems.map((match) => match[3]!))]), inArray(workItems.projectId, projectIds), isNull(workItems.deletedAt)));
    for (const match of stableItems) if (rows.some((row) => row.id === match[3])) references.push({ kind: "work-item", id: match[3]!, label: match[1]!.trim() });
  }
  for (const match of stable.filter((entry) => ["page", "wiki"].includes(entry[2]!.toLowerCase()))) {
    try {
      const page = await requireWikiPageAccess(database, userId, match[3]!, "read");
      const kind = page.projectId ? "page" : "wiki";
      if (kind === match[2]!.toLowerCase()) references.push({ kind, id: page.id, label: match[1]!.trim() });
    } catch (error) { if (!(error instanceof ActionError) || ![403, 404].includes(error.status)) throw error; }
  }
  const uniqueReferences = [...new Map(references.map((reference) => [`${reference.kind}:${reference.id}:${reference.label.toLocaleLowerCase()}`, reference])).values()];
  return { resolveReference: resolverFromReferences(uniqueReferences), references: uniqueReferences };
}

function stateOut(state: StateRow) {
  return { id: state.id, projectId: state.projectId, name: state.name, group: state.group as StateGroup, sortOrder: state.sortOrder };
}

type Relations = { assigneeIds: string[]; labelIds: string[]; properties?: Array<{ propertyId: string; value: unknown }> };

function itemOut(item: ItemRow, key: string, relations: Relations = { assigneeIds: [], labelIds: [] }, markdownOptions: MarkdownOptions = {}, warnings: string[] = [], warningDetails: Array<{ code: string; message: string }> = [], listRow = false, parsed?: ReturnType<typeof storedMarkdownToDoc>) {
  // A row the backfill has not converted yet has no stored Markdown: it gets the escaped plain-text form, a linear serialise with no parse-back (measured 12 ms for 197 KB), never the verified form that parses.
  const markdown = item.descriptionMarkdown ?? plainTextWrittenForm(item.description ?? null);
  // A list row carries descriptionText and descriptionMarkdown only: parsing every description would make a list cost as much as reading every item. The parsed document comes from get_work_item.
  const document = listRow ? null : parsed ?? null;
  return {
    ...relations, properties: relations.properties ?? [], typeId: item.typeId ?? "", parentId: item.parentId, startDate: item.startDate, dueDate: item.dueDate,
    id: item.id, projectId: item.projectId, sequence: item.sequence, displayId: `${key}-${item.sequence}`, title: item.title,
    // List rows omit `description` (the parsed document): read one item for it. They carry descriptionText and descriptionMarkdown.
    ...(listRow ? {} : { description: document }), descriptionText: item.descriptionText,
    descriptionMarkdown: markdown, descriptionMarkdownWarnings: warnings, descriptionMarkdownWarningDetails: warningDetails,
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

  /** Shared implementation for the legacy array Action and the Workspace View metadata Action. */
  async function listWorkspaceWorkItems(context: Context, input: WorkspaceListInput) {
    const accessible = (await accessibleProjects(db, context.userId, input.workspaceId)).filter((project) => !project.archivedAt);
    if (accessible.length === 0) return { items: [], truncated: false };
    const markdownOptions = await workItemMarkdownOptions(db, context.userId, input.workspaceId);
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
          const compiled = await compileFilterQuery(db, { workspaceId: input.workspaceId, projectId: project.id, projectKey: project.key, userId: me }, input.query, { registry: weftFilterQueryRegistry });
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
    const rows = await db.select().from(workItems).where(and(...conditions)).orderBy(...order, asc(workItems.projectId), asc(workItems.sequence)).limit(2001);
    const relations = await relationsOf(db, rows.map((row) => row.id));
    const byProject = new Map(accessible.map((project) => [project.id, project]));
    const truncated = rows.length > 2000;
    return {
      items: rows.slice(0, 2000).map((row) => ({ ...itemOut(row, byProject.get(row.projectId)!.key, relations.get(row.id), markdownOptions, [], [], true), projectKey: byProject.get(row.projectId)!.key, projectName: byProject.get(row.projectId)!.name })),
      truncated,
    };
  }

  async function relationsOf(database: Database, itemIds: string[]) {
    const result = new Map<string, Relations>(itemIds.map((id) => [id, { assigneeIds: [], labelIds: [], properties: [] }]));
    if (itemIds.length === 0) return result;
    for (const [id, values] of await loadPropertyValues(database, itemIds)) result.get(id)!.properties = values;
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

  async function hydrate(database: Database, rows: ItemRow[], key: string, markdownOptions: MarkdownOptions = {}, listRows = false) {
    const relations = await relationsOf(database, rows.map((row) => row.id));
    // A large or slow-shaped description is parsed on a worker, one row at a time, so a read cannot stall the event loop or fill the queue.
    const documents = new Map<string, ReturnType<typeof storedMarkdownToDoc>>();
    if (!listRows) {
      // A row carries its prepared document (written with the Markdown); only a row without one (a degraded backfill row, or one written before the cache) is parsed, once, in a batch.
      // A row with no stored document serves its legacy document while it has one (a degraded or too-large backfill row, until its first edit); only then is its Markdown parsed.
      for (const row of rows) {
        const stored = row.descriptionDoc ?? row.description;
        if (stored && typeof stored === "object" && (stored as { type?: unknown }).type === "doc") documents.set(row.id, stored as ReturnType<typeof storedMarkdownToDoc>);
      }
      const withMarkdown = rows.filter((row) => row.descriptionMarkdown && !documents.has(row.id));
      const parsed = await storedDocumentsWithWarnings(withMarkdown.map((row) => ({ markdown: row.descriptionMarkdown!, options: { ...markdownOptions, preserveUnresolvedReferences: true, preserveStableReferences: true } })));
      withMarkdown.forEach((row, index) => documents.set(row.id, parsed[index]!.document as ReturnType<typeof storedMarkdownToDoc>));
    }
    return rows.map((row) => itemOut(row, key, relations.get(row.id), markdownOptions, [], [], listRows, documents.get(row.id)));
  }

  /** Validates and applies assignees, labels and parent, returning the Activity entries for what changed. */
  async function applyRelations(database: Database, context: Context, project: { id: string; workspaceId: string }, item: ItemRow, current: Relations, input: FieldInput) {
    const entries: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    const column: Partial<typeof workItems.$inferInsert> = {};
    let wakeOutcomes: WakeOutcome[] = [];
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
        // An Agent's change wakes another Agent only when its Run's Agent has the Can wake Agents switch on; the decision reports that per Agent (ADR 0013).
        wakeOutcomes = await queueRunsForAssignees(database, { originatorId: context.userId, waker: wakerOf(context.source), wakingRunId: context.agent?.runId ?? null, project, workItemId: item.id, assigneeUserIds: added });
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
    return { entries, column, wakeOutcomes };
  }

  /** Member user ids of the project, loaded once when a person-kind value needs checking. */
  async function memberIdsOf(database: Database, projectId: string) {
    const rows = await database.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, projectId));
    return new Set(rows.map((row) => row.userId));
  }

  /**
   * Works out the type change and the property values of one create or update, without writing. Refuses a type change that would drop
   * values unless `dropPropertyValues` confirms it, fills defaults of a new type, and checks required properties of the resulting type.
   */
  async function planTypeAndProperties(database: Database, project: { id: string; workspaceId: string; typesEnabled: boolean }, item: ItemRow, input: TypeInput, creating = false) {
    const touches = input.typeId !== undefined || input.properties !== undefined || input.dropPropertyValues !== undefined;
    const empty = { typeChange: null, propertyChanges: [] as Array<{ propertyId: string; name: string; oldValue: unknown; newValue: unknown }>, writes: [] as Array<{ propertyId: string; value: unknown }> };
    if (!project.typesEnabled) {
      if (touches) throw new ActionError(featureOffMessage("types"), 400);
      return empty;
    }
    if (!touches && !creating) return empty;
    const currentType = item.typeId ? await loadTypeRow(database, project.id, item.typeId) : await defaultTypeOf(database, project);
    // A new work item starts with its type's defaults, so it counts as a type change to fill them; there is no earlier value to drop.
    const typeChanged = creating || (input.typeId !== undefined && input.typeId !== currentType.id);
    const nextType = input.typeId !== undefined ? await loadTypeRow(database, project.id, input.typeId) : currentType;
    const allProperties = await loadProperties(database, project.id);
    const byId = new Map<string, PropertyDef>(allProperties.map((property) => [property.id, property]));
    const nextProperties = await loadProperties(database, project.id, nextType.id);
    const nextIds = new Set(nextProperties.map((property) => property.id));
    const before = new Map((await loadPropertyValues(database, [item.id])).get(item.id)!.map((entry) => [entry.propertyId, entry.value]));
    const values = new Map<string, unknown>(before);
    if (typeChanged) {
      const dropped = [...before.keys()].filter((id) => !nextIds.has(id));
      if (dropped.length > 0 && input.dropPropertyValues !== true) {
        const names = dropped.map((id) => byId.get(id)?.name ?? "a property");
        throw new ActionError(`Changing the type to ${nextType.name} drops the values of: ${names.join(", ")}. Confirm the change to drop them.`, 409);
      }
      for (const id of dropped) values.delete(id);
    }
    const explicit = new Set<string>();
    if (input.properties !== undefined && input.properties.length > 0) {
      const members = input.properties.some((entry) => byId.get(entry.propertyId)?.kind === "person") ? await memberIdsOf(database, project.id) : new Set<string>();
      for (const entry of input.properties) {
        const property = nextProperties.find((candidate) => candidate.id === entry.propertyId);
        if (!property) {
          const other = byId.get(entry.propertyId);
          if (other) throw new ActionError(`${other.name} does not belong to ${nextType.name}. Pick a type it belongs to, or leave it out.`, 400);
          throw new ActionError("Custom property not found in this project", 400);
        }
        if (explicit.has(property.id)) throw new ActionError(`${property.name} is listed twice`, 400);
        explicit.add(property.id);
        values.set(property.id, coerceValue(property, entry.value, members) ?? null);
      }
    }
    if (typeChanged) {
      for (const property of nextProperties) {
        if (!explicit.has(property.id) && !hasValue(values.get(property.id)) && property.defaultValue !== null && property.defaultValue !== undefined) values.set(property.id, property.defaultValue);
      }
    }
    if (typeChanged || input.properties !== undefined) assertRequiredFilled(nextType, nextProperties, values);
    const propertyChanges: Array<{ propertyId: string; name: string; oldValue: unknown; newValue: unknown }> = [];
    const writes: Array<{ propertyId: string; value: unknown }> = [];
    for (const id of new Set([...before.keys(), ...values.keys()])) {
      const oldValue = before.get(id) ?? null;
      const newValue = hasValue(values.get(id)) ? values.get(id)! : null;
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      propertyChanges.push({ propertyId: id, name: byId.get(id)?.name ?? "Property", oldValue, newValue });
      writes.push({ propertyId: id, value: newValue });
    }
    return { typeChange: typeChanged && !creating && nextType.id !== currentType.id ? { typeId: nextType.id, oldName: currentType.name, newName: nextType.name } : null, propertyChanges, writes };
  }

  /** Writes the property values planned by planTypeAndProperties: a null value removes the row. */
  async function writePropertyValues(database: Database, workItemId: string, writes: Array<{ propertyId: string; value: unknown }>) {
    for (const write of writes) {
      if (write.value === null) {
        await database.delete(workItemPropertyValues).where(and(eq(workItemPropertyValues.workItemId, workItemId), eq(workItemPropertyValues.propertyId, write.propertyId)));
      } else {
        await database.insert(workItemPropertyValues).values({ workItemId, propertyId: write.propertyId, value: write.value })
          .onConflictDoUpdate({ target: [workItemPropertyValues.workItemId, workItemPropertyValues.propertyId], set: { value: write.value } });
      }
    }
  }

  type BulkUpdateInput = { projectId: string; workItemIds: string[]; stateId?: string; priority?: Priority; estimatePointId?: string | null; startDate?: string | null; dueDate?: string | null; addAssigneeIds?: string[]; removeAssigneeIds?: string[]; addLabelIds?: string[]; removeLabelIds?: string[] };
  type UpdateInput = { title?: string; description?: unknown; descriptionMarkdown?: string; stateId?: string; priority?: Priority } & FieldInput & TypeInput;

  /** Applies one update to a work item inside the caller's transaction: validation, Activities, Triggers. `bulkEditId` links the Activities of one Bulk edit. */
  async function applyItemUpdate(database: Database, context: Context, project: { id: string; workspaceId: string; key: string; typesEnabled: boolean }, existing: ItemRow, input: UpdateInput, bulkEditId?: string) {
    // Lock order is Estimate before work item, the same as switching or deleting an Estimate, so the two cannot deadlock.
    if (input.estimatePointId) await database.select({ id: estimates.id }).from(estimates).where(eq(estimates.projectId, project.id)).for("share");
    const [item] = await database.select().from(workItems).where(and(eq(workItems.id, existing.id), liveWorkItems)).for("update");
    if (!item) throw new ActionError("Work item not found", 404);
    assertNotArchived(item);
    if (input.stateId) await stateOfProject(database, project.id, input.stateId);
    const markdownOptions = await workItemMarkdownOptions(database, context.userId, project.workspaceId, project.id, input.descriptionMarkdown);
    let descriptionWarnings: string[] = [];
    let descriptionDocument: unknown;
    let descriptionWarningDetails: Array<{ code: string; message: string }> = [];
    const changes: Array<{ field: string; column: Partial<typeof workItems.$inferInsert>; oldValue: unknown; newValue: unknown }> = [];
    if (input.title !== undefined && input.title !== item.title) changes.push({ field: "title", column: { title: input.title }, oldValue: item.title, newValue: input.title });
    if (input.stateId !== undefined && input.stateId !== item.stateId) changes.push({ field: "state", column: { stateId: input.stateId }, oldValue: item.stateId, newValue: input.stateId });
    if (input.priority !== undefined && input.priority !== item.priority) changes.push({ field: "priority", column: { priority: input.priority }, oldValue: item.priority, newValue: input.priority });
    if (input.description !== undefined && JSON.stringify(input.description) !== JSON.stringify(item.descriptionDoc ?? item.description) || input.descriptionMarkdown !== undefined && input.descriptionMarkdown !== (item.descriptionMarkdown ?? await writtenFormOf(item.description))) {
      const description = await writtenDescription(input.description, input.descriptionMarkdown, { ...markdownOptions, existingStableReferences: await existingStableReferences(database, "work-item", item.id, "body", item.descriptionMarkdown) });
      await validateRichTextAssets(database, description.document, "work_item", item.id, context.userId);
      descriptionWarnings = description.warnings;
      descriptionDocument = description.document;
      descriptionWarningDetails = description.warningDetails;
      const [latestVersion] = await database.select({ createdAt: workItemDescriptionVersions.createdAt }).from(workItemDescriptionVersions)
        .where(eq(workItemDescriptionVersions.workItemId, item.id)).orderBy(desc(workItemDescriptionVersions.createdAt), desc(workItemDescriptionVersions.id)).limit(1);
      if (item.descriptionText && (!latestVersion || Date.now() - latestVersion.createdAt.getTime() >= descriptionVersionIntervalMs)) {
        await database.insert(workItemDescriptionVersions).values({ workItemId: item.id, contentMarkdown: item.descriptionMarkdown ?? await writtenFormOf(item.description), contentText: item.descriptionText, createdBy: context.userId });
      }
      changes.push({ field: "description", column: { descriptionMarkdown: description.markdown, descriptionDoc: description.document, descriptionText: description.text }, oldValue: item.descriptionMarkdown ?? await writtenFormOf(item.description), newValue: description.markdown });
    }
    if (input.estimatePointId !== undefined && input.estimatePointId !== item.estimatePointId) {
      const newValue = input.estimatePointId ? await estimateValueOf(database, project.id, input.estimatePointId) : null;
      if (!input.estimatePointId) {
        const [own] = await database.select({ enabled: estimates.enabled }).from(estimates).where(eq(estimates.projectId, project.id));
        if (own && !own.enabled) throw new ActionError("The Estimate is turned off", 400);
      }
      changes.push({ field: "estimate", column: { estimatePointId: input.estimatePointId }, oldValue: await estimateValueOrNull(database, item.estimatePointId), newValue });
    }
    const typed = await planTypeAndProperties(database, project, item, input);
    if (typed.typeChange) changes.push({ field: "type", column: { typeId: typed.typeChange.typeId }, oldValue: typed.typeChange.oldName, newValue: typed.typeChange.newName });
    if (input.startDate !== undefined && input.startDate !== item.startDate) changes.push({ field: "startDate", column: { startDate: input.startDate }, oldValue: item.startDate, newValue: input.startDate });
    if (input.dueDate !== undefined && input.dueDate !== item.dueDate) changes.push({ field: "dueDate", column: { dueDate: input.dueDate }, oldValue: item.dueDate, newValue: input.dueDate });
    assertDateOrder(input.startDate !== undefined ? input.startDate : item.startDate, input.dueDate !== undefined ? input.dueDate : item.dueDate);
    const current = (await relationsOf(database, [item.id])).get(item.id)!;
    const applied = await applyRelations(database, context, project, item, current, input);
    const entries = [
      ...changes.map(({ field, oldValue, newValue }) => ({ field, oldValue, newValue })), ...applied.entries,
      ...typed.propertyChanges.map((change) => ({ field: propertyActivityField(change.propertyId, change.name), oldValue: change.oldValue, newValue: change.newValue })),
    ];
    if (entries.length === 0) return { ...(await hydrate(database, [item], project.key, markdownOptions))[0]!, descriptionMarkdownWarnings: descriptionWarnings, descriptionMarkdownWarningDetails: descriptionWarningDetails, wakeOutcomes: applied.wakeOutcomes };
    const [updated] = await database.update(workItems).set({ ...Object.assign({}, ...changes.map((change) => change.column), applied.column), updatedAt: new Date() }).where(eq(workItems.id, item.id)).returning();
    if (descriptionDocument !== undefined) await setOutlinksFromDocument(database, "work-item", item.id, "body", descriptionDocument);
    await writePropertyValues(database, item.id, typed.writes);
    // An Agent's change fires Triggers through the wake decision (ADR 0013); only an AI Autopilot change with no Agent behind it does not.
    if (context.source !== "ai_autopilot") {
      await fireEventTriggers(database, { eventType: "work_item_updated", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null });
      if (changes.some((change) => change.field === "state")) await fireEventTriggers(database, { eventType: "state_changed", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null });
      const stateChange = changes.find((change) => change.field === "state");
      if (stateChange) await fireSubItemsClosed(database, { workItemId: item.id, previousStateId: stateChange.oldValue as string, projectId: project.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null });
      if (entries.some((entry) => entry.field === "assignees")) await fireEventTriggers(database, { eventType: "assignee_changed", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null });
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
    await emitOutboundEvent(database, { workspaceId: project.workspaceId, projectId: project.id, type: "work_item.updated", build: async (database) => ({ workItem: await workItemSnapshot(database, item.id), changedFields: entries.map((entry) => publicActivityField(entry.field)) }) });
    return { ...(await hydrate(database, [updated!], project.key, markdownOptions))[0]!, descriptionMarkdownWarnings: descriptionWarnings, descriptionMarkdownWarningDetails: descriptionWarningDetails, wakeOutcomes: applied.wakeOutcomes };
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
        ...projectInput, title: Type.String({ minLength: 1, maxLength: 500 }), descriptionMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH, description: "Markdown work item description, for example ## Plan followed by - First step. Use instead of description." })), description: Type.Optional(Type.Any()),
        stateId: Type.Optional(uuid()), priority: Type.Optional(prioritySchema), ...fieldInput, ...typeFieldInput,
      }),
      output: Type.Intersect([workItemOutput, Type.Object({ wakeOutcomes: Type.Array(wakeOutcomeOutput) })]),
      handler: async (context: Context, input: { projectId: string; title: string; description?: unknown; descriptionMarkdown?: string; stateId?: string; priority?: Priority } & FieldInput & TypeInput) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        const markdownOptions = await workItemMarkdownOptions(db, context.userId, project.workspaceId, project.id, input.descriptionMarkdown);
        const description = input.description !== undefined || input.descriptionMarkdown !== undefined ? await writtenDescription(input.description, input.descriptionMarkdown, markdownOptions) : { document: undefined, markdown: "", text: "", warnings: [], warningDetails: [] };
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const state = input.stateId ? await stateOfProject(database, project.id, input.stateId) : (await orderedStates(database, project.id))[0];
          if (!state) throw new ActionError("Project has no states", 400);
          // The row lock taken by this UPDATE serialises creators per project, and the counter rolls back with the transaction: no gaps.
          const [counter] = await database.update(projects).set({ workItemSequence: sql`${projects.workItemSequence} + 1` }).where(eq(projects.id, project.id)).returning({ sequence: projects.workItemSequence, key: projects.key });
          const [{ value }] = await database.select({ value: max(workItems.sortOrder) }).from(workItems).where(eq(workItems.projectId, project.id));
          if (input.estimatePointId) await estimateValueOf(database, project.id, input.estimatePointId);
          const type = project.typesEnabled && input.typeId ? await loadTypeRow(database, project.id, input.typeId) : await defaultTypeOf(database, project);
          const [item] = await database.insert(workItems).values({
            workspaceId: project.workspaceId, projectId: project.id, sequence: counter!.sequence, title: input.title, estimatePointId: input.estimatePointId ?? null, typeId: type.id,
            descriptionMarkdown: description.markdown, descriptionDoc: description.document, descriptionText: description.text, stateId: state.id,
            priority: input.priority ?? "none", sortOrder: (value ?? 0) + 65536, createdBy: context.userId,
            startDate: input.startDate ?? null, dueDate: input.dueDate ?? null,
          }).returning();
          await validateRichTextAssets(database, description.document, "work_item", item!.id, context.userId);
          assertDateOrder(input.startDate ?? null, input.dueDate ?? null);
          const typed = await planTypeAndProperties(database, project, item!, input, true);
          await writePropertyValues(database, item!.id, typed.writes);
          const applied = await applyRelations(database, context, project, item!, { assigneeIds: [], labelIds: [] }, { ...input, parentId: input.parentId ?? undefined });
          applied.entries.push(...typed.propertyChanges.map((change) => ({ field: propertyActivityField(change.propertyId, change.name), oldValue: change.oldValue, newValue: change.newValue })));
          const created = Object.keys(applied.column).length > 0 ? (await database.update(workItems).set(applied.column).where(eq(workItems.id, item!.id)).returning())[0]! : item!;
          await setOutlinksFromDocument(database, "work-item", created.id, "body", description.document);
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item!.id, field: "created", newValue: input.title });
          await fireEventTriggers(database, { eventType: "work_item_created", projectId: project.id, workItemId: item!.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null });
          const dateEntries = [["startDate", input.startDate], ["dueDate", input.dueDate], ["estimate", input.estimatePointId ? await estimateValueOf(database, project.id, input.estimatePointId) : null]].filter(([, value]) => value) as Array<[string, string]>;
          for (const [field, value] of dateEntries) applied.entries.push({ field, oldValue: null, newValue: value });
          for (const entry of applied.entries) await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item!.id, ...entry });
          await emitOutboundEvent(database, { workspaceId: project.workspaceId, projectId: project.id, type: "work_item.created", build: async (database) => ({ workItem: await workItemSnapshot(database, item!.id) }) });
          return { ...(await hydrate(database, [created], counter!.key, markdownOptions))[0]!, descriptionMarkdownWarnings: description.warnings, descriptionMarkdownWarningDetails: description.warningDetails, wakeOutcomes: applied.wakeOutcomes };
        });
      },
    },
    listWorkItems: {
      name: "list_work_items", kind: "read" as const,
      input: Type.Object(listInput), output: Type.Array(workItemOutput),
      handler: async (context: Context, input: ListInput) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        const markdownOptions = await workItemMarkdownOptions(db, context.userId, project.workspaceId, project.id);
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
        if (input.typeIds?.length) conditions.push(inArray(workItems.typeId, input.typeIds));
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
          const compiled = await compileFilterQuery(db, { workspaceId: project.workspaceId, projectId: project.id, projectKey: project.key, userId: context.userId }, source, { registry: weftFilterQueryRegistry });
          if (compiled.where) conditions.push(compiled.where);
          const rows = await db.select().from(workItems).where(and(...conditions))
            .orderBy(...(compiled.orderBy.length ? compiled.orderBy : order), asc(workItems.sequence)).limit(compiled.limit);
          return hydrate(db, rows, project.key, markdownOptions, true);
        }
        const rows = await db.select().from(workItems).where(and(...conditions)).orderBy(...order, direction(workItems.sequence));
        return hydrate(db, rows, project.key, markdownOptions, true);
      },
    },
    /** Work items across every project the caller can access in the workspace; a private project the caller is not in never contributes a row. */
    listWorkspaceWorkItems: {
      name: "list_workspace_work_items", kind: "read" as const,
      input: Type.Object(workspaceListInput), output: Type.Array(Type.Intersect([workItemOutput, Type.Object({ projectKey: Type.String(), projectName: Type.String() })])),
      handler: async (context: Context, input: WorkspaceListInput) => (await listWorkspaceWorkItems(context, input)).items,
    },
    /** Additive Workspace View contract: same bounded results plus an explicit indication of additional matches. */
    listWorkspaceWorkItemsWithMetadata: {
      name: "list_workspace_work_items_with_metadata", kind: "read" as const,
      input: Type.Object(workspaceListInput), output: Type.Object({ items: Type.Array(Type.Intersect([workItemOutput, Type.Object({ projectKey: Type.String(), projectName: Type.String() })])), truncated: Type.Boolean() }),
      handler: async (context: Context, input: WorkspaceListInput) => listWorkspaceWorkItems(context, input),
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
            await fireEventTriggers(database, { eventType: "state_changed", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null });
            await fireSubItemsClosed(database, { workItemId: item.id, previousStateId: item.stateId, projectId: project.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null });
            await fireEventTriggers(database, { eventType: "work_item_updated", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null });
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: "state", oldValue: item.stateId, newValue: input.stateId });
            await emitOutboundEvent(database, { workspaceId: project.workspaceId, projectId: project.id, type: "work_item.updated", build: async (database) => ({ workItem: await workItemSnapshot(database, item.id), changedFields: ["state"] }) });
          }
          const markdownOptions = await workItemMarkdownOptions(database, context.userId, project.workspaceId, project.id);
          return (await hydrate(database, [updated!], project.key, markdownOptions))[0]!;
        });
      },
    },
    getWorkItem: {
      name: "get_work_item", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid(), displayId: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9]{1,11}-[0-9]+$" }) }), output: workItemOutput,
      handler: async (context: Context, input: { workspaceId: string; displayId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(input.displayId);
        if (!match) throw new ActionError(workItemNotFound(), 404);
        const key = match[1]!.toUpperCase();
        const sequence = Number(match[2]);
        let [project] = await db.select().from(projects).where(and(eq(projects.workspaceId, input.workspaceId), eq(projects.key, key)));
        if (!project) {
          const [alias] = await db.select({ projectId: projectKeyAliases.projectId }).from(projectKeyAliases).where(and(eq(projectKeyAliases.workspaceId, input.workspaceId), eq(projectKeyAliases.key, key)));
          if (alias) [project] = await db.select().from(projects).where(eq(projects.id, alias.projectId));
        }
        if (!project) throw new ActionError(workItemNotFound(), 404);
        await requireProjectAccess(db, context.userId, project.id, "read");
        const [item] = await db.select().from(workItems).where(and(eq(workItems.projectId, project.id), eq(workItems.sequence, sequence), liveWorkItems));
        if (!item) throw new ActionError(workItemNotFound(), 404);
        const markdownOptions = await workItemMarkdownOptions(db, context.userId, project.workspaceId, project.id, item.descriptionMarkdown ?? "");
        const result = (await hydrate(db, [item], project.key, markdownOptions))[0]!;
        const stored = result.description;
        result.description = await makeUnavailableReferencesPlainText(db, context.userId, result.description) as typeof result.description;
        // The stored Markdown is already the Written form: it is serialised again only when references the reader cannot open were rewritten, and then once, falling back to the stored text on a timeout.
        if (result.description && JSON.stringify(result.description) !== JSON.stringify(stored)) result.descriptionMarkdown = await readWrittenFormOf(result.description, result.descriptionMarkdown);
        result.descriptionText = descriptionPlainText(result.description);
        return result;
      },
    },
    updateWorkItem: {
      name: "update_work_item", kind: "write" as const,
      input: Type.Object({
        workItemId: uuid(), title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), descriptionMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH, description: "Markdown work item description, for example ## Plan followed by - First step. Use instead of description." })), description: Type.Optional(Type.Any()),
        stateId: Type.Optional(uuid()), priority: Type.Optional(prioritySchema), ...fieldInput, ...typeFieldInput,
      }),
      output: Type.Intersect([workItemOutput, Type.Object({ wakeOutcomes: Type.Array(wakeOutcomeOutput) })]),
      handler: async (context: Context, input: { workItemId: string; title?: string; description?: unknown; descriptionMarkdown?: string; stateId?: string; priority?: Priority } & FieldInput & TypeInput) => {
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
        const markdownOptions = await workItemMarkdownOptions(db, context.userId, project.workspaceId, project.id);
        const rows = await db.select().from(workItems).where(and(eq(workItems.parentId, parent.id), unarchivedWorkItems)).orderBy(asc(workItems.sortOrder), asc(workItems.sequence));
        return hydrate(db, rows, project.key, markdownOptions, true);
      },
    },
    listLabels: {
      name: "list_labels", kind: "read" as const,
      input: Type.Object(projectInput), output: Type.Array(labelOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "read");
        const rows = await db.select().from(labels).where(eq(labels.projectId, input.projectId)).orderBy(asc(labels.position), asc(labels.name));
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
          const [{ value }] = await database.select({ value: max(labels.position) }).from(labels).where(eq(labels.projectId, project.id));
          const [label] = await database.insert(labels).values({ workspaceId: project.workspaceId, projectId: project.id, name: input.name, position: (value ?? -1) + 1, ...(input.color ? { color: input.color } : {}) }).returning();
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "label", entityId: label!.id, field: "created", newValue: input.name });
          return { id: label!.id, projectId: label!.projectId, name: label!.name, color: label!.color };
        });
      },
    },
    reorderLabels: {
      name: "reorder_labels", kind: "write" as const,
      input: Type.Object({ ...projectInput, labelIds: Type.Array(uuid()) }), output: Type.Array(labelOutput),
      handler: async (context: Context, input: { projectId: string; labelIds: string[] }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`labels:${project.id}`}))`);
          const current = await database.select().from(labels).where(eq(labels.projectId, project.id)).orderBy(asc(labels.position), asc(labels.name));
          const sameSet = input.labelIds.length === current.length && new Set(input.labelIds).size === current.length && current.every((label) => input.labelIds.includes(label.id));
          if (!sameSet) throw new ActionError("Reorder must list every label exactly once", 400);
          for (const [position, labelId] of input.labelIds.entries()) {
            // Compare the stored position, not the list index: a deleted label leaves a gap, so an index can match while the stored value does not.
            if (current.find((label) => label.id === labelId)?.position === position) continue;
            await database.update(labels).set({ position }).where(eq(labels.id, labelId));
          }
          const reordered = await database.select().from(labels).where(eq(labels.projectId, project.id)).orderBy(asc(labels.position), asc(labels.name));
          return reordered.map((row) => ({ id: row.id, projectId: row.projectId, name: row.name, color: row.color }));
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
      // A page of versions, newest first: pass the last id back as `after` for the next page. A row carries its Markdown and text; the parsed document (`content`) comes only with `versionId`, one version at a time.
      input: Type.Object({
        workItemId: uuid(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Versions per page. Default 20, at most 100." })),
        after: Type.Optional(uuid()), versionId: Type.Optional(uuid()),
      }),
      output: Type.Array(Type.Object({ id: Type.String(), content: Type.Optional(Type.Any()), contentMarkdown: Type.String(), contentText: Type.String(), createdBy: Type.String(), createdByName: Type.String(), createdAt: Type.String() })),
      handler: async (context: Context, input: { workItemId: string; limit?: number; after?: string; versionId?: string }) => {
        const item = await loadItem(input.workItemId);
        await requireProjectAccess(db, context.userId, item.projectId, "read");
        const base = [eq(workItemDescriptionVersions.workItemId, item.id)];
        if (input.versionId) base.push(eq(workItemDescriptionVersions.id, input.versionId));
        else if (input.after) {
          const [cursor] = await db.select({ id: workItemDescriptionVersions.id }).from(workItemDescriptionVersions)
            .where(and(eq(workItemDescriptionVersions.id, input.after), eq(workItemDescriptionVersions.workItemId, item.id)));
          if (!cursor) throw new ActionError("Version not found", 404);
          // Compared inside the database, so timestamps keep their microseconds and rows that share one are not skipped.
          base.push(sql`(${workItemDescriptionVersions.createdAt}, ${workItemDescriptionVersions.id}) < (select created_at, id from work_item_description_versions where id = ${input.after})`);
        }
        const rows = await db.select({ version: workItemDescriptionVersions, createdByName: users.name }).from(workItemDescriptionVersions)
          .innerJoin(users, eq(users.id, workItemDescriptionVersions.createdBy)).where(and(...base))
          .orderBy(desc(workItemDescriptionVersions.createdAt), desc(workItemDescriptionVersions.id)).limit(input.versionId ? 1 : Math.min(Math.max(input.limit ?? 20, 1), 100));
        if (input.versionId && !rows.length) throw new ActionError("Version not found", 404);
        // The page stops before its Markdown passes ~1 MB (the cursor continues from the last row returned); a legacy row without Markdown is serialised on the stored lane, never refused.
        const out = [];
        let bytes = 0;
        for (const { version, createdByName } of rows) {
          const contentMarkdown = version.contentMarkdown ?? await readWrittenFormOf(version.content, version.contentText);
          if (out.length && !input.versionId && bytes + contentMarkdown.length > PAGE_MARKDOWN_BUDGET) break;
          bytes += contentMarkdown.length;
          const row = { id: version.id, contentMarkdown, contentText: version.contentText, createdBy: version.createdBy, createdByName, createdAt: version.createdAt.toISOString() };
          out.push(input.versionId ? { ...row, content: version.contentMarkdown ? await storedDocumentOf(version.contentMarkdown) : version.content } : row);
        }
        return out;
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
          const markdownOptions = await workItemMarkdownOptions(database, context.userId, project.workspaceId, project.id);
          const [current] = await database.select().from(workItems).where(and(eq(workItems.id, item.id), liveWorkItems)).for("update");
          if (!current) throw new ActionError("Work item not found", 404);
          assertNotArchived(current);
          const [version] = await database.select().from(workItemDescriptionVersions).where(and(eq(workItemDescriptionVersions.id, input.versionId), eq(workItemDescriptionVersions.workItemId, current.id)));
          if (!version) throw new ActionError("Version not found", 404);
          if (current.descriptionText) await database.insert(workItemDescriptionVersions).values({ workItemId: current.id, contentMarkdown: current.descriptionMarkdown ?? await writtenFormOf(current.description), contentText: current.descriptionText, createdBy: context.userId });
          const versionMarkdown = version.contentMarkdown ?? await writtenFormOf(version.content);
          const restoredDocument = await storedDocumentOf(versionMarkdown, { preserveUnresolvedReferences: true });
          await validateRichTextAssets(database, restoredDocument, "work_item", current.id, context.userId);
          const [updated] = await database.update(workItems).set({ descriptionMarkdown: versionMarkdown, descriptionDoc: restoredDocument, descriptionText: descriptionPlainText(restoredDocument), updatedAt: new Date() }).where(eq(workItems.id, current.id)).returning();
          await setOutlinksFromDocument(database, "work-item", current.id, "body", restoredDocument);
          await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: current.id, field: "description_restored", oldValue: current.descriptionMarkdown ?? await writtenFormOf(current.description), newValue: versionMarkdown });
          return (await hydrate(database, [updated!], project.key, markdownOptions))[0]!;
        });
      },
    },
    listWorkItemActivities: {
      name: "list_work_item_activities", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(activityOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        let [item] = await db.select().from(workItems).where(and(eq(workItems.id, input.workItemId), liveWorkItems));
        let intake: typeof intakeItems.$inferSelect | undefined;
        if (!item) {
          [item] = await db.select().from(workItems).where(and(eq(workItems.id, input.workItemId), isNull(workItems.deletedAt)));
          if (!item) throw new ActionError("Work item not found", 404);
          [intake] = await db.select().from(intakeItems).where(eq(intakeItems.workItemId, item.id));
          if (!intake) throw new ActionError("Work item not found", 404);
        }
        const access = await requireProjectAccess(db, context.userId, item.projectId, "read");
        if (intake && intake.outcome !== "accepted") assertFeatureEnabled(access.project, "intake");
        if (intake && intake.outcome !== "accepted" && access.workspaceRole !== "Admin" && (access.workspaceRole === "Guest" || access.projectRole === "Guest") && intake.createdBy !== context.userId) throw new ActionError("Forbidden", 403);
        const originator = alias(users, "originator");
        const rows = (await db.select({ activity: activities, actorName: users.name, actorIsAgent: users.isAgent, originatorName: originator.name }).from(activities).innerJoin(users, eq(users.id, activities.actorId)).leftJoin(originator, eq(originator.id, activities.originatorId))
          .where(and(eq(activities.entityType, "work_item"), eq(activities.entityId, item.id))).orderBy(asc(activities.seq))).map((row) => ({ ...row.activity, actorName: row.actorName, actorIsAgent: row.actorIsAgent, originatorName: row.originatorName }));
        // A started Run names the Run that woke it. Its link is kept only for a viewer who may open Runs (not a Guest) and whose project holds that Run.
        const startedRunId = (row: { newValue: unknown }) => (row.newValue as { runId?: unknown } | null)?.runId;
        const startedRuns = rows.flatMap((row) => row.field === "run_started" && typeof startedRunId(row) === "string" ? [startedRunId(row) as string] : []);
        const startedBy = startedRuns.length ? await db.select({ id: runs.id, wokenByRunId: runs.wokenByRunId, depth: runs.depth }).from(runs).where(inArray(runs.id, startedRuns)) : [];
        const wakers = await loadWakingRuns(db, startedBy.flatMap((run) => run.wokenByRunId ? [run.wokenByRunId] : []));
        const wokenByRun = new Map(startedBy.map((run) => {
          const waker = run.wokenByRunId ? wakers.get(run.wokenByRunId) : undefined;
          return [run.id, waker ? { runId: access.workspaceRole !== "Guest" && waker.projectId === item.projectId ? waker.id : null, agentName: waker.agentName, depth: run.depth } : null] as const;
        }));
        const agentIds = rows.flatMap((row) => row.actorIsAgent && row.actorId !== null ? [row.actorId] : []);
        const codeAgents = new Set(agentIds.length ? (await db.select({ userId: agents.userId }).from(agents).where(and(inArray(agents.userId, agentIds), isNotNull(agents.runtimeId)))).map((agent) => agent.userId) : []);
        // A custom property change is logged with ids: show the option labels, the member names and the labels of a list instead.
        const properties = await loadProperties(db, item.projectId);
        // A new row names the property by id (and the name at the time); an older row has the name only.
        const propertyFor = (field: string) => {
          const parsed = parsePropertyActivityField(field);
          if (!parsed) return undefined;
          return parsed.propertyId ? properties.find((property) => property.id === parsed.propertyId) : properties.find((property) => property.name === parsed.name);
        };
        const fieldShown = (field: string) => publicActivityField(field, propertyFor(field)?.name);
        const personIds = rows.filter((row) => propertyFor(row.field)?.kind === "person").flatMap((row) => [row.oldValue, row.newValue]).filter((value): value is string => typeof value === "string");
        const names = new Map((personIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, personIds)) : []).map((user) => [user.id, user.name]));
        // A property that no longer exists cannot name its option ids, so an id-shaped value is hidden rather than shown raw.
        const rawId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const shown = (field: string, value: unknown) => {
          const property = propertyFor(field);
          if (property) return readablePropertyValue(property, value, names);
          if (!parsePropertyActivityField(field)) return value ?? null;
          return (typeof value === "string" && rawId.test(value)) || (Array.isArray(value) && value.some((entry) => typeof entry === "string" && rawId.test(entry))) ? null : value ?? null;
        };
        return rows.map((row) => ({ actorName: row.actorName, actorIsAgent: row.actorIsAgent, actorCodeCapable: row.actorId !== null && codeAgents.has(row.actorId), id: row.id, field: fieldShown(row.field), oldValue: shown(row.field, row.oldValue), newValue: shown(row.field, row.newValue), actorId: row.actorId, source: row.source, chatId: row.chatId, runId: row.runId, originatorId: row.originatorId, originatorName: row.originatorName, bulkEditId: row.bulkEditId, wokenBy: row.field === "run_started" && typeof startedRunId(row) === "string" ? wokenByRun.get(startedRunId(row) as string) ?? null : null, reason: row.reason ?? null, createdAt: row.createdAt.toISOString() }));
      },
    },
  };
}
