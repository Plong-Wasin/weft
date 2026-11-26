import { Button } from "@/ui/button";
import { accessReasonText } from "./access-reason";
import React from "react";
import { handleImeSafeEnter } from "./ime";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, CalendarCheck, CalendarClock, ChevronDown, CircleUserRound, Gauge, Layers, Link2, Maximize2, RefreshCw, Package, Tag, Trash2, Users, Archive, ArchiveRestore, X, CircleDot, Sigma, Shapes, MoreHorizontal } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action, actionResult, richTextActionError } from "./api";
import { copyText } from "./toast";
import { paths } from "./routes";
import { TimelinePanel } from "./comments-panel";
import { RunsPanel } from "./runs-panel";
import { RelationsPanel } from "./relations-panel";
import { SidecarTrigger } from "./sidecar";
import { AiOnly } from "./ai-flag";
import { Popover, menuItemClass } from "./shell/popover";
import { AttachmentsPanel } from "./asset-images";
import { WebLinksPanel } from "./web-links-panel";
import { OutlinksPanel } from "./outlinks-panel";
import { PullRequestsPanel } from "./pull-requests-panel";
import { useIntegrationsEnabled } from "./integrations-flag";
import { DescriptionEditor } from "./description-editor";
import { DateChip, EstimateSelect, MultiSelect, PriorityIcon, SingleSelect, StateIcon } from "./property-dropdowns";
import { Avatar } from "./avatar";
import { priorityOrder } from "./work-item-layout";
import { useWorkspace } from "./layouts/workspace-layout";
import { useLocale } from "./locale";
import { useInboxNotificationOpen } from "./inbox";
import type { Estimate, Label, Member, Project, WorkItem, WorkState } from "./types";
import { PropertyFields, TypePicker, droppedByTypeChange, missingRequired, propertiesOfType, useWorkItemTypes, type CustomProperty } from "./work-item-types";
import { DetailsPanelToggle, useDetailsPanel } from "./details-panel";

