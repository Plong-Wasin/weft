import { Button } from "@/ui/button";
import React from "react";
import { Ban, CalendarDays, Check, Circle, CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleX, Code2, SignalHigh, SignalLow, SignalMedium, Sigma } from "lucide-react";
import { getLocale, translate, type MessageKey } from "@weft/shared";
import { AgentLabel } from "./avatar";
import { Popover } from "./shell/popover";
import { DatePanel } from "./date-picker";
import { isOverdue, shortDay, todayKey, type DateField, type DateRange } from "./date-picker-logic";
import { filterPickerOptions, groupPickerOptions, isPickable, isSearchable, moveActive } from "./picker-search";
import type { Estimate, StateGroup } from "./types";
import { cn } from "./lib/utils";

import { Input } from "@/ui/input";
const t = (key: string) => translate(key as MessageKey);
const outlinedChip = "border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-accent [@media(pointer:coarse)]:min-h-11";
const quietChip = "rounded-md bg-transparent px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground [@media(pointer:coarse)]:min-h-11";
const outlinedIconChip = "border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-accent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
const quietIconChip = "rounded-md bg-transparent px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground min-h-7 min-w-7 max-sm:min-h-9 max-sm:min-w-9 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
export function chipClass(quiet = false, iconOnly = false) {
  if (quiet) return iconOnly ? quietIconChip : quietChip;
  return iconOnly ? outlinedIconChip : outlinedChip;
}
const optionClass = "flex h-auto min-h-9 w-full items-center gap-2 rounded-md bg-transparent px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11";

export type Option = { id: string; name: string; icon?: React.ReactNode; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null };

export function StateIcon({ group }: { group: StateGroup }) {
  const common = { "aria-hidden": true, size: 14 } as const;
  if (group === "backlog") return <CircleDashed {...common} className="text-muted-foreground" />;
  if (group === "started") return <CircleDot {...common} className="text-amber-700 dark:text-amber-400" />;
  if (group === "completed") return <CircleCheck {...common} className="text-emerald-700 dark:text-emerald-400" />;
  if (group === "cancelled") return <CircleX {...common} className="text-destructive" />;
  return <Circle {...common} className="text-muted-foreground" />;
}

export function PriorityIcon({ priority }: { priority: string }) {
  const common = { "aria-hidden": true, size: 14 } as const;
  if (priority === "urgent") return <CircleAlert {...common} className="text-destructive" />;
  if (priority === "high") return <SignalHigh {...common} className="text-amber-700 dark:text-amber-400" />;
  if (priority === "medium") return <SignalMedium {...common} className="text-amber-700 dark:text-amber-400" />;
  if (priority === "low") return <SignalLow {...common} className="text-foreground" />;
  return <Ban {...common} className="text-muted-foreground" />;
}

/** A calendar day (YYYY-MM-DD) in the locale's own calendar. */
export function formatDay(value: string) {
  return new Intl.DateTimeFormat(getLocale() === "th" ? "th-TH" : "en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function Trigger({ label, children }: { label: string; children: React.ReactNode }) { return <span title={label} className="flex min-w-0 items-center gap-1.5">{children}</span>; }

/** A read-only property chip that can reveal its full value without requiring hover. */
function Static({ label, children, quiet, className }: { label: string; children: React.ReactNode; quiet?: boolean; className?: string }) {
  const content = <span aria-hidden="true" className="flex min-w-0 items-center gap-1.5">{children}</span>;
  // The same read-only value can fit or clip depending on font metrics, zoom, and viewport width.
  // Always provide a reveal action so touch and keyboard users never depend on hover or guessed text lengths.
  return <Popover label={label} className={`flex items-center gap-1.5 rounded-md ${className ?? chipClass(quiet)}`} panelRole="dialog" panelClassName="w-72 max-w-[calc(100vw-2rem)] p-3" trigger={content}>
    {() => <p tabIndex={0} className="m-0 whitespace-normal break-words text-13 text-foreground">{label}</p>}
  </Popover>;
}

/** The search field (above SEARCH_THRESHOLD options) and the option list of a picker; arrows move the highlight, Enter picks it. */
function PickerBody({ label, options, onPick, searchAlways, children }: { label: string; options: Option[]; onPick: (option: Option) => void; searchAlways?: boolean; children: (visible: Option[], activeId: string | undefined, optionId: (option: Option) => string) => React.ReactNode }) {
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
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (searchable) return;
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[role=menuitemradio], [role=menuitemcheckbox]") ?? [])]
      .filter((item) => item.getAttribute("aria-disabled") !== "true");
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    const targetIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1)
      : event.key === "ArrowUp" ? Math.max(0, index - 1) : -1;
    if (targetIndex < 0) return;
    event.preventDefault();
    items[targetIndex]?.focus();
  };
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
    {searchable && <div className="sticky top-0 z-10 bg-popover pb-1">
      <Input type="search" aria-label={t("picker.search")} aria-expanded="true" aria-controls={listId} placeholder={t("picker.search")} autoComplete="off" value={query}
        onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeyDown} aria-activedescendant={active ? optionId(active) : undefined}
        className="min-h-9 w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" />
    </div>}
    {visible.length === 0 ? <p role="status" className="px-2.5 py-1.5 text-sm text-muted-foreground">{t("picker.noMatches")}</p> : <div id={listId} ref={list} role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>{children(visible, active?.id, optionId)}</div>}
  </>;
}

