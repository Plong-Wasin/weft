import React from "react";
import { Link, useNavigate } from "react-router";
import { ArchiveRestore, CalendarDays, CalendarSync, EllipsisVertical, Plus, X } from "lucide-react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { EmptyState } from "./empty-state";
import { WorkItemLayouts } from "./work-item-layouts";
import { paths } from "./routes";
import { Popover, menuItemClass } from "./shell/popover";
import { StateIcon, formatDay } from "./property-dropdowns";
import { stateGroups, type StateGroup } from "./types";
import { DescriptionEditor } from "./description-editor";
import { EntityDescription } from "./entity-description";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
type Status = "upcoming" | "active" | "completed";
export type Cycle = { id: string; projectId?: string; name: string; startDate: string; endDate: string; status: Status; itemCount: number; progress: { completed: number; total: number }; archived: boolean; descriptionMarkdown?: string; description?: unknown };
type CycleDetail = Cycle & { workItemIds: string[] };
type Item = { id: string; displayId: string; title: string; stateId?: string };
type State = { id: string; name: string; group: StateGroup };
type Person = { userId: string; name: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null; accessAsk?: "owner" | "admin" | null; accessOwnerName?: string | null };
const t = (key: string) => translate(key as MessageKey);
const tabs: Status[] = ["upcoming", "active", "completed"];
/** Which tab opens first when the user has not picked one: the first with Cycles in it. */
const tabPriority: Status[] = ["active", "upcoming", "completed"];
const primaryButton = "flex items-center gap-1.5";
const groupColor: Record<StateGroup, string> = { backlog: "bg-layer-1-selected", unstarted: "bg-accent-strong", started: "bg-warning-primary", completed: "bg-success-primary", cancelled: "bg-danger-primary" };

const count = (n: number) => formatNumber(n);
const range = (cycle: Cycle) => `${formatDay(cycle.startDate)} – ${formatDay(cycle.endDate)}`;
const percent = (cycle: Cycle) => (cycle.progress.total === 0 ? 0 : Math.round((cycle.progress.completed / cycle.progress.total) * 100));

/** Warns, never blocks: shows the Cycles whose dates overlap the chosen range. */
function useOverlap(action: Call, projectId: string, startDate: string, endDate: string, cycleId?: string) {
  const [names, setNames] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!startDate || !endDate || startDate > endDate) { setNames([]); return; }
    let live = true;
    void action<{ overlapping: Cycle[] }>("check_cycle_dates", { projectId, startDate, endDate, ...(cycleId ? { cycleId } : {}) }).then((result) => { if (live) setNames((result?.overlapping ?? []).map((cycle) => cycle.name)); });
    return () => { live = false; };
  }, [action, projectId, startDate, endDate, cycleId]);
  return names;
}

/** A centred dialog over a backdrop; Escape and a click on the backdrop close it. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  React.useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);
  return <>
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
      const element = dialog.current;
      if (!element || event.target !== element) return;
      const bounds = element.getBoundingClientRect();
      const onBackdrop = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (onBackdrop) onClose();
    }} className="fixed left-1/2 top-[10vh] z-50 m-0 max-h-[80vh] w-[calc(100vw-1.5rem)] max-w-lg -translate-x-1/2 overflow-auto rounded-lg border border-subtle bg-surface-1 p-5 text-primary shadow-lg backdrop:bg-backdrop">
      <div className="mb-3 flex items-center gap-2">
        <h2 id={titleId} className="m-0 flex-1 text-18 font-semibold text-primary">{title}</h2>
        <button type="button" className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover" aria-label={t("cycles.close")} onClick={onClose}><X aria-hidden size={16} /></button>
      </div>
      {children}
    </dialog>
  </>;
}

/** Create or edit a Cycle. The overlap notice is a warning: saving stays possible. */
function CycleModal({ action, projectId, workspaceId, cycle, onClose, onSaved }: { action: Call; projectId: string; workspaceId: string; cycle?: Cycle; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = React.useState(cycle?.name ?? "");
  const [startDate, setStartDate] = React.useState(cycle?.startDate ?? "");
  const [endDate, setEndDate] = React.useState(cycle?.endDate ?? "");
  const [description, setDescription] = React.useState<unknown>(cycle?.description ?? null);
  const [mentionPeople, setMentionPeople] = React.useState<Person[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const overlap = useOverlap(action, projectId, startDate, endDate, cycle?.id);
  React.useEffect(() => { void action<Person[]>("list_project_members", { projectId }).then((rows) => setMentionPeople(rows ?? [])); }, [action, projectId]);
  return <Modal title={t(cycle ? "cycles.editTitle" : "cycles.newTitle")} onClose={onClose}>
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      const saved = cycle ? await action("update_cycle", { cycleId: cycle.id, name, startDate, endDate, description }) : await action("create_cycle", { projectId, name, startDate, endDate, ...(description ? { description } : {}) });
      if (!saved) return setNote(t("cycles.failed"));
      onSaved();
      onClose();
    }}>
      <label>{t("cycles.name")}<input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div className="grid gap-1 text-13 text-secondary"><span>{t("workItems.description")}</span><DescriptionEditor workspaceId={workspaceId} owner={cycle ? { ownerType: "cycle", ownerId: cycle.id } : undefined} mentionPeople={mentionPeople} initial={description} editable onChange={setDescription} /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>{t("cycles.start")}<input required type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>{t("cycles.end")}<input required type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
      </div>
      {overlap.length > 0 && <p role="status" data-testid="cycle-overlap" className="m-0 rounded-md bg-warning-subtle px-3 py-2 text-13 text-primary">{t("cycles.overlap").replace("{names}", overlap.join(", "))}</p>}
      {note && <p role="alert" className="m-0 text-danger-text">{note}</p>}
      <div className="flex justify-end gap-2 border-t border-subtle pt-3">
        <button type="button" className="secondary" onClick={onClose}>{t("cycles.cancel")}</button>
        <button type="submit">{t(cycle ? "cycles.save" : "cycles.create")}</button>
      </div>
    </form>
  </Modal>;
}

