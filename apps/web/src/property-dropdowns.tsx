import React from "react";
import { Ban, CalendarDays, Check, Circle, CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleX, Code2, SignalHigh, SignalLow, SignalMedium, Sigma } from "lucide-react";
import { getLocale, translate, type MessageKey } from "@weft/shared";
import { AgentLabel } from "./avatar";
import { Popover } from "./shell/popover";
import { DatePanel } from "./date-picker";
import { isOverdue, shortDay, todayKey, type DateField, type DateRange } from "./date-picker-logic";
import { filterPickerOptions, groupPickerOptions, isPickable, isSearchable, moveActive } from "./picker-search";
import type { Estimate, StateGroup } from "./types";

const t = (key: string) => translate(key as MessageKey);
const chip = "border border-subtle bg-surface-1 px-2 py-1 text-12 font-medium text-primary hover:bg-layer-transparent-hover";
const optionClass = "flex w-full items-center gap-2 rounded-md bg-transparent px-2.5 py-1.5 text-left text-13 text-primary hover:bg-layer-transparent-hover";

export type Option = { id: string; name: string; icon?: React.ReactNode; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null };

export function StateIcon({ group }: { group: StateGroup }) {
  const common = { "aria-hidden": true, size: 14 } as const;
  if (group === "backlog") return <CircleDashed {...common} className="text-tertiary" />;
  if (group === "started") return <CircleDot {...common} className="text-warning-primary" />;
  if (group === "completed") return <CircleCheck {...common} className="text-success-text" />;
  if (group === "cancelled") return <CircleX {...common} className="text-danger-text" />;
  return <Circle {...common} className="text-secondary" />;
}

export function PriorityIcon({ priority }: { priority: string }) {
  const common = { "aria-hidden": true, size: 14 } as const;
  if (priority === "urgent") return <CircleAlert {...common} className="text-danger-text" />;
  if (priority === "high") return <SignalHigh {...common} className="text-warning-primary" />;
  if (priority === "medium") return <SignalMedium {...common} className="text-warning-primary" />;
  if (priority === "low") return <SignalLow {...common} className="text-accent-text" />;
  return <Ban {...common} className="text-tertiary" />;
}

