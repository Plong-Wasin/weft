import { Type } from "@sinclair/typebox";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, modelPrices, runs, users } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";

/** USD per million tokens for one model, as the admin typed them. */
export type ModelPrice = { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion: number | null };
export type PriceTable = Map<string, ModelPrice>;

/** The prices of one workspace, keyed by model name. A model without a row has no price: its cost reads as unknown. */
export async function loadPriceTable(database: Database, workspaceId: string): Promise<PriceTable> {
  const rows = await database.select({ model: modelPrices.model, input: modelPrices.inputUsdPerMillion, output: modelPrices.outputUsdPerMillion, cached: modelPrices.cachedInputUsdPerMillion })
    .from(modelPrices).where(eq(modelPrices.workspaceId, workspaceId));
  return new Map(rows.map((row) => [row.model, { inputUsdPerMillion: Number(row.input), outputUsdPerMillion: Number(row.output), cachedInputUsdPerMillion: row.cached === null ? null : Number(row.cached) }]));
}

export type RunUsage = {
  usageReported: boolean; inputTokens: number; outputTokens: number; model: string | null;
  cacheReadTokens?: number; cacheCreationTokens?: number;
  /** The total cost the CLI itself reported, when it did. */
  reportedCostUsd?: number | null;
};

/**
 * The USD cost of one Run: the cost the provider's CLI reported when there is one (it knows the real rates), otherwise the reported tokens
 * at the model's price. Fresh input is priced at the input price, cache reads at the cached-input price (the input price when none is set),
 * and cache creation at the input price. Null when the usage was not reported, the Run has no model, or the model has no price: unknown is never shown as zero.
 */
export function estimateCostUsd(usage: RunUsage, prices: PriceTable): number | null {
  if (usage.reportedCostUsd !== null && usage.reportedCostUsd !== undefined) return roundUsd(usage.reportedCostUsd);
  if (!usage.usageReported || !usage.model) return null;
  const price = prices.get(usage.model);
  if (!price) return null;
  const cacheRead = usage.cacheReadTokens ?? 0, cacheCreation = usage.cacheCreationTokens ?? 0;
  return roundUsd((
    (usage.inputTokens + cacheCreation) * price.inputUsdPerMillion + cacheRead * (price.cachedInputUsdPerMillion ?? price.inputUsdPerMillion) + usage.outputTokens * price.outputUsdPerMillion
  ) / 1_000_000);
}

const priceOutput = Type.Object({ id: Type.String(), model: Type.String(), inputUsdPerMillion: Type.Number(), outputUsdPerMillion: Type.Number(), cachedInputUsdPerMillion: Type.Union([Type.Number(), Type.Null()]), updatedAt: Type.String() });
const dayPattern = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const usageRow = Type.Object({
  day: Type.String(), agentId: Type.Union([Type.String(), Type.Null()]), agentName: Type.Union([Type.String(), Type.Null()]),
  personId: Type.String(), personName: Type.String(),
  runs: Type.Integer(), unknownUsageRuns: Type.Integer(), unknownCostRuns: Type.Integer(),
  inputTokens: Type.Union([Type.Integer(), Type.Null()]), outputTokens: Type.Union([Type.Integer(), Type.Null()]),
  cacheReadTokens: Type.Union([Type.Integer(), Type.Null()]), cacheCreationTokens: Type.Union([Type.Integer(), Type.Null()]),
  /** How many of the Runs behind `estimatedCostUsd` carry the cost their CLI reported rather than an estimate from the price table. */
  reportedCostRuns: Type.Integer(),
  elapsedMs: Type.Union([Type.Integer(), Type.Null()]), estimatedCostUsd: Type.Union([Type.Number(), Type.Null()]),
});
const usageSummaryOutput = Type.Object({
  from: Type.String(), to: Type.String(), rows: Type.Array(usageRow),
  /** Models that have Runs with reported usage in the range but no price (and no cost reported by the CLI): their cost reads as unknown until an Admin adds a price. */
  unpricedModels: Type.Array(Type.Object({ model: Type.String(), runs: Type.Integer() })),
  totals: Type.Object({ runs: Type.Integer(), unknownUsageRuns: Type.Integer(), unknownCostRuns: Type.Integer(), reportedCostRuns: Type.Integer(), inputTokens: Type.Union([Type.Integer(), Type.Null()]), outputTokens: Type.Union([Type.Integer(), Type.Null()]), cacheReadTokens: Type.Union([Type.Integer(), Type.Null()]), cacheCreationTokens: Type.Union([Type.Integer(), Type.Null()]), elapsedMs: Type.Union([Type.Integer(), Type.Null()]), estimatedCostUsd: Type.Union([Type.Number(), Type.Null()]) }),
});

