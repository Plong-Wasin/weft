import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { runs } from "@weft/db";

/** The first instant of the UTC calendar month containing `now`: budgets reset here. */
export function monthStart(now: Date = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Tokens the Agent's Runs created this calendar month reported from the provider (input plus output). */
export async function agentMonthlyUsage(database: Database, agentId: string, now: Date = new Date()) {
  const start = monthStart(now);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const [row] = await database.select({ used: sql<number>`coalesce(sum(${runs.inputTokens} + ${runs.outputTokens}), 0)::int` }).from(runs)
    .where(and(eq(runs.agentId, agentId), gte(runs.createdAt, start), lt(runs.createdAt, next)));
  return row!.used;
}
