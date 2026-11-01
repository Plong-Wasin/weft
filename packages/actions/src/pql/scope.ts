import { and, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { cycleItems, cycles, moduleItems, modules, projects, workItems } from "@weft/db";
import { ActionError } from "../members";
import { assertFeatureEnabled, type ProjectFeature } from "../features";
import { createPqlRegistry, list, relationField } from "./registry";
import type { Named, PqlContext, PqlField, PqlFunction } from "./types";

/** Loads a project-wide lookup once per compiled query (the context object lives for one query). */
const lookups = new WeakMap<PqlContext, Map<string, Promise<unknown>>>();
function once<T>(context: PqlContext, key: string, load: () => Promise<T>): Promise<T> {
  let cache = lookups.get(context);
  if (!cache) lookups.set(context, (cache = new Map()));
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key) as Promise<T>;
}

/** A query that names Cycles or Modules is a clear 400 when the project has turned that feature off. */
async function requireFeature(context: PqlContext, feature: ProjectFeature) {
  await once(context, `feature:${feature}`, async () => {
    const [project] = await context.db.select().from(projects).where(eq(projects.id, context.projectId));
    if (!project) throw new ActionError("Project not found", 404);
    assertFeatureEnabled(project, feature);
  });
}

/** Names that resolve: live Cycles of this project. Archived and deleted ones count as missing. */
const liveCycles = (context: PqlContext) => once<Array<Named & { startDate: string; endDate: string }>>(context, "cycles", async () => {
  await requireFeature(context, "cycles");
  return context.db.select({ id: cycles.id, name: cycles.name, startDate: cycles.startDate, endDate: cycles.endDate }).from(cycles)
    .where(and(eq(cycles.projectId, context.projectId), isNull(cycles.deletedAt), isNull(cycles.archivedAt)));
});

const liveModules = (context: PqlContext) => once<Named[]>(context, "modules", async () => {
  await requireFeature(context, "modules");
  return context.db.select({ id: modules.id, name: modules.name }).from(modules)
    .where(and(eq(modules.projectId, context.projectId), isNull(modules.deletedAt), isNull(modules.archivedAt)));
});

// IS NULL and IS NOT NULL look at membership of a Cycle or Module that is not deleted (an archived one still holds its items).
const cycleLinked = (ids: string[] | null) => sql`exists (select 1 from ${cycleItems} ci join ${cycles} c on c.id = ci.cycle_id
  where ci.work_item_id = ${workItems.id} and c.deleted_at is null${ids ? sql` and ci.cycle_id in (${list(ids)})` : sql``})`;
const moduleLinked = (ids: string[] | null) => sql`exists (select 1 from ${moduleItems} mi join ${modules} m on m.id = mi.module_id
  where mi.work_item_id = ${workItems.id} and m.deleted_at is null${ids ? sql` and mi.module_id in (${list(ids)})` : sql``})`;

/**
 * Wraps a relation field so the feature check also runs for IS NULL, which never resolves a name.
 * Value functions such as activeCycle() are checked by their own `evaluate`.
 */
function guarded(field: PqlField, feature: ProjectFeature): PqlField {
  return { ...field, async compile(context, operator, operands, operatorPos) { await requireFeature(context, feature); return field.compile(context, operator, operands, operatorPos); } };
}

export const scopeFields: PqlField[] = [
  guarded(relationField({ name: "cycle", kind: "cycle", accepts: ["cycle"], entries: liveCycles, linked: cycleLinked }), "cycles"),
  guarded(relationField({ name: "module", kind: "module", accepts: ["module"], entries: liveModules, linked: moduleLinked }), "modules"),
];

export const scopeFunctions: PqlFunction[] = [
  {
    // Cycles may overlap in dates, so more than one can be active; `cycle = activeCycle()` then matches any of them.
    name: "activeCycle", kind: "value", returns: "cycle", list: false,
    evaluate: async (context) => (await liveCycles(context)).filter((cycle) => cycle.startDate <= context.today && context.today <= cycle.endDate).map((cycle) => cycle.id),
  },
];

/** The registry list_work_items and search_work_items compile with: the built-in fields plus cycle, module and activeCycle(). */
export const weftPqlRegistry = createPqlRegistry({ fields: scopeFields, functions: scopeFunctions });
