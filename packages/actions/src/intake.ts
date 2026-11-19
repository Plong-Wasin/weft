import { Type } from "@sinclair/typebox";
import { plainTextWrittenForm } from "./rich-markdown";
import { existingStableReferences, setOutlinksFromDocument } from "./outlinks";
import { storedDocumentsWithWarnings, writtenFormOf } from "./written-form-pool";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, agents, intakeItems, labels, projectMembers, projects, users, workItemAssignees, workItemLabels, workItemStates, workItemTypes, workItems } from "@weft/db";
import { assertFeatureEnabled } from "./features";
import { ActionError } from "./members";
import { enqueueNotification, type NotificationKind } from "./notifications";
import { requireProjectAccess } from "./projects";
import { fireEventTriggers } from "./triggers";
import { liveWorkItems, triageGroup } from "./triage";
import { emitOutboundEvent, workItemSnapshot } from "./outbound-webhooks";
import { applyPropertyDefaults, assertRequiredFilled, loadProperties, loadPropertyValues, startingType } from "./work-item-properties";
import { activityActor, priorities, workItemMarkdownOptions, writtenDescription, type ActivityContext, type Priority } from "./work-items";
import { markdownToDoc, storedMarkdownToDoc, WRITTEN_FORM_MAX_INPUT_LENGTH } from "./markdown-doc";
import { richTextMarkdown } from "./rich-markdown";
import { validateRichTextAssets } from "./rich-text-validation";
import { disabledAgentUserIds, hasAgentAccess } from "./agent-access";
import { queueRunsForAssignees, wakerOf } from "./runs";

export const intakeOutcomes = ["pending", "snoozed", "accepted", "rejected", "duplicate"] as const;
export type IntakeOutcome = (typeof intakeOutcomes)[number];

const uuid = () => Type.String({ format: "uuid" });
const outcomeSchema = Type.Union(intakeOutcomes.map((outcome) => Type.Literal(outcome)));
const prioritySchema = Type.Union(priorities.map((priority) => Type.Literal(priority)));
const nullable = <T extends import("@sinclair/typebox").TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const dateSchema = Type.Union([Type.String({ format: "date" }), Type.Null()]);
const intakeOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), workItemId: Type.String(), displayId: Type.String(), title: Type.String(),
  description: Type.Optional(Type.Any({ description: "The parsed editor document. Present when one Intake item is read or written; list results omit it and carry descriptionMarkdown and descriptionText instead." })), descriptionText: Type.String(), descriptionMarkdown: Type.String(), descriptionMarkdownWarnings: Type.Array(Type.String()), descriptionMarkdownWarningDetails: Type.Array(Type.Object({ code: Type.String(), message: Type.String() })), priority: prioritySchema, outcome: outcomeSchema,
  assigneeIds: Type.Array(Type.String()), labelIds: Type.Array(Type.String()), dueDate: nullable(Type.String()),
  snoozedTill: nullable(Type.String()), duplicateTo: nullable(Type.String()), duplicateToDisplayId: nullable(Type.String()),
  createdBy: Type.String(), createdByName: Type.String(), createdAt: Type.String(), decidedAt: nullable(Type.String()),
});
type Context = ActivityContext;
type IntakeRow = typeof intakeItems.$inferSelect;

/** A snoozed item whose time has passed counts as pending again; nothing needs to run to wake it up. */
export function effectiveOutcome(row: Pick<IntakeRow, "outcome" | "snoozedTill">, now: Date = new Date()): IntakeOutcome {
  if (row.outcome === "snoozed" && (!row.snoozedTill || row.snoozedTill <= now)) return "pending";
  return row.outcome as IntakeOutcome;
}
function assertDueDate(value: string | null | undefined) {
  if (value === undefined || value === null) return;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ActionError("dueDate must be a valid calendar date", 400);
}