/** A calendar day (YYYY-MM-DD) in the locale's own calendar. */
export function formatDay(value: string) {
  return new Intl.DateTimeFormat(getLocale() === "th" ? "th-TH" : "en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function Trigger({ label, children }: { label: string; children: React.ReactNode }) { return <span title={label} className="flex items-center gap-1.5">{children}</span>; }

/** A property value as a chip; without write access it is plain text instead of a dropdown. */
function Static({ label, children }: { label: string; children: React.ReactNode }) {
  const value = React.useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = React.useState(false);
  const measure = React.useCallback(() => {
    const root = value.current;
    if (!root) return;
    const next = Array.from(root.querySelectorAll<HTMLElement>("[title]"))
      .some((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1);
    setTruncated((current) => current === next ? current : next);
  }, []);
  React.useLayoutEffect(measure, [children, measure]);
  React.useEffect(() => {
    const root = value.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure]);

  const content = <span ref={value} className="flex min-w-0 items-center gap-1.5">{children}</span>;
  const className = `flex items-center gap-1.5 rounded-md ${chip}`;
  if (!truncated) return <span className={className}>{content}</span>;
  return <Popover label={label} className={className} panelRole="dialog" panelClassName="w-72 max-w-[calc(100vw-2rem)] p-3" trigger={content}>
    {() => <p tabIndex={0} className="m-0 whitespace-normal break-words text-13 text-primary">{label}</p>}
  </Popover>;
}

/** The search field (above SEARCH_THRESHOLD options) and the option list of a picker; arrows move the highlight, Enter picks it. */
function PickerBody({ options, onPick, searchAlways, children }: { options: Option[]; onPick: (option: Option) => void; searchAlways?: boolean; children: (visible: Option[], activeId: string | undefined, optionId: (option: Option) => string) => React.ReactNode }) {
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const list = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const searchable = isSearchable(options, searchAlways);
  const visible = groupPickerOptions(searchable ? filterPickerOptions(options, query) : options);
  const activeIndex = visible.length ? Math.min(index, visible.length - 1) : -1;
  const active = visible[activeIndex];
  // Each option has a DOM id, so the search field can name the highlighted option in aria-activedescendant while focus stays in the field.
  const optionId = (option: Option) => `${listId}-${visible.indexOf(option)}`;
  React.useEffect(() => { list.current?.querySelector("[data-active]")?.scrollIntoView?.({ block: "nearest" }); }, [activeIndex]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIndex(moveActive(activeIndex, event.key === "ArrowDown" ? 1 : -1, visible.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active && isPickable(active)) onPick(active);
    }
  };
  return <>
    {searchable && <div className="sticky top-0 z-10 bg-surface-1 pb-1">
      <input type="search" aria-label={t("picker.search")} placeholder={t("picker.search")} autoComplete="off" value={query}
        onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeyDown} aria-activedescendant={active ? optionId(active) : undefined}
        className="w-full rounded-md border border-subtle bg-surface-1 px-2.5 py-1.5 text-13 text-primary placeholder:text-tertiary" />
    </div>}
    <div ref={list}>{visible.length === 0 ? <p className="px-2.5 py-1.5 text-13 text-tertiary">{t("picker.noMatches")}</p> : children(visible, active?.id, optionId)}</div>
  </>;
}

/** Inline dropdown that picks one option (state, priority, cycle). */
export function SingleSelect({ label, summary, options, value, onSelect, readOnly, icon, iconOnly }: { label: string; summary: string; options: Option[]; value: string; onSelect: (id: string) => void; readOnly?: boolean; icon?: React.ReactNode; iconOnly?: boolean }) {
  const name = `${label}: ${summary}`;
  if (readOnly) return <Static label={name}>{icon}{!iconOnly && <span className="max-w-32 truncate" title={summary}>{summary}</span>}</Static>;
  return <Popover label={name} className={chip} panelClassName="max-h-72 w-52 overflow-auto" trigger={<Trigger label={label}>{icon}<span className={iconOnly ? "hidden text-11 max-sm:inline" : "max-w-32 truncate"}>{summary}</span></Trigger>}>
    {(close) => <PickerBody options={options} onPick={(option) => { close(); if (option.id !== value) onSelect(option.id); }}>
      {(visible, activeId, optionId) => visible.map((option) => <button key={option.id} id={optionId(option)} type="button" role="menuitemradio" aria-checked={option.id === value} data-active={option.id === activeId || undefined} className={`${optionClass} data-[active=true]:bg-layer-transparent-hover`}
        onClick={() => { close(); if (option.id !== value) onSelect(option.id); }}>
        {option.icon}<span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">{option.name}</span>{option.id === value && <Check aria-hidden size={14} className="text-secondary" />}
      </button>)}
    </PickerBody>}
  </Popover>;
}

/** Picks, changes or clears the Estimate point of a work item. Renders nothing while the project has no turned-on Estimate. */
export function EstimateSelect({ estimate, pointId, onSelect, readOnly, iconOnlyWhenEmpty }: { estimate: Estimate | null; pointId: string | null; onSelect: (pointId: string | null) => void; readOnly?: boolean; iconOnlyWhenEmpty?: boolean }) {
  if (!estimate?.enabled) return null;
  const summary = estimate.points.find((point) => point.id === pointId)?.value ?? t("workItems.noEstimate");
  const icon = <Sigma aria-hidden size={14} className="text-secondary" />;
  return <SingleSelect label={t("workItems.estimate")} summary={summary} value={pointId ?? ""} readOnly={readOnly} icon={icon} iconOnly={iconOnlyWhenEmpty && !pointId}
    options={[{ id: "", name: t("workItems.noEstimate") }, ...estimate.points.map((point) => ({ id: point.id, name: point.value }))]} onSelect={(id) => onSelect(id || null)} />;
}

/** Inline dropdown that toggles any number of options (assignees, labels, modules); it stays open while picking. */
export function MultiSelect({ label, summary, options, selected, onToggle, readOnly, icon, onOpen, searchAlways }: { label: string; summary: React.ReactNode; options: Option[]; selected: string[]; onToggle: (id: string, on: boolean) => void; readOnly?: boolean; icon?: React.ReactNode; onOpen?: () => void; /** Shows the search field whatever the number of options (the Assignee picker). */ searchAlways?: boolean }) {
  const name = `${label}: ${selected.map((id) => options.find((option) => option.id === id)?.name ?? "").filter(Boolean).join(", ") || "—"}`;
  if (readOnly) return <Static label={name}>{icon}{summary}</Static>;
  return <Popover label={name} className={chip} panelClassName="max-h-72 w-52 !min-w-0 overflow-auto" onOpen={onOpen} trigger={<Trigger label={label}>{icon}{summary}</Trigger>}>
    {() => options.length === 0 ? <p className="px-2.5 py-1.5 text-13 text-tertiary">—</p> : <PickerBody options={options} searchAlways={searchAlways} onPick={(option) => { if (isPickable(option)) onToggle(option.id, !selected.includes(option.id)); }}>
      {(visible, activeId, optionId) => <>{[false, true].map((agents) => {
      const group = visible.filter((option) => !!option.isAgent === agents);
      if (!group.length) return null;
      return <React.Fragment key={String(agents)}>{visible.some((option) => option.isAgent) && <p className="px-2.5 pb-1 pt-2 text-11 font-semibold uppercase tracking-wide text-tertiary">{agents ? t("agents.group") : t("members.group")}</p>}{group.map((option) => {
      const on = selected.includes(option.id);
      const unavailable = option.isAgent && option.hasAccess === false;
      return <button key={option.id} id={optionId(option)} type="button" role="menuitemcheckbox" aria-checked={on} aria-disabled={unavailable || undefined} data-active={option.id === activeId || undefined} title={unavailable ? option.accessReason ?? undefined : undefined} className={`${optionClass} data-[active=true]:bg-layer-transparent-hover ${option.codeCapable ? "flex-wrap gap-1 text-11" : ""} ${unavailable ? "flex-wrap cursor-not-allowed" : ""}`} onClick={() => { if (!unavailable) onToggle(option.id, !on); }}>
        {option.icon}<span className={`min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere] ${unavailable ? "text-tertiary" : ""}`}>{option.name}{option.isAgent && <> <AgentLabel /></>}</span>{option.codeCapable && <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-layer-1 px-2 py-1 text-12 text-secondary basis-[calc(100%_-_1.25rem)] ml-5`} title={t("agents.codeCapable")}><Code2 aria-hidden size={13} className="text-warning-primary" />{t("agents.canEditCode")}</span>}{on && <Check aria-hidden size={14} className="text-secondary" />}
        {unavailable && <span className="w-full basis-full min-w-0 whitespace-normal pl-5 text-12 text-secondary">{option.accessReason}</span>}
      </button>;
      })}</React.Fragment>;
    })}</>}
    </PickerBody>}
  </Popover>;
}

/** A calendar popover for the Start and Due dates of a work item; it opens on `field` and picks both dates in one calendar. */
export function DatePopover({ label, trigger, range, field, onChange, className = chip, clearable }: { label: string; trigger: React.ReactNode; range: DateRange; field: DateField; onChange: (change: Partial<DateRange>) => void; className?: string; clearable?: boolean }) {
  return <Popover label={label} className={className} panelRole="dialog" panelClassName="grid w-64 gap-2 p-3" trigger={trigger}>
    {() => <DatePanel range={range} field={field} onChange={onChange} clearable={clearable} />}
  </Popover>;
}

/** One date (Start or Due) of a work item as text, such as "Nov 20"; it opens the calendar on that field. Overdue Due dates show red. */
export function DateChip({ label, field, range, onChange, readOnly, stateGroup, icon }: { label: string; field: DateField; range: DateRange; onChange: (change: Partial<DateRange>) => void; readOnly?: boolean; stateGroup?: StateGroup; icon?: React.ReactNode }) {
  const value = field === "start" ? range.startDate : range.dueDate;
  const text = value ? shortDay(value) : t("datePicker.noDate");
  const late = field === "due" && isOverdue(value, todayKey(), stateGroup);
  // The overdue word is part of the accessible name: the trigger's aria-label replaces its visible text for screen readers.
  const name = late ? `${label}: ${text}, ${t("datePicker.overdue")}` : `${label}: ${text}`;
  const body = <>{icon}<span className={`min-w-0 max-w-32 truncate ${late ? "text-danger-text" : ""}`} title={text}>{text}</span>{late && <span className="sr-only">{t("datePicker.overdue")}</span>}</>;
  if (readOnly) return <Static label={name}>{body}</Static>;
  return <DatePopover label={name} range={range} field={field} onChange={onChange} trigger={<Trigger label={label}>{body}</Trigger>} />;
}

/** Inline dropdown with the start and due date of a work item: one calendar popover for both. `clearable={false}` hides "No date" where clearing is not offered (the bulk bar). */
export function DatesMenu({ startDate, dueDate, onChange, readOnly, iconOnlyWhenEmpty, stateGroup, clearable }: { startDate: string | null; dueDate: string | null; onChange: (change: Partial<DateRange>) => void; readOnly?: boolean; iconOnlyWhenEmpty?: boolean; stateGroup?: StateGroup; clearable?: boolean }) {
  const text = startDate && dueDate ? `${shortDay(startDate)} – ${shortDay(dueDate)}` : startDate ? shortDay(startDate) : dueDate ? shortDay(dueDate) : t("workItems.noDates");
  const iconOnly = iconOnlyWhenEmpty && !startDate && !dueDate;
  const late = isOverdue(dueDate, todayKey(), stateGroup);
  const name = `${t("layout.property.dates")}: ${text}${late ? `, ${t("datePicker.overdue")}` : ""}`;
  const body = <><CalendarDays aria-hidden size={14} className="text-secondary" /><span className={`min-w-0 max-w-32 truncate ${iconOnly ? "hidden text-11 max-sm:inline" : ""} ${late ? "text-danger-text" : ""}`} title={text}>{text}</span>{late && <span className="sr-only">{t("datePicker.overdue")}</span>}</>;
  if (readOnly) return <Static label={name}>{body}</Static>;
  return <DatePopover label={name} trigger={<Trigger label={t("layout.property.dates")}>{body}</Trigger>} range={{ startDate, dueDate }} field={startDate || !dueDate ? "start" : "due"} onChange={onChange} clearable={clearable} />;
}
