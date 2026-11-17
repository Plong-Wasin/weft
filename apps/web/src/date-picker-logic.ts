import { getLocale, type MessageKey } from "@weft/shared";
import type { StateGroup } from "./types";

/** A calendar day as YYYY-MM-DD. Start and Due are calendar days, so comparing the strings orders them. */
export type DayKey = string;
export type DateField = "start" | "due";
export type DateRange = { startDate: DayKey | null; dueDate: DayKey | null };
export type QuickPick = "today" | "tomorrow" | "nextWeek" | "none";

/** The local calendar day of `now`; the browser's zone decides when a day starts. */
export function todayKey(now = new Date()): DayKey {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

/** Adds whole days in calendar arithmetic (UTC here, so no DST gap or repeat). */
export function addDays(day: DayKey, days: number): DayKey {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The Monday after `day`; on a Monday that is a week on, so "Next week" is never today. */
export function nextMonday(day: DayKey): DayKey {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, ((1 - weekday + 7) % 7) || 7);
}

export function quickPickDate(pick: Exclude<QuickPick, "none">, today: DayKey): DayKey {
  if (pick === "today") return today;
  if (pick === "tomorrow") return addDays(today, 1);
  return nextMonday(today);
}

/** Sets one edge of the range to `day`; when that crosses the other edge, the other edge moves to `day`. */
export function pickDay(range: DateRange, field: DateField, day: DayKey): DateRange {
  if (field === "start") return { startDate: day, dueDate: range.dueDate && range.dueDate < day ? day : range.dueDate };
  return { startDate: range.startDate && range.startDate > day ? day : range.startDate, dueDate: day };
}

/** A quick pick sets the active field; "No date" clears both fields. */
export function applyQuickPick(range: DateRange, field: DateField, pick: QuickPick, today: DayKey): DateRange {
  if (pick === "none") return { startDate: null, dueDate: null };
  return pickDay(range, field, quickPickDate(pick, today));
}

/** A Due date before today is overdue, unless its State is completed. */
export function isOverdue(dueDate: DayKey | null, today: DayKey, group?: StateGroup): boolean {
  return !!dueDate && group !== "completed" && dueDate < today;
}

/** Short text such as "Nov 20"; the year appears only when it is not the current year. */
export function shortDay(value: DayKey, now = new Date()): string {
  const date = new Date(`${value}T00:00:00Z`);
  const withYear = date.getUTCFullYear() !== now.getFullYear();
  return new Intl.DateTimeFormat(getLocale() === "th" ? "th-TH" : "en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" }).format(date);
}

/** The full date for a screen reader, such as "November 20, 2026". */
export function longDay(value: DayKey): string {
  return new Intl.DateTimeFormat(getLocale() === "th" ? "th-TH" : "en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

export const quickPickKeys: Record<QuickPick, MessageKey> = {
  today: "datePicker.today", tomorrow: "datePicker.tomorrow", nextWeek: "datePicker.nextWeek", none: "datePicker.noDate",
};
