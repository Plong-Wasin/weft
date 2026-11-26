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

/** A Due date before today is overdue, unless its State is completed or cancelled (no work is left to do). */
export function isOverdue(dueDate: DayKey | null, today: DayKey, group?: StateGroup): boolean {
  return !!dueDate && group !== "completed" && group !== "cancelled" && dueDate < today;
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

const intlLocale = () => getLocale() === "th" ? "th-TH" : "en-US";

/** The year of `month` (YYYY-MM) as the app shows it in the current locale: Buddhist era in Thai (2030 shows as 2573). */
export function displayYear(month: string): number {
  const year = new Intl.DateTimeFormat(intlLocale(), { year: "numeric", timeZone: "UTC" }).formatToParts(new Date(`${month}-01T00:00:00Z`)).find((part) => part.type === "year")!.value;
  return Number(year.replace(/\D/g, ""));
}

/** The stored (Gregorian) year for a year typed as the app shows it; null while the text is not a whole year in range. */
export function storedYear(typed: string, month: string): number | null {
  if (!/^\d{4}$/.test(typed.trim())) return null;
  const year = Number(typed) - (displayYear(month) - Number(month.slice(0, 4)));
  return year >= 1 && year <= 9999 ? year : null;
}

/** The month name and its year in the current locale, such as "May 2030" or "พฤษภาคม 2573". */
export function monthTitle(month: string): string {
  return new Intl.DateTimeFormat(intlLocale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

/** Days in `month` (YYYY-MM). */
export function monthLength(month: string): number {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, index!, 0)).getUTCDate();
}

/** The same day of the month `count` months away, clamped to that month's last day (Jan 31 + 1 month = Feb 28). */
export function addMonths(day: DayKey, count: number): DayKey {
  const [year, index] = day.split("-").map(Number);
  const month = new Date(Date.UTC(year!, index! - 1 + count, 1)).toISOString().slice(0, 7);
  return `${month}-${String(Math.min(Number(day.slice(8)), monthLength(month))).padStart(2, "0")}`;
}

/**
 * The day a calendar key moves focus to (WAI-ARIA date picker grid): arrows by day and week, PageUp/PageDown by month
 * (with Shift by year), Home/End to the start/end of the Monday-first week. Null for any other key.
 */
export function gridKeyTarget(from: DayKey, key: string, shift = false): DayKey | null {
  const weekday = (new Date(`${from}T00:00:00Z`).getUTCDay() + 6) % 7;
  switch (key) {
    case "ArrowLeft": return addDays(from, -1);
    case "ArrowRight": return addDays(from, 1);
    case "ArrowUp": return addDays(from, -7);
    case "ArrowDown": return addDays(from, 7);
    case "PageUp": return addMonths(from, shift ? -12 : -1);
    case "PageDown": return addMonths(from, shift ? 12 : 1);
    case "Home": return addDays(from, -weekday);
    case "End": return addDays(from, 6 - weekday);
    default: return null;
  }
}

/**
 * The one day of `month` that holds the grid's Tab stop: the focused day, else the selected day, else today, else the
 * first day inside the bounds, else the 1st. A day outside `min`/`max` is skipped while an in-bounds one exists.
 */
export function calendarTabStop(month: string, { focusDay, selected, today, min, max }: { focusDay?: DayKey | null; selected?: DayKey | null; today?: DayKey; min?: DayKey; max?: DayKey }): DayKey {
  const inMonth = (day?: DayKey | null): day is DayKey => !!day && day.slice(0, 7) === month;
  const inBounds = (day: DayKey) => (!min || day >= min) && (!max || day <= max);
  for (const day of [focusDay, selected, today]) if (inMonth(day) && inBounds(day)) return day;
  if (inMonth(focusDay)) return focusDay;
  const days = Array.from({ length: monthLength(month) }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
  return days.find(inBounds) ?? days[0]!;
}
