type Field = { values: Set<number>; any: boolean };
export type ScheduleKind = "daily" | "weekly" | "monthly" | "cron";

export type CalendarSchedule = {
  unit: "day" | "week" | "month" | "year";
  interval: number;
  time: string;
  timezone: string;
  /** Stable local-date anchor for interval counting. */
  anchorDate: string;
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  day?: number;
};

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, Number(part.value)])) as { year: number; month: number; day: number };
}

function localDateTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  // Iterating the offset converges across ordinary timezone offsets and DST boundaries.
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)])) as { year: number; month: number; day: number; hour: number; minute: number };
    const observed = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute);
    guess += desired - observed;
  }
  return new Date(guess);
}

function daysBetween(a: string, b: string) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}

export function nextCalendarOccurrence(schedule: CalendarSchedule, from: Date): Date {
  if (!Number.isInteger(schedule.interval) || schedule.interval < 1) throw new Error("Schedule interval must be a positive integer");
  const time = /^(\d{2}):(\d{2})$/.exec(schedule.time);
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) throw new Error("Schedule time must be HH:mm");
  // Validate the IANA timezone before searching.
  new Intl.DateTimeFormat("en", { timeZone: schedule.timezone });
  const anchor = schedule.anchorDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error("Schedule anchorDate must be YYYY-MM-DD");
  const local = localParts(from, schedule.timezone);
  let cursor = Date.UTC(local.year, local.month - 1, local.day);
  const anchorWeekStart = (() => { const [y, m, d] = anchor.split("-").map(Number); const date = new Date(Date.UTC(y!, m! - 1, d!)); date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7)); return date.toISOString().slice(0, 10); })();
  for (let i = 0; i < 366 * 12; i++, cursor += 86_400_000) {
    const date = new Date(cursor), year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    const key = date.toISOString().slice(0, 10);
    if (key < anchor) continue;
    let matches = false;
    if (schedule.unit === "day") matches = daysBetween(anchor, key) % schedule.interval === 0;
    if (schedule.unit === "week") {
      const weekStart = new Date(cursor); weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
      const week = weekStart.toISOString().slice(0, 10);
      const weekday = (date.getUTCDay() + 6) % 7 + 1;
      matches = daysBetween(anchorWeekStart, week) >= 0 && Math.floor(daysBetween(anchorWeekStart, week) / 7) % schedule.interval === 0 && (schedule.weekdays?.length ? schedule.weekdays.includes(weekday) : weekday === (new Date(Date.UTC(...anchor.split("-").map(Number) as [number, number, number]))).getUTCDay() || weekday === 7);
    }
    if (schedule.unit === "month") {
      const [ay, am] = anchor.split("-").map(Number); const delta = (year - ay!) * 12 + month - am!;
      const wanted = schedule.dayOfMonth ?? Number(anchor.slice(8, 10));
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      matches = delta >= 0 && delta % schedule.interval === 0 && day === Math.min(wanted, last);
    }
    if (schedule.unit === "year") {
      const ay = Number(anchor.slice(0, 4)); const wantedMonth = schedule.month ?? Number(anchor.slice(5, 7)); const wantedDay = schedule.day ?? Number(anchor.slice(8, 10));
      const actualDay = Math.min(wantedDay, new Date(Date.UTC(year, wantedMonth, 0)).getUTCDate());
      matches = year >= ay && (year - ay) % schedule.interval === 0 && month === wantedMonth && day === actualDay;
    }
    if (!matches) continue;
    const occurrence = localDateTimeToUtc(year, month, day, Number(time[1]), Number(time[2]), schedule.timezone);
    if (occurrence > from) return occurrence;
  }
  throw new Error("Schedule has no occurrence in the next twelve years");
}

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
