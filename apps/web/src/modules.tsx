import React from "react";
import { Link, useNavigate } from "react-router";
import { Archive, ArchiveRestore, CalendarRange, ChevronRight, CircleUserRound, Ellipsis, LayoutGrid, List, Package, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { EmptyState } from "./empty-state";
import { WorkItemLayouts } from "./work-item-layouts";
import { BurndownChart } from "./cycles";
import { paths } from "./routes";
import { Popover, menuItemClass } from "./shell/popover";
import { Avatar, MultiSelect, SingleSelect, formatDay } from "./property-dropdowns";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
const statuses = ["backlog", "planned", "in-progress", "paused", "completed", "cancelled"] as const;
type Status = (typeof statuses)[number];
type Module = {
  id: string; name: string; status: Status; leadId: string | null; memberIds: string[]; startDate: string | null; endDate: string | null; archived: boolean;
  itemCount: number; progress: { total: number; completed: number; cancelled: number; percent: number };
};
type ModuleDetail = Module & { projectId: string; workItemIds: string[] };
type Item = { id: string; displayId: string; title: string };
type Person = { userId: string; name: string; isAgent?: boolean };
type Display = "list" | "grid";
const t = (key: string) => translate(key as MessageKey);
const displayKey = "weft.modules.display";

const statusTone: Record<Status, string> = {
  backlog: "bg-layer-2 text-secondary", planned: "bg-accent-subtle text-accent-text", "in-progress": "bg-warning-subtle text-warning-primary",
  paused: "bg-layer-2 text-tertiary", completed: "bg-success-subtle text-success-text", cancelled: "bg-danger-subtle text-danger-text",
};
const primaryButton = "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-13 font-medium";
const iconButton = "grid size-7 place-items-center rounded-md border-0 bg-transparent p-0 text-secondary hover:bg-layer-transparent-hover hover:text-primary";

function StatusBadge({ status }: { status: Status }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-sm px-2 py-0.5 text-11 font-medium ${statusTone[status]}`}>{t(`modules.status.${status}`)}</span>;
}

/** Plane's circular progress: the ring fills with the completed share. */
function ProgressRing({ percent }: { percent: number }) {
  const radius = 11;
  const circumference = 2 * Math.PI * radius;
  return <span role="img" aria-label={`${t("modules.progress")}: ${t("modules.percent").replace("{percent}", formatNumber(percent))}`} data-testid="module-progress" data-percent={percent} className="relative grid size-7 shrink-0 place-items-center">
    <svg aria-hidden viewBox="0 0 28 28" className="absolute inset-0 -rotate-90">
      <circle cx="14" cy="14" r={radius} fill="none" strokeWidth="2.5" className="stroke-[var(--color-layer-3)]" />
      <circle cx="14" cy="14" r={radius} fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-[var(--color-success-primary)]" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} />
    </svg>
    <span aria-hidden className="text-9 font-medium text-secondary">{formatNumber(percent)}%</span>
  </span>;
}

function dateRange(module: Pick<Module, "startDate" | "endDate">) {
  if (!module.startDate && !module.endDate) return t("modules.noDates");
  return `${module.startDate ? formatDay(module.startDate) : "…"} → ${module.endDate ? formatDay(module.endDate) : "…"}`;
}

function Overlay({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  React.useEffect(() => {
    // Escape closes the dialog, unless it is closing an open dropdown first.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector('[data-module-modal] [role="menu"]')) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <>
    <div aria-hidden className="fixed inset-0 z-40 bg-backdrop" onClick={onClose} />
    <div data-module-modal role="dialog" aria-modal="true" aria-label={label} className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-1.5rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-subtle bg-surface-1 shadow-xl">{children}</div>
  </>;
}

function ModuleFormModal({ action, projectId, module, onClose, onSaved }: { action: Call; projectId: string; module?: Module; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = React.useState(module?.name ?? "");
  const [status, setStatus] = React.useState<Status>(module?.status ?? "backlog");
  const [leadId, setLeadId] = React.useState(module?.leadId ?? "");
  const [memberIds, setMemberIds] = React.useState<string[]>(module?.memberIds ?? []);
  const [startDate, setStartDate] = React.useState(module?.startDate ?? "");
  const [endDate, setEndDate] = React.useState(module?.endDate ?? "");
  const [people, setPeople] = React.useState<Person[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { void action<Person[]>("list_project_members", { projectId }).then((rows) => setPeople(rows ?? [])); }, [action, projectId]);
  const nameOf = (id: string) => people.find((person) => person.userId === id)?.name ?? "";
  const title = t(module ? "modules.editTitle" : "modules.addTitleModal");
  return <Overlay label={title} onClose={onClose}>
    <form className="my-0 grid gap-4 p-5" onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      const body = { name, status, leadId: leadId || null, memberIds, startDate: startDate || null, endDate: endDate || null };
      const saved = module ? await action("update_module", { moduleId: module.id, ...body }) : await action("create_module", { projectId, ...body });
      setBusy(false);
      if (!saved) return setNote(t("modules.failed"));
      onSaved();
      onClose();
    }}>
      <div className="flex items-center gap-2">
        <h2 className="m-0 flex-1 text-18 font-semibold text-primary">{title}</h2>
        <button type="button" className={iconButton} aria-label={t("modules.close")} onClick={onClose}><X aria-hidden size={16} /></button>
      </div>
      <input autoFocus required aria-label={t("modules.name")} placeholder={t("modules.name")} value={name} maxLength={255} className="w-full text-16" onChange={(event) => setName(event.target.value)} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-13 text-secondary">{t("modules.start")}<input type="date" value={startDate} max={endDate || undefined} className="w-auto" onChange={(event) => setStartDate(event.target.value)} /></label>
        <label className="flex items-center gap-2 text-13 text-secondary">{t("modules.end")}<input type="date" value={endDate} min={startDate || undefined} className="w-auto" onChange={(event) => setEndDate(event.target.value)} /></label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SingleSelect label={t("modules.status")} summary={t(`modules.status.${status}`)} value={status} options={statuses.map((value) => ({ id: value, name: t(`modules.status.${value}`) }))} onSelect={(value) => setStatus(value as Status)} />
        <SingleSelect label={t("modules.lead")} summary={leadId ? nameOf(leadId) : t("modules.noLead")} value={leadId} icon={<CircleUserRound aria-hidden size={14} className="text-secondary" />}
          options={[{ id: "", name: t("modules.noLead") }, ...people.filter((person) => !person.isAgent).map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} /> }))]} onSelect={setLeadId} />
        <MultiSelect label={t("modules.members")} selected={memberIds} icon={<Users aria-hidden size={14} className="text-secondary" />}
          summary={memberIds.length === 0 ? <span className="text-secondary">{t("modules.members")}</span> : <span>{memberIds.map(nameOf).filter(Boolean).join(", ")}</span>}
          options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} /> }))}
          onToggle={(id, on) => setMemberIds(on ? [...memberIds, id] : memberIds.filter((other) => other !== id))} />
      </div>
      {note && <p role="alert" className="m-0 text-danger-text">{note}</p>}
      <div className="flex justify-end gap-2 border-t border-subtle pt-4">
        <button type="button" className="secondary" onClick={onClose}>{t("modules.cancel")}</button>
        <button type="submit" disabled={busy}>{t(module ? "modules.save" : "modules.create")}</button>
      </div>
    </form>
  </Overlay>;
}

/** The "…" menu of a Module: edit, archive/unarchive, delete. Archive and delete need the Admin role; a Module is archivable once completed or cancelled. */
function ModuleMenu({ module, canWrite, canAdmin, onEdit, onArchive, onDelete }: { module: Module; canWrite: boolean; canAdmin: boolean; onEdit: () => void; onArchive: () => void; onDelete: () => void }) {
  if (!canWrite && !canAdmin) return null;
  const archivable = module.status === "completed" || module.status === "cancelled";
  return <Popover label={t("modules.actions")} align="right" className={iconButton} trigger={<Ellipsis aria-hidden size={16} />} panelClassName="w-52">
    {(close) => <>
      {canWrite && !module.archived && <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onEdit(); }}><Pencil aria-hidden size={14} />{t("modules.edit")}</button>}
      {canAdmin && (module.archived
        ? <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onArchive(); }}><ArchiveRestore aria-hidden size={14} />{t("modules.unarchive")}</button>
        : <button type="button" role="menuitem" className={`${menuItemClass} disabled:opacity-50`} disabled={!archivable} title={t("modules.archiveHint")} onClick={() => { close(); onArchive(); }}><Archive aria-hidden size={14} />{t("modules.archive")}</button>)}
      {canAdmin && <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onDelete(); }}><Trash2 aria-hidden size={14} />{t("modules.delete")}</button>}
    </>}
  </Popover>;
}

function Members({ ids, people }: { ids: string[]; people: Person[] }) {
  const named = ids.map((id) => people.find((person) => person.userId === id)).filter((person): person is Person => !!person);
  if (named.length === 0) return null;
  return <span className="flex items-center -space-x-1" title={named.map((person) => person.name).join(", ")}>{named.slice(0, 3).map((person) => <Avatar key={person.userId} name={person.name} />)}{named.length > 3 && <span className="pl-2 text-11 text-secondary">+{named.length - 3}</span>}</span>;
}

function useDisplay(): [Display, (next: Display) => void] {
  const [display, setDisplay] = React.useState<Display>(() => { try { return localStorage.getItem(displayKey) === "grid" ? "grid" : "list"; } catch { return "list"; } });
  return [display, (next) => { setDisplay(next); try { localStorage.setItem(displayKey, next); } catch { /* storage unavailable: the choice lasts for this visit */ } }];
}

export function ModulesPage({ workspaceSlug, projectKey, projectId, canWrite, canAdmin, enabled, action }: { workspaceSlug: string; projectKey: string; projectId: string; canWrite: boolean; canAdmin: boolean; enabled: boolean; action: Call }) {
  const [modules, setModules] = React.useState<Module[] | null>(null);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [archived, setArchived] = React.useState(false);
  const [display, setDisplay] = useDisplay();
  const [form, setForm] = React.useState<{ module?: Module } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setModules(enabled ? await action<Module[]>("list_modules", { projectId, archived }) : null), [action, projectId, enabled, archived]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { if (enabled) void action<Person[]>("list_project_members", { projectId }).then((rows) => setPeople(rows ?? [])); }, [action, projectId, enabled]);
  if (!enabled) return <section><p role="status">{t("modules.off")}</p></section>;
  const run = async (name: string, body: unknown) => { setNote((await action(name, body)) === null ? t("modules.failed") : null); await load(); };
  const remove = (module: Module) => { if (window.confirm(t("modules.deleteConfirm"))) void run("delete_module", { moduleId: module.id }); };
  const menu = (module: Module) => <ModuleMenu module={module} canWrite={canWrite} canAdmin={canAdmin} onEdit={() => setForm({ module })}
    onArchive={() => void run(module.archived ? "unarchive_module" : "archive_module", { moduleId: module.id })} onDelete={() => remove(module)} />;
  const leadOf = (module: Module) => people.find((person) => person.userId === module.leadId);
  const toggle = (value: Display, icon: React.ReactNode) => <button type="button" aria-pressed={display === value} aria-label={t(`modules.display.${value}`)} title={t(`modules.display.${value}`)}
    className={`${iconButton} ${display === value ? "bg-layer-transparent-selected text-primary" : ""}`} onClick={() => setDisplay(value)}>{icon}</button>;
  return <section className="grid gap-0">
    <header className="flex flex-wrap items-center gap-3 border-b border-subtle px-4 py-2.5">
      <nav aria-label={t("workItems.breadcrumb")} className="flex items-center gap-2 text-13 text-secondary">
        <Link to={paths.workItems(workspaceSlug, projectKey)} className="text-secondary hover:text-primary">{projectKey}</Link><ChevronRight aria-hidden size={12} />
        <Package aria-hidden size={14} /><h2 className="m-0 text-13 font-medium text-primary">{t("modules.title")}</h2>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-13 text-secondary"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />{t("modules.showArchived")}</label>
        <div role="group" aria-label={t("modules.display")} className="flex items-center gap-0.5 rounded-md bg-layer-1 p-0.5">{toggle("list", <List aria-hidden size={15} />)}{toggle("grid", <LayoutGrid aria-hidden size={15} />)}</div>
        {canWrite && !archived && <button type="button" className={primaryButton} onClick={() => setForm({})}><Plus aria-hidden size={14} />{t("modules.addNew")}</button>}
      </div>
    </header>
    {note && <p role="alert" className="m-0 px-4 py-2 text-danger-text">{note}</p>}
    {modules?.length === 0 && (archived
      ? <EmptyState title={t("modules.empty")} />
      : <EmptyState title={t("modules.empty")} description={t("modules.emptyHint")} action={canWrite ? <button type="button" className={primaryButton} onClick={() => setForm({})}><Plus aria-hidden size={14} />{t("modules.createFirst")}</button> : undefined} />)}
    {display === "list"
      ? <ul aria-label={t("modules.title")} className="m-0 list-none p-0">{(modules ?? []).map((module) => <li key={module.id} data-testid={`module-row-${module.name}`} className="flex flex-wrap items-center gap-3 border-b border-subtle px-4 py-3 hover:bg-layer-transparent-hover">
        <ProgressRing percent={module.progress.percent} />
        <Link to={paths.module(workspaceSlug, projectKey, module.id)} className="min-w-0 flex-1 truncate text-14 font-medium text-primary">{module.name}</Link>
        <span className="flex items-center gap-1.5 rounded-md border border-subtle px-2 py-1 text-12 text-secondary"><CalendarRange aria-hidden size={13} />{dateRange(module)}</span>
        <StatusBadge status={module.status} />
        <span className="text-12 text-secondary">{t("modules.itemCount").replace("{count}", formatNumber(module.itemCount))}</span>
        <Members ids={module.memberIds} people={people} />
        {leadOf(module) && <span title={`${t("modules.lead")}: ${leadOf(module)?.name}`}><Avatar name={leadOf(module)?.name ?? ""} /></span>}
        {menu(module)}
      </li>)}</ul>
      : <ul aria-label={t("modules.title")} className="m-0 grid list-none grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">{(modules ?? []).map((module) => <li key={module.id} data-testid={`module-card-${module.name}`} className="grid content-between gap-4 rounded-lg border border-subtle bg-surface-1 p-4 hover:shadow-md">
        <div className="flex items-start gap-2">
          <Link to={paths.module(workspaceSlug, projectKey, module.id)} className="min-w-0 flex-1 truncate text-16 font-medium text-primary">{module.name}</Link>
          {menu(module)}
        </div>
        <div className="flex items-center gap-2"><StatusBadge status={module.status} /><span className="text-12 text-secondary">{t("modules.itemCount").replace("{count}", formatNumber(module.itemCount))}</span></div>
        <div className="flex items-center gap-1.5 text-12 text-secondary"><CalendarRange aria-hidden size={13} />{dateRange(module)}</div>
        <div className="flex items-center gap-2 border-t border-subtle pt-3">
          <ProgressRing percent={module.progress.percent} />
          <span className="text-12 text-secondary">{t("modules.percent").replace("{percent}", formatNumber(module.progress.percent))}</span>
          <span className="ml-auto flex items-center gap-2"><Members ids={module.memberIds} people={people} />{leadOf(module) && <span title={`${t("modules.lead")}: ${leadOf(module)?.name}`}><Avatar name={leadOf(module)?.name ?? ""} /></span>}</span>
        </div>
      </li>)}</ul>}
    {form && <ModuleFormModal action={action} projectId={projectId} module={form.module} onClose={() => setForm(null)} onSaved={() => void load()} />}
  </section>;
}

/** Picks existing work items of the project to add to the Module. */
function AddItemsModal({ candidates, onAdd, onClose }: { candidates: Item[]; onAdd: (ids: string[]) => Promise<void>; onClose: () => void }) {
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([]);
  const shown = candidates.filter((item) => `${item.displayId} ${item.title}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <Overlay label={t("modules.addItemsTitle")} onClose={onClose}>
    <div className="grid gap-3 p-5">
      <div className="flex items-center gap-2">
        <h2 className="m-0 flex-1 text-18 font-semibold text-primary">{t("modules.addItemsTitle")}</h2>
        <button type="button" className={iconButton} aria-label={t("modules.close")} onClick={onClose}><X aria-hidden size={16} /></button>
      </div>
      <input autoFocus type="search" aria-label={t("modules.searchItems")} placeholder={t("modules.searchItems")} value={query} className="w-full text-14" onChange={(event) => setQuery(event.target.value)} />
      {candidates.length === 0 && <p className="m-0 text-13 text-secondary">{t("modules.noneToAdd")}</p>}
      <ul className="m-0 grid max-h-72 list-none gap-0.5 overflow-auto p-0">{shown.map((item) => <li key={item.id}>
        <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-13 text-primary hover:bg-layer-transparent-hover">
          <input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />
          <span className="text-tertiary">{item.displayId}</span><span className="truncate">{item.title}</span>
        </label>
      </li>)}</ul>
      <div className="flex justify-end gap-2 border-t border-subtle pt-4">
        <button type="button" className="secondary" onClick={onClose}>{t("modules.cancel")}</button>
        <button type="button" disabled={selected.length === 0} onClick={async () => { await onAdd(selected); onClose(); }}>{t("modules.add")}</button>
      </div>
    </div>
  </Overlay>;
}

function PropertyRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2 text-13">
    <span className="flex items-center gap-2 text-secondary">{icon}{label}</span>
    <div className="flex min-w-0 flex-wrap items-center gap-1">{children}</div>
  </div>;
}

