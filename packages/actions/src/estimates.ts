import { Type } from "@sinclair/typebox";
import { asc, eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { estimatePoints, estimates } from "@weft/db";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";

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
type Context = { userId: string };
type EstimateRow = typeof estimates.$inferSelect;

/** Whether work items hold this Estimate point. Work items do not use the Estimate yet, so nothing does; the work item field replaces this. */
async function pointInUse(_database: Database, _pointId: string) {
  return false;
}

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
              if (await pointInUse(database, point.id)) throw new ActionError(`Estimate point "${point.value}" is used by work items; switch or clear them first`, 409);
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
          if (await pointInUse(database, target.id)) throw new ActionError(`Estimate point "${target.value}" is used by work items; switch or clear them first`, 409);
          await database.delete(estimatePoints).where(eq(estimatePoints.id, target.id));
          for (const [position, point] of points.filter((entry) => entry.id !== target.id).entries()) await database.update(estimatePoints).set({ position }).where(eq(estimatePoints.id, point.id));
          return present(database, current!);
        });
      },
    },
  };
}
