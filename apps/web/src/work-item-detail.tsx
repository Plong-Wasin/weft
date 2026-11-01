import React from "react";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, CalendarCheck, CalendarClock, CircleUserRound, Gauge, Layers, Link2, Maximize2, RefreshCw, Package, Tag, Trash2, Users, X, CircleDot } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "./api";
import { paths } from "./routes";
import { TimelinePanel } from "./comments-panel";
import { RelationsPanel } from "./relations-panel";
import { Sidecar } from "./sidecar";
import { AttachmentsPanel } from "./asset-images";
import { DescriptionEditor } from "./description-editor";
import { Avatar, MultiSelect, PriorityIcon, SingleSelect, StateIcon } from "./property-dropdowns";
import { priorityOrder } from "./work-item-layout";
import { useWorkspace } from "./layouts/workspace-layout";
import type { Label, Member, Project, WorkItem, WorkState } from "./types";

type Named = { id: string; name: string; status?: string };
const t = (key: string) => translate(key as MessageKey);
const sectionClass = "grid gap-2 [&_form]:my-0 [&_form]:flex [&_form]:flex-wrap [&_form]:items-center [&_form]:gap-2 [&_select]:w-auto [&_button]:w-auto [&_button]:whitespace-nowrap [&_p]:m-0 [&_h3]:m-0 [&_h3]:text-16 [&_h3]:font-semibold [&_h3]:text-primary [&_ul]:m-0 [&_ul]:pl-5";
const iconButton = "grid size-8 place-items-center rounded-md border border-subtle bg-surface-1 p-0 text-secondary hover:bg-layer-transparent-hover hover:text-primary";

function PropertyRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2 text-13">
    <span className="flex items-center gap-2 text-secondary">{icon}{label}</span>
    <div className="flex min-w-0 flex-wrap items-center gap-1">{children}</div>
  </div>;
}