/** Inline dropdown that picks one option (state, priority, cycle). */
export function SingleSelect({ label, summary, display, options, value, onSelect, readOnly, icon, iconOnly, hideIconOnlyTextOnPhone, quiet, className: triggerClass }: { label: string; summary: string; /** Visible text when it differs from the accessible value (a muted dash for an empty list cell). */ display?: string; options: Option[]; value: string; onSelect: (id: string) => void; readOnly?: boolean; icon?: React.ReactNode; iconOnly?: boolean; hideIconOnlyTextOnPhone?: boolean; quiet?: boolean; className?: string }) {
  const name = `${label}: ${summary}`;
  const buttonClass = triggerClass ? `${chipClass(quiet, iconOnly)} ${triggerClass}` : chipClass(quiet, iconOnly);
  if (readOnly) return <Static label={name} quiet={quiet} className={buttonClass}>{icon}{!iconOnly && <span className={`max-w-32 truncate ${display ? "text-muted-foreground" : ""}`} title={summary}>{display ?? summary}</span>}</Static>;
  return <Popover label={name} className={buttonClass} panelRole="dialog" panelClassName="max-h-72 w-52 overflow-auto" trigger={<Trigger label={name}>{icon}<span className={`${iconOnly ? hideIconOnlyTextOnPhone ? "hidden" : "hidden text-11 max-sm:inline" : "min-w-0 flex-1 max-w-32 truncate"} ${display ? "text-muted-foreground" : ""}`}>{display ?? summary}</span></Trigger>}>
    {(close) => <PickerBody label={label} options={options} onPick={(option) => { close(); if (option.id !== value) onSelect(option.id); }}>
      {(visible, activeId, optionId) => visible.map((option) => <Button key={option.id} id={optionId(option)} type="button" role="menuitemradio" aria-checked={option.id === value} data-active={option.id === activeId || undefined} className={cn(optionClass, "data-[active=true]:bg-accent")}
        onClick={() => { close(); if (option.id !== value) onSelect(option.id); }}>
        {option.icon}<span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">{option.name}</span>{option.id === value && <Check aria-hidden size={14} className="text-muted-foreground" />}
      </Button>)}
    </PickerBody>}
  </Popover>;
}

/** Picks, changes or clears the Estimate point of a work item. Renders nothing while the project has no turned-on Estimate. */
export function EstimateSelect({ estimate, pointId, onSelect, readOnly, iconOnlyWhenEmpty, quiet, emptyLabel, className }: { estimate: Estimate | null; pointId: string | null; onSelect: (pointId: string | null) => void; readOnly?: boolean; iconOnlyWhenEmpty?: boolean; quiet?: boolean; emptyLabel?: string; className?: string }) {
  if (!estimate?.enabled) return null;
  const point = estimate.points.find((candidate) => candidate.id === pointId)?.value;
  const summary = point ?? t("workItems.noEstimate");
  const icon = <Sigma aria-hidden size={14} className="text-muted-foreground" />;
  return <SingleSelect label={t("workItems.estimate")} summary={summary} display={point === undefined ? emptyLabel : undefined} value={pointId ?? ""} readOnly={readOnly} quiet={quiet} icon={icon} iconOnly={iconOnlyWhenEmpty && !pointId} className={className}
    options={[{ id: "", name: t("workItems.noEstimate") }, ...estimate.points.map((point) => ({ id: point.id, name: point.value }))]} onSelect={(id) => onSelect(id || null)} />;
}

