import { expect, test } from "bun:test";
import { formatDuration, formatUsd, tokensOf, totalsBy, usageCsv, type UsageRow } from "../src/usage-format";

const row = (overrides: Partial<UsageRow>): UsageRow => ({
  day: "2026-11-13", agentId: "a1", agentName: "Bot", personId: "p1", personName: "Ann",
  runs: 1, unknownUsageRuns: 0, unknownCostRuns: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, reportedCostRuns: 0, elapsedMs: 61_000, estimatedCostUsd: 0.5, ...overrides,
});
const label = (unit: "seconds" | "minutes", values: Record<string, number>) => unit === "seconds" ? `${values.count} s` : `${values.minutes} min ${values.seconds} s`;

test("unknown usage, time and cost stay unknown in every total, never zero", () => {
  const rows = [row({ runs: 1, unknownUsageRuns: 1, unknownCostRuns: 1, inputTokens: null, outputTokens: null, elapsedMs: null, estimatedCostUsd: null }), row({ day: "2026-11-14" })];
  const [agent] = totalsBy(rows, (item) => ({ key: item.agentId ?? "", label: item.agentName ?? "" }));
  expect(agent).toMatchObject({ runs: 2, unknownUsageRuns: 1, unknownCostRuns: 1, inputTokens: 100, outputTokens: 20, elapsedMs: 61_000, estimatedCostUsd: 0.5 });
  const onlyUnknown = totalsBy([row({ inputTokens: null, outputTokens: null, elapsedMs: null, estimatedCostUsd: null })], () => ({ key: "x", label: "x" }))[0]!;
  expect([onlyUnknown.inputTokens, onlyUnknown.elapsedMs, onlyUnknown.estimatedCostUsd]).toEqual([null, null, null]);
  expect(tokensOf(onlyUnknown)).toBeNull();
});

test("totals group by the key they are asked for", () => {
  const rows = [row({ personId: "p1", personName: "Ann" }), row({ personId: "p2", personName: "Ben", runs: 3 })];
  const byPerson = totalsBy(rows, (item) => ({ key: item.personId, label: item.personName }));
  expect(byPerson.map((total) => [total.label, total.runs])).toEqual([["Ann", 1], ["Ben", 3]]);
});

test("duration and cost read plainly, and unknown values have no text", () => {
  expect(formatDuration(61_000, label)).toBe("1 min 1 s");
  expect(formatDuration(4_400, label)).toBe("4 s");
  expect(formatDuration(null, label)).toBeNull();
  expect(formatUsd(0.0105)).toBe("$0.0105");
  expect(formatUsd(2)).toBe("$2.00");
  expect(formatUsd(null)).toBeNull();
});

test("the CSV quotes names with commas and leaves unknown values blank", () => {
  const csv = usageCsv([row({ personName: "Ann, Jr.", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, estimatedCostUsd: null, elapsedMs: null, unknownUsageRuns: 1, unknownCostRuns: 1 })], (item) => item.agentName ?? "", (item) => item.personName);
  const [header, line] = csv.trim().split("\r\n");
  expect(header).toBe("Day (UTC),Agent,Person,Runs,Runs with unknown tokens,Input tokens,Cache read tokens,Cache creation tokens,Output tokens,Time (seconds),Cost (USD),Runs without cost,Runs with provider-reported cost");
  expect(line).toBe('2026-11-13,Bot,"Ann, Jr.",1,1,,,,,,,1,0');
});

test("csv text a spreadsheet would run as a formula is guarded, and negative numbers stay numbers", () => {
  const csv = usageCsv([row({ agentName: "=HYPERLINK(\"http://x\")", personName: "+1 Ann", estimatedCostUsd: -5 }), row({ agentName: "@sum", personName: "\tTab" }), row({ agentName: "-cmd", personName: "Plain" })], (item) => item.agentName ?? "", (item) => item.personName);
  const lines = csv.split("\r\n");
  expect(lines[1]!.startsWith(`2026-11-13,"'=HYPERLINK(""http://x"")",'+1 Ann,`)).toBe(true);
  expect(lines[1]).toContain(",-5,");
  expect(lines[2]).toContain(",'@sum,'\tTab,");
  expect(lines[3]).toContain(",'-cmd,Plain,");
});