/** Progress shown as a ring with the percentage inside, the way Plane marks a Cycle. */
function Ring({ cycle }: { cycle: Cycle }) {
  const value = percent(cycle);
  return <span role="img" aria-label={`${t("cycles.progress")} ${value}%`} className="grid size-10 shrink-0 place-items-center rounded-full text-11 font-semibold text-secondary"
    style={{ background: `conic-gradient(var(--bg-success-primary) ${value * 3.6}deg, var(--bg-layer-1-selected) 0)` }}><span className="grid size-8 place-items-center rounded-full bg-surface-1">{value}%</span></span>;
}

const bar = (cycle: Cycle) => <progress className="h-1.5 w-28" value={cycle.progress.completed} max={Math.max(cycle.progress.total, 1)} aria-label={t("cycles.progress")} data-testid="cycle-progress"
  title={t("cycles.progressOf").replace("{done}", count(cycle.progress.completed)).replace("{total}", count(cycle.progress.total))} />;

const statusPill = (status: Status) => <span className={`rounded-full px-2 py-0.5 text-11 font-medium ${status === "active" ? "bg-warning-subtle text-primary" : status === "completed" ? "bg-success-subtle text-primary" : "bg-layer-1 text-secondary"}`}>{t(`cycles.status.${status}`)}</span>;

/** The ⋮ menu of a Cycle: edit for writers, archive (ended Cycles) and delete for admins. */
function CycleMenu({ cycle, canWrite, canAdmin, onEdit, onArchive, onDelete }: { cycle: Cycle; canWrite: boolean; canAdmin: boolean; onEdit: () => void; onArchive: () => void; onDelete: () => void }) {
  const canArchive = canAdmin && cycle.status === "completed" && !cycle.archived;
  if (!canWrite && !canAdmin) return null;
  return <Popover label={`${t("cycles.menu")}: ${cycle.name}`} align="right" trigger={<EllipsisVertical aria-hidden size={16} />}>
    {(close) => <>
      {canWrite && !cycle.archived && <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onEdit(); }}>{t("cycles.edit")}</button>}
      {canAdmin && cycle.archived && <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onArchive(); }}><ArchiveRestore aria-hidden size={14} />{t("cycles.unarchive")}</button>}
      {canArchive && <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onArchive(); }}>{t("cycles.archive")}</button>}
      {canAdmin && <button type="button" role="menuitem" className={`${menuItemClass} text-danger-text`} onClick={() => { close(); onDelete(); }}>{t("cycles.delete")}</button>}
    </>}
  </Popover>;
}

/** Archive and delete with the same confirmations in the list, the detail page and the active cycles page. */
function useCycleCommands(action: Call, reload: () => void, setNote: (note: string | null) => void) {
  return {
    archive: async (cycle: Cycle) => { setNote((await action("archive_cycle", { cycleId: cycle.id })) === null ? t("cycles.failed") : null); reload(); },
    restore: async (cycle: Cycle) => { setNote((await action("unarchive_cycle", { cycleId: cycle.id })) === null ? t("cycles.failed") : null); reload(); },
    destroy: async (cycle: Cycle) => {
      if (!window.confirm(t("cycles.deleteConfirm"))) return false;
      if ((await action("delete_cycle", { cycleId: cycle.id })) === null) { setNote(t("cycles.failed")); return false; }
      reload();
      return true;
    },
  };
}

