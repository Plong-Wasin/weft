type Field = { values: Set<number>; any: boolean };
export type ScheduleKind = "daily" | "weekly" | "monthly" | "cron";

function field(text: string, min: number, max: number, label: string): Field {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [rangeText, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Cron ${label} step must be a positive integer`);
    const range = rangeText === "*" ? [min, max] : rangeText!.split("-").map(Number);
    if (range.length < 1 || range.length > 2 || range.some((n) => !Number.isInteger(n) || n < min || n > max) || (range.length === 2 && range[0]! > range[1]!))
      throw new Error(`Cron ${label} must be between ${min} and ${max}`);
    for (let n = range[0]!; n <= (range[1] ?? range[0]!); n += step) values.add(n);
  }
  return { values, any: text === "*" };
}

export function parseCron(expression: string) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron must have five fields: minute hour day month weekday");
  return [field(parts[0]!, 0, 59, "minute"), field(parts[1]!, 0, 23, "hour"), field(parts[2]!, 1, 31, "day"), field(parts[3]!, 1, 12, "month"), field(parts[4]!, 0, 7, "weekday")] as const;
}

function matches(date: Date, cron: ReturnType<typeof parseCron>) {
  const [minute, hour, day, month, weekday] = cron;
  const dow = date.getUTCDay();
  const dayMatch = day.any && weekday.any ? true : day.any ? weekday.values.has(dow) || (dow === 0 && weekday.values.has(7)) : weekday.any ? day.values.has(date.getUTCDate()) : day.values.has(date.getUTCDate()) || weekday.values.has(dow) || (dow === 0 && weekday.values.has(7));
  return minute.values.has(date.getUTCMinutes()) && hour.values.has(date.getUTCHours()) && month.values.has(date.getUTCMonth() + 1) && dayMatch;
}

export function nextScheduleOccurrence(kind: ScheduleKind, expression: string | null, from: Date): Date {
  if (kind === "daily") { const result = new Date(from); result.setUTCDate(result.getUTCDate() + 1); return result; }
  if (kind === "weekly") { const result = new Date(from); result.setUTCDate(result.getUTCDate() + 7); return result; }
  if (kind === "monthly") {
    const result = new Date(from); const day = result.getUTCDate();
    result.setUTCDate(1); result.setUTCMonth(result.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay)); return result;
  }
  const parsed = parseCron(expression ?? "");
  const candidate = new Date(from); candidate.setUTCSeconds(0, 0); candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  // Cron schedules are minute-granularity; search five years for the next valid calendar date.
  for (let i = 0; i < 60 * 24 * 366 * 5; i++, candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)) if (matches(candidate, parsed)) return new Date(candidate);
  throw new Error("Cron has no occurrence in the next five years");
}
