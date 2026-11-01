import React from "react";
import { Link, useNavigate } from "react-router";
import { CalendarDays, CalendarSync, EllipsisVertical, Plus, X } from "lucide-react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { WorkItemLayouts } from "./work-item-layouts";
import { paths } from "./routes";
import { Popover, menuItemClass } from "./shell/popover";
import { StateIcon, formatDay } from "./property-dropdowns";
import { stateGroups, type StateGroup } from "./types";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
type Status = "upcoming" | "active" | "completed";
export type Cycle = { id: string; projectId?: string; name: string; startDate: string; endDate: string; status: Status; itemCount: number; progress: { completed: number; total: number }; archived: boolean };
type CycleDetail = Cycle & { workItemIds: string[] };
type Item = { id: string; displayId: string; title: string; stateId?: string };
type State = { id: string; name: string; group: StateGroup };
const t = (key: string) => translate(key as MessageKey);
const tabs: Status[] = ["upcoming", "active", "completed"];
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
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <>
    <div aria-hidden className="fixed inset-0 z-40 bg-backdrop" onClick={onClose} />
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed left-1/2 top-[10vh] z-50 max-h-[80vh] w-[calc(100vw-1.5rem)] max-w-lg -translate-x-1/2 overflow-auto rounded-lg border border-subtle bg-surface-1 p-5 shadow-lg">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="m-0 flex-1 text-18 font-semibold text-primary">{title}</h2>
        <button type="button" className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover" aria-label={t("cycles.close")} onClick={onClose}><X aria-hidden size={16} /></button>
      </div>
      {children}
    </div>
  </>;
}

/** Create or edit a Cycle. The overlap notice is a warning: saving stays possible. */
function CycleModal({ action, projectId, cycle, onClose, onSaved }: { action: Call; projectId: string; cycle?: Cycle; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = React.useState(cycle?.name ?? "");
  const [startDate, setStartDate] = React.useState(cycle?.startDate ?? "");
  const [endDate, setEndDate] = React.useState(cycle?.endDate ?? "");
  const [note, setNote] = React.useState<string | null>(null);
  const overlap = useOverlap(action, projectId, startDate, endDate, cycle?.id);
  return <Modal title={t(cycle ? "cycles.editTitle" : "cycles.newTitle")} onClose={onClose}>
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      const saved = cycle ? await action("update_cycle", { cycleId: cycle.id, name, startDate, endDate }) : await action("create_cycle", { projectId, name, startDate, endDate });
      if (!saved) return setNote(t("cycles.failed"));
      onSaved();
      onClose();
    }}>
      <label>{t("cycles.name")}<input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></label>
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
  return <span role="img" aria-label={`${t("cycles.progress")} ${value}%`} className="grid size-8 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-secondary"
    style={{ background: `conic-gradient(var(--bg-success-primary) ${value * 3.6}deg, var(--bg-layer-1-selected) 0)` }}><span className="grid size-6 place-items-center rounded-full bg-surface-1">{value}%</span></span>;
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
      {canWrite && <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onEdit(); }}>{t("cycles.edit")}</button>}
      {canArchive && <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onArchive(); }}>{t("cycles.archive")}</button>}
      {canAdmin && <button type="button" role="menuitem" className={`${menuItemClass} text-danger-text`} onClick={() => { close(); onDelete(); }}>{t("cycles.delete")}</button>}
    </>}
  </Popover>;
}

/** Archive and delete with the same confirmations in the list, the detail page and the active cycles page. */
function useCycleCommands(action: Call, reload: () => void, setNote: (note: string | null) => void) {
  return {
    archive: async (cycle: Cycle) => { setNote((await action("archive_cycle", { cycleId: cycle.id })) === null ? t("cycles.failed") : null); reload(); },
    destroy: async (cycle: Cycle) => {
      if (!window.confirm(t("cycles.deleteConfirm"))) return false;
      if ((await action("delete_cycle", { cycleId: cycle.id })) === null) { setNote(t("cycles.failed")); return false; }
      reload();
      return true;
    },
  };
}

function CycleRow({ cycle, href, children }: { cycle: Cycle; href: string; children?: React.ReactNode }) {
  return <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-subtle px-4 py-3" data-testid="cycle-row">
    <Ring cycle={cycle} />
    <Link to={href} className="min-w-32 flex-1 truncate text-14 font-medium text-primary">{cycle.name}</Link>
    {statusPill(cycle.status)}
    <span className="flex items-center gap-1.5 text-12 text-secondary"><CalendarDays aria-hidden size={14} />{range(cycle)}</span>
    <span className="text-12 text-secondary">{t("cycles.itemCount").replace("{count}", count(cycle.itemCount))}</span>
    {bar(cycle)}
    {children}
  </li>;
}