function CycleRow({ cycle, href, children }: { cycle: Cycle; href: string; children?: React.ReactNode }) {
  return <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-4 py-3 transition-colors hover:bg-layer-transparent-hover" data-testid="cycle-row">
    <Ring cycle={cycle} />
    <Link to={href} title={cycle.name} className="min-w-32 flex-1 truncate text-14 font-medium text-primary">{cycle.name}</Link>
    {statusPill(cycle.status)}
    <span className="flex items-center gap-1.5 text-12 text-secondary"><CalendarDays aria-hidden size={14} />{range(cycle)}</span>
    <span className="text-12 text-secondary">{t("cycles.itemCount").replace("{count}", count(cycle.itemCount))}</span>
    {bar(cycle)}
    {children}
  </li>;
}

export function CyclesPage({ workspaceId, workspaceSlug, projectKey, projectId, canWrite, canAdmin = false, enabled, action }: { workspaceId: string; workspaceSlug: string; projectKey: string; projectId: string; canWrite: boolean; canAdmin?: boolean; enabled: boolean; action: Call }) {
  const [cycles, setCycles] = React.useState<Cycle[] | null>(null);
  const [archived, setArchived] = React.useState(false);
  const [pickedTab, setTab] = React.useState<Status | null>(null);
  const [editing, setEditing] = React.useState<Cycle | "new" | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setCycles(enabled ? await action<Cycle[]>("list_cycles", { projectId, archived }) : null), [action, projectId, enabled, archived]);
  React.useEffect(() => { void load(); }, [load]);
  const commands = useCycleCommands(action, () => void load(), setNote);
  if (!enabled) return <section><p role="status">{t("cycles.off")}</p></section>;
  const tab = pickedTab ?? tabPriority.find((status) => (cycles ?? []).some((cycle) => cycle.status === status)) ?? "active";
  const shown = (cycles ?? []).filter((cycle) => cycle.status === tab);
  const counts = (status: Status) => (cycles ?? []).filter((cycle) => cycle.status === status).length;
  return <section className="grid gap-4">
    <header className="flex flex-wrap items-center gap-3">
      <h2 className="m-0 flex flex-1 items-center gap-2 text-16 font-semibold"><CalendarSync aria-hidden size={16} />{t("cycles.title")}</h2>
      <label className="flex items-center gap-2 text-13 text-secondary"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} /> {t("cycles.showArchived")}</label>
      {canWrite && <button type="button" className={primaryButton} onClick={() => setEditing("new")}><Plus aria-hidden size={14} />{t("cycles.new")}</button>}
    </header>
    <div role="tablist" aria-label={t("cycles.title")} className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-layer-1 p-1">
      {tabs.map((status) => <button key={status} type="button" role="tab" aria-selected={tab === status} onClick={() => setTab(status)}
        className={`rounded-md border-0 px-3 py-2 text-14 font-medium ${tab === status ? "bg-surface-1 text-primary shadow-sm" : "bg-transparent text-secondary hover:bg-layer-transparent-hover"}`}>{t(`cycles.status.${status}`)} <span className="text-12 text-tertiary">{count(counts(status))}</span></button>)}
    </div>
    {cycles !== null && cycles.length === 0 && (archived
      ? <EmptyState title={t("archives.emptyCycles")} />
      : <EmptyState title={t("cycles.empty")} description={t("cycles.emptyHint")} action={canWrite ? <button type="button" className={primaryButton} onClick={() => setEditing("new")}><Plus aria-hidden size={14} />{t("cycles.createFirst")}</button> : undefined} />)}
    {cycles !== null && cycles.length > 0 && shown.length === 0 && <p role="status" className="m-0 px-1 py-4 text-14 text-secondary">{t("cycles.emptyTab")}</p>}
    <ul role="tabpanel" className="m-0 grid list-none gap-1 rounded-xl bg-layer-1 p-1 empty:hidden">
      {shown.map((cycle) => <CycleRow key={cycle.id} cycle={cycle} href={paths.cycle(workspaceSlug, projectKey, cycle.id)}>
        <CycleMenu cycle={cycle} canWrite={canWrite} canAdmin={canAdmin} onEdit={() => setEditing(cycle)} onArchive={() => void (cycle.archived ? commands.restore(cycle) : commands.archive(cycle))} onDelete={() => void commands.destroy(cycle)} />
      </CycleRow>)}
    </ul>
    {note && <p role="alert" className="m-0 text-danger-text">{note}</p>}
    {editing && <CycleModal action={action} projectId={projectId} workspaceId={workspaceId} cycle={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => void load()} />}
  </section>;
}

