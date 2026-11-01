import { Type } from "@sinclair/typebox";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, projects, workItemRelations, workItems } from "@weft/db";
import { liveWorkItems } from "./triage";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import type { ActivitySource } from "./work-items";

type Context = { userId: string; source?: ActivitySource };

export const relationTypes = ["blocks", "blocked_by", "duplicate", "relates_to"] as const;
export type RelationType = (typeof relationTypes)[number];
const inverse: Record<RelationType, RelationType> = { blocks: "blocked_by", blocked_by: "blocks", duplicate: "duplicate", relates_to: "relates_to" };

const uuid = () => Type.String({ format: "uuid" });
const relationType = Type.Union(relationTypes.map((type) => Type.Literal(type)));
const relationOutput = Type.Object({
  id: Type.String(), type: relationType, createdAt: Type.String(),
  workItem: Type.Object({ id: Type.String(), displayId: Type.String(), title: Type.String(), stateId: Type.String() }),
});

export function createRelationActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  async function loadItem(workItemId: string) {
    const [item] = await db.select().from(workItems).where(and(eq(workItems.id, workItemId), liveWorkItems));
    if (!item) throw new ActionError("Work item not found", 404);
    return item;
  }

  async function logActivity(database: Database, context: Context, item: { workspaceId: string; projectId: string; id: string }, field: string, value: { type: RelationType; workItemId: string }) {
    await database.insert(activities).values({
      workspaceId: item.workspaceId, projectId: item.projectId, entityType: "work_item", entityId: item.id, field,
      ...(field === "relation_added" ? { newValue: value } : { oldValue: value }), actorId: context.userId, source: context.source ?? "ui",
    });
  }

  const pairOf = (a: string, b: string) => or(and(eq(workItemRelations.workItemId, a), eq(workItemRelations.relatedWorkItemId, b)), and(eq(workItemRelations.workItemId, b), eq(workItemRelations.relatedWorkItemId, a)))!;

  return {
    listWorkItemRelations: {
      name: "list_work_item_relations", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(relationOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const item = await loadItem(input.workItemId);
        await requireProjectAccess(db, context.userId, item.projectId, "read");
        const rows = await db.select().from(workItemRelations)
          .where(or(eq(workItemRelations.workItemId, item.id), eq(workItemRelations.relatedWorkItemId, item.id))).orderBy(asc(workItemRelations.createdAt), asc(workItemRelations.id));
        const otherId = (row: typeof rows[number]) => row.workItemId === item.id ? row.relatedWorkItemId : row.workItemId;
        const others = rows.length === 0 ? [] : await db.select({ id: workItems.id, sequence: workItems.sequence, title: workItems.title, stateId: workItems.stateId }).from(workItems)
          .where(and(inArray(workItems.id, rows.map(otherId)), liveWorkItems));
        const byId = new Map(others.map((row) => [row.id, row]));
        const [project] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, item.projectId));
        return rows.flatMap((row) => {
          const other = byId.get(otherId(row));
          if (!other) return [];
          // The stored row reads "workItemId is <type> relatedWorkItemId"; the related side sees the inverse.
          const type = (row.workItemId === item.id ? row.type : inverse[row.type as RelationType]) as RelationType;
          return [{ id: row.id, type, createdAt: row.createdAt.toISOString(), workItem: { id: other.id, displayId: `${project!.key}-${other.sequence}`, title: other.title, stateId: other.stateId } }];
        });
      },
    },
    createWorkItemRelation: {
      name: "create_work_item_relation", kind: "write" as const,
      input: Type.Object({ workItemId: uuid(), relatedWorkItemId: uuid(), type: relationType }), output: relationOutput,
      handler: async (context: Context, input: { workItemId: string; relatedWorkItemId: string; type: RelationType }) => {
        const item = await loadItem(input.workItemId);
        await requireProjectAccess(db, context.userId, item.projectId, "write");
        if (input.relatedWorkItemId === item.id) throw new ActionError("A work item cannot be related to itself", 400);
        const related = await loadItem(input.relatedWorkItemId);
        if (related.projectId !== item.projectId) throw new ActionError("Both work items must be in the same project", 400);
        const [existing] = await db.select({ id: workItemRelations.id }).from(workItemRelations).where(pairOf(item.id, related.id));
        if (existing) throw new ActionError("These work items are already related", 400);
        // blocked_by and blocks share one stored type: "blocks" is saved from the blocked side's point of view.
        const stored = input.type === "blocks"
          ? { workItemId: related.id, relatedWorkItemId: item.id, type: "blocked_by" }
          : { workItemId: item.id, relatedWorkItemId: related.id, type: input.type };
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`work-item-relation:${[item.id, related.id].sort().join(":")}`}))`);
          const [again] = await database.select({ id: workItemRelations.id }).from(workItemRelations).where(pairOf(item.id, related.id));
          if (again) throw new ActionError("These work items are already related", 400);
          const [row] = await database.insert(workItemRelations).values({ workspaceId: item.workspaceId, projectId: item.projectId, createdBy: context.userId, ...stored }).returning();
          await logActivity(database, context, item, "relation_added", { type: input.type, workItemId: related.id });
          await logActivity(database, context, related, "relation_added", { type: inverse[input.type], workItemId: item.id });
          const [project] = await database.select({ key: projects.key }).from(projects).where(eq(projects.id, item.projectId));
          return { id: row!.id, type: input.type, createdAt: row!.createdAt.toISOString(), workItem: { id: related.id, displayId: `${project!.key}-${related.sequence}`, title: related.title, stateId: related.stateId } };
        });
      },
    },
    removeWorkItemRelation: {
      name: "remove_work_item_relation", kind: "write" as const,
      input: Type.Object({ workItemId: uuid(), relatedWorkItemId: uuid() }), output: Type.Object({ removed: Type.Boolean() }),
      handler: async (context: Context, input: { workItemId: string; relatedWorkItemId: string }) => {
        const item = await loadItem(input.workItemId);
        await requireProjectAccess(db, context.userId, item.projectId, "write");
        const related = await loadItem(input.relatedWorkItemId);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [row] = await database.delete(workItemRelations).where(and(eq(workItemRelations.projectId, item.projectId), pairOf(item.id, related.id))).returning();
          if (!row) throw new ActionError("Relation not found", 404);
          const type = (row.workItemId === item.id ? row.type : inverse[row.type as RelationType]) as RelationType;
          await logActivity(database, context, item, "relation_removed", { type, workItemId: related.id });
          await logActivity(database, context, related, "relation_removed", { type: inverse[type], workItemId: item.id });
          return { removed: true };
        });
      },
    },
  };
}
