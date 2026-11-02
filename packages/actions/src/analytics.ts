import { Type } from "@sinclair/typebox";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@weft/db";
import { notInTriageFor } from "./triage";
import { ActionError, requireWorkspaceRole } from "./members";
import { accessibleProjects } from "./projects";
import { todayIso } from "./cycles";
import type { ActivityContext } from "./work-items";

/** The axes of Customized insights. Date axes bucket by month; the others split by a value of the work item. */
export const analyticsAxes = ["state", "stateGroup", "priority", "label", "assignee", "cycle", "module", "createdDate", "dueDate", "startDate", "completedDate"] as const;
export type AnalyticsAxis = (typeof analyticsAxes)[number];

const uuid = () => Type.String({ format: "uuid" });
const axisSchema = Type.Union(analyticsAxes.map((axis) => Type.Literal(axis)));
const projectIdsSchema = Type.Optional(Type.Array(uuid(), { maxItems: 500, description: "Only these projects; projects the caller cannot read are left out. Omit for every project the caller can read." }));
const bucketSchema = Type.Object({ key: Type.Union([Type.String(), Type.Null()]), label: Type.Union([Type.String(), Type.Null()]), count: Type.Integer() });

type Context = ActivityContext;
type Bucket = { key: string | null; label: string | null; count: number };
type Row = { xk: string | null; xl: string | null; gk?: string | null; gl?: string | null; n: string | number };

/**
 * Each axis as a lateral subquery over the work item alias `i`: one row per value (key, label), and a single row with a null key when the item has none.
 * Multi-valued axes (label, assignee, module) therefore count an item under each value and under "none".
 */
function dimension(axis: AnalyticsAxis): SQL {
  const orNone = (values: SQL) => sql`select * from (${values}) v union all select null::text, null::text where not exists (${values})`;
  switch (axis) {
    case "state": return sql`select s.name as k, s.name as l from work_item_states s where s.id = i.state_id`;
    case "stateGroup": return sql`select s.state_group as k, null::text as l from work_item_states s where s.id = i.state_id`;
    case "priority": return sql`select i.priority as k, null::text as l`;
    case "label": return orNone(sql`select l.name as k, l.name as l from work_item_labels wl join labels l on l.id = wl.label_id where wl.work_item_id = i.id`);
    case "assignee": return orNone(sql`select u.id as k, u.name as l from work_item_assignees wa join "user" u on u.id = wa.user_id where wa.work_item_id = i.id`);
    case "cycle": return orNone(sql`select c.id::text as k, c.name as l from cycle_items ci join cycles c on c.id = ci.cycle_id and c.deleted_at is null where ci.work_item_id = i.id`);
    case "module": return orNone(sql`select m.id::text as k, m.name as l from module_items mi join modules m on m.id = mi.module_id and m.deleted_at is null where mi.work_item_id = i.id`);
    case "createdDate": return sql`select to_char(i.created_at at time zone 'UTC', 'YYYY-MM') as k, null::text as l`;
    case "dueDate": return sql`select to_char(i.due_date, 'YYYY-MM') as k, null::text as l`;
    case "startDate": return sql`select to_char(i.start_date, 'YYYY-MM') as k, null::text as l`;
    case "completedDate": return sql`select to_char(i.completed_at at time zone 'UTC', 'YYYY-MM') as k, null::text as l`;
  }
}

const isDateAxis = (axis: AnalyticsAxis) => axis.endsWith("Date");
const priorityOrder = ["urgent", "high", "medium", "low", "none"];
const groupOrder = ["backlog", "unstarted", "started", "completed", "cancelled"];

/** Fixed orders for enums, chronological for months, alphabetical for names; "none" always last. */
function sortBuckets<T extends { key: string | null; label: string | null }>(axis: AnalyticsAxis, buckets: T[]): T[] {
  const rank = (bucket: T) => {
    if (bucket.key === null) return Number.MAX_SAFE_INTEGER;
    if (axis === "priority") return priorityOrder.indexOf(bucket.key);
    if (axis === "stateGroup") return groupOrder.indexOf(bucket.key);
    return 0;
  };
  return [...buckets].sort((a, b) => rank(a) - rank(b) || (isDateAxis(axis) ? (a.key ?? "").localeCompare(b.key ?? "") : (a.label ?? a.key ?? "").localeCompare(b.label ?? b.key ?? "")));
}