export function ModuleDetailPage({ workspaceSlug, projectKey, projectId, moduleId, canWrite, canAdmin, enabled, action, run: runQuery }: { workspaceSlug: string; projectKey: string; projectId: string; moduleId: string; canWrite: boolean; canAdmin: boolean; enabled: boolean; action: Call; run?: Run }) {
  const navigate = useNavigate();
  const [module, setModule] = React.useState<ModuleDetail | null | undefined>(undefined);
  const [candidates, setCandidates] = React.useState<Item[]>([]);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [editing, setEditing] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const back = paths.modules(workspaceSlug, projectKey);
  const load = React.useCallback(async () => {
    if (!enabled) return setModule(null);
    const loaded = await action<ModuleDetail>("get_module", { moduleId });
    // A Module of another project opened under this project's route is treated as missing.
    const found = loaded && loaded.projectId === projectId ? loaded : null;
    setModule(found);
    if (!found) return;
    const everyone = await action<Item[]>("list_work_items", { projectId }) ?? [];
    setCandidates(everyone.filter((item) => !found.workItemIds.includes(item.id)));
    setRefreshKey((key) => key + 1);
  }, [action, moduleId, projectId, enabled]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { if (enabled) void action<Person[]>("list_project_members", { projectId }).then((rows) => setPeople(rows ?? [])); }, [action, projectId, enabled]);
  if (!enabled) return <section><p role="status">{t("modules.off")}</p></section>;
  if (module === undefined) return null;
  if (module === null) return <section><p role="alert">{t("modules.failed")}</p><Link to={back}>{t("modules.back")}</Link></section>;
  const open = !module.archived;
  const editable = canWrite && open;
  const run = async (name: string, body: unknown) => { setNote((await action(name, body)) === null ? t("modules.failed") : null); await load(); };
  const patch = (change: Partial<Pick<Module, "status" | "leadId" | "memberIds" | "startDate" | "endDate">>) => run("update_module", { moduleId, name: module.name, status: module.status, leadId: module.leadId, memberIds: module.memberIds, startDate: module.startDate, endDate: module.endDate, ...change });
  const nameOf = (id: string) => people.find((person) => person.userId === id)?.name ?? "";
  const { completed, total, percent } = module.progress;
  return <section className="flex min-h-full min-w-0 max-w-full flex-col overflow-x-hidden">
    <header className="flex flex-wrap items-center gap-2 border-b border-subtle px-4 py-2.5">
      <nav aria-label={t("workItems.breadcrumb")} className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-13 text-secondary">
        <Link to={paths.workItems(workspaceSlug, projectKey)} className="text-secondary hover:text-primary">{projectKey}</Link><ChevronRight aria-hidden size={12} />
        <Link to={back} aria-label={t("modules.back")} className="text-secondary hover:text-primary">{t("modules.title")}</Link><ChevronRight aria-hidden size={12} />
        <span className="truncate font-medium text-primary">{module.name}</span>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        {editable && <button type="button" className={primaryButton} onClick={() => setAdding(true)}><Plus aria-hidden size={14} />{t("modules.addWorkItems")}</button>}
        <ModuleMenu module={module} canWrite={canWrite} canAdmin={canAdmin} onEdit={() => setEditing(true)}
          onArchive={() => void run(module.archived ? "unarchive_module" : "archive_module", { moduleId })}
          onDelete={async () => {
            if (!window.confirm(t("modules.deleteConfirm"))) return;
            if ((await action("delete_module", { moduleId })) === null) setNote(t("modules.failed")); else navigate(back);
          }} />
      </div>
    </header>
    {module.archived && <p role="status" className="m-0 px-4 py-2 text-13 text-secondary">{t("modules.archivedNote")}</p>}
    {note && <p role="alert" className="m-0 px-4 py-2 text-danger-text">{note}</p>}
    <div className="flex flex-1 flex-col lg:flex-row">
      <div className="min-w-0 flex-1 overflow-x-auto p-4">
        <h2 className="sr-only">{t("modules.workItems")}</h2>
        <WorkItemLayouts projectId={projectId} workspaceSlug={workspaceSlug} action={action} run={runQuery} refreshKey={refreshKey} moduleId={moduleId}
          rowAction={editable ? (item) => <button className="whitespace-nowrap rounded-md border border-subtle bg-surface-1 px-2 py-1 text-12 font-medium text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={() => void run("remove_module_items", { moduleId, workItemIds: [item.id] })}>{t("modules.remove")}</button> : undefined} />
      </div>
      <aside aria-label={t("modules.properties")} className="grid content-start gap-3 border-t border-subtle p-4 sm:p-6 lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0">
        <div className="flex items-center gap-2"><StatusBadge status={module.status} /></div>
        <BurndownChart action={action} name="get_module_burndown" body={{ moduleId }} projectId={projectId} refreshKey={refreshKey} testId="module-burndown" />
        <h2 className="m-0 text-20 font-semibold text-primary">{module.name}</h2>
        <PropertyRow icon={<CalendarRange aria-hidden size={15} />} label={t("modules.status")}>
          <SingleSelect label={t("modules.status")} summary={t(`modules.status.${module.status}`)} value={module.status} readOnly={!editable}
            options={statuses.map((value) => ({ id: value, name: t(`modules.status.${value}`) }))} onSelect={(value) => void patch({ status: value as Status })} />
        </PropertyRow>
        <PropertyRow icon={<CalendarRange aria-hidden size={15} />} label={t("modules.dateRange")}>
          <input type="date" aria-label={t("modules.start")} disabled={!editable} value={module.startDate ?? ""} max={module.endDate ?? undefined} className="w-auto text-13" onChange={(event) => void patch({ startDate: event.target.value || null })} />
          <input type="date" aria-label={t("modules.end")} disabled={!editable} value={module.endDate ?? ""} min={module.startDate ?? undefined} className="w-auto text-13" onChange={(event) => void patch({ endDate: event.target.value || null })} />
        </PropertyRow>
        <PropertyRow icon={<CircleUserRound aria-hidden size={15} />} label={t("modules.lead")}>
          <SingleSelect label={t("modules.lead")} summary={module.leadId ? nameOf(module.leadId) : t("modules.noLead")} value={module.leadId ?? ""} readOnly={!editable}
            icon={module.leadId ? <Avatar name={nameOf(module.leadId)} /> : undefined}
            options={[{ id: "", name: t("modules.noLead") }, ...people.filter((person) => !person.isAgent).map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} /> }))]} onSelect={(id) => void patch({ leadId: id || null })} />
        </PropertyRow>
        <PropertyRow icon={<Users aria-hidden size={15} />} label={t("modules.members")}>
          <MultiSelect label={t("modules.members")} readOnly={!editable} selected={module.memberIds}
            summary={module.memberIds.length === 0 ? <span className="text-secondary">{t("modules.noMembers")}</span> : <span className="flex items-center gap-1">{module.memberIds.slice(0, 3).map((id) => <Avatar key={id} name={nameOf(id)} />)}<span className="max-w-32 truncate">{module.memberIds.map(nameOf).join(", ")}</span></span>}
            options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} /> }))}
            onToggle={(id, on) => void patch({ memberIds: on ? [...module.memberIds, id] : module.memberIds.filter((other) => other !== id) })} />
        </PropertyRow>
        <PropertyRow icon={<Package aria-hidden size={15} />} label={t("modules.workItemsCount")}>
          <span data-testid="module-items-count" className="px-1 text-13 font-medium text-primary">{formatNumber(completed)}/{formatNumber(total)}</span>
        </PropertyRow>
        <div className="grid gap-2 border-t border-subtle pt-3">
          <div className="flex items-center justify-between text-13"><span className="font-medium text-primary">{t("modules.progress")}</span><span className="text-secondary">{t("modules.percent").replace("{percent}", formatNumber(percent))}</span></div>
          <progress max={100} value={percent} aria-label={t("modules.progress")} className="h-1.5 w-full" />
        </div>
      </aside>
    </div>
    {editing && <ModuleFormModal action={action} projectId={projectId} module={module} onClose={() => setEditing(false)} onSaved={() => void load()} />}
    {adding && <AddItemsModal candidates={candidates} onClose={() => setAdding(false)} onAdd={(ids) => run("add_module_items", { moduleId, workItemIds: ids })} />}
  </section>;
}