/** Inline dropdown that toggles any number of options (assignees, labels, modules); it stays open while picking. */
export function MultiSelect({ label, summary, options, selected, onToggle, readOnly, icon, onOpen, searchAlways, quiet, className: triggerClass }: { label: string; summary: React.ReactNode; options: Option[]; selected: string[]; onToggle: (id: string, on: boolean) => void; readOnly?: boolean; icon?: React.ReactNode; onOpen?: () => void; /** Shows the search field whatever the number of options (the Assignee picker). */ searchAlways?: boolean; quiet?: boolean; className?: string }) {
  const name = `${label}: ${selected.map((id) => options.find((option) => option.id === id)?.name ?? "").filter(Boolean).join(", ") || "—"}`;
  const buttonClass = triggerClass ? `${chipClass(quiet)} ${triggerClass}` : chipClass(quiet);
  if (readOnly) return <Static label={name} quiet={quiet} className={buttonClass}>{icon}{summary}</Static>;
  return <Popover label={name} className={buttonClass} panelRole="dialog" panelClassName="max-h-72 w-52 !min-w-0 overflow-auto" onOpen={onOpen} trigger={<Trigger label={name}>{icon}{summary}</Trigger>}>
    {() => options.length === 0 ? <p className="px-2.5 py-1.5 text-13 text-muted-foreground">—</p> : <PickerBody label={label} options={options} searchAlways={searchAlways} onPick={(option) => { if (isPickable(option)) onToggle(option.id, !selected.includes(option.id)); }}>
      {(visible, activeId, optionId) => <>{[false, true].map((agents) => {
      const group = visible.filter((option) => !!option.isAgent === agents);
      if (!group.length) return null;
      const hasAgentGroup = visible.some((option) => option.isAgent);
      const groupName = agents ? t("agents.group") : t("members.group");
      const rows = group.map((option) => {
      const on = selected.includes(option.id);
      const unavailable = option.isAgent && option.hasAccess === false;
      return <Button key={option.id} id={optionId(option)} type="button" role="menuitemcheckbox" aria-checked={on} aria-disabled={unavailable || undefined} data-active={option.id === activeId || undefined} title={unavailable ? option.accessReason ?? undefined : undefined} className={cn(optionClass, "data-[active=true]:bg-accent", option.codeCapable && "flex-wrap gap-1 text-xs", unavailable && "flex-wrap cursor-not-allowed")} onClick={() => { if (!unavailable) onToggle(option.id, !on); }}>
        {option.icon}<span className={cn("min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]", unavailable && "text-muted-foreground")}>{option.name}{option.isAgent && <> <AgentLabel /></>}</span>{option.codeCapable && <span className="ml-5 inline-flex shrink-0 basis-[calc(100%_-_1.25rem)] items-center gap-1 whitespace-nowrap rounded bg-muted px-2 py-1 text-xs text-muted-foreground" title={t("agents.codeCapable")}><Code2 aria-hidden size={13} className="text-amber-700 dark:text-amber-400" />{t("agents.canEditCode")}</span>}{on && <Check aria-hidden size={14} className="text-muted-foreground" />}
        {unavailable && <span className="w-full basis-full min-w-0 whitespace-normal pl-5 text-xs text-muted-foreground">{option.accessReason}</span>}
      </Button>;
      });
      return hasAgentGroup ? <div key={String(agents)} role="group" aria-label={groupName}><p aria-hidden="true" className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">{groupName}</p>{rows}</div> : <React.Fragment key={String(agents)}>{rows}</React.Fragment>;
    })}</>}
    </PickerBody>}
  </Popover>;
}