/** A work item in full: used as the peek panel body and as the full page. Every property in the sidebar is editable inline. */
export function WorkItemDetail({ displayId, mode, onClose, onChanged }: { displayId: string; mode: "page" | "peek"; onClose?: () => void; onChanged?: () => void }) {
  const { workspace, selfId } = useWorkspace();
  const navigate = useNavigate();
  const [item, setItem] = React.useState<WorkItem | null | undefined>(undefined);
  const [project, setProject] = React.useState<Project | null>(null);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [subItems, setSubItems] = React.useState<WorkItem[]>([]);
  const [projectItems, setProjectItems] = React.useState<WorkItem[]>([]);
  const [cycles, setCycles] = React.useState<Named[]>([]);
  const [modules, setModules] = React.useState<Named[]>([]);
  const [cycleId, setCycleId] = React.useState("");
  const [moduleIds, setModuleIds] = React.useState<string[]>([]);
  const [subTitle, setSubTitle] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const pending = React.useRef<{ id: string; doc: unknown } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedId = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    const found = await action<WorkItem>("get_work_item", { workspaceId: workspace.id, displayId });
    setItem(found);
    if (!found) return;
    // The server returns the current key: rewrite an old-alias URL to the canonical one (full page only).
    if (mode === "page" && found.displayId !== displayId.toUpperCase()) navigate(`${paths.workItem(workspace.slug, found.displayId)}${window.location.hash}`, { replace: true });
    if (loadedId.current !== found.id) { loadedId.current = found.id; setTitle(found.title); }
    const [projects, stateRows, labelRows, memberRows, subRows, itemRows] = await Promise.all([
      action<Project[]>("list_projects", { workspaceId: workspace.id }), action<WorkState[]>("list_states", { projectId: found.projectId }),
      action<Label[]>("list_labels", { projectId: found.projectId }), action<Member[]>("list_project_members", { projectId: found.projectId }),
      action<WorkItem[]>("list_sub_work_items", { workItemId: found.id }), action<WorkItem[]>("list_work_items", { projectId: found.projectId }),
    ]);
    const mine = (projects ?? []).find((candidate) => candidate.id === found.projectId) ?? null;
    setProject(mine); setStates(stateRows ?? []); setLabels(labelRows ?? []); setPeople(memberRows ?? []); setSubItems(subRows ?? []); setProjectItems(itemRows ?? []);
    // The work item payload carries no Cycle or Module, so its memberships come from one listing per Cycle or Module.
    const cycleRows = mine?.features.cycles ? await action<Named[]>("list_cycles", { projectId: found.projectId }) ?? [] : [];
    const moduleRows = mine?.features.modules ? await action<Named[]>("list_modules", { projectId: found.projectId }) ?? [] : [];
    setCycles(cycleRows); setModules(moduleRows);
    let inCycle = "";
    for (const cycle of cycleRows) if ((await action<WorkItem[]>("list_work_items", { projectId: found.projectId, cycleId: cycle.id }) ?? []).some((row) => row.id === found.id)) inCycle = cycle.id;
    const inModules: string[] = [];
    for (const module of moduleRows) if ((await action<WorkItem[]>("list_work_items", { projectId: found.projectId, moduleId: module.id }) ?? []).some((row) => row.id === found.id)) inModules.push(module.id);
    setCycleId(inCycle); setModuleIds(inModules);
  }, [workspace.id, workspace.slug, displayId, navigate, mode]);
  React.useEffect(() => { loadedId.current = null; void load(); }, [load]);

  const flush = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) void action("update_work_item", { workItemId: next.id, description: next.doc });
  }, []);
  // Closing the peek or leaving the page must not lose a description typed in the last moments.
  React.useEffect(() => flush, [flush]);

  if (item === undefined) return null;
  if (item === null) return <section className="grid gap-3 p-6"><p role="alert">{t("workItems.notFound")}</p><Link to={paths.home(workspace.slug)}>{t("projects.back")}</Link></section>;

  const guard = async (result: unknown) => { setNote(result === null ? t("workItems.failed") : null); await load(); onChanged?.(); };
  const change = async (body: Record<string, unknown>) => guard(await action("update_work_item", { workItemId: item.id, ...body }));
  const canWrite = project?.role !== "Guest" && !project?.archived;
  const back = project ? paths.workItems(workspace.slug, project.key) : paths.home(workspace.slug);
  const itemPath = paths.workItem(workspace.slug, item.displayId);
  const personName = (id: string) => people.find((person) => person.userId === id)?.name ?? id;
  const creator = personName(item.createdBy);
  const stateOf = states.find((state) => state.id === item.stateId);
  const assignees = item.assigneeIds;
  const parent = projectItems.find((candidate) => candidate.id === item.parentId);

  const setCycle = async (to: string) => {
    if (cycleId && await action("remove_cycle_items", { cycleId, workItemIds: [item.id] }) === null) return setNote(t("workItems.failed"));
    if (to && (await action<{ added: string[] }>("add_cycle_items", { cycleId: to, workItemIds: [item.id] }))?.added.includes(item.id) !== true) { await load(); return setNote(t("workItems.failed")); }
    await guard({});
  };
  const setModule = async (id: string, on: boolean) => guard(await action(on ? "add_module_items" : "remove_module_items", { moduleId: id, workItemIds: [item.id] }));
  const remove = async () => {
    if (await action("delete_work_item", { workItemId: item.id }) === null) return setNote(t("workItems.failed"));
    onChanged?.();
    if (mode === "peek") onClose?.(); else navigate(back);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${window.location.origin}${itemPath}`); setCopied(true); } catch { setNote(t("comments.copyFailed")); }
  };

  const header = <header className={`flex items-center gap-2 border-b border-subtle px-4 py-2.5 ${mode === "page" ? "" : "bg-surface-1"}`}>
    {mode === "peek"
      ? <>
        <button type="button" className={iconButton} aria-label={t("workItems.peek.close")} title={t("workItems.peek.close")} onClick={onClose}><X aria-hidden size={16} /></button>
        <Link to={itemPath} className={iconButton} aria-label={t("workItems.peek.expand")} title={t("workItems.peek.expand")}><Maximize2 aria-hidden size={15} /></Link>
      </>
      : <nav aria-label={t("workItems.breadcrumb")} className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-13 text-secondary">
        {project && <Link to={paths.workItems(workspace.slug, project.key)} className="truncate text-secondary hover:text-primary">{project.name}</Link>}
        <span aria-hidden>›</span>
        <Link to={back} className="text-secondary hover:text-primary">{t("workItems.title")}</Link>
        <span aria-hidden>›</span>
        <span className="font-medium text-primary">{item.displayId}</span>
      </nav>}
    <div className="ml-auto flex items-center gap-2">
      {mode === "page" && <span className="[&_button]:whitespace-nowrap"><Sidecar workspace={workspace} context={{ type: "work_item", id: item.displayId, title: item.title }} /></span>}
      <button type="button" className={iconButton} aria-label={copied ? t("workItems.linkCopied") : t("workItems.copyLink")} title={copied ? t("workItems.linkCopied") : t("workItems.copyLink")} onClick={() => void copy()}><Link2 aria-hidden size={15} /></button>
      {canWrite && <button type="button" className={iconButton} aria-label={t("workItems.delete")} title={t("workItems.delete")} onClick={() => void remove()}><Trash2 aria-hidden size={15} /></button>}
    </div>
  </header>;

  const main = <div className="grid min-w-0 content-start gap-6 p-4 sm:p-6">
    <div className="grid gap-2">
      <h2 className="m-0 text-14 font-medium text-tertiary">{item.displayId}</h2>
      <input aria-label={t("workItems.titleField")} value={title} maxLength={500} readOnly={!canWrite} className="w-full border-0 bg-transparent p-0 text-24 font-semibold text-primary outline-none"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => { const next = title.trim(); if (!next) setTitle(item.title); else if (next !== item.title) void change({ title: next }); }}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    </div>
    <div className="min-h-16"><DescriptionEditor key={item.id} workItemId={item.id} initial={item.description} editable={canWrite}
      onChange={(doc) => { pending.current = { id: item.id, doc }; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(flush, 700); }} /></div>
    <section className={sectionClass} aria-label={t("workItems.subItems")}>
      <h3>{t("workItems.subItems")}</h3>
      {subItems.length === 0 && <p className="m-0 text-13 text-tertiary">{t("workItems.subItems.empty")}</p>}
      <ul className="list-none !pl-0">{subItems.map((sub) => <li key={sub.id} className="flex items-center gap-2 border-b border-subtle py-1.5 text-13">
        <StateIcon group={states.find((state) => state.id === sub.stateId)?.group ?? "unstarted"} />
        <Link to={paths.workItem(workspace.slug, sub.displayId)} className="text-primary"><span className="text-tertiary">{sub.displayId}</span> {sub.title}</Link>
      </li>)}</ul>
      {canWrite && <form className="my-0 flex items-center gap-2 [&>button]:shrink-0 [&>button]:whitespace-nowrap" onSubmit={async (event) => { event.preventDefault(); await guard(await action("create_work_item", { projectId: item.projectId, title: subTitle, parentId: item.id })); setSubTitle(""); }}>
        <input required aria-label={`${t("workItems.subItems")}: ${t("workItems.titleField")}`} placeholder={t("workItems.quickTitle")} value={subTitle} className="flex-1" onChange={(event) => setSubTitle(event.target.value)} />
        <button>{t("workItems.subItems.add")}</button>
      </form>}
    </section>
    <div className={sectionClass}><RelationsPanel workspaceSlug={workspace.slug} workItemId={item.id} candidates={projectItems.filter((candidate) => candidate.id !== item.id)} canWrite={canWrite} action={action} onChange={() => void load()} /></div>
    <div className={sectionClass}><AttachmentsPanel workItemId={item.id} canWrite={canWrite} action={action} onChange={() => void load()} /></div>
    <div className={sectionClass}><TimelinePanel workItemId={item.id} projectId={item.projectId} selfId={selfId} canComment={canWrite} linkBase={itemPath} action={action} onChange={() => void load()} /></div>
    {note && <p role="alert" className="text-danger-text">{note}</p>}
  </div>;

  const sidebar = <aside aria-label={t("workItems.properties")} className={`grid content-start gap-3 p-4 sm:p-6 ${mode === "page" ? "border-t border-subtle lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0" : "border-t border-subtle"}`}>
    <h3 className="m-0 text-14 font-semibold text-primary">{t("workItems.properties")}</h3>
    <PropertyRow icon={<CircleDot aria-hidden size={15} />} label={t("workItems.state")}>
      <SingleSelect label={t("workItems.state")} summary={stateOf?.name ?? ""} value={item.stateId} readOnly={!canWrite} icon={<StateIcon group={stateOf?.group ?? "unstarted"} />}
        options={states.map((state) => ({ id: state.id, name: state.name, icon: <StateIcon group={state.group} /> }))} onSelect={(stateId) => void change({ stateId })} />
    </PropertyRow>
    <PropertyRow icon={<Users aria-hidden size={15} />} label={t("workItems.assignees")}>
      <MultiSelect label={t("workItems.assignees")} readOnly={!canWrite} selected={assignees}
        summary={assignees.length === 0 ? <span className="text-secondary">{t("workItems.noAssignee")}</span> : <span className="flex items-center gap-1">{assignees.slice(0, 3).map((id) => <Avatar key={id} name={personName(id)} />)}<span className="max-w-32 truncate">{assignees.map(personName).join(", ")}</span></span>}
        options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} /> }))}
        onToggle={(id, on) => void change({ assigneeIds: on ? [...assignees, id] : assignees.filter((other) => other !== id) })} />
    </PropertyRow>
    <PropertyRow icon={<Gauge aria-hidden size={15} />} label={t("workItems.priority")}>
      <SingleSelect label={t("workItems.priority")} summary={t(`workItems.priority.${item.priority}`)} value={item.priority} readOnly={!canWrite} icon={<PriorityIcon priority={item.priority} />}
        options={priorityOrder.map((id) => ({ id, name: t(`workItems.priority.${id}`), icon: <PriorityIcon priority={id} /> }))} onSelect={(priority) => void change({ priority })} />
    </PropertyRow>
    <PropertyRow icon={<CircleUserRound aria-hidden size={15} />} label={t("workItems.createdBy")}>
      <span className="flex items-center gap-1.5 px-1 text-13 font-medium text-primary"><Avatar name={creator} />{creator}</span>
    </PropertyRow>
    <PropertyRow icon={<CalendarClock aria-hidden size={15} />} label={t("workItems.startDate")}>
      <input type="date" aria-label={t("workItems.startDate")} disabled={!canWrite} value={item.startDate ?? ""} max={item.dueDate ?? undefined} className="w-auto text-13" onChange={(event) => void change({ startDate: event.target.value || null })} />
    </PropertyRow>
    <PropertyRow icon={<CalendarCheck aria-hidden size={15} />} label={t("workItems.dueDate")}>
      <input type="date" aria-label={t("workItems.dueDate")} disabled={!canWrite} value={item.dueDate ?? ""} min={item.startDate ?? undefined} className="w-auto text-13" onChange={(event) => void change({ dueDate: event.target.value || null })} />
    </PropertyRow>
    {project?.features.modules && <PropertyRow icon={<Package aria-hidden size={15} />} label={t("workItems.modules")}>
      <MultiSelect label={t("workItems.modules")} readOnly={!canWrite} selected={moduleIds}
        summary={moduleIds.length === 0 ? <span className="text-secondary">{t("workItems.noModules")}</span> : <span>{moduleIds.map((id) => modules.find((module) => module.id === id)?.name).filter(Boolean).join(", ")}</span>}
        options={modules.map((module) => ({ id: module.id, name: module.name }))} onToggle={(id, on) => void setModule(id, on)} />
    </PropertyRow>}
    {project?.features.cycles && <PropertyRow icon={<RefreshCw aria-hidden size={15} />} label={t("workItems.cycle")}>
      <SingleSelect label={t("workItems.cycle")} readOnly={!canWrite} value={cycleId} summary={cycles.find((cycle) => cycle.id === cycleId)?.name ?? t("workItems.noCycle")}
        options={[{ id: "", name: t("workItems.noCycle") }, ...cycles.filter((cycle) => cycle.status !== "completed" || cycle.id === cycleId).map((cycle) => ({ id: cycle.id, name: cycle.name }))]} onSelect={(id) => void setCycle(id)} />
    </PropertyRow>}
    <PropertyRow icon={<Layers aria-hidden size={15} />} label={t("workItems.parent")}>
      <SingleSelect label={t("workItems.parent")} readOnly={!canWrite} value={item.parentId ?? ""} summary={parent ? `${parent.displayId} ${parent.title}` : t("workItems.addParent")}
        options={[{ id: "", name: t("workItems.noParent") }, ...projectItems.filter((candidate) => candidate.id !== item.id).map((candidate) => ({ id: candidate.id, name: `${candidate.displayId} ${candidate.title}` }))]} onSelect={(id) => void change({ parentId: id || null })} />
      {parent && <Link to={paths.workItem(workspace.slug, parent.displayId)} aria-label={parent.displayId} className="text-secondary hover:text-primary"><ArrowUpRight aria-hidden size={14} /></Link>}
    </PropertyRow>
    <PropertyRow icon={<Tag aria-hidden size={15} />} label={t("workItems.labels")}>
      <MultiSelect label={t("workItems.labels")} readOnly={!canWrite} selected={item.labelIds} icon={undefined}
        summary={item.labelIds.length === 0 ? <span className="text-secondary">{t("workItems.noLabels")}</span> : <span className="flex flex-wrap items-center gap-1">{item.labelIds.map((id) => labels.find((label) => label.id === id)).filter((label): label is Label => !!label).map((label) => <span key={label.id} className="flex items-center gap-1"><span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: label.color }} />{label.name}</span>)}</span>}
        options={labels.map((label) => ({ id: label.id, name: label.name, icon: <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} /> }))}
        onToggle={(id, on) => void change({ labelIds: on ? [...item.labelIds, id] : item.labelIds.filter((other) => other !== id) })} />
    </PropertyRow>
  </aside>;

  if (mode === "peek") return <div className="flex h-full flex-col">{header}<div className="min-h-0 flex-1 overflow-auto">{main}{sidebar}</div></div>;
  return <div className="flex min-h-full flex-col">{header}<div className="flex flex-1 flex-col lg:flex-row"><div className="min-w-0 flex-1">{main}</div>{sidebar}</div></div>;
}