/** Work item counts per state group of one Cycle, in workflow order. */
function Breakdown({ cycle, items, states }: { cycle: CycleDetail; items: Item[]; states: State[] }) {
  const groupOf = new Map(states.map((state) => [state.id, state.group]));
  const inCycle = items.filter((item) => cycle.workItemIds.includes(item.id));
  const per = stateGroups.map((group) => ({ group, n: inCycle.filter((item) => groupOf.get(item.stateId ?? "") === group).length }));
  return <div className="grid gap-2" data-testid="cycle-breakdown">
    <div className="flex h-1.5 overflow-hidden rounded-full bg-layer-1">{per.filter((entry) => entry.n > 0).map((entry) => <span key={entry.group} className={groupColor[entry.group]} style={{ width: `${(entry.n / Math.max(inCycle.length, 1)) * 100}%` }} />)}</div>
    {per.map((entry) => <div key={entry.group} className="flex items-center gap-2 text-13 text-secondary"><StateIcon group={entry.group} /><span className="flex-1">{t(`states.group.${entry.group}`)}</span><span>{count(entry.n)}</span></div>)}
  </div>;
}

type Burndown = { total: number | null; reason?: string | null; days: Array<{ date: string; open: number | null; ideal: number | null; pointsOpen?: number | null; idealPoints?: number | null; unknown?: boolean; unestimatedOpen?: number | null }> } & Partial<{
  initialScope: number | null; finalOutcome: { completed: number | null; open: number | null; cancelled: number | null; completedPoints?: number | null; openPoints?: number | null; cancelledPoints?: number | null } | null; outcomeDate: string | null;
  unestimated: number | null; coverageStart: string; dateChanges: Array<{ at: string; previousStartDate: string; previousEndDate: string; startDate: string; endDate: string }>;
  scopeChanges: Array<{ date: string; added: number; removed: number }>;
}>;