export function CyclesPage({ workspaceSlug, projectKey, projectId, canWrite, canAdmin = false, enabled, action }: { workspaceSlug: string; projectKey: string; projectId: string; canWrite: boolean; canAdmin?: boolean; enabled: boolean; action: Call }) {
  const [cycles, setCycles] = React.useState<Cycle[] | null>(null);
  const [archived, setArchived] = React.useState(false);
  const [tab, setTab] = React.useState<Status>("active");
  const [editing, setEditing] = React.useState<Cycle | "new" | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setCycles(enabled ? await action<Cycle[]>("list_cycles", { projectId, archived }) : null), [action, projectId, enabled, archived]);
  React.useEffect(() => { void load(); }, [load]);
  const commands = useCycleCommands(action, () => void load(), setNote);
  if (!enabled) return <section><p role="status">{t("cycles.off")}</p></section>;
  const shown = (cycles ?? []).filter((cycle) => cycle.status === tab);
  const counts = (status: Status) => (cycles ?? []).filter((cycle) => cycle.status === status).length;
  return <section className="grid gap-3">
    <header className="flex flex-wrap items-center gap-3">
      <h3 className="m-0 flex flex-1 items-center gap-2 text-16 font-semibold"><CalendarSync aria-hidden size={16} />{t("cycles.title")}</h3>
      <label className="flex items-center gap-2 text-13 text-secondary"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} /> {t("cycles.showArchived")}</label>
      {canWrite && <button type="button" className={primaryButton} onClick={() => setEditing("new")}><Plus aria-hidden size={14} />{t("cycles.new")}</button>}
    </header>
    <div role="tablist" aria-label={t("cycles.title")} className="flex gap-1 border-b border-subtle">
      {tabs.map((status) => <button key={status} type="button" role="tab" aria-selected={tab === status} onClick={() => setTab(status)}
        className={`-mb-px rounded-none border-b-2 bg-transparent px-3 py-2 text-14 font-medium ${tab === status ? "border-accent-strong text-primary" : "border-transparent text-secondary"}`}>{t(`cycles.status.${status}`)} <span className="text-12 text-tertiary">{count(counts(status))}</span></button>)}
    </div>
    {cycles !== null && shown.length === 0 && <p className="m-0 text-secondary">{t("cycles.empty")}</p>}
    <ul role="tabpanel" className="m-0 list-none rounded-lg border border-subtle p-0">
      {shown.map((cycle) => <CycleRow key={cycle.id} cycle={cycle} href={paths.cycle(workspaceSlug, projectKey, cycle.id)}>
        <CycleMenu cycle={cycle} canWrite={canWrite} canAdmin={canAdmin} onEdit={() => setEditing(cycle)} onArchive={() => void commands.archive(cycle)} onDelete={() => void commands.destroy(cycle)} />
      </CycleRow>)}
    </ul>
    {note && <p role="alert" className="m-0 text-danger-text">{note}</p>}
    {editing && <CycleModal action={action} projectId={projectId} cycle={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => void load()} />}
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

