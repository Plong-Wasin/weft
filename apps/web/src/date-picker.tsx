import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getLocale, translate, type MessageKey } from "@weft/shared";
import { applyQuickPick, calendarTabStop, displayYear, gridKeyTarget, longDay, monthTitle, pickDay, quickPickKeys, shortDay, storedYear, todayKey, type DateField, type DateRange, type DayKey, type QuickPick } from "./date-picker-logic";

const t = (key: string) => translate(key as MessageKey);
// The shared catalogue has no "Year" key yet; the label follows the app locale like the rest of the panel.
const yearLabel = () => getLocale() === "th" ? "ปี" : "Year";
const quickPicks: QuickPick[] = ["today", "tomorrow", "nextWeek", "none"];
const locale = () => getLocale() === "th" ? "th-TH" : "en-US";

/** `month` is YYYY-MM; the result is the month `count` months away. */
function shiftMonth(month: string, count: number) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, index! - 1 + count, 1)).toISOString().slice(0, 7);
}

/** The days of one month in weeks that start on Monday; null pads the first week. */
function monthCells(month: string): Array<DayKey | null> {
  const [year, index] = month.split("-").map(Number);
  const lead = (new Date(Date.UTC(year!, index! - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year!, index!, 0)).getUTCDate();
  return [...Array.from({ length: lead }, () => null), ...Array.from({ length: count }, (_, day) => `${month}-${String(day + 1).padStart(2, "0")}`)];
}

/**
 * Start and Due in one calendar. The active field (Start or Due) takes the next day clicked; after Start the Due takes over.
 * Each change is sent as the changed fields only; a quick pick sets the active field and "No date" clears both.
 */
export function DatePanel({ range, field: initialField, onChange, today = todayKey(), clearable = true, single = false, label, min, max }: { range: DateRange; field: DateField; onChange: (change: Partial<DateRange>) => void; today?: DayKey; clearable?: boolean; single?: boolean; label?: string; min?: DayKey; max?: DayKey }) {
  const [draft, setDraft] = React.useState(range);
  const [field, setField] = React.useState<DateField>(initialField);
  const [focusDay, setFocusDay] = React.useState<DayKey | null>(null);
  const [month, setMonth] = React.useState(() => (range[initialField === "start" ? "startDate" : "dueDate"] ?? today).slice(0, 7));
  // The year box holds what the person is typing; it shows the locale's year (Buddhist era in Thai) and stores Gregorian.
  const [yearDraft, setYearDraft] = React.useState<string | null>(null);
  const grid = React.useRef<HTMLDivElement>(null);
  // The panel's own draft keeps a second click right after the first one, before the saved Work item comes back.
  React.useEffect(() => setDraft(range), [range.startDate, range.dueDate]);
  React.useEffect(() => { if (focusDay) grid.current?.querySelector<HTMLElement>(`[data-date="${focusDay}"]`)?.focus(); }, [focusDay]);

  const commit = (next: DateRange) => {
    const change: Partial<DateRange> = {};
    if (next.startDate !== draft.startDate) change.startDate = next.startDate;
    if (next.dueDate !== draft.dueDate) change.dueDate = next.dueDate;
    setDraft(next);
    if (Object.keys(change).length) onChange(change);
  };
  const inBounds = (day: DayKey) => (!min || day >= min) && (!max || day <= max);
  const pick = (day: DayKey) => {
    if (!inBounds(day)) return;
    if (single) {
      commit({ ...draft, [field === "start" ? "startDate" : "dueDate"]: day });
      setFocusDay(day);
      return;
    }
    commit(pickDay(draft, field, day));
    setFocusDay(day);
    if (field === "start") setField("due");
  };
  const cells = monthCells(month);
  const tabStop = calendarTabStop(month, { focusDay, selected: draft[field === "start" ? "startDate" : "dueDate"], today, min, max });
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale(), { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + index))));
  const monthName = new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  const title = monthTitle(month);
  const onGridKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const from = (event.target as HTMLElement).dataset.date;
    const next = from ? gridKeyTarget(from, event.key, event.shiftKey) : null;
    if (!next) return;
    event.preventDefault();
    if (next.slice(0, 7) !== month) setMonth(next.slice(0, 7));
    setFocusDay(next);
  };
  const fieldValue = (name: DateField) => draft[name === "start" ? "startDate" : "dueDate"];

  return <div className="grid gap-2">
    {!single && <div className="grid grid-cols-2 gap-1" role="group" aria-label={t("datePicker.calendar")}>
      {(["start", "due"] as const).map((name) => <Button key={name} type="button" aria-pressed={field === name} onClick={() => setField(name)}
        className={`grid min-h-11 gap-0.5 rounded-md border px-2 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${field === name ? "border-ring bg-accent text-accent-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}>
        <span>{t(name === "start" ? "workItems.startDate" : "workItems.dueDate")}</span>
        <span className="font-medium text-foreground">{fieldValue(name) ? shortDay(fieldValue(name)!) : t("datePicker.noDate")}</span>
      </Button>)}
    </div>}
    <div className="flex flex-wrap gap-1">
      {quickPicks.filter((quick) => clearable || quick !== "none").map((quick) => <Button key={quick} type="button" disabled={quick !== "none" && !inBounds(applyQuickPick(draft, field, quick, today)[field === "start" ? "startDate" : "dueDate"]!)} className="min-h-9 rounded-md border border-input bg-background px-2 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
        onClick={() => {
          if (single && quick === "none") commit({ ...draft, [field === "start" ? "startDate" : "dueDate"]: null });
          else commit(applyQuickPick(draft, field, quick, today));
        }}>{t(quickPickKeys[quick])}</Button>)}
    </div>
    <div className="flex items-center justify-between gap-1">
      <Button type="button" aria-label={t("datePicker.previousMonth")} className="grid size-9 place-items-center rounded-md bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft aria-hidden size={16} /></Button>
      <span className="flex min-w-0 items-center justify-center gap-1.5 text-sm font-semibold text-foreground">
        <span aria-live="polite" className="sr-only">{title}</span>
        <span aria-hidden>{monthName}</span>
        <Input type="number" inputMode="numeric" aria-label={yearLabel()} value={yearDraft ?? String(displayYear(month))} className="h-8 w-[4.5rem] px-2 text-center text-sm font-semibold tabular-nums"
          onBlur={() => setYearDraft(null)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setYearDraft(null); } }}
          onChange={(event) => {
            const typed = event.target.value;
            const year = storedYear(typed, month);
            if (year === null) { setYearDraft(typed); return; }
            setYearDraft(null);
            setMonth(`${String(year).padStart(4, "0")}-${month.slice(5, 7)}`);
          }} />
      </span>
      <Button type="button" aria-label={t("datePicker.nextMonth")} className="grid size-9 place-items-center rounded-md bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight aria-hidden size={16} /></Button>
    </div>
    <div className="grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground" aria-hidden>{weekdays.map((name, index) => <span key={index}>{name}</span>)}</div>
    <div ref={grid} role="group" aria-label={label ? `${label}: ${title}` : title} data-month={month} onKeyDown={onGridKey} className="grid grid-cols-7 gap-0.5">
      {cells.map((day, index) => {
        if (!day) return <span key={`pad-${index}`} />;
        const start = draft.startDate, due = draft.dueDate;
        const selected = single ? day === (field === "start" ? start : due) : day === start || day === due;
        const inRange = !single && !!start && !!due && day > start && day < due;
        const tone = selected ? "bg-[var(--primary)] text-primary-foreground hover:bg-[var(--primary)]/90" : inRange ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent hover:text-accent-foreground";
        return <Button key={day} type="button" data-date={day} aria-label={longDay(day)} aria-pressed={selected} aria-current={day === today ? "date" : undefined} aria-disabled={!inBounds(day) || undefined}
          tabIndex={day === tabStop ? 0 : -1} onClick={() => pick(day)}
          className={`grid h-9 place-items-center rounded-md bg-transparent text-center text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent ${tone} ${day === today ? "font-semibold underline underline-offset-4" : ""}`}>{Number(day.slice(8))}</Button>;
      })}
    </div>
  </div>;
}
