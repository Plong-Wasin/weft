import { Type } from "@sinclair/typebox";
import { and, asc, count, eq, isNotNull } from "drizzle-orm";
import type { Database } from "@weft/db";
import { estimatePoints, estimates, workItems } from "@weft/db";
import { ActionError } from "./members";
import { logActivity, type ActivityContext } from "./work-items";
import { requireProjectAccess } from "./projects";
import { liveWorkItems } from "./triage";

export const estimateTypes = ["points", "categories"] as const;
export type EstimateType = (typeof estimateTypes)[number];
export const minEstimatePoints = 2;
export const maxEstimatePoints = 6;

const uuid = () => Type.String({ format: "uuid" });
const typeSchema = Type.Union(estimateTypes.map((type) => Type.Literal(type)));
const nameSchema = Type.String({ minLength: 1, maxLength: 100 });
const valueSchema = Type.String({ minLength: 1, maxLength: 20 });
const pointOutput = Type.Object({ id: Type.String(), position: Type.Integer(), value: Type.String() });
const estimateOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), type: typeSchema, enabled: Type.Boolean(), points: Type.Array(pointOutput),
});
type Context = ActivityContext;
/** The Activity entries of a clear are written one by one in groups of this size; the whole clear stays in one transaction. */
const clearBatchSize = 500;
type EstimateRow = typeof estimates.$inferSelect;

/** The numeric value of a points Estimate point; text that is not a number weighs zero. */
export function pointWeight(value: string | null) {
  const weight = value === null ? NaN : Number(value);
  return Number.isFinite(weight) ? weight : 0;
}

/** Throws unless the project has a turned-on Estimate of type points; burndown in points mode needs one. */
export async function requirePointsEstimate(database: Database, projectId: string) {
  const [row] = await database.select({ type: estimates.type, enabled: estimates.enabled }).from(estimates).where(eq(estimates.projectId, projectId));
  if (!row || !row.enabled || row.type !== "points") throw new ActionError("Points mode needs a project with a points Estimate", 400);
}

/** How many live work items hold this Estimate point. */
async function pointUsage(database: Database, pointId: string) {
  const [row] = await database.select({ count: count() }).from(workItems).where(and(eq(workItems.estimatePointId, pointId), liveWorkItems));
  return row!.count;
}

const usedMessage = (value: string, used: number) => `Estimate point "${value}" is used by ${used} work item${used === 1 ? "" : "s"}; switch or clear them first`;

/** Points are numbers kept as plain text ("0.5", "13"); categories are free labels. Either way no two values are equal. */
function normalizeValues(type: EstimateType, values: string[]) {
  if (values.length < minEstimatePoints || values.length > maxEstimatePoints) throw new ActionError(`An Estimate needs ${minEstimatePoints} to ${maxEstimatePoints} values`, 400);
  const cleaned = values.map((value) => value.trim());
  for (const value of cleaned) {
    if (value === "") throw new ActionError("An Estimate value must not be empty", 400);
    if (type === "points" && !/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/.test(value)) throw new ActionError(`"${value}" is not a number; points must be numbers`, 400);
  }
  const keys = cleaned.map((value) => (type === "points" ? String(Number(value)) : value.toLowerCase()));
  if (new Set(keys).size !== keys.length) throw new ActionError("Estimate values must be different from each other", 400);
  return cleaned;
}

/** Live work items of a project that hold an Estimate point, with the value they hold. */
async function sizedItems(database: Database, projectId: string) {
  return database.select({ id: workItems.id, value: estimatePoints.value }).from(workItems)
    .innerJoin(estimatePoints, eq(estimatePoints.id, workItems.estimatePointId)).where(and(eq(workItems.projectId, projectId), liveWorkItems)).orderBy(asc(workItems.id));
}

/** Clears the Estimate point of every work item in the project (soft-deleted ones too) and logs one Activity per live work item that had one. Returns that count. */
async function clearProjectPoints(database: Database, context: Context, project: { id: string; workspaceId: string }) {
  const sized = await sizedItems(database, project.id);
  await database.update(workItems).set({ estimatePointId: null }).where(and(eq(workItems.projectId, project.id), isNotNull(workItems.estimatePointId)));
  for (let start = 0; start < sized.length; start += clearBatchSize) {
    for (const item of sized.slice(start, start + clearBatchSize)) {
      await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: "estimate", oldValue: item.value, newValue: null });
    }
  }
  return sized.length;
}