export function createIntakeActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  async function log(database: Database, context: Context, project: { id: string; workspaceId: string }, workItemId: string, field: string, oldValue: unknown = null, newValue: unknown = null) {
    await database.insert(activities).values({
      workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: workItemId, field, oldValue, newValue,
      ...activityActor(context),
    });
  }

  /** Rows of one project's Intake joined with their work item, newest first. */
  async function load(database: Database, projectId: string, where: ReturnType<typeof and>, options: { document?: boolean } = {}) {
    const rows = await database.select({ intake: intakeItems, item: workItems, key: projects.key, authorName: users.name }).from(intakeItems)
      .innerJoin(workItems, and(eq(workItems.id, intakeItems.workItemId), isNull(workItems.deletedAt)))
      .innerJoin(projects, eq(projects.id, intakeItems.projectId)).innerJoin(users, eq(users.id, intakeItems.createdBy))
      .where(and(eq(intakeItems.projectId, projectId), where)).orderBy(desc(intakeItems.createdAt), desc(intakeItems.id));
    const targets = rows.flatMap((row) => row.intake.duplicateTo ? [row.intake.duplicateTo] : []);
    const named = new Map<string, string>();
    for (const target of new Set(targets)) {
      const [found] = await database.select({ sequence: workItems.sequence }).from(workItems).where(eq(workItems.id, target));
      if (found) named.set(target, `${rows[0]!.key}-${found.sequence}`);
    }
    // The parsed document is built for a single item only, on a worker when it is large.
    const documents = new Map<string, unknown>();
    if (options.document) {
      // The prepared document is stored with the Markdown; only a row without one is parsed.
      for (const row of rows) {
        const stored = row.item.descriptionDoc ?? row.item.description;
        if (stored && typeof stored === "object" && (stored as { type?: unknown }).type === "doc") documents.set(row.item.id, stored);
      }
      const withMarkdown = rows.filter((row) => row.item.descriptionMarkdown && !documents.has(row.item.id));
      const parsed = await storedDocumentsWithWarnings(withMarkdown.map((row) => ({ markdown: row.item.descriptionMarkdown! })));
      withMarkdown.forEach((row, index) => documents.set(row.item.id, parsed[index]!.document));
    }
    const ids = rows.map(({ item }) => item.id);
    const assigneeRows = ids.length ? await database.select().from(workItemAssignees).where(inArray(workItemAssignees.workItemId, ids)) : [];
    const labelRows = ids.length ? await database.select().from(workItemLabels).where(inArray(workItemLabels.workItemId, ids)) : [];
    return rows.map((row) => ({
      id: row.intake.id, projectId: row.intake.projectId, workItemId: row.item.id, displayId: `${row.key}-${row.item.sequence}`, title: row.item.title,
      // The parsed document is built for a single item only; the Intake list returns descriptionText and descriptionMarkdown.
      ...(options.document ? { description: documents.get(row.item.id) ?? row.item.description ?? null } : {}), descriptionText: row.item.descriptionText,
      descriptionMarkdown: row.item.descriptionMarkdown ?? plainTextWrittenForm(row.item.description), descriptionMarkdownWarnings: [], descriptionMarkdownWarningDetails: [], priority: row.item.priority as Priority,
      outcome: effectiveOutcome(row.intake), snoozedTill: row.intake.snoozedTill?.toISOString() ?? null, duplicateTo: row.intake.duplicateTo,
      duplicateToDisplayId: row.intake.duplicateTo ? named.get(row.intake.duplicateTo) ?? null : null,
      createdBy: row.intake.createdBy, createdByName: row.authorName, createdAt: row.intake.createdAt.toISOString(), decidedAt: row.intake.decidedAt?.toISOString() ?? null,
      assigneeIds: assigneeRows.filter((value) => value.workItemId === row.item.id).map((value) => value.userId).sort(),
      labelIds: labelRows.filter((value) => value.workItemId === row.item.id).map((value) => value.labelId).sort(), dueDate: row.item.dueDate,
    }));
  }

  async function one(database: Database, intakeItemId: string) {
    const [row] = await database.select().from(intakeItems).where(eq(intakeItems.id, intakeItemId));
    if (!row) throw new ActionError("Intake item not found", 404);
    const [item] = await database.select().from(workItems).where(and(eq(workItems.id, row.workItemId), isNull(workItems.deletedAt)));
    if (!item) throw new ActionError("Intake item not found", 404);
    return { row, item };
  }

  /** Store Intake properties without waking Agents: pending work is not approved to run yet. */
  async function applyIntakeProperties(database: Database, context: Context, project: { id: string; workspaceId: string }, item: typeof workItems.$inferSelect, input: { assigneeIds?: string[]; labelIds?: string[] }) {
    if (input.assigneeIds !== undefined) {
      const current = (await database.select({ userId: workItemAssignees.userId }).from(workItemAssignees).where(eq(workItemAssignees.workItemId, item.id))).map((row) => row.userId).sort();
      const next = [...new Set(input.assigneeIds)].sort();
      const added = next.filter((id) => !current.includes(id));
      if (added.length) {
        const members = await database.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, project.id), inArray(projectMembers.userId, added)));
        if (members.length !== added.length) throw new ActionError("Assignees must be project members", 400);
        if ((await disabledAgentUserIds(database, added)).size) throw new ActionError("A disabled Agent cannot be assigned", 400);
        const agentRows = await database.select({ id: agents.id }).from(agents).where(inArray(agents.userId, added));
        for (const agent of agentRows) if (!(await hasAgentAccess(database, agent.id, context.userId))) throw new ActionError("You do not have Agent access to assign this Agent", 403);
      }
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        await database.delete(workItemAssignees).where(eq(workItemAssignees.workItemId, item.id));
        if (next.length) await database.insert(workItemAssignees).values(next.map((userId) => ({ workItemId: item.id, userId })));
        await database.update(workItems).set({ updatedAt: new Date() }).where(eq(workItems.id, item.id));
        await log(database, context, project, item.id, "assignees", current, next);
      }
    }
    if (input.labelIds !== undefined) {
      const current = (await database.select({ labelId: workItemLabels.labelId }).from(workItemLabels).where(eq(workItemLabels.workItemId, item.id))).map((row) => row.labelId).sort();
      const next = [...new Set(input.labelIds)].sort();
      if (next.length) {
        const found = await database.select({ id: labels.id }).from(labels).where(and(eq(labels.projectId, project.id), inArray(labels.id, next)));
        if (found.length !== next.length) throw new ActionError("Labels must belong to this project", 400);
      }
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        await database.delete(workItemLabels).where(eq(workItemLabels.workItemId, item.id));
        if (next.length) await database.insert(workItemLabels).values(next.map((labelId) => ({ workItemId: item.id, labelId })));
        await database.update(workItems).set({ updatedAt: new Date() }).where(eq(workItems.id, item.id));
        await log(database, context, project, item.id, "labels", current, next);
      }
    }
  }

  /** Who may decide: project Admin or Member. Returns the row and project; refuses a decided item. */
  async function forDecision(context: Context, intakeItemId: string) {
    const { row, item } = await one(db, intakeItemId);
    const { project } = await requireProjectAccess(db, context.userId, row.projectId, "write");
    assertFeatureEnabled(project, "intake");
    if (project.archivedAt) throw new ActionError("Project is archived", 400);
    if (!["pending", "snoozed"].includes(row.outcome)) throw new ActionError("Intake item is already decided", 400);
    return { row, item, project };
  }

  async function decide(context: Context, intakeItemId: string, decision: "accepted" | "rejected" | "snoozed" | "duplicate", options: { snoozedTill?: Date; duplicateTo?: string; stateId?: string } = {}) {
    const { row, item, project } = await forDecision(context, intakeItemId);
    return db.transaction(async (transaction) => {
      const database = tx(transaction);
      // The lock serialises two people deciding the same item; the loser sees it already decided.
      const [locked] = await database.select().from(intakeItems).where(eq(intakeItems.id, row.id)).for("update");
      if (!locked || !["pending", "snoozed"].includes(locked.outcome)) throw new ActionError("Intake item is already decided", 400);
      const patch: Partial<typeof intakeItems.$inferInsert> = { outcome: decision, decidedBy: context.userId, decidedAt: new Date(), snoozedTill: null, duplicateTo: null };
      let entry: { field: string; newValue: unknown } = { field: `intake_${decision === "accepted" ? "accepted" : decision === "rejected" ? "rejected" : decision === "snoozed" ? "snoozed" : "duplicate"}`, newValue: null };
      if (decision === "accepted") {
        let target: typeof workItemStates.$inferSelect | undefined;
        if (options.stateId !== undefined) {
          [target] = await database.select().from(workItemStates).where(and(eq(workItemStates.id, options.stateId), eq(workItemStates.projectId, project.id)));
          if (!target || target.group === triageGroup) throw new ActionError("State must be a normal State in this project", 400);
        } else {
          [target] = await database.select().from(workItemStates).where(and(eq(workItemStates.projectId, project.id), eq(workItemStates.group, "backlog"))).orderBy(asc(workItemStates.sortOrder));
          if (!target) throw new ActionError("Project has no Backlog state to accept into", 400);
        }
        if (project.typesEnabled && item.typeId) {
          const type = await database.select().from(workItemTypes).where(eq(workItemTypes.id, item.typeId));
          const properties = await loadProperties(database, project.id, item.typeId);
          const values = new Map((await loadPropertyValues(database, [item.id])).get(item.id)!.map((value) => [value.propertyId, value.value]));
          assertRequiredFilled(type[0] ?? { name: "work item type" }, properties, values);
        }
        await database.update(workItems).set({ stateId: target.id, updatedAt: new Date() }).where(eq(workItems.id, item.id));
        entry = { field: "intake_accepted", newValue: target.id };
        const assigned = await database.select({ userId: workItemAssignees.userId }).from(workItemAssignees).where(eq(workItemAssignees.workItemId, item.id));
        await queueRunsForAssignees(database, { originatorId: context.userId, waker: wakerOf(context.source), wakingRunId: context.agent?.runId ?? null, project, workItemId: item.id, assigneeUserIds: assigned.map(({ userId }) => userId) });
        await fireEventTriggers(database, { eventType: "work_item_created", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source, wakingRunId: context.agent?.runId ?? null, excludeAgentUserIds: assigned.map(({ userId }) => userId) });
      } else if (decision === "snoozed") {
        patch.snoozedTill = options.snoozedTill!;
        entry = { field: "intake_snoozed", newValue: options.snoozedTill!.toISOString() };
      } else if (decision === "duplicate") {
        patch.duplicateTo = options.duplicateTo!;
        entry = { field: "intake_duplicate", newValue: options.duplicateTo! };
      }
      await database.update(intakeItems).set(patch).where(eq(intakeItems.id, row.id));
      await log(database, context, project, item.id, entry.field, null, entry.newValue);
      if (decision !== "snoozed") {
        const kind: NotificationKind = decision === "accepted" ? "intake_accepted" : decision === "rejected" ? "intake_rejected" : "intake_duplicate";
        await enqueueNotification(database, { kind, workItemId: item.id, actorId: context.userId, recipientIds: [row.createdBy] });
      }
      return (await load(database, project.id, eq(intakeItems.id, row.id), { document: true }))[0]!;
    });
  }

  const idInput = { intakeItemId: uuid() };

  return {
    submitIntakeItem: {
      name: "submit_intake_item", kind: "write" as const,
      input: Type.Object({ projectId: uuid(), title: Type.String({ minLength: 1, maxLength: 500 }), descriptionMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH })), description: Type.Optional(Type.Any()), priority: Type.Optional(prioritySchema), assigneeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), labelIds: Type.Optional(Type.Array(uuid())), dueDate: Type.Optional(dateSchema) }),
      output: intakeOutput,
      handler: async (context: Context, input: { projectId: string; title: string; description?: unknown; descriptionMarkdown?: string; priority?: Priority; assigneeIds?: string[]; labelIds?: string[]; dueDate?: string | null }) => {
        assertDueDate(input.dueDate);
        // Anyone who can see the project may submit, Guests included; that is why this is a read-level check.
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        const markdownOptions = await workItemMarkdownOptions(db, context.userId, project.workspaceId, project.id);
        const description = input.description !== undefined || input.descriptionMarkdown !== undefined ? await writtenDescription(input.description, input.descriptionMarkdown, markdownOptions) : { document: undefined, markdown: "", text: "", warnings: [], warningDetails: [] };
        assertFeatureEnabled(project, "intake");
        if (project.archivedAt) throw new ActionError("Project is archived", 400);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [triage] = await database.select().from(workItemStates).where(and(eq(workItemStates.projectId, project.id), eq(workItemStates.group, triageGroup)));
          if (!triage) throw new ActionError("Project has no Triage state", 400);
          const [counter] = await database.update(projects).set({ workItemSequence: sql`${projects.workItemSequence} + 1` }).where(eq(projects.id, project.id)).returning({ sequence: projects.workItemSequence });
          const [{ value }] = await database.select({ value: sql<number | null>`max(${workItems.sortOrder})` }).from(workItems).where(eq(workItems.projectId, project.id));
          const [item] = await database.insert(workItems).values({
            workspaceId: project.workspaceId, projectId: project.id, sequence: counter!.sequence, title: input.title,
            descriptionMarkdown: description.markdown, descriptionDoc: description.document, descriptionText: description.text, stateId: triage.id,
            priority: input.priority ?? "none", sortOrder: (value ?? 0) + 65536, createdBy: context.userId, dueDate: input.dueDate ?? null,
            typeId: await startingType(database, project),
          }).returning();
          await validateRichTextAssets(database, description.document, "work_item", item!.id, context.userId);
          await setOutlinksFromDocument(database, "work-item", item!.id, "body", description.document);
          await applyPropertyDefaults(database, project, item!);
          await applyIntakeProperties(database, context, project, item!, input);
          const [row] = await database.insert(intakeItems).values({ workspaceId: project.workspaceId, projectId: project.id, workItemId: item!.id, createdBy: context.userId }).returning();
          await log(database, context, project, item!.id, "created", null, input.title);
          if (input.dueDate !== undefined && input.dueDate !== null) await log(database, context, project, item!.id, "dueDate", null, input.dueDate);
          await emitOutboundEvent(database, { workspaceId: project.workspaceId, projectId: project.id, type: "work_item.created", build: async (database) => ({ workItem: await workItemSnapshot(database, item!.id) }) });
          return { ...(await load(database, project.id, eq(intakeItems.id, row!.id), { document: true }))[0]!, descriptionMarkdownWarnings: description.warnings, descriptionMarkdownWarningDetails: description.warningDetails };
        });
      },
    },
    listIntakeItems: {
      name: "list_intake_items", kind: "read" as const,
      input: Type.Object({ projectId: uuid(), outcome: outcomeSchema }), output: Type.Array(intakeOutput),
      handler: async (context: Context, input: { projectId: string; outcome: IntakeOutcome }) => {
        const { project, workspaceRole, projectRole } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        assertFeatureEnabled(project, "intake");
        // Plane limits a Guest to the items they submitted themselves.
        const guestOnly = workspaceRole !== "Admin" && (workspaceRole === "Guest" || projectRole === "Guest");
        const now = new Date();
        const where = input.outcome === "pending" ? or(eq(intakeItems.outcome, "pending"), and(eq(intakeItems.outcome, "snoozed"), lte(intakeItems.snoozedTill, now)))
          : input.outcome === "snoozed" ? and(eq(intakeItems.outcome, "snoozed"), gt(intakeItems.snoozedTill, now)) : eq(intakeItems.outcome, input.outcome);
        return load(db, project.id, guestOnly ? and(where, eq(intakeItems.createdBy, context.userId)) : where);
      },
    },
    updateIntakeItem: {
      name: "update_intake_item", kind: "write" as const,
      input: Type.Object({ ...idInput, title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), descriptionMarkdown: Type.Optional(Type.String({ maxLength: WRITTEN_FORM_MAX_INPUT_LENGTH })), description: Type.Optional(Type.Any()), priority: Type.Optional(prioritySchema), assigneeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), labelIds: Type.Optional(Type.Array(uuid())), dueDate: Type.Optional(dateSchema) }),
      output: intakeOutput,
      handler: async (context: Context, input: { intakeItemId: string; title?: string; description?: unknown; descriptionMarkdown?: string; priority?: Priority; assigneeIds?: string[]; labelIds?: string[]; dueDate?: string | null }) => {
        assertDueDate(input.dueDate);
        const { row, item } = await one(db, input.intakeItemId);
        const { project, workspaceRole, projectRole } = await requireProjectAccess(db, context.userId, row.projectId, "read");
        const markdownOptions = await workItemMarkdownOptions(db, context.userId, project.workspaceId, project.id);
        assertFeatureEnabled(project, "intake");
        // Plane's partial_update: only a project Admin or the submitter edits content.
        const admin = workspaceRole === "Admin" || projectRole === "Admin";
        if (!admin && row.createdBy !== context.userId) throw new ActionError("Forbidden", 403);
        if (project.archivedAt) throw new ActionError("Project is archived", 400);
        if (row.outcome === "accepted") throw new ActionError("An accepted item is edited as a work item", 400);
        if (row.outcome === "rejected" || row.outcome === "duplicate") throw new ActionError("A decided Intake item is read-only", 400);
        let descriptionWarnings: string[] = [];
        let descriptionWarningDetails: Array<{ code: string; message: string }> = [];
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [locked] = await database.select().from(intakeItems).where(eq(intakeItems.id, row.id)).for("update");
          if (!locked) throw new ActionError("Intake item not found", 404);
          if (locked.outcome !== "pending" && locked.outcome !== "snoozed") throw new ActionError("A decided Intake item is read-only", 400);
          // Another edit may have committed while this caller waited for the Intake lock.
          const [item] = await database.select().from(workItems).where(and(eq(workItems.id, row.workItemId), isNull(workItems.deletedAt)));
          if (!item) throw new ActionError("Intake item not found", 404);
          const changes: Array<{ field: string; column: Partial<typeof workItems.$inferInsert>; oldValue: unknown; newValue: unknown }> = [];
          if (input.dueDate !== undefined && input.dueDate !== item.dueDate) changes.push({ field: "dueDate", column: { dueDate: input.dueDate }, oldValue: item.dueDate, newValue: input.dueDate });
          if (input.title !== undefined && input.title !== item.title) changes.push({ field: "title", column: { title: input.title }, oldValue: item.title, newValue: input.title });
          if (input.priority !== undefined && input.priority !== item.priority) changes.push({ field: "priority", column: { priority: input.priority }, oldValue: item.priority, newValue: input.priority });
          if (input.description !== undefined || input.descriptionMarkdown !== undefined) {
            const description = await writtenDescription(input.description, input.descriptionMarkdown, { ...markdownOptions, existingStableReferences: await existingStableReferences(database, "work-item", item.id, "body", item.descriptionMarkdown) });
            await validateRichTextAssets(database, description.document, "work_item", item.id, context.userId);
            descriptionWarnings = description.warnings;
            descriptionWarningDetails = description.warningDetails;
            await setOutlinksFromDocument(database, "work-item", item.id, "body", description.document);
            if (description.markdown !== (item.descriptionMarkdown ?? await writtenFormOf(item.description))) changes.push({ field: "description", column: { descriptionMarkdown: description.markdown, descriptionDoc: description.document, descriptionText: description.text }, oldValue: item.descriptionMarkdown ?? await writtenFormOf(item.description), newValue: description.markdown });
          }
          if (changes.length > 0) {
            await database.update(workItems).set({ ...Object.assign({}, ...changes.map((change) => change.column)), updatedAt: new Date() }).where(eq(workItems.id, item.id));
            for (const change of changes) await log(database, context, project, item.id, change.field, change.oldValue, change.newValue);
          }
          await applyIntakeProperties(database, context, project, item, input);
          return { ...(await load(database, project.id, eq(intakeItems.id, row.id), { document: true }))[0]!, descriptionMarkdownWarnings: descriptionWarnings, descriptionMarkdownWarningDetails: descriptionWarningDetails };
        });
      },
    },
    acceptIntakeItem: {
      name: "accept_intake_item", kind: "write" as const, input: Type.Object({ ...idInput, stateId: Type.Optional(uuid()) }), output: intakeOutput,
      handler: (context: Context, input: { intakeItemId: string; stateId?: string }) => decide(context, input.intakeItemId, "accepted", { stateId: input.stateId }),
    },
    rejectIntakeItem: {
      name: "reject_intake_item", kind: "write" as const, input: Type.Object(idInput), output: intakeOutput,
      handler: (context: Context, input: { intakeItemId: string }) => decide(context, input.intakeItemId, "rejected"),
    },
    snoozeIntakeItem: {
      name: "snooze_intake_item", kind: "write" as const,
      input: Type.Object({ ...idInput, snoozedTill: Type.String({ minLength: 1 }) }), output: intakeOutput,
      handler: async (context: Context, input: { intakeItemId: string; snoozedTill: string }) => {
        await forDecision(context, input.intakeItemId);
        const till = new Date(input.snoozedTill);
        if (Number.isNaN(till.getTime()) || till <= new Date()) throw new ActionError("snoozedTill must be a future date", 400);
        return decide(context, input.intakeItemId, "snoozed", { snoozedTill: till });
      },
    },
    unsnoozeIntakeItem: {
      name: "unsnooze_intake_item", kind: "write" as const,
      input: Type.Object(idInput), output: intakeOutput,
      handler: async (context: Context, input: { intakeItemId: string }) => {
        const { row, project, item } = await forDecision(context, input.intakeItemId);
        if (effectiveOutcome(row) !== "snoozed") throw new ActionError("Intake item is not snoozed", 400);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [locked] = await database.select().from(intakeItems).where(eq(intakeItems.id, row.id)).for("update");
          if (!locked || effectiveOutcome(locked) !== "snoozed") throw new ActionError("Intake item is not snoozed", 400);
          await database.update(intakeItems).set({ outcome: "pending", snoozedTill: null, decidedBy: null, decidedAt: null }).where(eq(intakeItems.id, row.id));
          await log(database, context, project, item.id, "intake_unsnoozed", locked.snoozedTill?.toISOString() ?? null, null);
          return (await load(database, project.id, eq(intakeItems.id, row.id), { document: true }))[0]!;
        });
      },
    },
    duplicateIntakeItem: {
      name: "duplicate_intake_item", kind: "write" as const,
      input: Type.Object({ ...idInput, duplicateTo: uuid() }), output: intakeOutput,
      handler: async (context: Context, input: { intakeItemId: string; duplicateTo: string }) => {
        const { row, item } = await forDecision(context, input.intakeItemId);
        // The original must be a normal work item of the same project; no Relation is created.
        const [original] = await db.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.id, input.duplicateTo), eq(workItems.projectId, row.projectId), liveWorkItems));
        if (!original || original.id === item.id) throw new ActionError("duplicateTo must be another work item of this project", 400);
        return decide(context, input.intakeItemId, "duplicate", { duplicateTo: original.id });
      },
    },
  };
}
