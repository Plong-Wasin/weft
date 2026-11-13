import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, intakeItems, projects, users, workItemStates, workItems } from "@weft/db";
import { assertFeatureEnabled } from "./features";
import { ActionError } from "./members";
import { enqueueNotification, type NotificationKind } from "./notifications";
import { requireProjectAccess } from "./projects";
import { fireEventTriggers } from "./triggers";
import { liveWorkItems, triageGroup } from "./triage";
import { emitOutboundEvent, workItemSnapshot } from "./outbound-webhooks";
import { applyPropertyDefaults, startingType } from "./work-item-properties";
import { activityActor, plainText, priorities, type ActivityContext, type Priority } from "./work-items";

export const intakeOutcomes = ["pending", "snoozed", "accepted", "rejected", "duplicate"] as const;
export type IntakeOutcome = (typeof intakeOutcomes)[number];

const uuid = () => Type.String({ format: "uuid" });
const outcomeSchema = Type.Union(intakeOutcomes.map((outcome) => Type.Literal(outcome)));
const prioritySchema = Type.Union(priorities.map((priority) => Type.Literal(priority)));
const nullable = <T extends import("@sinclair/typebox").TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const intakeOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), workItemId: Type.String(), displayId: Type.String(), title: Type.String(),
  description: Type.Any(), descriptionText: Type.String(), priority: prioritySchema, outcome: outcomeSchema,
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