/** A calendar popover for the Start and Due dates of a work item; it opens on `field` and picks both dates in one calendar. */
export function DatePopover({ label, trigger, range, field, onChange, className = outlinedChip, clearable }: { label: string; trigger: React.ReactNode; range: DateRange; field: DateField; onChange: (change: Partial<DateRange>) => void; className?: string; clearable?: boolean }) {
  return <Popover label={label} className={className} panelRole="dialog" panelClassName="grid w-[22rem] gap-2 p-3" trigger={trigger}>
    {() => <DatePanel range={range} field={field} onChange={onChange} clearable={clearable} />}
  </Popover>;
}

/** One date (Start or Due) of a work item as text, such as "Nov 20"; it opens the calendar on that field. Overdue Due dates show red. */
export function DateChip({ label, field, range, onChange, readOnly, stateGroup, icon, quiet }: { label: string; field: DateField; range: DateRange; onChange: (change: Partial<DateRange>) => void; readOnly?: boolean; stateGroup?: StateGroup; icon?: React.ReactNode; quiet?: boolean }) {
  const value = field === "start" ? range.startDate : range.dueDate;
  const text = value ? shortDay(value) : t("datePicker.noDate");
  const late = field === "due" && isOverdue(value, todayKey(), stateGroup);
  // The overdue word is part of the accessible name: the trigger's aria-label replaces its visible text for screen readers.
  const name = late ? `${label}: ${text}, ${t("datePicker.overdue")}` : `${label}: ${text}`;
  const body = <>{icon}<span className={`min-w-0 max-w-32 truncate ${late ? "text-destructive" : ""}`} title={late ? t("datePicker.overdue") : undefined}>{text}</span>{late && <span className="sr-only">{t("datePicker.overdue")}</span>}</>;
  if (readOnly) return <Static label={name} quiet={quiet}>{body}</Static>;
  return <DatePopover label={name} range={range} field={field} onChange={onChange} className={chipClass(quiet)} trigger={<Trigger label={name}>{body}</Trigger>} />;
}

/** Inline dropdown with the start and due date of a work item: one calendar popover for both. `clearable={false}` hides "No date" where clearing is not offered (the bulk bar). */
export function DatesMenu({ startDate, dueDate, onChange, readOnly, iconOnlyWhenEmpty, stateGroup, clearable, quiet, emptyLabel }: { startDate: string | null; dueDate: string | null; onChange: (change: Partial<DateRange>) => void; readOnly?: boolean; iconOnlyWhenEmpty?: boolean; stateGroup?: StateGroup; clearable?: boolean; quiet?: boolean; emptyLabel?: string }) {
  const text = startDate && dueDate ? `${shortDay(startDate)} – ${shortDay(dueDate)}` : startDate ? shortDay(startDate) : dueDate ? shortDay(dueDate) : t("workItems.noDates");
  const empty = !startDate && !dueDate;
  const shown = empty && emptyLabel ? emptyLabel : text;
  const iconOnly = iconOnlyWhenEmpty && !startDate && !dueDate;
  const late = isOverdue(dueDate, todayKey(), stateGroup);
  const name = `${t("layout.property.dates")}: ${text}${late ? `, ${t("datePicker.overdue")}` : ""}`;
  const body = <><CalendarDays aria-hidden size={14} className="text-muted-foreground" /><span className={`min-w-0 max-w-32 truncate ${iconOnly ? "hidden text-11 max-sm:inline" : ""} ${late ? "text-destructive" : ""} ${empty && emptyLabel ? "text-muted-foreground" : ""}`} title={late ? t("datePicker.overdue") : undefined}>{shown}</span>{late && <span className="sr-only">{t("datePicker.overdue")}</span>}</>;
  const className = chipClass(quiet, iconOnly);
  if (readOnly) return <Static label={name} quiet={quiet} className={className}>{body}</Static>;
  return <DatePopover label={name} className={className} trigger={<Trigger label={name}>{body}</Trigger>} range={{ startDate, dueDate }} field={startDate || !dueDate ? "start" : "due"} onChange={onChange} clearable={clearable} />;
}