export function createEstimateActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  async function present(database: Database, row: EstimateRow) {
    const points = await database.select().from(estimatePoints).where(eq(estimatePoints.estimateId, row.id)).orderBy(asc(estimatePoints.position), asc(estimatePoints.id));
    return { id: row.id, projectId: row.projectId, name: row.name, type: row.type as EstimateType, enabled: row.enabled, points: points.map((point) => ({ id: point.id, position: point.position, value: point.value })) };
  }

  async function estimateOf(database: Database, projectId: string) {
    const [row] = await database.select().from(estimates).where(eq(estimates.projectId, projectId));
    return row ?? null;
  }

  return {
    /** Null when the project has no Estimate; a turned-off Estimate is visible to project Admins only. */
    getEstimate: {
      name: "get_estimate", kind: "read" as const,
      input: Type.Object({ projectId: uuid() }), output: Type.Union([estimateOutput, Type.Null()]),
      handler: async (context: Context, input: { projectId: string }) => {
        const { workspaceRole, projectRole } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        const row = await estimateOf(db, input.projectId);
        if (!row) return null;
        if (!row.enabled && workspaceRole !== "Admin" && projectRole !== "Admin") return null;
        return present(db, row);
      },
    },
    createEstimate: {
      name: "create_estimate", kind: "write" as const,
      input: Type.Object({ projectId: uuid(), name: Type.Optional(nameSchema), type: typeSchema, values: Type.Array(valueSchema, { minItems: minEstimatePoints, maxItems: maxEstimatePoints }) }),
      output: estimateOutput,
      handler: async (context: Context, input: { projectId: string; name?: string; type: EstimateType; values: string[] }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        const values = normalizeValues(input.type, input.values);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [row] = await database.insert(estimates).values({
            workspaceId: project.workspaceId, projectId: project.id, name: input.name?.trim() || "Estimate", type: input.type, createdBy: context.userId,
          }).onConflictDoNothing().returning();
          if (!row) throw new ActionError("This project already has an Estimate", 409);
          await database.insert(estimatePoints).values(values.map((value, position) => ({ estimateId: row.id, position, value })));
          return present(database, row);
        });
      },
    },
    /** `points` is the full ordered list: a point with an id is kept (renamed, moved), one without is added, one left out is deleted unless a work item uses it. Enabling is allowed while off; every other change is refused. */
    updateEstimate: {
      name: "update_estimate", kind: "write" as const,
      input: Type.Object({
        projectId: uuid(), name: Type.Optional(nameSchema), enabled: Type.Optional(Type.Boolean()),
        points: Type.Optional(Type.Array(Type.Object({ id: Type.Optional(uuid()), value: valueSchema }), { minItems: minEstimatePoints, maxItems: maxEstimatePoints })),
      }),
      output: estimateOutput,
      handler: async (context: Context, input: { projectId: string; name?: string; enabled?: boolean; points?: Array<{ id?: string; value: string }> }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [current] = await database.select().from(estimates).where(eq(estimates.projectId, input.projectId)).for("update");
          if (!current) throw new ActionError("This project has no Estimate", 404);
          const editing = input.name !== undefined || input.points !== undefined;
          if (!current.enabled && editing && input.enabled !== true) throw new ActionError("The Estimate is turned off", 400);
          if (input.points) {
            const values = normalizeValues(current.type as EstimateType, input.points.map((point) => point.value));
            const existing = await database.select().from(estimatePoints).where(eq(estimatePoints.estimateId, current.id));
            const known = new Set(existing.map((point) => point.id)), kept = new Set<string>();
            for (const point of input.points) {
              if (!point.id) continue;
              if (!known.has(point.id)) throw new ActionError("Estimate point not found in this Estimate", 400);
              if (kept.has(point.id)) throw new ActionError("An Estimate point is listed twice", 400);
              kept.add(point.id);
            }
            for (const point of existing.filter((entry) => !kept.has(entry.id))) {
              const used = await pointUsage(database, point.id);
              if (used > 0) throw new ActionError(usedMessage(point.value, used), 409);
              await database.delete(estimatePoints).where(eq(estimatePoints.id, point.id));
            }
            for (const [position, point] of input.points.entries()) {
              if (point.id) await database.update(estimatePoints).set({ position, value: values[position]! }).where(eq(estimatePoints.id, point.id));
              else await database.insert(estimatePoints).values({ estimateId: current.id, position, value: values[position]! });
            }
          }
          const [row] = await database.update(estimates).set({ name: input.name?.trim() || current.name, enabled: input.enabled ?? current.enabled }).where(eq(estimates.id, current.id)).returning();
          return present(database, row!);
        });
      },
    },
    /** How many work items hold an Estimate point: the count a switch or delete would clear. Admin only, as the actions that need it. */
    getEstimateUsage: {
      name: "get_estimate_usage", kind: "read" as const,
      input: Type.Object({ projectId: uuid() }), output: Type.Object({ workItems: Type.Integer() }),
      handler: async (context: Context, input: { projectId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "admin");
        return { workItems: (await sizedItems(db, input.projectId)).length };
      },
    },
    /** Replaces the Estimate with the other system (points or categories) and clears every Estimate point in the project, in one transaction. */
    switchEstimateType: {
      name: "switch_estimate_type", kind: "write" as const,
      input: Type.Object({ projectId: uuid(), type: typeSchema, values: Type.Array(valueSchema, { minItems: minEstimatePoints, maxItems: maxEstimatePoints }) }),
      output: Type.Composite([estimateOutput, Type.Object({ cleared: Type.Integer() })]),
      handler: async (context: Context, input: { projectId: string; type: EstimateType; values: string[] }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        const values = normalizeValues(input.type, input.values);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [current] = await database.select().from(estimates).where(eq(estimates.projectId, input.projectId)).for("update");
          if (!current) throw new ActionError("This project has no Estimate", 404);
          if (!current.enabled) throw new ActionError("The Estimate is turned off", 400);
          if (current.type === input.type) throw new ActionError(`The Estimate already uses ${input.type}; switch to the other system`, 400);
          const cleared = await clearProjectPoints(database, context, project);
          await database.delete(estimatePoints).where(eq(estimatePoints.estimateId, current.id));
          await database.insert(estimatePoints).values(values.map((value, position) => ({ estimateId: current.id, position, value })));
          const [row] = await database.update(estimates).set({ type: input.type }).where(eq(estimates.id, current.id)).returning();
          return { ...(await present(database, row!)), cleared };
        });
      },
    },
    /** Deletes the Estimate and clears every Estimate point in the project, in one transaction. Idempotent: a project with no Estimate answers removed false. */
    deleteEstimate: {
      name: "delete_estimate", kind: "write" as const,
      input: Type.Object({ projectId: uuid() }), output: Type.Object({ removed: Type.Boolean(), cleared: Type.Integer() }),
      handler: async (context: Context, input: { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [current] = await database.select().from(estimates).where(eq(estimates.projectId, input.projectId)).for("update");
          if (!current) return { removed: false, cleared: 0 };
          const cleared = await clearProjectPoints(database, context, project);
          await database.delete(estimates).where(eq(estimates.id, current.id));
          return { removed: true, cleared };
        });
      },
    },
    /** Deletes one point: only while no work item uses it, and never below the minimum of 2. */
    deleteEstimatePoint: {
      name: "delete_estimate_point", kind: "write" as const,
      input: Type.Object({ pointId: uuid() }), output: estimateOutput,
      handler: async (context: Context, input: { pointId: string }) => {
        const [found] = await db.select({ estimateId: estimatePoints.estimateId, projectId: estimates.projectId }).from(estimatePoints)
          .innerJoin(estimates, eq(estimates.id, estimatePoints.estimateId)).where(eq(estimatePoints.id, input.pointId));
        if (!found) throw new ActionError("Estimate point not found", 404);
        await requireProjectAccess(db, context.userId, found.projectId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const [current] = await database.select().from(estimates).where(eq(estimates.id, found.estimateId)).for("update");
          if (!current!.enabled) throw new ActionError("The Estimate is turned off", 400);
          const points = await database.select().from(estimatePoints).where(eq(estimatePoints.estimateId, current!.id)).orderBy(asc(estimatePoints.position));
          const target = points.find((point) => point.id === input.pointId);
          if (!target) throw new ActionError("Estimate point not found", 404);
          if (points.length <= minEstimatePoints) throw new ActionError(`An Estimate needs at least ${minEstimatePoints} values`, 400);
          const used = await pointUsage(database, target.id);
          if (used > 0) throw new ActionError(usedMessage(target.value, used), 409);
          await database.delete(estimatePoints).where(eq(estimatePoints.id, target.id));
          for (const [position, point] of points.filter((entry) => entry.id !== target.id).entries()) await database.update(estimatePoints).set({ position }).where(eq(estimatePoints.id, point.id));
          return present(database, current!);
        });
      },
    },
  };
}
