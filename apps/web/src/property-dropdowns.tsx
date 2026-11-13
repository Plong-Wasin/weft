import React from "react";
import { Ban, Bot, CalendarDays, Check, Circle, CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleX, Code2, SignalHigh, SignalLow, SignalMedium, Sigma } from "lucide-react";
import { getLocale, translate, type MessageKey } from "@weft/shared";
import { Popover } from "./shell/popover";
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

export function Avatar({ name }: { name: string }) {
  return <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-primary text-10 font-semibold text-on-color">{name.trim().charAt(0).toUpperCase()}</span>;
}

/** A calendar day (YYYY-MM-DD) in the locale's own calendar. */
export function formatDay(value: string) {
  return new Intl.DateTimeFormat(getLocale() === "th" ? "th-TH" : "en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function Trigger({ label, children }: { label: string; children: React.ReactNode }) { return <span title={label} className="flex items-center gap-1.5">{children}</span>; }

/** A property value as a chip; without write access it is plain text instead of a dropdown. */
function Static({ label, children }: { label: string; children: React.ReactNode }) {
  return <span aria-label={label} className={`flex items-center gap-1.5 rounded-md ${chip}`}>{children}</span>;
}

/** Inline dropdown that picks one option (state, priority, cycle). */
export function SingleSelect({ label, summary, options, value, onSelect, readOnly, icon, iconOnly }: { label: string; summary: string; options: Option[]; value: string; onSelect: (id: string) => void; readOnly?: boolean; icon?: React.ReactNode; iconOnly?: boolean }) {
  const name = `${label}: ${summary}`;
  if (readOnly) return <Static label={name}>{icon}{!iconOnly && <span>{summary}</span>}</Static>;
  return <Popover label={name} className={chip} panelClassName="max-h-72 w-52 overflow-auto" trigger={<Trigger label={label}>{icon}{!iconOnly && <span className="max-w-32 truncate">{summary}</span>}</Trigger>}>
    {(close) => options.map((option) => <button key={option.id} type="button" role="menuitemradio" aria-checked={option.id === value} className={optionClass}
      onClick={() => { close(); if (option.id !== value) onSelect(option.id); }}>
      {option.icon}<span className="flex-1 truncate">{option.name}</span>{option.id === value && <Check aria-hidden size={14} className="text-secondary" />}
    </button>)}
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
export function MultiSelect({ label, summary, options, selected, onToggle, readOnly, icon, onOpen }: { label: string; summary: React.ReactNode; options: Option[]; selected: string[]; onToggle: (id: string, on: boolean) => void; readOnly?: boolean; icon?: React.ReactNode; onOpen?: () => void }) {
  const name = `${label}: ${selected.map((id) => options.find((option) => option.id === id)?.name ?? "").filter(Boolean).join(", ") || "—"}`;
  if (readOnly) return <Static label={name}>{icon}{summary}</Static>;
  return <Popover label={name} className={chip} panelClassName="max-h-72 w-52 !min-w-0 overflow-auto" onOpen={onOpen} trigger={<Trigger label={label}>{icon}{summary}</Trigger>}>
    {() => options.length === 0 ? <p className="px-2.5 py-1.5 text-13 text-tertiary">—</p> : <>{[false, true].map((agents) => {
      const group = options.filter((option) => !!option.isAgent === agents);
      if (!group.length) return null;
      return <React.Fragment key={String(agents)}>{options.some((option) => option.isAgent) && <p className="px-2.5 pb-1 pt-2 text-11 font-semibold uppercase tracking-wide text-tertiary">{agents ? t("agents.group") : t("members.group")}</p>}{group.map((option) => {
      const on = selected.includes(option.id);
      const unavailable = option.isAgent && option.hasAccess === false;
      return <button key={option.id} type="button" role="menuitemcheckbox" aria-checked={on} aria-disabled={unavailable || undefined} title={unavailable ? option.accessReason ?? undefined : undefined} className={`${optionClass} ${option.codeCapable ? "gap-1 text-11" : ""} ${unavailable ? "flex-wrap cursor-not-allowed opacity-60" : ""}`} onClick={() => { if (!unavailable) onToggle(option.id, !on); }}>
        {option.isAgent ? <span title={t("comments.agent")}><Bot aria-hidden size={option.codeCapable ? 12 : 14} className="text-secondary" /></span> : option.icon}<span className={option.codeCapable ? "min-w-0 whitespace-nowrap" : "flex-1 truncate"}>{option.name}{option.isAgent && <> <span className="ml-1 text-10 text-tertiary">{t("comments.agent")}</span></>}</span>{option.codeCapable && <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-layer-1 px-1 py-0.5 text-[9px] text-secondary" title={t("agents.codeCapable")}><Code2 aria-hidden size={11} className="text-warning-primary" />{t("agents.canEditCode")}</span>}{on && <Check aria-hidden size={14} className="text-secondary" />}
        {unavailable && <span className="w-full basis-full min-w-0 whitespace-normal pl-5 text-11 text-tertiary">{option.accessReason}</span>}
      </button>;
      })}</React.Fragment>;
    })}</>}
  </Popover>;
}

/** Inline dropdown with the start and due date of a work item. */
export function DatesMenu({ startDate, dueDate, onChange, readOnly, iconOnlyWhenEmpty }: { startDate: string | null; dueDate: string | null; onChange: (change: { startDate?: string | null; dueDate?: string | null }) => void; readOnly?: boolean; iconOnlyWhenEmpty?: boolean }) {
  const text = startDate && dueDate ? `${formatDay(startDate)} – ${formatDay(dueDate)}` : startDate ? formatDay(startDate) : dueDate ? formatDay(dueDate) : t("workItems.noDates");
  const name = `${t("layout.property.dates")}: ${text}`;
  const body = <><CalendarDays aria-hidden size={14} className="text-secondary" />{!(iconOnlyWhenEmpty && !startDate && !dueDate) && <span>{text}</span>}</>;
  if (readOnly) return <Static label={name}>{body}</Static>;
  return <Popover label={name} className={chip} panelRole="dialog" panelClassName="grid w-60 gap-2 p-3" trigger={<Trigger label={t("layout.property.dates")}>{body}</Trigger>}>
    {() => <>
      <label className="grid gap-1 text-12 text-secondary">{t("workItems.startDate")}<input type="date" value={startDate ?? ""} max={dueDate ?? undefined} onChange={(event) => onChange({ startDate: event.target.value || null })} /></label>
      <label className="grid gap-1 text-12 text-secondary">{t("workItems.dueDate")}<input type="date" value={dueDate ?? ""} min={startDate ?? undefined} onChange={(event) => onChange({ dueDate: event.target.value || null })} /></label>
    </>}
  </Popover>;
}
