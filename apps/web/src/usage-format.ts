/** One row of the usage report, as `get_usage_summary` returns it. Null means unknown, never zero. */
export type UsageRow = {
  day: string; agentId: string | null; agentName: string | null; personId: string; personName: string;
  runs: number; unknownUsageRuns: number; unknownCostRuns: number;
  /** Fresh input only; cache reads and cache creation are counted apart. */
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null;
  /** How many of the Runs behind the cost carry the cost their CLI reported instead of an estimate from the price table. */
  reportedCostRuns: number;
  elapsedMs: number | null; estimatedCostUsd: number | null;
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** An estimated cost in US dollars, or null when it is unknown. */
export function formatUsd(value: number | null): string | null {
  return value === null ? null : usd.format(value);
}

/** Tokens as a plain count, or null when unknown. */
export function tokensOf(row: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null }): number | null {
  return row.inputTokens === null || row.outputTokens === null ? null : row.inputTokens + row.outputTokens + (row.cacheReadTokens ?? 0) + (row.cacheCreationTokens ?? 0);
}

/** Seconds, or minutes and seconds, or null when unknown. The page supplies the words through `label`. */
export function formatDuration(ms: number | null, label: (key: "seconds" | "minutes", values: Record<string, number>) => string): string | null {
  if (ms === null) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return label("seconds", { count: seconds });
  return label("minutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

export type UsageTotal = { key: string; label: string; runs: number; unknownUsageRuns: number; unknownCostRuns: number; reportedCostRuns: number; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null; elapsedMs: number | null; estimatedCostUsd: number | null };

/** Adds rows up under one key (Agent, person or day). A total stays unknown only when every row under it is unknown. */
export function totalsBy(rows: UsageRow[], keyOf: (row: UsageRow) => { key: string; label: string }): UsageTotal[] {
  const sumKnown = (values: Array<number | null>) => values.some((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
  const groups = new Map<string, { label: string; rows: UsageRow[] }>();
  for (const row of rows) {
    const { key, label } = keyOf(row);
    const group = groups.get(key) ?? { label, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key, label: group.label,
    runs: group.rows.reduce((total, row) => total + row.runs, 0),
    unknownUsageRuns: group.rows.reduce((total, row) => total + row.unknownUsageRuns, 0),
    unknownCostRuns: group.rows.reduce((total, row) => total + row.unknownCostRuns, 0),
    reportedCostRuns: group.rows.reduce((total, row) => total + row.reportedCostRuns, 0),
    inputTokens: sumKnown(group.rows.map((row) => row.inputTokens)), outputTokens: sumKnown(group.rows.map((row) => row.outputTokens)),
    cacheReadTokens: sumKnown(group.rows.map((row) => row.cacheReadTokens)), cacheCreationTokens: sumKnown(group.rows.map((row) => row.cacheCreationTokens)),
    elapsedMs: sumKnown(group.rows.map((row) => row.elapsedMs)), estimatedCostUsd: sumKnown(group.rows.map((row) => row.estimatedCostUsd)),
  }));
}

/** Same rule as the work item export (`guardFormula` in packages/actions/src/exports.ts): a text a spreadsheet would run as a formula gets a leading apostrophe. Numbers are never guarded, so -5 stays a number. */
const guardFormula = (value: string) => /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

export const csvCell = (value: string | number | null) => {
  if (value === null) return "";
  const text = typeof value === "string" ? guardFormula(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The report as CSV, one line per day, Agent and person. Blank cells are unknown values. Costs are in US dollars: estimated from the price table, or as reported by the provider's CLI. */
export function usageCsv(rows: UsageRow[], agentName: (row: UsageRow) => string, personName: (row: UsageRow) => string): string {
  const header = ["Day (UTC)", "Agent", "Person", "Runs", "Runs with unknown tokens", "Input tokens", "Cache read tokens", "Cache creation tokens", "Output tokens", "Time (seconds)", "Cost (USD)", "Runs without cost", "Runs with provider-reported cost"];
  const lines = rows.map((row) => [
    row.day, agentName(row), personName(row), row.runs, row.unknownUsageRuns, row.inputTokens, row.cacheReadTokens, row.cacheCreationTokens, row.outputTokens,
    row.elapsedMs === null ? null : Math.round(row.elapsedMs / 1000), row.estimatedCostUsd, row.unknownCostRuns, row.reportedCostRuns,
  ].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}