const utcMonthRange = (now: Date) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
};

/** Sums the Runs of one workspace by UTC day, Agent, person and model over an inclusive date range. Queued and skipped Runs never reached the CLI, so they are left out. */
export async function summarizeUsage(database: Database, workspaceId: string, from: string, to: string) {
  // The day is written without bound parameters so the SELECT and GROUP BY expressions match exactly.
  const day = sql<string>`((${runs.createdAt} at time zone 'UTC')::date)::text`;
  const hasReportedCost = sql<boolean>`(${runs.reportedCostUsd} is not null)`;
  const inRange = and(sql`(${runs.createdAt} at time zone 'UTC')::date >= ${from}::date`, sql`(${runs.createdAt} at time zone 'UTC')::date <= ${to}::date`);
  const grouped = await database.select({
    day, agentId: runs.agentId, agentName: users.name, personId: runs.originatorId,
    personName: sql<string>`(select name from "user" where id = ${runs.originatorId})`,
    model: runs.model, reported: runs.usageReported, hasReportedCost, runs: sql<number>`count(*)::int`,
    // Summed as bigint: a month of Runs passes 2^31 tokens. The driver returns bigint as text, so it is converted below.
    input: sql<string>`coalesce(sum(${runs.inputTokens}::bigint), 0)::bigint`, output: sql<string>`coalesce(sum(${runs.outputTokens}::bigint), 0)::bigint`,
    cacheRead: sql<string>`coalesce(sum(${runs.cacheReadTokens}::bigint), 0)::bigint`, cacheCreation: sql<string>`coalesce(sum(${runs.cacheCreationTokens}::bigint), 0)::bigint`,
    reportedCost: sql<string>`coalesce(sum(${runs.reportedCostUsd}), 0)::float8`,
    timedRuns: sql<number>`count(*) filter (where ${runs.startedAt} is not null and ${runs.finishedAt} is not null)::int`,
    elapsedMs: sql<number>`coalesce(sum(extract(epoch from (${runs.finishedAt} - ${runs.startedAt})) * 1000) filter (where ${runs.startedAt} is not null and ${runs.finishedAt} is not null), 0)::float8`,
  }).from(runs)
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(users, eq(users.id, agents.userId))
    .where(and(eq(runs.workspaceId, workspaceId), notInArray(runs.status, ["queued", "skipped"]), inRange))
    .groupBy(day, runs.agentId, users.name, runs.originatorId, runs.model, runs.usageReported, hasReportedCost)
    .orderBy(asc(day));
  const prices = await loadPriceTable(database, workspaceId);
  type Row = { day: string; agentId: string | null; agentName: string | null; personId: string; personName: string; runs: number; unknownUsageRuns: number; unknownCostRuns: number; tokenRuns: number; reportedCostRuns: number; input: number; output: number; cacheRead: number; cacheCreation: number; timedRuns: number; elapsedMs: number; costUsd: number | null };
  const byKey = new Map<string, Row>();
  const unpriced = new Map<string, number>();
  for (const line of grouped) {
    const key = `${line.day}|${line.agentId ?? ""}|${line.personId}`;
    const row = byKey.get(key) ?? { day: line.day, agentId: line.agentId, agentName: line.agentName, personId: line.personId, personName: line.personName ?? "", runs: 0, unknownUsageRuns: 0, unknownCostRuns: 0, tokenRuns: 0, reportedCostRuns: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, timedRuns: 0, elapsedMs: 0, costUsd: null };
    byKey.set(key, row);
    row.runs += line.runs;
    if (line.reported) { row.tokenRuns += line.runs; row.input += Number(line.input); row.output += Number(line.output); row.cacheRead += Number(line.cacheRead); row.cacheCreation += Number(line.cacheCreation); } else row.unknownUsageRuns += line.runs;
    row.timedRuns += line.timedRuns; row.elapsedMs += Number(line.elapsedMs);
    const cost = estimateCostUsd({
      usageReported: line.reported, inputTokens: Number(line.input), outputTokens: Number(line.output), cacheReadTokens: Number(line.cacheRead), cacheCreationTokens: Number(line.cacheCreation),
      model: line.model, reportedCostUsd: line.hasReportedCost ? Number(line.reportedCost) : null,
    }, prices);
    if (line.hasReportedCost) row.reportedCostRuns += line.runs;
    else if (line.reported && (!line.model || !prices.has(line.model))) {
      const model = line.model ?? "__model_not_reported__";
      unpriced.set(model, (unpriced.get(model) ?? 0) + line.runs);
    }
    if (cost === null) row.unknownCostRuns += line.runs;
    else row.costUsd = (row.costUsd ?? 0) + cost;
  }
  const rows = [...byKey.values()].map((row) => ({
    day: row.day, agentId: row.agentId, agentName: row.agentName, personId: row.personId, personName: row.personName,
    runs: row.runs, unknownUsageRuns: row.unknownUsageRuns, unknownCostRuns: row.unknownCostRuns, reportedCostRuns: row.reportedCostRuns,
    inputTokens: row.tokenRuns > 0 ? row.input : null, outputTokens: row.tokenRuns > 0 ? row.output : null,
    cacheReadTokens: row.tokenRuns > 0 ? row.cacheRead : null, cacheCreationTokens: row.tokenRuns > 0 ? row.cacheCreation : null,
    elapsedMs: row.timedRuns > 0 ? Math.round(row.elapsedMs) : null, estimatedCostUsd: row.costUsd === null ? null : roundUsd(row.costUsd),
  }));
  const sumKnown = (values: Array<number | null>) => values.some((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
  const totals = {
    runs: rows.reduce((total, row) => total + row.runs, 0),
    unknownUsageRuns: rows.reduce((total, row) => total + row.unknownUsageRuns, 0),
    unknownCostRuns: rows.reduce((total, row) => total + row.unknownCostRuns, 0),
    reportedCostRuns: rows.reduce((total, row) => total + row.reportedCostRuns, 0),
    inputTokens: sumKnown(rows.map((row) => row.inputTokens)), outputTokens: sumKnown(rows.map((row) => row.outputTokens)),
    cacheReadTokens: sumKnown(rows.map((row) => row.cacheReadTokens)), cacheCreationTokens: sumKnown(rows.map((row) => row.cacheCreationTokens)),
    elapsedMs: sumKnown(rows.map((row) => row.elapsedMs)), estimatedCostUsd: sumKnown(rows.map((row) => row.estimatedCostUsd)),
  };
  if (totals.estimatedCostUsd !== null) totals.estimatedCostUsd = roundUsd(totals.estimatedCostUsd);
  const unpricedModels = [...unpriced.entries()].map(([model, count]) => ({ model, runs: count })).sort((a, b) => a.model.localeCompare(b.model));
  return { from, to, rows, unpricedModels, totals };
}

const roundUsd = (value: number) => Math.round(value * 1e6) / 1e6;

function checkRange(from: string | undefined, to: string | undefined, now: Date) {
  const month = utcMonthRange(now);
  const start = from ?? month.from;
  const end = to ?? month.to;
  if (start > end) throw new ActionError("The start date must be on or before the end date", 400);
  if (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) > 366 * 86_400_000) throw new ActionError("Pick a range of one year or less", 400);
  return { from: start, to: end };
}

/** Usage and the price table are for workspace Admins: they show what each person and Agent spent. */
export function createUsageActions(db: Database, now: () => Date = () => new Date()) {
  return {
    getUsageSummary: {
      name: "get_usage_summary", kind: "read" as const,
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }), from: Type.Optional(dayPattern), to: Type.Optional(dayPattern) }),
      output: usageSummaryOutput,
      handler: async (context: { userId: string }, input: { workspaceId: string; from?: string; to?: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const range = checkRange(input.from, input.to, now());
        return summarizeUsage(db, input.workspaceId, range.from, range.to);
      },
    },
    listModelPrices: {
      name: "list_model_prices", kind: "read" as const,
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }) }), output: Type.Array(priceOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        return (await db.select().from(modelPrices).where(eq(modelPrices.workspaceId, input.workspaceId)).orderBy(asc(modelPrices.model)))
          .map((row) => ({ id: row.id, model: row.model, inputUsdPerMillion: Number(row.inputUsdPerMillion), outputUsdPerMillion: Number(row.outputUsdPerMillion), cachedInputUsdPerMillion: row.cachedInputUsdPerMillion === null ? null : Number(row.cachedInputUsdPerMillion), updatedAt: row.updatedAt.toISOString() }));
      },
    },
    setModelPrice: {
      name: "set_model_price", kind: "write" as const,
      input: Type.Object({
        workspaceId: Type.String({ format: "uuid" }), model: Type.String({ minLength: 1, maxLength: 120 }),
        inputUsdPerMillion: Type.Number({ minimum: 0, maximum: 100_000 }), outputUsdPerMillion: Type.Number({ minimum: 0, maximum: 100_000 }),
        /** Price of cache-read input tokens. Leave out to price them at the input price. */
        cachedInputUsdPerMillion: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 100_000 }), Type.Null()])),
      }),
      output: priceOutput,
      handler: async (context: { userId: string }, input: { workspaceId: string; model: string; inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number | null }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const model = input.model.trim();
        if (!model) throw new ActionError("Enter the model name", 400);
        const values = { workspaceId: input.workspaceId, model, inputUsdPerMillion: String(input.inputUsdPerMillion), outputUsdPerMillion: String(input.outputUsdPerMillion), cachedInputUsdPerMillion: input.cachedInputUsdPerMillion === null || input.cachedInputUsdPerMillion === undefined ? null : String(input.cachedInputUsdPerMillion), updatedBy: context.userId, updatedAt: now() };
        const [row] = await db.insert(modelPrices).values(values).onConflictDoUpdate({ target: [modelPrices.workspaceId, modelPrices.model], set: values }).returning();
        return { id: row!.id, model: row!.model, inputUsdPerMillion: Number(row!.inputUsdPerMillion), outputUsdPerMillion: Number(row!.outputUsdPerMillion), cachedInputUsdPerMillion: row!.cachedInputUsdPerMillion === null ? null : Number(row!.cachedInputUsdPerMillion), updatedAt: row!.updatedAt.toISOString() };
      },
    },
    deleteModelPrice: {
      name: "delete_model_price", kind: "write" as const,
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }), priceId: Type.String({ format: "uuid" }) }), output: Type.Object({ ok: Type.Literal(true) }),
      handler: async (context: { userId: string }, input: { workspaceId: string; priceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const deleted = await db.delete(modelPrices).where(and(eq(modelPrices.id, input.priceId), eq(modelPrices.workspaceId, input.workspaceId))).returning({ id: modelPrices.id });
        if (deleted.length === 0) throw new ActionError("Price not found", 404);
        return { ok: true as const };
      },
    },
  };
}
