import { Button } from "@/ui/button";
import { PageHeader } from "./shell/page-header";
import React from "react";
import { Link, useNavigate } from "react-router";
import { Archive, ArchiveRestore, CalendarRange, ChevronRight, CircleUserRound, Ellipsis, LayoutGrid, List, Package, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { EmptyState } from "./empty-state";
import { WorkItemLayouts } from "./work-item-layouts";
import { DescriptionEditor } from "./description-editor";
import { EntityDescription } from "./entity-description";
import { BurndownChart } from "./cycles";
import { paths } from "./routes";
import { Popover, menuItemClass } from "./shell/popover";
import { MultiSelect, SingleSelect, formatDay } from "./property-dropdowns";
import { Avatar } from "./avatar";
import { DetailsPanelToggle, useDetailsPanel } from "./details-panel";

import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { DatePicker } from "@/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from "@/ui/select";
type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
const statuses = ["backlog", "planned", "in-progress", "paused", "completed", "cancelled"] as const;
type Status = (typeof statuses)[number];
type Module = {
  id: string; name: string; status: Status; leadId: string | null; memberIds: string[]; startDate: string | null; endDate: string | null; archived: boolean;
  itemCount: number; progress: { total: number; completed: number; cancelled: number; percent: number }; descriptionMarkdown?: string; description?: unknown;
};
type ModuleDetail = Module & { projectId: string; workItemIds: string[] };
type Item = { id: string; displayId: string; title: string };
type Insights = { blocked: Item[]; overdue: Item[]; breakdowns: Record<string, Array<{ key: string; label: string; items: Item[] }>> };
type Person = { userId: string; name: string; isAgent?: boolean };
type Display = "list" | "grid";
const t = (key: string) => translate(key as MessageKey);
const displayKey = "weft.modules.display";

const statusTone: Record<Status, string> = {
  backlog: "bg-background text-muted-foreground", planned: "bg-accent text-foreground", "in-progress": "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  paused: "bg-background text-muted-foreground", completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", cancelled: "bg-destructive/10 text-destructive",
};
const primaryButton = "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium";
const iconButton = "grid size-7 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-accent hover:text-foreground";

function StatusBadge({ status }: { status: Status }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs font-medium ${statusTone[status]}`}>{t(`modules.status.${status}`)}</span>;
}

/** Plane's circular progress: the ring fills with the completed share. */
function ProgressRing({ percent }: { percent: number }) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  return <span role="img" aria-label={`${t("modules.progress")}: ${t("modules.percent").replace("{percent}", formatNumber(percent))}`} data-testid="module-progress" data-percent={percent} className="relative grid size-9 shrink-0 place-items-center">
    <svg aria-hidden viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
      <circle cx="18" cy="18" r="15" fill="none" strokeWidth="2.5" className="stroke-[var(--color-layer-3)]" />
      <circle cx="18" cy="18" r="15" fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-[var(--color-success-primary)]" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} />
    </svg>
    <span aria-hidden className="whitespace-nowrap text-[10px] font-medium tabular-nums text-muted-foreground">{formatNumber(percent)}%</span>
  </span>;
}

function dateRange(module: Pick<Module, "startDate" | "endDate">) {
  if (!module.startDate && !module.endDate) return t("modules.noDates");
  return `${module.startDate ? formatDay(module.startDate) : "…"} → ${module.endDate ? formatDay(module.endDate) : "…"}`;
}

function Overlay({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const pressedOutside = React.useRef(false);
  React.useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    element.querySelector<HTMLElement>("[autofocus]")?.focus();
    return () => { if (element.open) element.close(); };
  }, []);
  const outside = (event: React.PointerEvent<HTMLDialogElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  const close = () => { if (dialog.current?.open) dialog.current.close(); };
  return <dialog ref={dialog} aria-label={label} onClose={onClose} onPointerDown={(event) => { pressedOutside.current = outside(event); }} onPointerUp={(event) => { if (pressedOutside.current && outside(event)) close(); pressedOutside.current = false; }}
    className="module-dialog fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto overscroll-contain rounded-lg border border-border bg-card p-0 shadow-xl backdrop:bg-black/30">{children}</dialog>;
}

function ModuleFormModal({ action, projectId, workspaceId, module, onClose, onSaved }: { action: Call; projectId: string; workspaceId: string; module?: Module; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = React.useState(module?.name ?? "");
  const [status, setStatus] = React.useState<Status>(module?.status ?? "backlog");
  const [leadId, setLeadId] = React.useState(module?.leadId ?? "");
  const [memberIds, setMemberIds] = React.useState<string[]>(module?.memberIds ?? []);
  const [startDate, setStartDate] = React.useState(module?.startDate ?? "");
  const [endDate, setEndDate] = React.useState(module?.endDate ?? "");
  const [description, setDescription] = React.useState<unknown>(module?.description ?? null);
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
      const body = { name, status, leadId: leadId || null, memberIds, startDate: startDate || null, endDate: endDate || null, description };
      const saved = module ? await action("update_module", { moduleId: module.id, ...body }) : await action("create_module", { projectId, ...body });
      setBusy(false);
      if (!saved) return setNote(t("modules.failed"));
      onSaved();
      onClose();
    }}>
      <div className="flex items-center gap-2">
        <h2 className="m-0 flex-1 text-lg font-semibold text-foreground">{title}</h2>
        <Button type="button" className={iconButton} aria-label={t("modules.close")} onClick={onClose}><X aria-hidden size={16} /></Button>
      </div>
      <Input autoFocus required aria-label={t("modules.name")} placeholder={t("modules.name")} value={name} maxLength={255} className="w-full text-base" onChange={(event) => setName(event.target.value)} />
      <div className="grid gap-1 text-sm text-muted-foreground"><span>{t("workItems.description")}</span><DescriptionEditor workspaceId={workspaceId} owner={module ? { ownerType: "module", ownerId: module.id } : undefined} mentionPeople={people} initial={description} editable onChange={setDescription} /></div>
      <div className="flex flex-wrap items-center gap-2">
        <SingleSelect label={t("modules.status")} summary={t(`modules.status.${status}`)} value={status} options={statuses.map((value) => ({ id: value, name: t(`modules.status.${value}`) }))} onSelect={(value) => setStatus(value as Status)} />
        <SingleSelect label={t("modules.lead")} summary={leadId ? nameOf(leadId) : t("modules.noLead")} value={leadId} icon={<CircleUserRound aria-hidden size={14} className="text-muted-foreground" />}
          options={[{ id: "", name: t("modules.noLead") }, ...people.filter((person) => !person.isAgent).map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} /> }))]} onSelect={setLeadId} />
        <MultiSelect label={t("modules.members")} selected={memberIds} icon={<Users aria-hidden size={14} className="text-muted-foreground" />}
          summary={memberIds.length === 0 ? <span className="text-muted-foreground">{t("modules.members")}</span> : <span>{memberIds.map(nameOf).filter(Boolean).join(", ")}</span>}
          options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} /> }))}
          onToggle={(id, on) => setMemberIds(on ? [...memberIds, id] : memberIds.filter((other) => other !== id))} />
      </div>
      <div data-testid="module-date-fields" className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <label className="grid min-w-40 gap-1 text-sm text-muted-foreground">{t("modules.start")}<DatePicker label={t("modules.start")} value={startDate} max={endDate || undefined} onChange={setStartDate} /></label>
        <label className="grid min-w-40 gap-1 text-sm text-muted-foreground">{t("modules.end")}<DatePicker label={t("modules.end")} value={endDate} min={startDate || undefined} field="due" onChange={setEndDate} /></label>
      </div>
      {note && <p role="alert" className="m-0 text-destructive">{note}</p>}
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" className="secondary" onClick={onClose}>{t("modules.cancel")}</Button>
        <Button type="submit" disabled={busy}>{t(module ? "modules.save" : "modules.create")}</Button>
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
      {canWrite && !module.archived && <Button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onEdit(); }}><Pencil aria-hidden size={14} />{t("modules.edit")}</Button>}
      {canAdmin && (module.archived
        ? <Button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onArchive(); }}><ArchiveRestore aria-hidden size={14} />{t("modules.unarchive")}</Button>
        : <Button type="button" role="menuitem" className={`${menuItemClass} disabled:opacity-50`} disabled={!archivable} title={t("modules.archiveHint")} onClick={() => { close(); onArchive(); }}><Archive aria-hidden size={14} />{t("modules.archive")}</Button>)}
      {canAdmin && <Button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onDelete(); }}><Trash2 aria-hidden size={14} />{t("modules.delete")}</Button>}
    </>}
  </Popover>;
}

function Members({ ids, people }: { ids: string[]; people: Person[] }) {
  const named = ids.map((id) => people.find((person) => person.userId === id)).filter((person): person is Person => !!person);
  if (named.length === 0) return null;
  return <span className="flex items-center -space-x-1" title={named.map((person) => person.name).join(", ")}>{named.slice(0, 3).map((person) => <Avatar key={person.userId} name={person.name} id={person.userId} agent={person.isAgent} />)}{named.length > 3 && <span className="pl-2 text-xs text-muted-foreground">+{named.length - 3}</span>}</span>;
}

function useDisplay(): [Display, (next: Display) => void] {
  const [display, setDisplay] = React.useState<Display>(() => { try { return localStorage.getItem(displayKey) === "grid" ? "grid" : "list"; } catch { return "list"; } });
  return [display, (next) => { setDisplay(next); try { localStorage.setItem(displayKey, next); } catch { /* storage unavailable: the choice lasts for this visit */ } }];
}

export function ModulesPage({ workspaceId, workspaceSlug, projectKey, projectId, canWrite, canAdmin, enabled, action }: { workspaceId: string; workspaceSlug: string; projectKey: string; projectId: string; canWrite: boolean; canAdmin: boolean; enabled: boolean; action: Call }) {
  const [modules, setModules] = React.useState<Module[] | null>(null);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [archived, setArchived] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [leadFilter, setLeadFilter] = React.useState("");
  const [memberFilter, setMemberFilter] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [display, setDisplay] = useDisplay();
  const [form, setForm] = React.useState<{ module?: Module } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const requestId = React.useRef(0);
  const load = React.useCallback(async () => {
    const currentRequest = ++requestId.current;
    const result = enabled ? await action<Module[]>("list_modules", { projectId, archived, search, ...(statusFilter ? { status: statusFilter } : {}), ...(leadFilter ? { leadId: leadFilter } : {}), ...(memberFilter ? { memberId: memberFilter } : {}), ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}) }) : null;
    if (currentRequest === requestId.current) setModules(result);
  }, [action, projectId, enabled, archived, search, statusFilter, leadFilter, memberFilter, dateFrom, dateTo]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { if (enabled) void action<Person[]>("list_project_members", { projectId }).then((rows) => setPeople(rows ?? [])); }, [action, projectId, enabled]);
  if (!enabled) return <section><p role="status">{t("modules.off")}</p></section>;
  const run = async (name: string, body: unknown) => { setNote((await action(name, body)) === null ? t("modules.failed") : null); await load(); };
  const remove = (module: Module) => { if (window.confirm(t("modules.deleteConfirm"))) void run("delete_module", { moduleId: module.id }); };
  const menu = (module: Module) => <ModuleMenu module={module} canWrite={canWrite} canAdmin={canAdmin} onEdit={() => setForm({ module })}
    onArchive={() => void run(module.archived ? "unarchive_module" : "archive_module", { moduleId: module.id })} onDelete={() => remove(module)} />;
  const leadOf = (module: Module) => people.find((person) => person.userId === module.leadId);
  const toggle = (value: Display, icon: React.ReactNode) => <Button type="button" aria-pressed={display === value} aria-label={t(`modules.display.${value}`)} title={t(`modules.display.${value}`)}
    className={`${iconButton} ${display === value ? "bg-accent text-foreground" : ""}`} onClick={() => setDisplay(value)}>{icon}</Button>;
  return <section className="grid gap-4">
    <PageHeader level={2} title={<><Package aria-hidden size={20} />{t("modules.title")}</>} actions={<>
        <label className="flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground"><Checkbox checked={archived} onChange={(event) => setArchived(event.target.checked)} />{t("modules.showArchived")}</label>
        <div role="group" aria-label={t("modules.display")} className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">{toggle("list", <List aria-hidden size={15} />)}{toggle("grid", <LayoutGrid aria-hidden size={15} />)}</div>
        {canWrite && !archived && <Button type="button" className={primaryButton} onClick={() => setForm({})}><Plus aria-hidden size={14} />{t("modules.addNew")}</Button>}
    </>} className="border-b border-border pb-3" />
    <div data-testid="module-filters" className="grid grid-cols-1 items-end gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 xl:grid-cols-6">
      <label className="grid min-w-0 gap-1 text-sm font-medium">{t("modules.searchModules")}<Input type="search" aria-label={t("modules.searchModules")} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="grid min-w-0 gap-1 text-sm font-medium">{t("modules.statusFilter")}<Select value={statusFilter || "any"} items={[{ value: "any", label: t("modules.anyStatus") }, ...statuses.map((value) => ({ value, label: t(`modules.status.${value}`) }))]} onValueChange={(value) => setStatusFilter(!value || value === "any" ? "" : value)}><SelectTrigger aria-label={t("modules.statusFilter")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="any"><SelectItemText>{t("modules.anyStatus")}</SelectItemText></SelectItem>{statuses.map((value) => <SelectItem key={value} value={value}><SelectItemText>{t(`modules.status.${value}`)}</SelectItemText></SelectItem>)}</SelectContent></Select></label>
      <label className="grid min-w-0 gap-1 text-sm font-medium">{t("modules.leadFilter")}<Select value={leadFilter || "any"} items={[{ value: "any", label: t("modules.anyLead") }, ...people.filter((person) => !person.isAgent).map((person) => ({ value: person.userId, label: person.name }))]} onValueChange={(value) => setLeadFilter(!value || value === "any" ? "" : value)}><SelectTrigger aria-label={t("modules.leadFilter")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="any"><SelectItemText>{t("modules.anyLead")}</SelectItemText></SelectItem>{people.filter((person) => !person.isAgent).map((person) => <SelectItem key={person.userId} value={person.userId}><SelectItemText>{person.name}</SelectItemText></SelectItem>)}</SelectContent></Select></label>
      <label className="grid min-w-0 gap-1 text-sm font-medium">{t("modules.memberFilter")}<Select value={memberFilter || "any"} items={[{ value: "any", label: t("modules.anyMember") }, ...people.map((person) => ({ value: person.userId, label: person.name }))]} onValueChange={(value) => setMemberFilter(!value || value === "any" ? "" : value)}><SelectTrigger aria-label={t("modules.memberFilter")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="any"><SelectItemText>{t("modules.anyMember")}</SelectItemText></SelectItem>{people.map((person) => <SelectItem key={person.userId} value={person.userId}><SelectItemText>{person.name}</SelectItemText></SelectItem>)}</SelectContent></Select></label>
      <label className="grid min-w-0 gap-1 text-sm font-medium">{t("modules.dateFrom")}<DatePicker label={t("modules.dateFrom")} value={dateFrom} onChange={setDateFrom} /></label>
      <label className="grid min-w-0 gap-1 text-sm font-medium">{t("modules.dateTo")}<DatePicker label={t("modules.dateTo")} value={dateTo} field="due" onChange={setDateTo} /></label>
      {(search || statusFilter || leadFilter || memberFilter || dateFrom || dateTo) && <Button type="button" className={primaryButton} onClick={() => { setSearch(""); setStatusFilter(""); setLeadFilter(""); setMemberFilter(""); setDateFrom(""); setDateTo(""); }}>{t("modules.clearFilters")}</Button>}
    </div>
    {note && <p role="alert" className="m-0 px-4 py-2 text-destructive">{note}</p>}
    {modules?.length === 0 && (archived || search || statusFilter || leadFilter || memberFilter || dateFrom || dateTo
      ? <EmptyState title={search || statusFilter || leadFilter || memberFilter || dateFrom || dateTo ? t("modules.noMatches") : t("modules.empty")} />
      : <EmptyState title={t("modules.empty")} description={t("modules.emptyHint")} action={canWrite ? <Button type="button" className={primaryButton} onClick={() => setForm({})}><Plus aria-hidden size={14} />{t("modules.createFirst")}</Button> : undefined} />)}
    {display === "list"
      ? <ul aria-label={t("modules.title")} className="m-0 grid list-none gap-1 rounded-xl border border-border bg-card p-1 empty:hidden">{(modules ?? []).map((module) => <li key={module.id} data-testid={`module-row-${module.name}`} className="flex flex-wrap items-center gap-3 rounded-lg px-4 py-3 transition-colors hover:bg-accent">
        <ProgressRing percent={module.progress.percent} />
        <Link to={paths.module(workspaceSlug, projectKey, module.id)} className="min-w-48 flex-1 truncate text-sm font-medium text-foreground">{module.name}</Link>
        <span className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"><CalendarRange aria-hidden size={13} />{dateRange(module)}</span>
        <StatusBadge status={module.status} />
        <span className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">{t("modules.itemCount").replace("{count}", formatNumber(module.itemCount))}</span>
        <Members ids={module.memberIds} people={people} />
        {leadOf(module) && <span title={`${t("modules.lead")}: ${leadOf(module)?.name}`}><Avatar name={leadOf(module)?.name ?? ""} id={module.leadId ?? undefined} /></span>}
        {menu(module)}
      </li>)}</ul>
      : <ul aria-label={t("modules.title")} className="m-0 grid list-none grid-cols-1 gap-2 rounded-xl border border-border bg-card p-2 empty:hidden sm:grid-cols-2 xl:grid-cols-3">{(modules ?? []).map((module) => <li key={module.id} data-testid={`module-card-${module.name}`} className="grid content-between gap-4 rounded-lg bg-muted p-4 transition-colors hover:bg-background">
        <div className="flex items-start gap-2">
          <Link to={paths.module(workspaceSlug, projectKey, module.id)} className="min-w-0 flex-1 truncate text-base font-medium text-foreground">{module.name}</Link>
          {menu(module)}
        </div>
        <div className="flex items-center gap-2"><StatusBadge status={module.status} /><span className="text-xs text-muted-foreground">{t("modules.itemCount").replace("{count}", formatNumber(module.itemCount))}</span></div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarRange aria-hidden size={13} />{dateRange(module)}</div>
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <ProgressRing percent={module.progress.percent} />
          <span className="text-xs text-muted-foreground">{t("modules.percent").replace("{percent}", formatNumber(module.progress.percent))}</span>
          <span className="ml-auto flex items-center gap-2"><Members ids={module.memberIds} people={people} />{leadOf(module) && <span title={`${t("modules.lead")}: ${leadOf(module)?.name}`}><Avatar name={leadOf(module)?.name ?? ""} id={module.leadId ?? undefined} /></span>}</span>
        </div>
      </li>)}</ul>}
    {form && <ModuleFormModal action={action} projectId={projectId} workspaceId={workspaceId} module={form.module} onClose={() => setForm(null)} onSaved={() => void load()} />}
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
        <h2 className="m-0 flex-1 text-lg font-semibold text-foreground">{t("modules.addItemsTitle")}</h2>
        <Button type="button" className={iconButton} aria-label={t("modules.close")} onClick={onClose}><X aria-hidden size={16} /></Button>
      </div>
      <Input autoFocus type="search" aria-label={t("modules.searchItems")} placeholder={t("modules.searchItems")} value={query} className="w-full text-sm" onChange={(event) => setQuery(event.target.value)} />
      {candidates.length === 0 && <p className="m-0 text-sm text-muted-foreground">{t("modules.noneToAdd")}</p>}
      <ul className="m-0 grid max-h-72 list-none gap-0.5 overflow-auto p-0">{shown.map((item) => <li key={item.id}>
        <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent">
          <Checkbox checked={selected.includes(item.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />
          <span className="text-muted-foreground">{item.displayId}</span><span className="truncate">{item.title}</span>
        </label>
      </li>)}</ul>
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" className="secondary" onClick={onClose}>{t("modules.cancel")}</Button>
        <Button type="button" disabled={selected.length === 0} onClick={async () => { await onAdd(selected); onClose(); }}>{t("modules.add")}</Button>
      </div>
    </div>
  </Overlay>;
}

function PropertyRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2 text-sm">
    <span className="flex items-center gap-2 text-muted-foreground">{icon}{label}</span>
    <div className="flex min-w-0 flex-wrap items-center gap-1">{children}</div>
  </div>;
}

export function ModuleDetailPage({ workspaceId, workspaceSlug, projectKey, projectId, moduleId, canWrite, canAdmin, enabled, action, run: runQuery }: { workspaceId: string; workspaceSlug: string; projectKey: string; projectId: string; moduleId: string; canWrite: boolean; canAdmin: boolean; enabled: boolean; action: Call; run?: Run }) {
  const detailsPanel = useDetailsPanel("module");
  const navigate = useNavigate();
  const [module, setModule] = React.useState<ModuleDetail | null | undefined>(undefined);
  const [candidates, setCandidates] = React.useState<Item[]>([]);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [insights, setInsights] = React.useState<Insights | null>(null);
  const [breakdown, setBreakdown] = React.useState("state");
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
    setInsights(await action<Insights>("get_module_insights", { moduleId }));
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
  return <section className="flex min-h-full min-w-0 max-w-full flex-col gap-3 overflow-x-hidden">
    <header className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
      <nav aria-label={t("workItems.breadcrumb")} className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-sm text-muted-foreground">
        <Link to={paths.workItems(workspaceSlug, projectKey)} className="text-muted-foreground hover:text-foreground">{projectKey}</Link><ChevronRight aria-hidden size={12} />
        <Link to={back} aria-label={t("modules.back")} className="text-muted-foreground hover:text-foreground">{t("modules.title")}</Link><ChevronRight aria-hidden size={12} />
        <span className="truncate font-medium text-foreground">{module.name}</span>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <DetailsPanelToggle open={detailsPanel.open} onToggle={detailsPanel.toggle} panelId="module-details-panel" />
        {editable && <Button type="button" className={primaryButton} onClick={() => setAdding(true)}><Plus aria-hidden size={14} />{t("modules.addWorkItems")}</Button>}
        <ModuleMenu module={module} canWrite={canWrite} canAdmin={canAdmin} onEdit={() => setEditing(true)}
          onArchive={() => void run(module.archived ? "unarchive_module" : "archive_module", { moduleId })}
          onDelete={async () => {
            if (!window.confirm(t("modules.deleteConfirm"))) return;
            if ((await action("delete_module", { moduleId })) === null) setNote(t("modules.failed")); else navigate(back);
          }} />
      </div>
    </header>
    {module.archived && <p role="status" className="m-0 px-4 py-2 text-sm text-muted-foreground">{t("modules.archivedNote")}</p>}
    {note && <p role="alert" className="m-0 px-4 py-2 text-destructive">{note}</p>}
    <div className="flex flex-1 flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 overflow-x-auto p-4">
        <h2 className="sr-only">{t("modules.workItems")}</h2>
        <WorkItemLayouts projectId={projectId} workspaceSlug={workspaceSlug} action={action} run={runQuery} refreshKey={refreshKey} moduleId={moduleId}
          rowAction={editable ? (item) => <Button className="whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => void run("remove_module_items", { moduleId, workItemIds: [item.id] })}>{t("modules.remove")}</Button> : undefined} />
      </div>
      <aside id="module-details-panel" aria-label={t("modules.properties")} className={`grid content-start gap-3 rounded-xl border border-border bg-card p-4 sm:p-5 lg:w-80 lg:shrink-0 ${detailsPanel.open ? "" : "lg:hidden"}`}>
        <section className="grid gap-2" aria-label={t("workItems.description")}><h3 className="m-0 text-sm font-semibold">{t("workItems.description")}</h3><EntityDescription key={module.id} action={action} workspaceId={workspaceId} owner={{ ownerType: "module", ownerId: module.id }} mentionPeople={people} initial={module.description ?? null} editable={editable} /></section>
        <div className="flex items-center gap-2"><StatusBadge status={module.status} /></div>
        <BurndownChart action={action} name="get_module_burndown" body={{ moduleId }} projectId={projectId} refreshKey={refreshKey} testId="module-burndown" />
        {insights && <section aria-label={t("modules.risks")} className="grid gap-2 border-t border-border pt-3">
          <h3 className="m-0 text-sm font-semibold text-foreground">{t("modules.risks")}</h3>
          <InsightList title={t("modules.blocked")} items={insights.blocked} workspaceSlug={workspaceSlug} />
          <InsightList title={t("modules.overdue")} items={insights.overdue} workspaceSlug={workspaceSlug} />
          <label className="grid gap-1 text-xs text-muted-foreground">{t("modules.breakdown")}
            <Select value={breakdown} items={["state", "assignee", "label", "priority"].map((dimension) => ({ value: dimension, label: t(`modules.breakdown.${dimension}` as MessageKey) }))} onValueChange={(value) => { if (value) setBreakdown(value); }}>
              <SelectTrigger aria-label={t("modules.breakdown")}><SelectValue /></SelectTrigger>
              <SelectContent>{["state", "assignee", "label", "priority"].map((dimension) => <SelectItem key={dimension} value={dimension}><SelectItemText>{t(`modules.breakdown.${dimension}` as MessageKey)}</SelectItemText></SelectItem>)}</SelectContent>
            </Select>
          </label>
          <ul className="m-0 grid list-none gap-1 p-0">{(insights.breakdowns[breakdown] ?? []).map((group) => <li key={group.key} className="rounded border border-border p-2"><span className="flex justify-between text-xs"><span>{group.label}</span><span>{group.items.length}</span></span><ItemLinks items={group.items} workspaceSlug={workspaceSlug} /></li>)}</ul>
        </section>}
        <h2 className="m-0 text-xl font-semibold text-foreground">{module.name}</h2>
        <PropertyRow icon={<CalendarRange aria-hidden size={15} />} label={t("modules.status")}>
          <SingleSelect label={t("modules.status")} summary={t(`modules.status.${module.status}`)} value={module.status} readOnly={!editable}
            options={statuses.map((value) => ({ id: value, name: t(`modules.status.${value}`) }))} onSelect={(value) => void patch({ status: value as Status })} />
        </PropertyRow>
        <PropertyRow icon={<CalendarRange aria-hidden size={15} />} label={t("modules.dateRange")}>
          <DatePicker label={t("modules.start")} disabled={!editable} value={module.startDate ?? ""} max={module.endDate ?? undefined} onChange={(value) => void patch({ startDate: value || null })} />
          <DatePicker label={t("modules.end")} disabled={!editable} value={module.endDate ?? ""} min={module.startDate ?? undefined} field="due" onChange={(value) => void patch({ endDate: value || null })} />
        </PropertyRow>
        <PropertyRow icon={<CircleUserRound aria-hidden size={15} />} label={t("modules.lead")}>
          <SingleSelect label={t("modules.lead")} summary={module.leadId ? nameOf(module.leadId) : t("modules.noLead")} value={module.leadId ?? ""} readOnly={!editable}
            icon={module.leadId ? <Avatar name={nameOf(module.leadId)} id={module.leadId} /> : undefined}
            options={[{ id: "", name: t("modules.noLead") }, ...people.filter((person) => !person.isAgent).map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} /> }))]} onSelect={(id) => void patch({ leadId: id || null })} />
        </PropertyRow>
        <PropertyRow icon={<Users aria-hidden size={15} />} label={t("modules.members")}>
          <MultiSelect label={t("modules.members")} readOnly={!editable} selected={module.memberIds}
            summary={module.memberIds.length === 0 ? <span className="text-muted-foreground">{t("modules.noMembers")}</span> : <span className="flex items-center gap-1">{module.memberIds.slice(0, 3).map((id) => <Avatar key={id} name={nameOf(id)} id={id} agent={people.find((person) => person.userId === id)?.isAgent} />)}<span className="max-w-32 truncate">{module.memberIds.map(nameOf).join(", ")}</span></span>}
            options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} /> }))}
            onToggle={(id, on) => void patch({ memberIds: on ? [...module.memberIds, id] : module.memberIds.filter((other) => other !== id) })} />
        </PropertyRow>
        <PropertyRow icon={<Package aria-hidden size={15} />} label={t("modules.workItemsCount")}>
          <span data-testid="module-items-count" className="px-1 text-sm font-medium text-foreground">{formatNumber(completed)}/{formatNumber(total)}</span>
        </PropertyRow>
        <div className="grid gap-2 border-t border-border pt-3">
          <div className="flex items-center justify-between text-sm"><span className="font-medium text-foreground">{t("modules.progress")}</span><span className="text-muted-foreground">{t("modules.percent").replace("{percent}", formatNumber(percent))}</span></div>
          <progress max={100} value={percent} aria-label={t("modules.progress")} className="h-1.5 w-full" />
        </div>
      </aside>
    </div>
    {editing && <ModuleFormModal action={action} projectId={projectId} workspaceId={workspaceId} module={module} onClose={() => setEditing(false)} onSaved={() => void load()} />}
    {adding && <AddItemsModal candidates={candidates} onClose={() => setAdding(false)} onAdd={(ids) => run("add_module_items", { moduleId, workItemIds: ids })} />}
  </section>;
}

function InsightList({ title, items, workspaceSlug }: { title: string; items: Item[]; workspaceSlug: string }) {
  return <details><summary className="cursor-pointer text-sm font-medium">{title} · {items.length}</summary><ItemLinks items={items} workspaceSlug={workspaceSlug} /></details>;
}
function ItemLinks({ items, workspaceSlug }: { items: Item[]; workspaceSlug: string }) {
  return items.length ? <ul className="m-0 mt-1 grid list-none gap-1 p-0">{items.map((item) => <li key={item.id}><Link className="text-xs text-foreground hover:underline" to={paths.workItem(workspaceSlug, item.displayId)}>{item.displayId} · {item.title}</Link></li>)}</ul> : null;
}
