import React from "react";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, CalendarCheck, CalendarClock, CircleUserRound, Gauge, Layers, Link2, Maximize2, RefreshCw, Package, Tag, Trash2, Users, Archive, ArchiveRestore, X, CircleDot, Sigma } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action, actionResult } from "./api";
import { copyText } from "./toast";
import { paths } from "./routes";
import { TimelinePanel } from "./comments-panel";
import { RunsPanel } from "./runs-panel";
import { RelationsPanel } from "./relations-panel";
import { SidecarTrigger } from "./sidecar";
import { AttachmentsPanel } from "./asset-images";
import { WebLinksPanel } from "./web-links-panel";
import { DescriptionEditor } from "./description-editor";
import { Avatar, EstimateSelect, MultiSelect, PriorityIcon, SingleSelect, StateIcon } from "./property-dropdowns";
import { priorityOrder } from "./work-item-layout";
import { useWorkspace } from "./layouts/workspace-layout";
import type { Estimate, Label, Member, Project, WorkItem, WorkState } from "./types";

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
  const [timelineKey, setTimelineKey] = React.useState(0);
  const [project, setProject] = React.useState<Project | null>(null);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [lastDescriptionEdit, setLastDescriptionEdit] = React.useState<{ name: string; at: string } | null>(null);
  const [descriptionVersions, setDescriptionVersions] = React.useState<Array<{ id: string; contentText: string; createdByName: string; createdAt: string }>>([]);
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [editorEpoch, setEditorEpoch] = React.useState(0);
  const [subItems, setSubItems] = React.useState<WorkItem[]>([]);
  const [projectItems, setProjectItems] = React.useState<WorkItem[]>([]);
  const [cycles, setCycles] = React.useState<Named[]>([]);
  const [modules, setModules] = React.useState<Named[]>([]);
  const [cycleId, setCycleId] = React.useState("");
  const [moduleIds, setModuleIds] = React.useState<string[]>([]);
  const [subTitle, setSubTitle] = React.useState("");
  const [sectionCounts, setSectionCounts] = React.useState({ relations: 0, links: 0, attachments: 0 });
  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  const [activeForm, setActiveForm] = React.useState<string | null>(null);
  const attachmentPicker = React.useRef<HTMLInputElement>(null);
  const [estimate, setEstimate] = React.useState<Estimate | null>(null);
  const [title, setTitle] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const pending = React.useRef<{ id: string; doc: unknown } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedId = React.useRef<string | null>(null);
  const restoring = React.useRef(false);

  const load = React.useCallback(async () => {
    const found = await action<WorkItem>("get_work_item", { workspaceId: workspace.id, displayId });
    setItem(found);
    if (!found) return;
    // The server returns the current key: rewrite an old-alias URL to the canonical one (full page only).
    if (mode === "page" && found.displayId !== displayId.toUpperCase()) navigate(`${paths.workItem(workspace.slug, found.displayId)}${window.location.hash}`, { replace: true });
    if (loadedId.current !== found.id) { loadedId.current = found.id; setTitle(found.title); }
    const [projects, stateRows, labelRows, memberRows, subRows, itemRows, activities, estimateRow] = await Promise.all([
      action<Project[]>("list_projects", { workspaceId: workspace.id }), action<WorkState[]>("list_states", { projectId: found.projectId }),
      action<Label[]>("list_labels", { projectId: found.projectId }), action<Member[]>("list_project_members", { projectId: found.projectId }),
      action<WorkItem[]>("list_sub_work_items", { workItemId: found.id }), action<WorkItem[]>("list_work_items", { projectId: found.projectId }),
      action<Array<{ field: string; actorName: string; createdAt: string }>>("list_work_item_activities", { workItemId: found.id }),
      action<Estimate | null>("get_estimate", { projectId: found.projectId }),
    ]);
    setEstimate(estimateRow ?? null);
    const mine = (projects ?? []).find((candidate) => candidate.id === found.projectId) ?? null;
    setProject(mine); setStates(stateRows ?? []); setLabels(labelRows ?? []); setPeople(memberRows ?? []); setSubItems(subRows ?? []); setProjectItems(itemRows ?? []);
    const descriptionActivity = [...(activities ?? [])].reverse().find((row) => row.field === "description" || row.field === "description_restored");
    setLastDescriptionEdit(descriptionActivity ? { name: descriptionActivity.actorName, at: descriptionActivity.createdAt } : null);

    // The work item payload carries no Cycle or Module, so its memberships come from one listing per Cycle or Module.
    const cycleRows = mine?.features.cycles ? await action<Named[]>("list_cycles", { projectId: found.projectId }) ?? [] : [];
    const moduleRows = mine?.features.modules ? await action<Named[]>("list_modules", { projectId: found.projectId }) ?? [] : [];
    setCycles(cycleRows); setModules(moduleRows);
    let inCycle = "";
    for (const cycle of cycleRows) if ((await action<WorkItem[]>("list_work_items", { projectId: found.projectId, cycleId: cycle.id, archived: !!found.archivedAt }) ?? []).some((row) => row.id === found.id)) inCycle = cycle.id;
    const inModules: string[] = [];
    for (const module of moduleRows) if ((await action<WorkItem[]>("list_work_items", { projectId: found.projectId, moduleId: module.id, archived: !!found.archivedAt }) ?? []).some((row) => row.id === found.id)) inModules.push(module.id);
    setCycleId(inCycle); setModuleIds(inModules);
  }, [workspace.id, workspace.slug, displayId, navigate, mode]);
  React.useEffect(() => { loadedId.current = null; void load(); }, [load]);

  const flush = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    return next ? action("update_work_item", { workItemId: next.id, description: next.doc }) : Promise.resolve(null);
  }, []);
  const setCount = React.useCallback((key: "relations" | "links" | "attachments", count: number) => {
    setSectionCounts((current) => current[key] === count ? current : { ...current, [key]: count });
  }, []);
  // Closing the peek or leaving the page must not lose a description typed in the last moments.
  React.useEffect(() => () => { void flush(); }, [flush]);

  if (item === undefined) return null;
  if (item === null) return <section className="grid gap-3 p-6"><p role="alert">{t("workItems.notFound")}</p><Link to={paths.home(workspace.slug)}>{t("projects.back")}</Link></section>;

  const guard = async (result: unknown) => { setNote(result === null ? t("workItems.failed") : null); await load(); onChanged?.(); };
  const change = async (body: Record<string, unknown>) => guard(await action("update_work_item", { workItemId: item.id, ...body }));
  const isArchived = !!item.archivedAt;
  const mayArchive = project?.role !== "Guest" && !project?.archived;
  const canWrite = mayArchive && !isArchived;
  const group = states.find((state) => state.id === item.stateId)?.group;
  const eligible = group === "completed" || group === "cancelled";
  const archiveOrRestore = async (name: "archive_work_item" | "restore_work_item") => {
    const result = await actionResult(name, { workItemId: item.id });
    // The Action's refusal (open Cycle or Module, wrong state) is shown as it came, not swallowed.
    setNote("error" in result ? result.error : null);
    await load(); onChanged?.();
  };
  const back = project ? paths.workItems(workspace.slug, project.key) : paths.home(workspace.slug);
  const itemPath = paths.workItem(workspace.slug, item.displayId);
  const personName = (id: string) => people.find((person) => person.userId === id)?.name ?? id;
  const creator = personName(item.createdBy);
  const stateOf = states.find((state) => state.id === item.stateId);
  const assignees = item.assigneeIds;
  const parent = projectItems.find((candidate) => candidate.id === item.parentId);
  const countCallbacks = {
    relations: (count: number) => setCount("relations", count),
    links: (count: number) => setCount("links", count),
    attachments: (count: number) => setCount("attachments", count),
  };
  const openAction = (key: string) => {
    setActiveForm((current) => current === key ? null : key);
    setCollapsed((current) => current.filter((value) => value !== key));
  };
  const section = (key: string, label: string, count: number, content: React.ReactNode) => (
    <details className={sectionClass} hidden={count === 0 && activeForm !== key} open={!collapsed.includes(key)} onToggle={(event) => {
      const isOpen = event.currentTarget.open;
      setCollapsed((current) => isOpen ? current.filter((value) => value !== key) : current.includes(key) ? current : [...current, key]);
    }}>
      <summary className="cursor-pointer text-16 font-semibold text-primary">{label} <span className="text-13 font-normal text-tertiary">{count}</span></summary>
      {content}
    </details>
  );

  const setCycle = async (to: string) => {
    if (cycleId && await action("remove_cycle_items", { cycleId, workItemIds: [item.id] }) === null) return setNote(t("workItems.failed"));
    if (to && (await action<{ added: string[] }>("add_cycle_items", { cycleId: to, workItemIds: [item.id] }))?.added.includes(item.id) !== true) { await load(); return setNote(t("workItems.failed")); }
    await guard({});
  };
  const setModule = async (id: string, on: boolean) => guard(await action(on ? "add_module_items" : "remove_module_items", { moduleId: id, workItemIds: [item.id] }));
  const remove = async () => {
    if (!window.confirm(t("workItems.deleteConfirm"))) return;
    if (await action("delete_work_item", { workItemId: item.id }) === null) return setNote(t("workItems.failed"));
    onChanged?.();
    if (mode === "peek") onClose?.(); else navigate(back);
  };
  const copy = () => copyText(`${window.location.origin}${itemPath}`, t("workItems.linkCopied"), t("comments.copyFailed"));

  const header = <header className={`flex items-center gap-2 border-b border-subtle px-4 py-2.5 ${mode === "page" ? "" : "bg-surface-1"}`}>
    {mode === "peek"
      ? <>
        <button type="button" className={iconButton} aria-label={t("workItems.peek.close")} title={t("workItems.peek.close")} onClick={onClose}><X aria-hidden size={16} /></button>
        <Link to={itemPath} className={iconButton} aria-label={t("workItems.peek.expand")} title={t("workItems.peek.expand")}><Maximize2 aria-hidden size={15} /></Link>
      </>
      : <nav aria-label={t("workItems.breadcrumb")} className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap text-13 text-secondary">
        {project && <Link to={paths.workItems(workspace.slug, project.key)} className="truncate text-secondary hover:text-primary">{project.name}</Link>}
        <span aria-hidden className="hidden sm:inline">›</span>
        <Link to={back} className="hidden text-secondary hover:text-primary sm:inline">{t("workItems.title")}</Link>
        <span aria-hidden>›</span>
        <span className="font-medium text-primary">{item.displayId}</span>
      </nav>}
    <div className="ml-auto flex items-center gap-2">
      {mode === "page" && <span className="[&_button]:whitespace-nowrap"><SidecarTrigger context={{ type: "work_item", id: item.displayId, title: item.title }} /></span>}
      <button type="button" className={iconButton} aria-label={t("workItems.copyLink")} title={t("workItems.copyLink")} onClick={() => void copy()}><Link2 aria-hidden size={15} /></button>
      {mayArchive && !isArchived && eligible && <button type="button" className={iconButton} aria-label={t("workItems.archive")} title={t("workItems.archive")} onClick={() => void archiveOrRestore("archive_work_item")}><Archive aria-hidden size={15} /></button>}
      {canWrite && <button type="button" className={`${iconButton} hover:text-danger-text`} aria-label={t("workItems.delete")} title={t("workItems.delete")} onClick={() => void remove()}><Trash2 aria-hidden size={15} /></button>}
    </div>
  </header>;

  const relativeTime = (value: string) => {
    const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
    const unit: Intl.RelativeTimeFormatUnit = Math.abs(seconds) < 60 ? "second" : Math.abs(seconds) < 3600 ? "minute" : Math.abs(seconds) < 86400 ? "hour" : "day";
    const amount = unit === "second" ? seconds : unit === "minute" ? Math.round(seconds / 60) : unit === "hour" ? Math.round(seconds / 3600) : Math.round(seconds / 86400);
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(amount, unit);
  };
  const openVersions = async () => {
    await flush();
    const rows = await action<typeof descriptionVersions>("list_work_item_description_versions", { workItemId: item.id });
    setDescriptionVersions(rows ?? []); setVersionsOpen(true);
  };
  const restoreVersion = async (versionId: string) => {
    if (restoring.current) return;
    restoring.current = true;
    try { await restoreOnce(versionId); } finally { restoring.current = false; }
  };
  const restoreOnce = async (versionId: string) => {
    await flush();
    const restored = await action<WorkItem>("restore_work_item_description_version", { workItemId: item.id, versionId });
    // The editor only reads `initial` on mount, so remount it to show the restored text.
    if (restored) { setVersionsOpen(false); setEditorEpoch((value) => value + 1); await load(); }
  };
  const main = <div className="grid min-w-0 content-start gap-6 p-4 sm:p-6">
    {isArchived && <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-subtle bg-layer-1 px-3 py-2 text-13 text-secondary">
      <Archive aria-hidden size={15} /><span>{t("workItems.archivedBanner")}</span>
      {mayArchive && <button type="button" className="secondary ml-auto flex items-center gap-1.5" onClick={() => void archiveOrRestore("restore_work_item")}><ArchiveRestore aria-hidden size={14} />{t("workItems.restore")}</button>}
    </div>}
    <div className="grid gap-2">
      {mode === "page" ? <h1 className="m-0 text-14 font-medium text-tertiary">{item.displayId}</h1> : <h2 className="m-0 text-14 font-medium text-tertiary">{item.displayId}</h2>}
      <input aria-label={t("workItems.titleField")} value={title} maxLength={500} readOnly={!canWrite} className="w-full border-0 bg-transparent p-0 text-24 font-semibold text-primary"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => { const next = title.trim(); if (!next) setTitle(item.title); else if (next !== item.title) void change({ title: next }); }}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    </div>
    {lastDescriptionEdit && <button type="button" className="justify-self-start bg-transparent p-0 text-13 text-secondary hover:bg-transparent hover:text-primary" onClick={() => void openVersions()}>
      {t("workItems.lastEditedBy").replace("{name}", lastDescriptionEdit.name).replace("{time}", relativeTime(lastDescriptionEdit.at))} ▾
    </button>}
    <div className="min-h-16"><DescriptionEditor key={`${item.id}:${editorEpoch}`} workspaceId={workspace.id} workItemId={item.id} initial={item.description} editable={canWrite}
      onChange={(doc) => { pending.current = { id: item.id, doc }; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(flush, 700); }} /></div>
    <div role="group" className="flex flex-wrap gap-2" aria-label={t("workItems.actions")}>
      {canWrite && <>
        <button type="button" className="secondary" onClick={() => openAction("subItems")}>{t("workItems.addSubItemAction")}</button>
        <button type="button" className="secondary" onClick={() => openAction("relations")}>{t("workItems.addRelationAction")}</button>
        <button type="button" className="secondary" onClick={() => openAction("links")}>{t("workItems.addLinkAction")}</button>
        <button type="button" className="secondary" onClick={() => { setActiveForm("attachments"); setCollapsed((current) => current.filter((value) => value !== "attachments")); attachmentPicker.current?.click(); }}>{t("workItems.attachAction")}</button>
      </>}
    </div>
    {section("subItems", t("workItems.subItems"), subItems.length, <>
      <ul className="list-none !pl-0">{subItems.map((sub) => <li key={sub.id} className="flex items-center gap-2 border-b border-subtle py-1.5 text-13">
        <StateIcon group={states.find((state) => state.id === sub.stateId)?.group ?? "unstarted"} />
        <Link to={paths.workItem(workspace.slug, sub.displayId)} className="text-primary"><span className="text-tertiary">{sub.displayId}</span> {sub.title}</Link>
      </li>)}</ul>
      {canWrite && activeForm === "subItems" && <form className="my-0 flex items-center gap-2 [&>button]:shrink-0 [&>button]:whitespace-nowrap" onSubmit={async (event) => { event.preventDefault(); await guard(await action("create_work_item", { projectId: item.projectId, title: subTitle, parentId: item.id })); setSubTitle(""); setActiveForm(null); }}>
        <input required aria-label={`${t("workItems.subItems")}: ${t("workItems.titleField")}`} placeholder={t("workItems.quickTitle")} value={subTitle} className="flex-1" onChange={(event) => setSubTitle(event.target.value)} />
        <button>{t("workItems.subItems.add")}</button>
      </form>}
    </>)}
    {section("relations", t("relations.title"), sectionCounts.relations, <RelationsPanel workspaceSlug={workspace.slug} workItemId={item.id} candidates={projectItems.filter((candidate) => candidate.id !== item.id)} canWrite={canWrite} action={action} onChange={() => void load()} showForm={activeForm === "relations"} onClose={() => setActiveForm(null)} onCount={countCallbacks.relations} />)}
    {section("links", t("webLinks.title"), sectionCounts.links, <WebLinksPanel personName={personName} workItemId={item.id} canWrite={canWrite} action={action} onChange={() => void load()} showForm={activeForm === "links"} onClose={() => setActiveForm(null)} onCount={countCallbacks.links} />)}
    {section("attachments", t("assets.title"), sectionCounts.attachments, <AttachmentsPanel workItemId={item.id} canWrite={canWrite} action={action} onChange={() => void load()} showForm={activeForm === "attachments"} onCount={countCallbacks.attachments} pickerRef={attachmentPicker} />)}
    <div className={sectionClass}><RunsPanel workItemId={item.id} workspaceId={workspace.id} canControl={canWrite} selfId={selfId} isAdmin={project?.role === "Admin"} action={action} onActivity={() => { setTimelineKey((key) => key + 1); void load(); }} /></div>
    <div className={`${sectionClass} mt-2 border-t border-subtle pt-6`}><TimelinePanel workspaceId={workspace.id} workItemId={item.id} projectId={item.projectId} selfId={selfId} canComment={canWrite} linkBase={itemPath} refreshKey={timelineKey} action={action} onChange={() => void load()} /></div>
    {note && <p role="alert" className="text-danger-text">{note}</p>}
    {versionsOpen && <div role="presentation" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setVersionsOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="description-versions-title" className="grid max-h-[80vh] w-full max-w-xl gap-4 overflow-auto rounded-lg bg-surface-1 p-5 shadow-xl">
        <div className="flex items-center justify-between"><h2 id="description-versions-title" className="m-0 text-18 font-semibold">{t("workItems.descriptionVersions")}</h2><button type="button" className="secondary" onClick={() => setVersionsOpen(false)}>{t("workItems.close")}</button></div>
        {descriptionVersions.length === 0 ? <p>{t("workItems.noDescriptionVersions")}</p> : <ul className="m-0 grid gap-3 p-0">{descriptionVersions.map((version) => <li key={version.id} className="list-none rounded border border-subtle p-3"><p className="m-0 text-12 text-secondary">{version.createdByName} · {relativeTime(version.createdAt)}</p><p className="my-2 whitespace-pre-wrap text-13">{version.contentText || t("workItems.emptyDescription")}</p>{canWrite && <button type="button" className="secondary" onClick={() => void restoreVersion(version.id)}>{t("workItems.restoreVersion")}</button>}</li>)}</ul>}
      </section>
    </div>}
  </div>;

  const sidebar = <aside aria-label={t("workItems.properties")} className={`grid content-start gap-3 p-4 sm:p-6 ${mode === "page" ? "border-t border-subtle lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0" : "border-t border-subtle"}`}>
    <h2 className="m-0 text-14 font-semibold text-primary">{t("workItems.properties")}</h2>
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
    {estimate?.enabled && <PropertyRow icon={<Sigma aria-hidden size={15} />} label={t("workItems.estimate")}>
      <EstimateSelect estimate={estimate} pointId={item.estimatePointId} readOnly={!canWrite} onSelect={(estimatePointId) => void change({ estimatePointId })} />
    </PropertyRow>}
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