export function CycleDetailPage({ workspaceSlug, projectKey, projectId, cycleId, canWrite, canAdmin = false, enabled, action, run: runQuery }: { workspaceSlug: string; projectKey: string; projectId: string; cycleId: string; canWrite: boolean; canAdmin?: boolean; enabled: boolean; action: Call; run?: Run }) {
  const navigate = useNavigate();
  const [cycle, setCycle] = React.useState<CycleDetail | null | undefined>(undefined);
  const [everyone, setEveryone] = React.useState<Item[]>([]);
  const [states, setStates] = React.useState<State[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [others, setOthers] = React.useState<Cycle[]>([]);
  const [target, setTarget] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const load = React.useCallback(async () => {
    if (!enabled) return setCycle(null);
    const found = await action<CycleDetail>("get_cycle", { cycleId });
    setCycle(found);
    if (!found) return;
    setEveryone(await action<Item[]>("list_work_items", { projectId }) ?? []);
    setStates(await action<State[]>("list_states", { projectId }) ?? []);
    const all = await action<Cycle[]>("list_cycles", { projectId }) ?? [];
    setOthers(all.filter((other) => other.id !== found.id && other.status !== "completed"));
    setRefreshKey((key) => key + 1);
  }, [action, cycleId, projectId, enabled]);
  React.useEffect(() => { void load(); }, [load]);
  const commands = useCycleCommands(action, () => void load(), setNote);
  if (!enabled) return <section><p role="status">{t("cycles.off")}</p></section>;
  if (cycle === undefined) return null;
  if (cycle === null) return <section><p role="alert">{t("cycles.failed")}</p><Link to={paths.cycles(workspaceSlug, projectKey)}>{t("cycles.back")}</Link></section>;
  const ended = cycle.status === "completed";
  const candidates = everyone.filter((item) => !cycle.workItemIds.includes(item.id));
  const add = async (workItemId: string) => {
    const result = await action<{ added: string[]; skipped: unknown[] }>("add_cycle_items", { cycleId, workItemIds: [workItemId] });
    setNote(result === null ? t("cycles.failed") : result.skipped.length ? t("cycles.skipped").replace("{count}", count(result.skipped.length)) : null);
    await load();
  };
  const remove = async (workItemId: string) => { setNote((await action("remove_cycle_items", { cycleId, workItemIds: [workItemId] })) === null ? t("cycles.failed") : null); await load(); };
  const transfer = async () => {
    const result = await action<{ transferred: string[] }>("transfer_cycle_items", { cycleId, targetCycleId: target });
    setNote(result === null ? t("cycles.failed") : t("cycles.transferred").replace("{count}", count(result.transferred.length)));
    await load();
  };
  return <section className="grid gap-3">
    <header className="flex flex-wrap items-center gap-3">
      <Link to={paths.cycles(workspaceSlug, projectKey)} className="text-13">{t("cycles.back")}</Link>
      <h3 className="m-0 min-w-32 flex-1 truncate text-16 font-semibold">{cycle.name}</h3>
      {canWrite && !ended && !cycle.archived && <button type="button" className={primaryButton} onClick={() => setAdding(true)}><Plus aria-hidden size={14} />{t("cycles.addItems")}</button>}
      <CycleMenu cycle={cycle} canWrite={canWrite} canAdmin={canAdmin} onEdit={() => setEditing(true)} onArchive={() => void commands.archive(cycle)} onDelete={() => void commands.destroy(cycle).then((gone) => { if (gone) navigate(paths.cycles(workspaceSlug, projectKey)); })} />
    </header>
    {note && <p role="alert" className="m-0 text-danger-text">{note}</p>}
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1">
        <h4 className="mb-2 mt-0 text-14 font-semibold">{t("cycles.workItems")}</h4>
        <WorkItemLayouts projectId={projectId} workspaceSlug={workspaceSlug} action={action} run={runQuery} refreshKey={refreshKey} cycleId={cycleId}
          rowAction={canWrite ? (item) => <button className="secondary" onClick={() => void remove(item.id)}>{t("cycles.remove")}</button> : undefined} />
      </div>
      <aside aria-label={t("cycles.details")} className="grid h-fit gap-4 rounded-lg border border-subtle p-4 lg:w-80 lg:shrink-0">
        <div className="flex items-center gap-2">{statusPill(cycle.status)}{cycle.archived && <span role="status" className="text-12 text-secondary">{t("cycles.archived")}</span>}</div>
        <p className="m-0 flex items-center gap-1.5 text-13 text-secondary"><CalendarDays aria-hidden size={14} />{range(cycle)}</p>
        <p className="m-0 text-13 text-secondary">{t("cycles.itemCount").replace("{count}", count(cycle.itemCount))}</p>
        <div className="grid gap-2"><div className="flex items-center gap-2 text-13 font-medium">{t("cycles.progress")} <span className="text-secondary">{t("cycles.progressOf").replace("{done}", count(cycle.progress.completed)).replace("{total}", count(cycle.progress.total))}</span></div>{bar(cycle)}</div>
        <Breakdown cycle={cycle} items={everyone} states={states} />
        {ended && canWrite && !cycle.archived && <div data-testid="cycle-transfer" className="grid gap-2">
          <select aria-label={t("cycles.transferTarget")} value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">{t("cycles.transferTarget")}</option>
            {others.map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
          </select>
          <button disabled={!target} onClick={() => void transfer()}>{t("cycles.transfer")}</button>
        </div>}
      </aside>
    </div>
    {editing && <CycleModal action={action} projectId={projectId} cycle={cycle} onClose={() => setEditing(false)} onSaved={() => void load()} />}
    {adding && <Modal title={t("cycles.addTitle")} onClose={() => setAdding(false)}>
      {candidates.length === 0 && <p className="m-0 text-secondary">{t("cycles.noCandidates")}</p>}
      <ul className="m-0 grid list-none gap-1 p-0">{candidates.map((item) => <li key={item.id} className="flex items-center gap-2 text-13"><span className="flex-1 truncate">{item.displayId} · {item.title}</span><button onClick={() => void add(item.id)}>{t("cycles.add")}</button></li>)}</ul>
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
    <h2 className="m-0 flex items-center gap-2 text-18 font-semibold"><CalendarSync aria-hidden size={18} />{t("cycles.activeTitle")}</h2>
    {rows?.length === 0 && <p className="m-0 text-secondary">{t("cycles.activeEmpty")}</p>}
    <ul className="m-0 list-none rounded-lg border border-subtle p-0">
      {(rows ?? []).map(({ project, cycle }) => <CycleRow key={cycle.id} cycle={cycle} href={paths.cycle(workspaceSlug, project.key, cycle.id)}>
        <span className="rounded-md bg-layer-1 px-2 py-0.5 text-12 text-secondary">{project.key}</span>
      </CycleRow>)}
    </ul>
  </section>;
}