import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
type Named = { id: string; name: string; status?: string };
const t = (key: string) => translate(key as MessageKey);
const sectionClass = "grid gap-2 [&_form]:my-0 [&_form]:flex [&_form]:flex-wrap [&_form]:items-center [&_form]:gap-2 [&_select]:w-auto [&_button]:w-auto [&_button]:whitespace-nowrap [&_p]:m-0 [&_h3]:m-0 [&_h3]:text-16 [&_h3]:font-semibold [&_h3]:text-foreground [&_ul]:m-0 [&_ul]:pl-5";
const iconButton = "grid size-8 place-items-center bg-transparent p-0 text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-11";
const propertiesCollapsedKey = "weft:work-item-properties-collapsed";
// When browser storage is blocked the choice still lasts for the visit: this module outlives the page component, so the memory survives remounts.
const storedMemory: Record<string, string> = {};
function readStored(key: string): string | null {
  if (key in storedMemory) return storedMemory[key]!;
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string) {
  storedMemory[key] = value;
  try { localStorage.setItem(key, value); } catch { /* kept in memory for this visit */ }
}
function readCollapsedProps(): string[] {
  try {
    const parsed: unknown = JSON.parse(readStored(propertiesCollapsedKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

/**
 * The type row and the custom property inputs of a work item, in the peek panel and the page sidebar. Changing the type asks first when the
 * new type lacks properties that hold values; a required property cannot be cleared. Each save is one update_work_item call.
 */
function TypeRows({ project, item, canWrite, people, onSaved }: { project: Project; item: WorkItem; canWrite: boolean; people: Member[]; onSaved: () => Promise<void> }) {
  const { types, properties, ready } = useWorkItemTypes(project);
  const [pending, setPending] = React.useState<{ typeId: string; names: string[] } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  if (!ready || types.length === 0) return null;
  const current = item.properties ?? [];
  const values = new Map(current.map((entry) => [entry.propertyId, entry.value]));
  const typeProperties = propertiesOfType(properties, item.typeId ?? types[0]!.id);
  const save = async (body: Record<string, unknown>) => {
    const result = await actionResult<WorkItem>("update_work_item", { workItemId: item.id, ...body });
    if ("error" in result) return setNote(result.error);
    setNote(null);
    await onSaved();
  };
  const chooseType = (typeId: string) => {
    if (typeId === item.typeId) return;
    const names = droppedByTypeChange(properties, current, typeId);
    if (names.length > 0) return setPending({ typeId, names });
    void save({ typeId });
  };
  const setValue = (property: CustomProperty, value: unknown) => {
    if (value === null && property.required) return setNote(t("types.requiredNote").replace("{names}", property.name).replace("{type}", types.find((type) => type.id === item.typeId)?.name ?? ""));
    if (JSON.stringify(value ?? null) === JSON.stringify(values.get(property.id) ?? null)) return;
    void save({ properties: [{ propertyId: property.id, value }] });
  };
  const typeName = types.find((type) => type.id === item.typeId)?.name ?? "";
  const missing = missingRequired(typeProperties, values);
  return <>
    <PropertyRow icon={<Shapes aria-hidden size={15} />} label={t("types.type")}>
      <TypePicker types={types} value={item.typeId ?? ""} readOnly={!canWrite} onSelect={chooseType} />
    </PropertyRow>
    {pending && <div role="group" aria-label={t("types.dropHeading")} className="grid gap-2 rounded-md border border-border bg-muted p-3" data-type-drop>
      <span className="font-medium text-foreground">{t("types.dropHeading")}</span>
      <span className="text-13 text-muted-foreground">{t("types.dropBody").replace("{type}", types.find((type) => type.id === pending.typeId)?.name ?? "").replace("{names}", pending.names.join(", "))}</span>
      <span className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => { const next = pending.typeId; setPending(null); void save({ typeId: next, dropPropertyValues: true }); }}>{t("types.dropConfirm")}</Button>
        <Button type="button" onClick={() => setPending(null)}>{t("types.dropKeep")}</Button>
      </span>
    </div>}
    {typeProperties.length > 0 && <PropertyFields properties={typeProperties} values={values} members={people} idPrefix={`peek-${item.id}`} disabled={!canWrite} commitOnBlur onChange={setValue} />}
    {missing.length > 0 && canWrite && <p className="m-0 text-12 text-muted-foreground" data-missing-required>{t("types.missingNote").replace("{names}", missing.join(", ")).replace("{type}", typeName)}</p>}
    {note && <p role="alert" className="m-0 text-13 text-destructive">{note}</p>}
  </>;
}

function PropertyRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return <div data-property-row className="grid min-h-8 grid-cols-[minmax(6.5rem,0.85fr)_minmax(0,1.15fr)] items-center gap-2 rounded-lg px-1 text-13 transition-colors hover:bg-accent">
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">{icon}<span className="truncate" title={label}>{label}</span></span>
    <div className="flex min-w-0 flex-nowrap items-center gap-1 [&>*]:min-w-0 [&>div]:w-full [&>div>button]:w-full [&>div>button]:justify-start [&_button]:h-auto [&_button]:min-h-9 pointer-coarse:[&_button]:min-h-11">{children}</div>
  </div>;
}

/** Versions shown per page in the description history. */
const VERSIONS_PAGE = 20;
/** A page is full at 20 rows, or earlier when the server stopped at its size budget (about 1 MB of Markdown): either way there may be older versions. */
const hasMoreVersions = (rows: Array<{ contentMarkdown?: string }>) => rows.length >= VERSIONS_PAGE || rows.reduce((sum, row) => sum + (row.contentMarkdown?.length ?? 0), 0) > 700_000;
/** A work item in full: used as the peek panel body and as the full page. Every property in the sidebar is editable inline. */
export function WorkItemDetail({ displayId, mode, onClose, onChanged }: { displayId: string; mode: "page" | "peek"; onClose?: () => void; onChanged?: () => void }) {
  const { workspace, selfId } = useWorkspace();
  const locale = useLocale();
  const integrationsOn = useIntegrationsEnabled();
  const navigate = useNavigate();
  const inboxOpen = useInboxNotificationOpen();
  const [item, setItem] = React.useState<WorkItem | null | undefined>(undefined);
  const [timelineKey, setTimelineKey] = React.useState(0);
  const [project, setProject] = React.useState<Project | null>(null);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [lastDescriptionEdit, setLastDescriptionEdit] = React.useState<{ name: string; at: string } | null>(null);
  const [descriptionVersions, setDescriptionVersions] = React.useState<Array<{ id: string; contentText: string; contentMarkdown?: string; createdByName: string; createdAt: string }>>([]);
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [versionsMore, setVersionsMore] = React.useState(false);
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  const [versionsError, setVersionsError] = React.useState(false);
  const [versionsFirstFailed, setVersionsFirstFailed] = React.useState(false);
  const [editorEpoch, setEditorEpoch] = React.useState(0);
  const [subItems, setSubItems] = React.useState<WorkItem[]>([]);
  const [projectItems, setProjectItems] = React.useState<WorkItem[]>([]);
  const [cycles, setCycles] = React.useState<Named[]>([]);
  const [modules, setModules] = React.useState<Named[]>([]);
  const [cycleId, setCycleId] = React.useState("");
  const [moduleIds, setModuleIds] = React.useState<string[]>([]);
  const [subTitle, setSubTitle] = React.useState("");
  const [sectionCounts, setSectionCounts] = React.useState({ relations: 0, links: 0, attachments: 0, pullRequests: 0 });
  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  // The details panel is remembered per kind; the Properties sections are remembered per viewer.
  const detailsPanel = useDetailsPanel("work-item", mode === "page");
  const propertiesOpen = detailsPanel.open;
  const [collapsedProps, setCollapsedProps] = React.useState<string[]>(readCollapsedProps);
  const [activeForm, setActiveForm] = React.useState<string | null>(null);
  const attachmentPicker = React.useRef<HTMLInputElement>(null);
  const [estimate, setEstimate] = React.useState<Estimate | null>(null);
  const [title, setTitle] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [descriptionSaveState, setDescriptionSaveState] = React.useState<"saved" | "saving" | "updating" | "failed" | "notSaved">("saved");
  const [descriptionSaveError, setDescriptionSaveError] = React.useState<string | null>(null);
  const [descriptionOutlinksKey, setDescriptionOutlinksKey] = React.useState(0);
  const descriptionOutlinksKeyRef = React.useRef(0);
  descriptionOutlinksKeyRef.current = descriptionOutlinksKey;
  const pending = React.useRef<{ id: string; doc: unknown } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedId = React.useRef<string | null>(null);
  const restoring = React.useRef(false);
  // The title is a textarea that grows with its text, so a long title wraps at every width instead of being clipped.
  const titleRef = React.useRef<HTMLTextAreaElement>(null);
  const fitTitle = React.useCallback(() => {
    const element = titleRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);
  const titleMounted = item !== undefined && item !== null;
  React.useLayoutEffect(() => {
    fitTitle();
    const element = titleRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // Width changes without a window resize too, such as the Properties panel being hidden.
    const observer = new ResizeObserver(() => fitTitle());
    observer.observe(element);
    return () => observer.disconnect();
  }, [title, titleMounted, fitTitle]);

  const load = React.useCallback(async () => {
    const found = await action<WorkItem>("get_work_item", { workspaceId: workspace.id, displayId });
    setItem(found);
    if (!found) { inboxOpen.markUnavailable(); return; }
    inboxOpen.markLoaded();
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
  }, [workspace.id, workspace.slug, displayId, navigate, mode, inboxOpen.markLoaded, inboxOpen.markUnavailable]);
  React.useEffect(() => { loadedId.current = null; void load(); }, [load]);
  React.useEffect(() => { const refresh = () => { void load(); }; window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, [load]);

  const flush = React.useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return null;
    setDescriptionSaveState("saving");
    const result = await actionResult("update_work_item", { workItemId: next.id, description: next.doc });
    if ("error" in result) { setDescriptionSaveError(richTextActionError(result.code)); setDescriptionSaveState("failed"); return null; }
    else {
      setDescriptionSaveError(null);
      setDescriptionSaveState("updating");
      setDescriptionOutlinksKey((key) => key + 1);
    }
    return result.data;
  }, []);
  const onDescriptionOutlinksRefreshComplete = React.useCallback((refreshKey: number) => {
    if (refreshKey === descriptionOutlinksKeyRef.current) setDescriptionSaveState((current) => current === "updating" ? "saved" : current);
  }, []);
  const setCount = React.useCallback((key: "relations" | "links" | "attachments" | "pullRequests", count: number) => {
    setSectionCounts((current) => current[key] === count ? current : { ...current, [key]: count });
  }, []);
  // Closing the peek or leaving the page must not lose a description typed in the last moments.
  React.useEffect(() => () => { void flush(); }, [flush]);

  // While the item loads, the column shows its shape (title and description blocks) instead of going blank.
  if (item === undefined) return <section aria-busy="true" aria-label={t("workItems.loading")} className="grid content-start gap-6 p-4 sm:p-6" data-testid="work-item-skeleton">
    <div className="grid gap-3"><div className="h-3 w-16 rounded bg-muted motion-safe:animate-pulse" /><div className="h-7 w-2/3 rounded-md bg-muted motion-safe:animate-pulse" /></div>
    <div className="grid gap-2"><div className="h-4 w-full rounded bg-muted motion-safe:animate-pulse" /><div className="h-4 w-11/12 rounded bg-muted motion-safe:animate-pulse" /><div className="h-4 w-3/5 rounded bg-muted motion-safe:animate-pulse" /></div>
  </section>;
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
  const isAgentId = (id: string) => people.find((person) => person.userId === id)?.isAgent;
  const creator = personName(item.createdBy);
  const stateOf = states.find((state) => state.id === item.stateId);
  const assignees = item.assigneeIds;
  const parent = projectItems.find((candidate) => candidate.id === item.parentId);
  const countCallbacks = {
    relations: (count: number) => setCount("relations", count),
    links: (count: number) => setCount("links", count),
    attachments: (count: number) => setCount("attachments", count),
    pullRequests: (count: number) => setCount("pullRequests", count),
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
      <summary className="cursor-pointer text-16 font-semibold text-foreground">{label} <span className="text-13 font-normal text-muted-foreground">{count}</span></summary>
      {content}
    </details>
  );

  const setSectionOpen = (key: string, open: boolean) => {
    if (open !== collapsedProps.includes(key)) return;
    const next = open ? collapsedProps.filter((value) => value !== key) : [...collapsedProps, key];
    setCollapsedProps(next);
    writeStored(propertiesCollapsedKey, JSON.stringify(next));
  };

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

  const header = <header className={`flex items-center gap-2 border-b border-border px-4 py-2.5 pointer-coarse:py-1 ${mode === "page" ? "" : "bg-card"}`}>
    {mode === "peek"
      ? <>
        <span aria-hidden className="flex-1" />
        <Link to={itemPath} className={`${iconButton} rounded-lg max-sm:flex max-sm:h-auto max-sm:w-auto pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-sm:pointer-coarse:w-auto max-sm:items-center max-sm:gap-1 max-sm:px-1.5 max-sm:py-1`} aria-label={t("workItems.peek.expand")} title={t("workItems.peek.expand")}><Maximize2 aria-hidden size={15} /><span className="hidden text-10 max-sm:inline">{t("workItems.peek.expand")}</span></Link>
        <Button variant="ghost" type="button" className={`${iconButton} max-sm:flex max-sm:h-auto max-sm:w-auto pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-sm:pointer-coarse:w-auto max-sm:items-center max-sm:gap-1 max-sm:px-1.5 max-sm:py-1`} aria-label={t("workItems.peek.close")} title={t("workItems.peek.close")} onClick={onClose}><X aria-hidden size={16} /><span className="hidden text-10 max-sm:inline">{t("workItems.peek.close")}</span></Button>
      </>
      : <nav aria-label={t("workItems.breadcrumb")} className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap text-13 text-muted-foreground">
        {project && <Link to={paths.workItems(workspace.slug, project.key)} className="hidden truncate text-muted-foreground hover:text-foreground sm:inline">{project.name}</Link>}
        <span aria-hidden className="hidden sm:inline">›</span>
        <Link to={back} className="hidden text-muted-foreground hover:text-foreground sm:inline">{t("workItems.title")}</Link>
        <span aria-hidden className="hidden sm:inline">›</span>
        <span className="shrink-0 font-medium text-foreground">{item.displayId}</span>
      </nav>}
    {mode === "page" && <div className="ml-auto flex items-center gap-2">
      <span className="[&_button]:whitespace-nowrap"><AiOnly><SidecarTrigger context={{ type: "work_item", id: item.displayId, title: item.title }} /></AiOnly></span>
      <span className="hidden lg:block"><DetailsPanelToggle open={propertiesOpen} onToggle={detailsPanel.toggle} panelId={`work-item-details-${item.id}`} testId="work-item-properties-toggle" /></span>
      <Popover label={t("workItems.more")} align="right" className="!size-10 shrink-0 border border-border bg-card p-0 sm:hidden" trigger={<MoreHorizontal aria-hidden size={18} />}>
        {(close) => <>
          <Button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); void copy(); }}>{t("workItems.copyLink")}</Button>
          {mayArchive && !isArchived && eligible && <Button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); void archiveOrRestore("archive_work_item"); }}>{t("workItems.archive")}</Button>}
          {canWrite && <Button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); void remove(); }}>{t("workItems.delete")}</Button>}
        </>}
      </Popover>
      <div className="hidden items-center gap-2 sm:flex">
        <Button variant="ghost" type="button" className={iconButton} aria-label={t("workItems.copyLink")} title={t("workItems.copyLink")} onClick={() => void copy()}><Link2 aria-hidden size={15} /></Button>
        {mayArchive && !isArchived && eligible && <Button variant="ghost" type="button" className={iconButton} aria-label={t("workItems.archive")} title={t("workItems.archive")} onClick={() => void archiveOrRestore("archive_work_item")}><Archive aria-hidden size={15} /></Button>}
        {canWrite && <span aria-hidden className="mx-1 h-5 border-l border-border" />}
        {canWrite && <Button variant="ghost" type="button" className={`${iconButton} hover:text-destructive`} aria-label={t("workItems.delete")} title={t("workItems.delete")} onClick={() => void remove()}><Trash2 aria-hidden size={15} /></Button>}
      </div>
    </div>}
  </header>;

  const relativeTime = (value: string) => {
    const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
    const unit: Intl.RelativeTimeFormatUnit = Math.abs(seconds) < 60 ? "second" : Math.abs(seconds) < 3600 ? "minute" : Math.abs(seconds) < 86400 ? "hour" : "day";
    const amount = unit === "second" ? seconds : unit === "minute" ? Math.round(seconds / 60) : unit === "hour" ? Math.round(seconds / 3600) : Math.round(seconds / 86400);
    return new Intl.RelativeTimeFormat(locale === "th" ? "th-TH" : "en-US", { numeric: "auto" }).format(amount, unit);
  };
  const openVersions = async () => {
    await flush();
    const rows = await action<typeof descriptionVersions>("list_work_item_description_versions", { workItemId: item.id, limit: VERSIONS_PAGE });
    // A failed first page is an error with a retry, not "no versions".
    setDescriptionVersions(rows ?? []); setVersionsMore(rows ? hasMoreVersions(rows) : false); setVersionsError(rows === null || rows === undefined); setVersionsFirstFailed(rows === null || rows === undefined); setVersionsOpen(true);
  };
  // Older versions follow the cursor: the id of the last version shown.
  const showOlderVersions = async () => {
    const last = descriptionVersions.at(-1);
    if (!last || versionsLoading) return;
    setVersionsLoading(true); setVersionsError(false);
    try {
      const rows = await action<typeof descriptionVersions>("list_work_item_description_versions", { workItemId: item.id, limit: VERSIONS_PAGE, after: last.id });
      // A failed request is not the end of the history: the button stays and an error with a retry is shown.
      if (rows === null || rows === undefined) { setVersionsError(true); return; }
      setDescriptionVersions((current) => [...current, ...rows]); setVersionsMore(hasMoreVersions(rows));
    } catch { setVersionsError(true); }
    finally { setVersionsLoading(false); }
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
  // The four key properties as pickers: the bar under the title and the Properties section render the same ones, so both read one value.
  const keyPickers = {
    state: <SingleSelect label={t("workItems.state")} summary={stateOf?.name ?? ""} value={item.stateId} readOnly={!canWrite} icon={<StateIcon group={stateOf?.group ?? "unstarted"} />}
          options={states.map((state) => ({ id: state.id, name: state.name, icon: <StateIcon group={state.group} /> }))} onSelect={(stateId) => void change({ stateId })} />,
    priority: <SingleSelect label={t("workItems.priority")} summary={t(`workItems.priority.${item.priority}`)} value={item.priority} readOnly={!canWrite} icon={<PriorityIcon priority={item.priority} />}
          options={priorityOrder.map((id) => ({ id, name: t(`workItems.priority.${id}`), icon: <PriorityIcon priority={id} /> }))} onSelect={(priority) => void change({ priority })} />,
    assignees: <MultiSelect label={t("workItems.assignees")} readOnly={!canWrite} selected={assignees} searchAlways
          onOpen={() => { void action<Member[]>("list_project_members", { projectId: item.projectId }).then((rows) => rows && setPeople(rows)); }}
          summary={assignees.length === 0 ? <span className="text-muted-foreground">{t("workItems.noAssignee")}</span> : <span className="flex items-center gap-1">{assignees.slice(0, 3).map((id) => <Avatar key={id} name={personName(id)} id={id} agent={isAgentId(id)} />)}<span className="max-w-32 truncate">{assignees.map(personName).join(", ")}</span></span>}
          options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} />, isAgent: person.isAgent, codeCapable: person.codeCapable, hasAccess: person.hasAccess, accessReason: accessReasonText(person) }))}
          onToggle={(id, on) => void change({ assigneeIds: on ? [...assignees, id] : assignees.filter((other) => other !== id) })} />,
    due: <DateChip label={t("workItems.dueDate")} field="due" range={{ startDate: item.startDate, dueDate: item.dueDate }} stateGroup={stateOf?.group} readOnly={!canWrite} onChange={(dates) => void change(dates)} />,
  };
  const TitleHeading = mode === "page" ? "h1" : "h2";
  // The content is one column in order. The peek splits it: the part above the Timeline, then Properties, then the Timeline and what follows it.
  const mainTop = <>
    {isArchived &&<div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted px-3 py-2 text-13 text-muted-foreground">
      <Archive aria-hidden size={15} /><span>{t("workItems.archivedBanner")}</span>
      {mayArchive && <Button type="button" className="ml-auto flex items-center gap-1.5" onClick={() => void archiveOrRestore("restore_work_item")}><ArchiveRestore aria-hidden size={14} />{t("workItems.restore")}</Button>}
    </div>}
    <div className="grid gap-2">
      {mode === "peek" && <p className="m-0 text-13 text-muted-foreground">{item.displayId}</p>}
      <TitleHeading aria-label={title} className="m-0 text-2xl font-semibold leading-tight text-foreground">
      <Textarea ref={titleRef} rows={1} aria-label={t("workItems.titleField")} value={title} maxLength={500} readOnly={!canWrite} className="w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-2xl font-semibold leading-tight text-foreground md:text-2xl [overflow-wrap:anywhere]"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => { const next = title.trim(); if (!next) setTitle(item.title); else if (next !== item.title) void change({ title: next }); }}
        onKeyDown={(event) => { handleImeSafeEnter(event.nativeEvent, () => event.currentTarget.blur()); }} />
      </TitleHeading>
    </div>
    {/* Beside the description (wide page with the panel shown) the Properties panel already holds these, so the bar is for the other layouts. */}
    <div role="group" aria-label={t("workItems.quickProperties")} data-quick-properties className={`max-sm:grid max-sm:grid-cols-2 flex flex-wrap items-center gap-2 ${mode === "page" && propertiesOpen ? "lg:hidden" : ""} ${mode === "peek" ? "@[800px]:hidden" : ""}`}>
      {keyPickers.state}{keyPickers.priority}{keyPickers.assignees}{keyPickers.due}
    </div>
    <div className="min-h-16 min-w-0 max-w-full">
      <DescriptionEditor key={`${item.id}:${editorEpoch}`} workspaceId={workspace.id} workItemId={item.id} mentionPeople={people} initial={item.description} editable={canWrite}
        status={<p role="status" data-testid="description-save-status" className={`m-0 min-w-0 text-12 ${descriptionSaveState === "notSaved" || descriptionSaveState === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{descriptionSaveState === "failed" ? descriptionSaveError ?? t("workItems.descriptionSave.failed") : t(`workItems.descriptionSave.${descriptionSaveState}`)}</p>}
        onSourceDraftChange={(hasDraft) => { if (hasDraft) setDescriptionSaveState("notSaved"); }}
        onChange={(doc) => { pending.current = { id: item.id, doc }; setDescriptionSaveError(null); setDescriptionSaveState("saving"); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(flush, 700); }} />
    </div>
    {lastDescriptionEdit && <Button variant="ghost" data-testid="description-last-edited" type="button" className="justify-self-start bg-transparent p-0 text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={() => void openVersions()}>
      {t("workItems.lastEditedBy").replace("{name}", lastDescriptionEdit.name).replace("{time}", relativeTime(lastDescriptionEdit.at))} ▾
    </Button>}
    <div role="group" className="flex w-full min-w-0 max-w-full flex-wrap gap-2 max-sm:grid max-sm:grid-cols-[auto_auto] max-sm:justify-items-start max-sm:[&>button]:whitespace-nowrap" aria-label={t("workItems.actions")}>
      {canWrite && <>
        <Button type="button" className="max-sm:min-h-11 pointer-coarse:min-h-11" onClick={() => openAction("subItems")}>{t("workItems.addSubItemAction")}</Button>
        <Button type="button" className="max-sm:min-h-11 pointer-coarse:min-h-11" onClick={() => { setActiveForm("relations"); setCollapsed((current) => current.filter((value) => value !== "relations")); }}>{t("workItems.addRelationAction")}</Button>
        <Button type="button" className="max-sm:min-h-11 pointer-coarse:min-h-11" onClick={() => openAction("links")}>{t("workItems.addLinkAction")}</Button>
        <Button type="button" className="max-sm:min-h-11 pointer-coarse:min-h-11" onClick={() => { setActiveForm("attachments"); setCollapsed((current) => current.filter((value) => value !== "attachments")); attachmentPicker.current?.click(); }}>{t("workItems.attachAction")}</Button>
      </>}
    </div>
    {section("subItems", t("workItems.subItems"), subItems.length, <>
      <ul className="list-none !pl-0">{subItems.map((sub) => <li key={sub.id} className="flex items-center gap-2 border-b border-border py-1.5 text-13">
        <StateIcon group={states.find((state) => state.id === sub.stateId)?.group ?? "unstarted"} />
        <Link to={paths.workItem(workspace.slug, sub.displayId)} className="text-foreground"><span className="text-muted-foreground">{sub.displayId}</span> {sub.title}</Link>
      </li>)}</ul>
      {canWrite && activeForm === "subItems" && <form className="my-0 flex items-center gap-2 [&>button]:shrink-0 [&>button]:whitespace-nowrap" onSubmit={async (event) => { event.preventDefault(); await guard(await action("create_work_item", { projectId: item.projectId, title: subTitle, parentId: item.id })); setSubTitle(""); setActiveForm((current) => current === "subItems" ? null : current); }}>
        <Input required aria-label={`${t("workItems.subItems")}: ${t("workItems.titleField")}`} placeholder={t("workItems.quickTitle")} value={subTitle} className="flex-1" onChange={(event) => setSubTitle(event.target.value)} />
        <Button>{t("workItems.subItems.add")}</Button>
      </form>}
    </>)}
    {section("relations", t("relations.title"), sectionCounts.relations, <RelationsPanel workspaceSlug={workspace.slug} workItemId={item.id} candidates={projectItems.filter((candidate) => candidate.id !== item.id)} canWrite={canWrite} action={action} onChange={() => void load()} showForm={activeForm === "relations"} onClose={() => setActiveForm(null)} onCount={countCallbacks.relations} />)}
    {integrationsOn && section("pullRequests", t("pullRequests.title"), sectionCounts.pullRequests, <PullRequestsPanel workItemId={item.id} action={action} onCount={countCallbacks.pullRequests} />)}
    {section("attachments", t("assets.title"), sectionCounts.attachments, <AttachmentsPanel workItemId={item.id} canWrite={canWrite} action={action} onChange={() => void load()} showForm={activeForm === "attachments"} onCount={countCallbacks.attachments} pickerRef={attachmentPicker} />)}
    <div className={sectionClass}><RunsPanel workItemId={item.id} workspaceId={workspace.id} canControl={canWrite} selfId={selfId} isAdmin={project?.role === "Admin"} action={action} onActivity={() => { setTimelineKey((key) => key + 1); void load(); }} /></div>
  </>;
  const mainTail = <>
    <div className={`${sectionClass} mt-2 border-t border-border pt-6`}><TimelinePanel workspaceId={workspace.id} workItemId={item.id} projectId={item.projectId} selfId={selfId} canComment={canWrite} linkBase={itemPath} refreshKey={timelineKey} action={action} actionResult={actionResult} onChange={() => void load()} /></div>
    <details data-work-item-links className="grid gap-3 border-t border-border pt-4">
      <summary className="cursor-pointer text-15 font-semibold text-foreground">{t("outlinks.title")}</summary>
      <OutlinksPanel kind="work-item" id={item.id} run={action} compact refreshKey={descriptionOutlinksKey} updating={descriptionSaveState === "saving" || descriptionSaveState === "updating"} onRefreshComplete={onDescriptionOutlinksRefreshComplete} />
    </details>
    {section("links", t("webLinks.title"), sectionCounts.links, <WebLinksPanel personName={personName} workItemId={item.id} canWrite={canWrite} action={action} onChange={() => void load()} showForm={activeForm === "links"} onClose={() => setActiveForm(null)} onCount={countCallbacks.links} />)}
    {note && <p role="alert" className="text-destructive">{note}</p>}
    {versionsOpen && <div role="presentation" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setVersionsOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="description-versions-title" className="grid max-h-[80dvh] w-full max-w-xl gap-4 overflow-auto rounded-2xl bg-card p-5 shadow-xl">
        <div className="flex items-center justify-between"><h2 id="description-versions-title" className="m-0 text-18 font-semibold">{t("workItems.descriptionVersions")}</h2><Button type="button" onClick={() => setVersionsOpen(false)}>{t("workItems.close")}</Button></div>
        {descriptionVersions.length === 0 ? (versionsFirstFailed ? <Button type="button" className="justify-self-start" data-testid="retry-versions" onClick={() => void openVersions()}>{t("workItems.retryOlderVersions")}</Button> : <p>{t("workItems.noDescriptionVersions")}</p>) : <ul className="m-0 grid gap-3 p-0">{descriptionVersions.map((version) => <li key={version.id} className="list-none rounded border border-border p-3"><p className="m-0 text-12 text-muted-foreground">{version.createdByName} · {relativeTime(version.createdAt)}</p><p className="my-2 whitespace-pre-wrap text-13">{version.contentText || t("workItems.emptyDescription")}</p>{canWrite && <Button type="button" onClick={() => void restoreVersion(version.id)}>{t("workItems.restoreVersion")}</Button>}</li>)}</ul>}
        {versionsError && <p role="alert" data-testid="older-versions-error" className="m-0 text-13 text-destructive">{t("workItems.olderVersionsFailed")}</p>}
        {versionsMore && <Button type="button" className="justify-self-start" data-testid="show-older-versions" disabled={versionsLoading} aria-busy={versionsLoading} onClick={() => void showOlderVersions()}>{versionsLoading ? t("workItems.loadingOlderVersions") : versionsError ? t("workItems.retryOlderVersions") : t("workItems.showOlderVersions")}</Button>}
      </section>
    </div>}
  </>;
  const main = <div className="grid grid-cols-1 min-w-0 content-start gap-6 p-4 sm:p-6">{mainTop}{mainTail}</div>;

  // A section header is a button with a chevron: aria-expanded says whether its rows are shown, and the rows are hidden (not removed) when collapsed.
  const propSection = (key: "primary" | "more" | "details", content: React.ReactNode) => {
    const open = !collapsedProps.includes(key);
    const panelId = `work-item-props-${item.id}-${key}`;
    return <section data-props-section={key} className="grid content-start gap-3">
      <h3 className="m-0 text-13 font-medium">
        <Button variant="ghost" type="button" aria-expanded={open} aria-controls={panelId} className="flex w-full justify-start items-center gap-1.5 rounded-md bg-transparent p-0 text-left font-medium text-muted-foreground hover:bg-transparent hover:text-foreground pointer-coarse:min-h-11" onClick={() => setSectionOpen(key, !open)}>
          <ChevronDown aria-hidden size={15} className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />{t(`workItems.properties.${key}`)}
        </Button>
      </h3>
      <div id={panelId} className={open ? "grid content-start gap-3" : "hidden"}>{content}</div>
    </section>;
  };
  // The peek is two columns from 800 px of panel width (its container), where Properties sits in a sticky right column; below that it stacks.
  const peekColumn = "order-1 @[800px]:col-start-2 @[800px]:row-start-1 @[800px]:border-l @[800px]:border-t-0 @[800px]:sticky @[800px]:top-0 @[800px]:self-start @[800px]:max-h-[calc(100dvh-3.5rem)] @[800px]:overflow-y-auto";
  const sidebar = <aside id={mode === "page" ? `work-item-details-${item.id}` : undefined} aria-label={t("workItems.properties")} className={`grid content-start gap-3 p-4 sm:p-6 ${mode === "page" ? `border-t border-border lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0 lg:sticky lg:top-0 lg:max-h-screen lg:self-start lg:overflow-y-auto ${propertiesOpen ? "" : "lg:hidden"}` : `border-t border-border ${peekColumn}`}`}>
    <h2 className="m-0 text-14 font-semibold text-foreground">{t("workItems.properties")}</h2>
    {propSection("primary", <>
      <PropertyRow icon={<CircleDot aria-hidden size={15} />} label={t("workItems.state")}>
        {keyPickers.state}
      </PropertyRow>
      <PropertyRow icon={<Gauge aria-hidden size={15} />} label={t("workItems.priority")}>
        {keyPickers.priority}
      </PropertyRow>
      <PropertyRow icon={<Users aria-hidden size={15} />} label={t("workItems.assignees")}>
        {keyPickers.assignees}
      </PropertyRow>
      <PropertyRow icon={<CalendarCheck aria-hidden size={15} />} label={t("workItems.dueDate")}>
        {keyPickers.due}
      </PropertyRow>
      <PropertyRow icon={<Tag aria-hidden size={15} />} label={t("workItems.labels")}>
        <MultiSelect label={t("workItems.labels")} readOnly={!canWrite} selected={item.labelIds} icon={undefined}
          summary={item.labelIds.length === 0 ? <span className="text-muted-foreground">{t("workItems.noLabels")}</span> : <span className="flex min-w-0 flex-wrap items-center gap-1 whitespace-normal text-left">{item.labelIds.map((id) => labels.find((label) => label.id === id)).filter((label): label is Label => !!label).map((label) => <span key={label.id} className="flex min-w-0 max-w-full items-center gap-1"><span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: label.color }} /><span className="truncate">{label.name}</span></span>)}</span>}
          options={labels.map((label) => ({ id: label.id, name: label.name, icon: <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} /> }))}
          onToggle={(id, on) => void change({ labelIds: on ? [...item.labelIds, id] : item.labelIds.filter((other) => other !== id) })} />
      </PropertyRow>
    </>)}
    {propSection("more", <>
      <PropertyRow icon={<CalendarClock aria-hidden size={15} />} label={t("workItems.startDate")}>
        <DateChip label={t("workItems.startDate")} field="start" range={{ startDate: item.startDate, dueDate: item.dueDate }} readOnly={!canWrite} onChange={(dates) => void change(dates)} />
      </PropertyRow>
      {estimate?.enabled && <PropertyRow icon={<Sigma aria-hidden size={15} />} label={t("workItems.estimate")}>
        <EstimateSelect estimate={estimate} pointId={item.estimatePointId} readOnly={!canWrite} onSelect={(estimatePointId) => void change({ estimatePointId })} />
      </PropertyRow>}
      {project?.features.cycles && <PropertyRow icon={<RefreshCw aria-hidden size={15} />} label={t("workItems.cycle")}>
        <SingleSelect label={t("workItems.cycle")} readOnly={!canWrite} value={cycleId} summary={cycles.find((cycle) => cycle.id === cycleId)?.name ?? t("workItems.noCycle")}
          options={[{ id: "", name: t("workItems.noCycle") }, ...cycles.filter((cycle) => cycle.status !== "completed" || cycle.id === cycleId).map((cycle) => ({ id: cycle.id, name: cycle.name }))]} onSelect={(id) => void setCycle(id)} />
      </PropertyRow>}
      {project?.features.modules && <PropertyRow icon={<Package aria-hidden size={15} />} label={t("workItems.modules")}>
        <MultiSelect label={t("workItems.modules")} readOnly={!canWrite} selected={moduleIds}
          summary={moduleIds.length === 0 ? <span className="text-muted-foreground">{t("workItems.noModules")}</span> : <span className="min-w-0 truncate">{moduleIds.map((id) => modules.find((module) => module.id === id)?.name).filter(Boolean).join(", ")}</span>}
          options={modules.map((module) => ({ id: module.id, name: module.name }))} onToggle={(id, on) => void setModule(id, on)} />
      </PropertyRow>}
      <PropertyRow icon={<Layers aria-hidden size={15} />} label={t("workItems.parent")}>
        <SingleSelect label={t("workItems.parent")} readOnly={!canWrite} value={item.parentId ?? ""} summary={parent ? `${parent.displayId} ${parent.title}` : t("workItems.addParent")}
          options={[{ id: "", name: t("workItems.noParent") }, ...projectItems.filter((candidate) => candidate.id !== item.id).map((candidate) => ({ id: candidate.id, name: `${candidate.displayId} ${candidate.title}` }))]} onSelect={(id) => void change({ parentId: id || null })} />
        {parent && <Link to={paths.workItem(workspace.slug, parent.displayId)} aria-label={parent.displayId} className="text-muted-foreground hover:text-foreground"><ArrowUpRight aria-hidden size={14} /></Link>}
      </PropertyRow>
    </>)}
    {propSection("details", <>
      <PropertyRow icon={<CircleUserRound aria-hidden size={15} />} label={t("workItems.createdBy")}>
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap px-1 text-13 font-medium text-foreground"><Avatar name={creator} id={item.createdBy} agent={isAgentId(item.createdBy)} /><span className="min-w-0 truncate" title={creator}>{creator}</span></span>
      </PropertyRow>
      {project && <TypeRows project={project} item={item} canWrite={canWrite} people={people} onSaved={async () => { await load(); onChanged?.(); }} />}
    </>)}
    {mode === "peek" && <div className="flex flex-wrap gap-2 border-t border-border pt-4 pointer-coarse:[&>button]:min-h-11" data-peek-actions>
      <Button type="button" className="flex items-center gap-1.5 whitespace-nowrap" onClick={() => void copy()}><Link2 aria-hidden size={14} />{t("workItems.copyLink")}</Button>
      {mayArchive && !isArchived && eligible && <Button type="button" className="flex items-center gap-1.5 whitespace-nowrap" onClick={() => void archiveOrRestore("archive_work_item")}><Archive aria-hidden size={14} />{t("workItems.archive")}</Button>}
      {canWrite && <Button type="button" variant="secondary" className="flex items-center gap-1.5 whitespace-nowrap text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => void remove()}><Trash2 aria-hidden size={14} />{t("workItems.delete")}</Button>}
    </div>}
  </aside>;

  // Peek: above the Properties the content runs on one column; from 800 px of panel width the content is the left column and Properties the right one, and the Timeline goes back under the content.
  // The content wrapper is transparent below 800 px, so its two parts and Properties are plain siblings in the order mainTop, Properties (order-1), mainTail.
  if (mode === "peek") return <div className="flex h-full flex-col">{header}
    <div className="min-h-0 flex-1 overflow-y-auto flex flex-col @[800px]:grid @[800px]:grid-cols-[minmax(0,1fr)_20rem] @[800px]:items-start">
      <div className="contents @[800px]:flex @[800px]:min-w-0 @[800px]:flex-col @[800px]:col-start-1">
        <div className="order-0 grid grid-cols-1 min-w-0 content-start gap-6 p-4 sm:p-6 @[800px]:gap-4">{mainTop}</div>
        <div className="order-2 grid grid-cols-1 min-w-0 content-start gap-6 p-4 pt-0 sm:p-6 sm:pt-0">{mainTail}</div>
      </div>
      {sidebar}
    </div>
  </div>;
  return <div className="flex min-h-full flex-col">{header}<div className="flex flex-1 flex-col lg:flex-row"><div className="min-w-0 flex-1">{main}</div>{sidebar}</div></div>;
}