export function createAnalyticsActions(db: Database) {
  /** Admin and Member only (a Guest is refused), over the projects the caller can read, optionally narrowed to `projectIds`. */
  async function scope(context: Context, input: { workspaceId: string; projectIds?: string[] }) {
    await requireWorkspaceRole(db, context.userId, input.workspaceId, "write");
    const readable = await accessibleProjects(db, context.userId, input.workspaceId);
    const wanted = input.projectIds ? new Set(input.projectIds) : null;
    return readable.filter((project) => !wanted || wanted.has(project.id)).map((project) => project.id);
  }

  /** Not deleted, not archived, not in Triage, in the chosen projects: the one filter every number shares. */
  function itemsWhere(projectIds: string[]): SQL {
    const ids = sql.join(projectIds.map((id) => sql`${id}::uuid`), sql`, `);
    return sql`i.deleted_at is null and i.archived_at is null and ${notInTriageFor(sql`i.state_id`)} and i.project_id in (${ids})`;
  }

  return {
    getAnalyticsSummary: {
      name: "get_analytics_summary", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid(), projectIds: projectIdsSchema }),
      output: Type.Object({ total: Type.Integer(), open: Type.Integer(), completed: Type.Integer(), overdue: Type.Integer() }),
      handler: async (context: Context, input: { workspaceId: string; projectIds?: string[] }) => {
        const projectIds = await scope(context, input);
        if (projectIds.length === 0) return { total: 0, open: 0, completed: 0, overdue: 0 };
        const today = todayIso();
        const rows = await db.execute(sql`
          select count(*) as total,
            count(*) filter (where s.state_group not in ('completed', 'cancelled')) as open,
            count(*) filter (where s.state_group = 'completed') as completed,
            count(*) filter (where s.state_group not in ('completed', 'cancelled') and i.due_date < ${today}::date) as overdue
          from work_items i join work_item_states s on s.id = i.state_id where ${itemsWhere(projectIds)}`) as unknown as Array<Record<string, string | number>>;
        const row = rows[0]!;
        return { total: Number(row.total), open: Number(row.open), completed: Number(row.completed), overdue: Number(row.overdue) };
      },
    },
    getAnalyticsInsights: {
      name: "get_analytics_insights", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid(), x: axisSchema, groupBy: Type.Optional(axisSchema), projectIds: projectIdsSchema }),
      output: Type.Object({
        x: axisSchema, groupBy: Type.Union([axisSchema, Type.Null()]),
        /** One bucket per X value, in display order. `count` is work items; with a Group-by each bucket carries the split, and an item with several group values is counted under each. A null key is "none". */
        buckets: Type.Array(Type.Intersect([bucketSchema, Type.Object({ groups: Type.Array(bucketSchema) })])),
      }),
      handler: async (context: Context, input: { workspaceId: string; x: AnalyticsAxis; groupBy?: AnalyticsAxis; projectIds?: string[] }) => {
        if (input.groupBy === input.x) throw new ActionError("Group-by must differ from the X axis", 400);
        const projectIds = await scope(context, input);
        const groupBy = input.groupBy ?? null;
        if (projectIds.length === 0) return { x: input.x, groupBy, buckets: [] };
        const base = sql`from work_items i join lateral (${dimension(input.x)}) x on true`;
        const totals = await db.execute(sql`select x.k as xk, max(x.l) as xl, count(distinct i.id) as n ${base} where ${itemsWhere(projectIds)} group by x.k`) as unknown as Row[];
        const split = groupBy ? await db.execute(sql`select x.k as xk, g.k as gk, max(g.l) as gl, count(distinct i.id) as n ${base} join lateral (${dimension(groupBy)}) g on true where ${itemsWhere(projectIds)} group by x.k, g.k`) as unknown as Row[] : [];
        const buckets = sortBuckets(input.x, totals.map((row) => ({ key: row.xk, label: row.xl, count: Number(row.n) })));
        return {
          x: input.x, groupBy,
          buckets: buckets.map((bucket) => ({
            ...bucket,
            groups: groupBy ? sortBuckets(groupBy, split.filter((row) => row.xk === bucket.key).map((row) => ({ key: row.gk ?? null, label: row.gl ?? null, count: Number(row.n) }))) : [],
          })),
        };
      },
    },
  };
}