export function createIntakeActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  async function log(database: Database, context: Context, project: { id: string; workspaceId: string }, workItemId: string, field: string, oldValue: unknown = null, newValue: unknown = null) {
    await database.insert(activities).values({
      workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: workItemId, field, oldValue, newValue,
      ...activityActor(context),
    });
  }

  /** Rows of one project's Intake joined with their work item, newest first. */
  async function load(database: Database, projectId: string, where: ReturnType<typeof and>) {
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
    return rows.map((row) => ({
      id: row.intake.id, projectId: row.intake.projectId, workItemId: row.item.id, displayId: `${row.key}-${row.item.sequence}`, title: row.item.title,
      description: row.item.description ?? null, descriptionText: row.item.descriptionText, priority: row.item.priority as Priority,
      outcome: effectiveOutcome(row.intake), snoozedTill: row.intake.snoozedTill?.toISOString() ?? null, duplicateTo: row.intake.duplicateTo,
      duplicateToDisplayId: row.intake.duplicateTo ? named.get(row.intake.duplicateTo) ?? null : null,
      createdBy: row.intake.createdBy, createdByName: row.authorName, createdAt: row.intake.createdAt.toISOString(), decidedAt: row.intake.decidedAt?.toISOString() ?? null,
    }));
  }

  async function one(database: Database, intakeItemId: string) {
    const [row] = await database.select().from(intakeItems).where(eq(intakeItems.id, intakeItemId));
    if (!row) throw new ActionError("Intake item not found", 404);
    const [item] = await database.select().from(workItems).where(and(eq(workItems.id, row.workItemId), isNull(workItems.deletedAt)));
    if (!item) throw new ActionError("Intake item not found", 404);
    return { row, item };
  }

  /** Who may decide: project Admin or Member. Returns the row and project; refuses a decided item. */
  async function forDecision(context: Context, intakeItemId: string) {
    const { row, item } = await one(db, intakeItemId);
    const { project } = await requireProjectAccess(db, context.userId, row.projectId, "write");
    assertFeatureEnabled(project, "intake");
    if (!["pending", "snoozed"].includes(row.outcome)) throw new ActionError("Intake item is already decided", 400);
    return { row, item, project };
  }

  async function decide(context: Context, intakeItemId: string, decision: "accepted" | "rejected" | "snoozed" | "duplicate", options: { snoozedTill?: Date; duplicateTo?: string } = {}) {
    const { row, item, project } = await forDecision(context, intakeItemId);
    return db.transaction(async (transaction) => {
      const database = tx(transaction);
      // The lock serialises two people deciding the same item; the loser sees it already decided.
      const [locked] = await database.select().from(intakeItems).where(eq(intakeItems.id, row.id)).for("update");
      if (!locked || !["pending", "snoozed"].includes(locked.outcome)) throw new ActionError("Intake item is already decided", 400);
      const patch: Partial<typeof intakeItems.$inferInsert> = { outcome: decision, decidedBy: context.userId, decidedAt: new Date(), snoozedTill: null, duplicateTo: null };
      let entry: { field: string; newValue: unknown } = { field: `intake_${decision === "accepted" ? "accepted" : decision === "rejected" ? "rejected" : decision === "snoozed" ? "snoozed" : "duplicate"}`, newValue: null };
      if (decision === "accepted") {
        const states = await database.select().from(workItemStates).where(and(eq(workItemStates.projectId, project.id), eq(workItemStates.group, "backlog"))).orderBy(asc(workItemStates.sortOrder));
        const target = states[0];
        if (!target) throw new ActionError("Project has no Backlog state to accept into", 400);
        await database.update(workItems).set({ stateId: target.id, updatedAt: new Date() }).where(eq(workItems.id, item.id));
        entry = { field: "intake_accepted", newValue: target.id };
        await fireEventTriggers(database, { eventType: "work_item_created", projectId: project.id, workItemId: item.id, actorId: context.userId, source: context.source });
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
      return (await load(database, project.id, eq(intakeItems.id, row.id)))[0]!;
    });
  }

  const idInput = { intakeItemId: uuid() };

  return {
    submitIntakeItem: {
      name: "submit_intake_item", kind: "write" as const,
      input: Type.Object({ projectId: uuid(), title: Type.String({ minLength: 1, maxLength: 500 }), description: Type.Optional(Type.Any()), priority: Type.Optional(prioritySchema) }),
      output: intakeOutput,
      handler: async (context: Context, input: { projectId: string; title: string; description?: unknown; priority?: Priority }) => {
        // Anyone who can see the project may submit, Guests included; that is why this is a read-level check.
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
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
            description: input.description ?? null, descriptionText: plainText(input.description), stateId: triage.id,
            priority: input.priority ?? "none", sortOrder: (value ?? 0) + 65536, createdBy: context.userId,
            typeId: await startingType(database, project),
          }).returning();
          await applyPropertyDefaults(database, project, item!);
          const [row] = await database.insert(intakeItems).values({ workspaceId: project.workspaceId, projectId: project.id, workItemId: item!.id, createdBy: context.userId }).returning();
          await log(database, context, project, item!.id, "created", null, input.title);
          await emitOutboundEvent(database, { workspaceId: project.workspaceId, projectId: project.id, type: "work_item.created", build: async (database) => ({ workItem: await workItemSnapshot(database, item!.id) }) });
          return (await load(database, project.id, eq(intakeItems.id, row!.id)))[0]!;
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
      input: Type.Object({ ...idInput, title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), description: Type.Optional(Type.Any()), priority: Type.Optional(prioritySchema) }),
      output: intakeOutput,
      handler: async (context: Context, input: { intakeItemId: string; title?: string; description?: unknown; priority?: Priority }) => {
        const { row, item } = await one(db, input.intakeItemId);
        const { project, workspaceRole, projectRole } = await requireProjectAccess(db, context.userId, row.projectId, "read");
        assertFeatureEnabled(project, "intake");
        // Plane's partial_update: only a project Admin or the submitter edits content.
        const admin = workspaceRole === "Admin" || projectRole === "Admin";
        if (!admin && row.createdBy !== context.userId) throw new ActionError("Forbidden", 403);
        if (project.archivedAt) throw new ActionError("Project is archived", 400);
        if (row.outcome === "accepted") throw new ActionError("An accepted item is edited as a work item", 400);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const changes: Array<{ field: string; column: Partial<typeof workItems.$inferInsert>; oldValue: unknown; newValue: unknown }> = [];
          if (input.title !== undefined && input.title !== item.title) changes.push({ field: "title", column: { title: input.title }, oldValue: item.title, newValue: input.title });
          if (input.priority !== undefined && input.priority !== item.priority) changes.push({ field: "priority", column: { priority: input.priority }, oldValue: item.priority, newValue: input.priority });
          if (input.description !== undefined && JSON.stringify(input.description) !== JSON.stringify(item.description)) {
            changes.push({ field: "description", column: { description: input.description, descriptionText: plainText(input.description) }, oldValue: item.descriptionText, newValue: plainText(input.description) });
          }
          if (changes.length > 0) {
            await database.update(workItems).set({ ...Object.assign({}, ...changes.map((change) => change.column)), updatedAt: new Date() }).where(eq(workItems.id, item.id));
            for (const change of changes) await log(database, context, project, item.id, change.field, change.oldValue, change.newValue);
          }
          return (await load(database, project.id, eq(intakeItems.id, row.id)))[0]!;
        });
      },
    },
    acceptIntakeItem: {
      name: "accept_intake_item", kind: "write" as const, input: Type.Object(idInput), output: intakeOutput,
      handler: (context: Context, input: { intakeItemId: string }) => decide(context, input.intakeItemId, "accepted"),
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