/** Open work items per day against the ideal line, as plain SVG that scales to its box; future days (open null) are not drawn. */
export function BurndownChart({ action, name, body, projectId, refreshKey, testId = "cycle-burndown" }: { action: Call; name: string; body: unknown; projectId: string; refreshKey: number; testId?: string }) {
  const [data, setData] = React.useState<Burndown | null>(null);
  const [hasPoints, setHasPoints] = React.useState(false);
  const [unit, setUnit] = React.useState<"items" | "points">("items");
  React.useEffect(() => {
    let live = true;
    void action<{ type: string; enabled: boolean } | null>("get_estimate", { projectId }).then((estimate) => { if (live) setHasPoints(!!estimate && estimate.enabled && estimate.type === "points"); }, () => undefined);
    return () => { live = false; };
  }, [action, projectId, refreshKey]);
  // The switch only exists with a points Estimate; without one the chart always counts work items.
  const mode = hasPoints ? unit : "items";
  React.useEffect(() => {
    let live = true;
    void action<Burndown>(name, { ...(body as object), unit: mode }).then((result) => { if (live) setData(result); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, name, JSON.stringify(body), mode, refreshKey]);
  if (!data) return null;
  const w = 320, h = 160, pad = { l: 28, r: 8, t: 8, b: 20 };
  const values = data.days.map((day) => mode === "points" ? (day.pointsOpen ?? day.open) : day.open);
  const max = Math.max(data.total ?? 0, ...values.filter((value): value is number => value !== null), 1), last = Math.max(data.days.length - 1, 1);
  const x = (index: number) => pad.l + (index / last) * (w - pad.l - pad.r);
  const y = (value: number) => pad.t + (1 - value / max) * (h - pad.t - pad.b);
  const lineSegments = (points: Array<number | null>) => {
    const segments: string[] = []; let current: string[] = [];
    points.forEach((value, index) => {
      if (value === null) { if (current.length) segments.push(current.join(" ")); current = []; }
      else current.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`);
    });
    if (current.length) segments.push(current.join(" "));
    return segments;
  };
  const first = data.days[0]?.date, end = data.days[data.days.length - 1]?.date;
  return <div className="grid gap-2" data-testid={testId}>
    <div className="flex items-center justify-between gap-2"><span className="text-13 font-medium">{t("cycles.burndown")}</span>
      {hasPoints && <div role="group" aria-label={t("cycles.burndownUnit")} className="flex gap-1" data-testid="burndown-unit">
        {(["items", "points"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setUnit(value)} className={`rounded-md border border-subtle px-2 py-0.5 text-12 ${mode === value ? "bg-layer-1 font-medium text-primary" : "text-secondary"}`}>{t(`cycles.burndownUnit.${value}`)}</button>)}
      </div>}
    </div>
    {data.finalOutcome && <p className="m-0 text-12 text-secondary" role="status">
      {t("cycles.history.initialScope").replace("{count}", data.initialScope == null ? t("cycles.history.unknown") : count(data.initialScope))} · {t("cycles.history.outcome")}{data.outcomeDate ? ` (${formatDay(data.outcomeDate)})` : ""}: {data.finalOutcome.completed === null ? t("cycles.history.unknown") : count(data.finalOutcome.completed)} {t("cycles.history.completed")}, {data.finalOutcome.open === null ? t("cycles.history.unknown") : count(data.finalOutcome.open)} {t("cycles.history.open")}, {data.finalOutcome.cancelled === null ? t("cycles.history.unknown") : count(data.finalOutcome.cancelled)} {t("cycles.history.cancelled")}{mode === "points" && data.finalOutcome.openPoints !== undefined ? ` · ${t("cycles.history.pointsOutcome")}: ${data.finalOutcome.completedPoints == null ? t("cycles.history.unknown") : count(data.finalOutcome.completedPoints)} ${t("cycles.history.completed")}, ${data.finalOutcome.openPoints == null ? t("cycles.history.unknown") : count(data.finalOutcome.openPoints)} ${t("cycles.history.open")}, ${data.finalOutcome.cancelledPoints == null ? t("cycles.history.unknown") : count(data.finalOutcome.cancelledPoints)} ${t("cycles.history.cancelled")}` : ""}{mode === "points" && data.unestimated != null ? ` · ${count(data.unestimated)} ${t("cycles.history.unestimated")}` : ""} · {t("cycles.history.utcEnd")}
    </p>}
    {mode === "points" && !data.finalOutcome && data.unestimated != null && <p className="m-0 text-12 text-secondary">{count(data.unestimated)} {t("cycles.history.unestimated")}</p>}
    {(data.scopeChanges?.length ?? 0) > 0 && <p className="m-0 text-12 text-secondary">{t("cycles.history.scopeChanges")}: {data.scopeChanges!.map((change) => `${formatDay(change.date)} +${change.added} / −${change.removed}`).join(", ")}</p>}
    {(data.dateChanges?.length ?? 0) > 0 && <div className="grid gap-1 text-12 text-secondary" role="status"><span>{t("cycles.history.dateEdits")}</span>{data.dateChanges!.map((change) => <span key={change.at}>{formatDay(change.previousStartDate)}–{formatDay(change.previousEndDate)} → {formatDay(change.startDate)}–{formatDay(change.endDate)}</span>)}</div>}
    {data.days.some((day) => day.unknown && day.date < new Date().toISOString().slice(0, 10)) && data.coverageStart && <p className="m-0 text-12 text-secondary">{t("cycles.history.gaps").replace("{date}", formatDay(data.coverageStart.slice(0, 10)))}</p>}
    {data.days.some((day) => day.date >= new Date().toISOString().slice(0, 10)) && <p className="m-0 text-12 text-secondary">{t("cycles.history.future")}</p>}
    {data.reason ? <p className="m-0 text-13 text-secondary" role="status">{t(`cycles.burndownReason.${data.reason}`)}</p> : !values.some((value) => value !== null) ? <p className="m-0 text-13 text-secondary" role="status">{data.days.some((day) => day.unknown) ? t("cycles.history.noCoverage") : t("cycles.burndownEmpty")}</p> : <>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={t(mode === "points" ? "cycles.burndownLabelPoints" : "cycles.burndownLabel")} className="h-auto w-full max-w-full">
        <line x1={pad.l} y1={y(0)} x2={w - pad.r} y2={y(0)} stroke="var(--border-subtle)" />
        <text x={pad.l - 4} y={y(max) + 4} textAnchor="end" fontSize="10" fill="var(--txt-secondary)">{data.total === null ? t("cycles.history.unknown") : count(data.total)}</text>
        <text x={pad.l - 4} y={y(0) + 4} textAnchor="end" fontSize="10" fill="var(--txt-secondary)">0</text>
        {lineSegments(data.days.map((day) => mode === "points" ? (day.idealPoints ?? day.ideal) : day.ideal)).map((points, index) => <polyline key={`ideal-${index}`} fill="none" stroke="var(--border-strong)" strokeDasharray="4 3" strokeWidth="1.5" points={points} />)}
        {lineSegments(values).map((points, index) => <polyline key={`actual-${index}`} fill="none" stroke="var(--bg-accent-primary)" strokeWidth="2" points={points} />)}
        {first && <text x={pad.l} y={h - 4} fontSize="10" fill="var(--txt-secondary)">{formatDay(first)}</text>}
        {end && end !== first && <text x={w - pad.r} y={h - 4} textAnchor="end" fontSize="10" fill="var(--txt-secondary)">{formatDay(end)}</text>}
      </svg>
      <div className="flex gap-3 text-12 text-secondary"><span>— {t("cycles.burndownRemaining")}</span><span>- - {t("cycles.burndownIdeal")}</span></div>
    </>}
  </div>;
}

export function CycleDetailPage({ workspaceId, workspaceSlug, projectKey, projectId, cycleId, canWrite, canAdmin = false, enabled, action, run: runQuery }: { workspaceId: string; workspaceSlug: string; projectKey: string; projectId: string; cycleId: string; canWrite: boolean; canAdmin?: boolean; enabled: boolean; action: Call; run?: Run }) {
  const navigate = useNavigate();
  const [cycle, setCycle] = React.useState<CycleDetail | null | undefined>(undefined);
  const [everyone, setEveryone] = React.useState<Item[]>([]);
  const [states, setStates] = React.useState<State[]>([]);
  const [mentionPeople, setMentionPeople] = React.useState<Person[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [others, setOthers] = React.useState<Cycle[]>([]);
  const [target, setTarget] = React.useState("");
  const [transferSelection, setTransferSelection] = React.useState<string[]>([]);
  const [editing, setEditing] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [candidateQuery, setCandidateQuery] = React.useState("");
  const [selectedCandidates, setSelectedCandidates] = React.useState<string[]>([]);
  const [moveCandidates, setMoveCandidates] = React.useState(false);
  const [cycleOf, setCycleOf] = React.useState<Record<string, { id: string; name: string; archived: boolean }>>({});
  const load = React.useCallback(async () => {
    if (!enabled) return setCycle(null);
    const loaded = await action<CycleDetail>("get_cycle", { cycleId });
    // A Cycle of another project opened under this project's route is treated as missing.
    const found = loaded && loaded.projectId === projectId ? loaded : null;
    setCycle(found);
    if (!found) return;
    setMentionPeople(await action<Person[]>("list_project_members", { projectId }) ?? []);
    const loadedItems = await action<Item[]>("list_work_items", { projectId }) ?? [];
    const loadedStates = await action<State[]>("list_states", { projectId }) ?? [];
    setEveryone(loadedItems);
    setStates(loadedStates);
    const groupByState = new Map(loadedStates.map((state) => [state.id, state.group]));
    setTransferSelection(loadedItems.filter((item) => found.workItemIds.includes(item.id) && item.stateId && !["completed", "cancelled"].includes(groupByState.get(item.stateId) ?? "")).map((item) => item.id));
    const activeCycles = await action<Cycle[]>("list_cycles", { projectId }) ?? [];
    const archivedCycles = await action<Cycle[]>("list_cycles", { projectId, archived: true }) ?? [];
    const all = [...activeCycles, ...archivedCycles];
    setOthers(activeCycles.filter((other) => other.id !== found.id && other.status !== "completed"));
    const membership = await Promise.all(all.map(async (other) => ({ other, items: await action<Item[]>("list_work_items", { projectId, cycleId: other.id }) ?? [] })));
    setCycleOf(Object.fromEntries(membership.flatMap(({ other, items }) => items.map((item) => [item.id, { id: other.id, name: other.name, archived: other.archived }]))));
    setRefreshKey((key) => key + 1);
  }, [action, cycleId, projectId, enabled]);
  React.useEffect(() => { void load(); }, [load]);
  const commands = useCycleCommands(action, () => void load(), setNote);
  if (!enabled) return <section><p role="status">{t("cycles.off")}</p></section>;
  if (cycle === undefined) return null;
  if (cycle === null) return <section><p role="alert">{t("cycles.failed")}</p><Link to={paths.cycles(workspaceSlug, projectKey)}>{t("cycles.back")}</Link></section>;
  const ended = cycle.status === "completed";
  const candidates = everyone.filter((item) => !cycle.workItemIds.includes(item.id) && `${item.displayId} ${item.title}`.toLowerCase().includes(candidateQuery.trim().toLowerCase()));
  const remove = async (workItemId: string) => { setNote((await action("remove_cycle_items", { cycleId, workItemIds: [workItemId] })) === null ? t("cycles.failed") : null); await load(); };
  const transfer = async () => {
    const result = await action<{ transferred: string[]; conflicts: Array<{ workItemId: string; reason: string }> }>("selective_transfer_cycle_items", { cycleId, targetCycleId: target, workItemIds: transferSelection });
    setNote(result === null ? t("cycles.failed") : `${t("cycles.transferred").replace("{count}", count(result.transferred.length))}${result.conflicts.length ? ` ${t("cycles.transferConflicts").replace("{count}", count(result.conflicts.length))}` : ""}`);
    await load();
  };
  return <section className="grid gap-4">
    <header className="flex flex-wrap items-center gap-3 rounded-xl bg-layer-1 p-3">
      <Link to={paths.cycles(workspaceSlug, projectKey)} className="text-13">{t("cycles.back")}</Link>
      <h2 title={cycle.name} className="m-0 min-w-32 flex-1 truncate text-20 font-semibold">{cycle.name}</h2>
      {canWrite && !ended && !cycle.archived && <button type="button" className={primaryButton} onClick={() => setAdding(true)}><Plus aria-hidden size={14} />{t("cycles.addItems")}</button>}
      <CycleMenu cycle={cycle} canWrite={canWrite} canAdmin={canAdmin} onEdit={() => setEditing(true)} onArchive={() => void (cycle.archived ? commands.restore(cycle) : commands.archive(cycle))} onDelete={() => void commands.destroy(cycle).then((gone) => { if (gone) navigate(paths.cycles(workspaceSlug, projectKey)); })} />
    </header>
    {note && <p role="alert" className="m-0 text-danger-text">{note}</p>}
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1">
        <h4 className="mb-2 mt-0 text-14 font-semibold">{t("cycles.workItems")}</h4>
        <WorkItemLayouts projectId={projectId} workspaceSlug={workspaceSlug} action={action} run={runQuery} refreshKey={refreshKey} cycleId={cycleId}
          rowAction={canWrite && !cycle.archived ? (item) => <button className="secondary whitespace-nowrap px-2 py-1 text-12" onClick={() => void remove(item.id)}>{t("cycles.remove")}</button> : undefined} />
      </div>
      <aside aria-label={t("cycles.details")} className="grid h-fit gap-4 rounded-xl bg-layer-1 p-4 lg:w-80 lg:shrink-0">
        <section className="grid gap-2" aria-label={t("workItems.description")}><h3 className="m-0 text-14 font-semibold">{t("workItems.description")}</h3><EntityDescription key={cycle.id} action={action} workspaceId={workspaceId} owner={{ ownerType: "cycle", ownerId: cycle.id }} mentionPeople={mentionPeople} initial={cycle.description ?? null} editable={canWrite && !cycle.archived} /></section>
        <div className="flex items-center gap-2">{statusPill(cycle.status)}{cycle.archived && <span role="status" className="text-12 text-secondary">{t("cycles.archived")}</span>}</div>
        <p className="m-0 flex items-center gap-1.5 text-13 text-secondary"><CalendarDays aria-hidden size={14} />{range(cycle)}</p>
        <p className="m-0 text-13 text-secondary">{t("cycles.itemCount").replace("{count}", count(cycle.itemCount))}</p>
        <div className="grid gap-2"><div className="flex items-center gap-2 text-13 font-medium">{t("cycles.progress")} <span className="text-secondary">{t("cycles.progressOf").replace("{done}", count(cycle.progress.completed)).replace("{total}", count(cycle.progress.total))}</span></div>{bar(cycle)}</div>
        <Breakdown cycle={cycle} items={everyone} states={states} />
        <BurndownChart action={action} name="get_cycle_burndown" body={{ cycleId }} projectId={projectId} refreshKey={refreshKey} />
        {ended && canWrite && !cycle.archived && <div data-testid="cycle-transfer" className="grid gap-2">
          <h4 className="m-0 text-13 font-semibold">{t("cycles.transferReview")}</h4>
          <select aria-label={t("cycles.transferTarget")} value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">{t("cycles.transferTarget")}</option>
            {others.map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
          </select>
          {transferSelection.length === 0 && <p className="m-0 text-12 text-secondary">{t("cycles.noTransferItems")}</p>}
          <ul className="m-0 grid list-none gap-1 p-0">{everyone.filter((item) => cycle.workItemIds.includes(item.id) && (() => { const group = states.find((state) => state.id === item.stateId)?.group; return group !== "completed" && group !== "cancelled"; })()).map((item) => <li key={item.id} className="flex items-center gap-2 text-13"><input type="checkbox" aria-label={`${t("cycles.selectTransferItem")} ${item.displayId}`} checked={transferSelection.includes(item.id)} onChange={(event) => setTransferSelection((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} /><span className="truncate">{item.displayId} · {item.title}</span></li>)}</ul>
          <button disabled={!target || transferSelection.length === 0} onClick={() => void transfer()}>{t("cycles.transfer")}</button>
        </div>}
      </aside>
    </div>
    {editing && <CycleModal action={action} projectId={projectId} workspaceId={workspaceId} cycle={cycle} onClose={() => setEditing(false)} onSaved={() => void load()} />}
    {adding && <Modal title={t("cycles.addTitle")} onClose={() => setAdding(false)}>
      <div className="grid gap-3">
      <label>{t("cycles.searchCandidates")}<input autoFocus type="search" value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} /></label>
      {Object.keys(cycleOf).some((id) => !cycle.workItemIds.includes(id)) && <label className="flex items-center gap-2 text-13"><input type="checkbox" checked={moveCandidates} onChange={(event) => setMoveCandidates(event.target.checked)} />{t("cycles.allowMove")}</label>}
      {candidates.length === 0 && <p className="m-0 text-secondary">{t("cycles.noCandidates")}</p>}
      <ul className="m-0 grid max-h-72 list-none gap-1 overflow-auto p-0">{candidates.map((item) => {
        const currentCycle = cycleOf[item.id];
        const disabled = !!currentCycle && (!moveCandidates || currentCycle.archived);
        return <li key={item.id} className="flex items-center gap-2 text-13"><input type="checkbox" aria-label={`${t("cycles.selectCandidate")} ${item.displayId}`} disabled={disabled} checked={selectedCandidates.includes(item.id)} onChange={(event) => setSelectedCandidates((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} /><span className="min-w-0 flex-1 truncate">{item.displayId} · {item.title}</span><span title={currentCycle?.name} className="min-w-0 max-w-[40%] truncate text-secondary">{currentCycle ?t("cycles.currentCycle").replace("{name}", currentCycle.name) : t("cycles.noCurrentCycle")}</span></li>;
      })}</ul>
      <div className="flex justify-end"><button disabled={selectedCandidates.length === 0} onClick={async () => {
        const expectedCycleIds = Object.fromEntries(selectedCandidates.map((id) => [id, cycleOf[id]?.id ?? null]));
        const result = await action<{ added: string[]; skipped: Array<{ workItemId: string; cycleId: string }> }>("add_cycle_items", { cycleId, workItemIds: selectedCandidates, move: moveCandidates, expectedCycleIds });
        setNote(result === null ? t("cycles.failed") : result.skipped.length ? t("cycles.selectionConflict").replace("{count}", count(result.skipped.length)) : null);
        setSelectedCandidates([]); setAdding(false); await load();
      }}>{t("cycles.addSelected").replace("{count}", count(selectedCandidates.length))}</button></div>
      </div>
    </Modal>}
  </section>;
}

type ProjectRef = { id: string; key: string; name: string; features: { cycles: boolean } };

/** Workspace active cycles: the Active Cycle of every project that has the feature on, with the same row actions. */
export function ActiveCyclesPage({ workspaceId, workspaceSlug, action }: { workspaceId: string; workspaceSlug: string; action: Call }) {
  const [rows, setRows] = React.useState<Array<{ project: ProjectRef; cycle: Cycle }> | null>(null);
  const load = React.useCallback(async () => {
    const projects = (await action<ProjectRef[]>("list_projects", { workspaceId, archived: false }) ?? []).filter((project) => project.features.cycles);
    const lists = await Promise.all(projects.map(async (project) => ({ project, cycles: await action<Cycle[]>("list_cycles", { projectId: project.id }) ?? [] })));
    setRows(lists.flatMap(({ project, cycles }) => cycles.filter((cycle) => cycle.status === "active").map((cycle) => ({ project, cycle }))));
  }, [action, workspaceId]);
  React.useEffect(() => { void load(); }, [load]);
  return <section className="grid gap-3">
    {/* A workspace route: no project header above it, so this is the page's one h1. */}
    <h1 className="m-0 flex items-center gap-2 text-18 font-semibold"><CalendarSync aria-hidden size={18} />{t("cycles.activeTitle")}</h1>
    {rows?.length === 0 && <EmptyState title={t("cycles.activeEmpty")} description={t("cycles.activeEmptyHint")} />}
    <ul className="m-0 list-none rounded-lg border border-subtle p-0 empty:hidden">
      {(rows ?? []).map(({ project, cycle }) => <CycleRow key={cycle.id} cycle={cycle} href={paths.cycle(workspaceSlug, project.key, cycle.id)}>
        <span className="rounded-md bg-layer-1 px-2 py-0.5 text-12 text-secondary">{project.key}</span>
      </CycleRow>)}
    </ul>
  </section>;
}
