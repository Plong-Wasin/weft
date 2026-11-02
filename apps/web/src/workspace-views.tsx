import React from "react";
import { Link, useNavigate } from "react-router";
import { BookmarkPlus, Check, ChevronDown, ChevronRight, Layers, Lock, MoreHorizontal, SlidersHorizontal } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action, actionResult } from "./api";
import { paths } from "./routes";
import { Popover, menuItemClass } from "./shell/popover";
import { Avatar, formatDay, PriorityIcon, StateIcon } from "./property-dropdowns";
import { PqlEditor, PqlToggle } from "./filter-bar";
import { displayProperties, parseLayoutParams, serializeLayoutParams, sortFields, type DisplayProperty, type LayoutParams } from "./work-item-layout";
import { differsFromView, paramsToSettings, viewToParams, type SavedView } from "./view-params";
import { DeleteViewModal, ViewFormModal } from "./views";
import type { Member, Project, StateGroup, Workspace } from "./types";

const t = (key: string) => translate(key as MessageKey);
const primary = "rounded-md border-0 bg-accent-primary px-3 py-1 text-13 font-medium text-on-color hover:bg-accent-primary-hover disabled:opacity-60";
const ghost = "flex items-center gap-1.5 rounded-md border border-subtle bg-surface-1 px-2.5 py-1 text-13 font-medium text-primary hover:bg-layer-transparent-hover";
const cell = "border-b border-subtle px-3 py-2 text-left align-middle whitespace-nowrap";

/** Plane's four built-in workspace views, addressed by the same URL keys. */
export const builtinViews = [
  { slug: "all-issues", kind: "all", label: "workspaceViews.all" },
  { slug: "assigned", kind: "assigned", label: "workspaceViews.assigned" },
  { slug: "created", kind: "created", label: "workspaceViews.created" },
  { slug: "subscribed", kind: "subscribed", label: "workspaceViews.subscribed" },
] as const;

type Item = { id: string; displayId: string; title: string; projectId: string; projectKey: string; projectName: string; stateId: string; priority: string; assigneeIds: string[]; labelIds: string[]; startDate: string | null; dueDate: string | null };
type State = { id: string; name: string; group: StateGroup };
type Label = { id: string; name: string };
/** Workspace views are always the spreadsheet Layout: the columns the viewer may choose. */
const asWorkspace = (params: LayoutParams): LayoutParams => ({ ...params, layout: "spreadsheet", group: "none", subGroup: "none" });
const columnProperties = displayProperties.filter((property) => property !== "cycle" && property !== "modules" && property !== "estimate");

/** The spreadsheet of work items across every project the viewer can access. Reads only; edits happen in the work item itself. */
function WorkspaceSheet({ items, projects, states, labels, people, workspaceSlug, props, empty }: { items: Item[]; projects: Project[]; states: State[]; labels: Label[]; people: Member[]; workspaceSlug: string; props: DisplayProperty[]; empty: string }) {
  const columns = props.filter((property) => (columnProperties as readonly string[]).includes(property) && property !== "id");
  const stateOf = (item: Item) => states.find((state) => state.id === item.stateId);
  const cellOf = (item: Item, property: DisplayProperty) => {
    switch (property) {
      case "state": return <span className="flex items-center gap-1.5"><StateIcon group={stateOf(item)?.group ?? "unstarted"} />{stateOf(item)?.name}</span>;
      case "priority": return <span className="flex items-center gap-1.5"><PriorityIcon priority={item.priority} />{t(`workItems.priority.${item.priority}`)}</span>;
      case "assignee": return item.assigneeIds.length === 0 ? <span className="text-tertiary">—</span>
        : <span className="flex items-center -space-x-1">{item.assigneeIds.slice(0, 3).map((id) => <Avatar key={id} name={people.find((person) => person.userId === id)?.name ?? "?"} />)}</span>;
      case "labels": return item.labelIds.length === 0 ? <span className="text-tertiary">—</span> : <span>{item.labelIds.map((id) => labels.find((label) => label.id === id)?.name).filter(Boolean).join(", ")}</span>;
      case "dates": return <span>{item.startDate && item.dueDate ? `${formatDay(item.startDate)} – ${formatDay(item.dueDate)}` : item.startDate ? formatDay(item.startDate) : item.dueDate ? formatDay(item.dueDate) : "—"}</span>;
      default: return null;
    }
  };
  return <div className="overflow-hidden rounded-lg border border-subtle">
    {items.length === 0 && <p role="status" className="border-b border-subtle bg-surface-1 px-5 py-3 text-14 text-secondary">{empty}</p>}
    <div className="overflow-x-auto" data-testid="sheet-scroll">
      <table className="w-full border-separate border-spacing-0 bg-surface-1 text-13">
        <thead><tr className="bg-layer-1 text-12 font-medium text-tertiary">
          <th scope="col" className={`${cell} sticky left-0 z-10 min-w-64 bg-layer-1`}>{t("layout.sheet.workItem")}</th>
          <th scope="col" className={cell}>{t("workspaceViews.project")}</th>
          {columns.map((property) => <th key={property} scope="col" className={cell}>{t(`layout.property.${property}`)}</th>)}
        </tr></thead>
        <tbody>{items.map((item) => <tr key={item.id} data-testid={`row-${item.displayId}`} className="group hover:bg-layer-transparent-hover">
          <th scope="row" className={`${cell} sticky left-0 z-10 min-w-64 bg-surface-1 font-normal group-hover:bg-layer-1`}>
            <span className="flex items-center gap-3">{props.includes("id") && <span className="shrink-0 text-12 text-tertiary">{item.displayId}</span>}
              <Link to={paths.workItem(workspaceSlug, item.displayId)} className="max-w-72 truncate text-14 font-medium text-primary">{item.title}</Link></span>
          </th>
          <td className={cell}><Link to={paths.workItems(workspaceSlug, item.projectKey)} className="text-secondary hover:text-primary">{item.projectName}</Link></td>
          {columns.map((property) => <td key={property} className={cell}>{cellOf(item, property)}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

/** One workspace view: a built-in (all, assigned, created, subscribed) or a saved workspace View. Display settings live in the URL; a saved View can be updated from them. */
export function WorkspaceViewPage({ workspace, selfId, viewId }: { workspace: Workspace; selfId: string; viewId: string }) {
  const navigate = useNavigate();
  const builtin = builtinViews.find((entry) => entry.slug === viewId);
  const [saved, setSaved] = React.useState<SavedView[] | null>(null);
  const [view, setView] = React.useState<SavedView | null | undefined>(builtin ? null : undefined);
  const [params, setParams] = React.useState<LayoutParams>(() => asWorkspace(parseLayoutParams(window.location.search)));
  const [ready, setReady] = React.useState(!!builtin);
  const [items, setItems] = React.useState<Item[] | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [states, setStates] = React.useState<State[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  const [pqlOpen, setPqlOpen] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<null | "save" | "edit" | "delete">(null);
  const [copied, setCopied] = React.useState(false);
  const reloadList = React.useCallback(async () => setSaved((await action<{ views: SavedView[] }>("list_workspace_views", { workspaceId: workspace.id }))?.views ?? []), [workspace.id]);
  React.useEffect(() => {
    void reloadList();
    void action<Member[]>("list_members", { workspaceId: workspace.id }).then((rows) => setPeople(rows ?? []));
    void (async () => {
      const found = await action<Project[]>("list_projects", { workspaceId: workspace.id }) ?? [];
      setProjects(found);
      const lists = await Promise.all(found.map(async (project) => ({ states: await action<State[]>("list_states", { projectId: project.id }) ?? [], labels: await action<Label[]>("list_labels", { projectId: project.id }) ?? [] })));
      setStates(lists.flatMap((entry) => entry.states)); setLabels(lists.flatMap((entry) => entry.labels));
    })();
  }, [workspace.id, reloadList]);
  React.useEffect(() => {
    if (builtin) return;
    let live = true;
    void action<SavedView>("get_view", { viewId }).then((loaded) => {
      if (!live) return;
      // A View opened under the wrong route (a project View, or another workspace's) is treated as missing.
      const found = loaded && loaded.scope === "workspace" && loaded.workspaceId === workspace.id ? loaded : null;
      if (found && window.location.search === "") {
        const next = asWorkspace(viewToParams(found));
        window.history.replaceState(null, "", `${window.location.pathname}${serializeLayoutParams(next)}`);
        setParams(next);
      }
      setView(found); setReady(true);
    });
    return () => { live = false; };
  }, [viewId, builtin, workspace.id]);
  const update = (patch: Partial<LayoutParams>) => {
    const next = asWorkspace({ ...params, ...patch });
    window.history.pushState(null, "", `${window.location.pathname}${serializeLayoutParams(next)}`);
    setParams(next);
  };
  React.useEffect(() => {
    if (!ready) return;
    let live = true;
    void actionResult<Item[]>("list_workspace_work_items", { workspaceId: workspace.id, ...(builtin ? { builtin: builtin.kind } : {}), ...(params.q.trim() ? { query: params.q } : {}), sort: params.sort, direction: params.dir }).then((result) => {
      if (!live) return;
      if ("error" in result) { setQueryError(params.q.trim() ? result.error : null); return; }
      setQueryError(null); setItems(result.data);
    });
    return () => { live = false; };
  }, [ready, workspace.id, builtin, params.q, params.sort, params.dir]);

  if (view === undefined) return null;
  if (!builtin && view === null) return <section><p role="alert">{t("views.notFound")}</p><Link to={paths.workspaceView(workspace.slug, "all-issues")}>{t("views.back")}</Link></section>;
  const role = people.find((person) => person.userId === selfId)?.role;
  const canWrite = role !== undefined && role !== "Guest";
  const canChange = !!view && (view.ownerId === selfId || role === "Admin");
  const title = builtin ? t(builtin.label) : view!.name;
  const link = `${window.location.origin}${paths.workspaceView(workspace.slug, builtin ? builtin.slug : viewId)}`;
  const entries = [...builtinViews.map((entry) => ({ slug: entry.slug as string, name: t(entry.label), isPrivate: false })), ...(saved ?? []).map((entry) => ({ slug: entry.id, name: entry.name, isPrivate: entry.access === "private" }))];
  return <section className="grid gap-3">
    <header className="flex flex-wrap items-center gap-2 border-b border-subtle pb-3">
      <nav aria-label={t("views.breadcrumb")} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-14 text-secondary">
        <Layers aria-hidden size={14} /><span>{t("views.title")}</span><ChevronRight aria-hidden size={14} />
        <Popover label={t("workspaceViews.switch")} className="text-14 font-medium text-primary" panelClassName="max-h-80 w-64 overflow-auto" trigger={<><h1 className="m-0 text-14 font-medium">{title}</h1><ChevronDown aria-hidden size={14} /></>}>
          {(close) => entries.map((entry) => <button key={entry.slug} type="button" role="menuitemradio" aria-checked={entry.slug === viewId} className={menuItemClass}
            onClick={() => { close(); navigate(paths.workspaceView(workspace.slug, entry.slug)); }}>
            <Layers aria-hidden size={14} className="text-secondary" /><span className="flex-1 truncate">{entry.name}</span>{entry.isPrivate && <Lock aria-hidden size={12} className="text-tertiary" />}{entry.slug === viewId && <Check aria-hidden size={14} />}</button>)}
        </Popover>
        {view && <span title={t(`views.access.${view.access}`)} className="text-12 text-tertiary">{t(`views.access.${view.access}`)}</span>}
      </nav>
      <PqlToggle open={pqlOpen || queryError !== null} onToggle={() => setPqlOpen(!pqlOpen)} />
      <Popover label={t("layout.display")} className={ghost} panelRole="dialog" panelClassName="grid w-72 max-w-[calc(100vw-2rem)] max-h-[70vh] gap-3 overflow-auto p-3" trigger={<><SlidersHorizontal aria-hidden size={14} /><span>{t("layout.display")}</span></>}>
        {() => <>
          <label>{t("layout.sort")}<select value={params.sort} onChange={(event) => update({ sort: event.target.value as LayoutParams["sort"] })}>
            {sortFields.map((value) => <option key={value} value={value}>{value === "manual" ? t("workspaceViews.sort.manual") : t(`layout.sort.${value}`)}</option>)}</select></label>
          <label>{t("layout.direction")}<select value={params.dir} onChange={(event) => update({ dir: event.target.value as LayoutParams["dir"] })}>
            {(["asc", "desc"] as const).map((value) => <option key={value} value={value}>{t(`layout.direction.${value}`)}</option>)}</select></label>
          <fieldset className="m-0 grid gap-1 border-0 p-0"><legend className="text-12 font-medium text-tertiary">{t("layout.properties")}</legend>
            {columnProperties.map((property) => <label key={property} className="flex items-center gap-2 text-13"><input type="checkbox" checked={params.props.includes(property)}
              onChange={(event) => update({ props: columnProperties.filter((other) => other === property ? event.target.checked : params.props.includes(other)) })} />{t(`layout.property.${property}`)}</label>)}</fieldset>
        </>}
      </Popover>
      {canWrite && <button type="button" className={ghost} onClick={() => setForm("save")}><BookmarkPlus aria-hidden size={14} />{t("views.saveAs")}</button>}
      {view && canChange && differsFromView(view, params) && <button type="button" className={primary} onClick={async () => {
        const next = await action<SavedView>("update_view", { viewId: view.id, ...paramsToSettings(params) });
        if (next) { setView(next); setStatus(t("views.updated")); void reloadList(); } else setStatus(t("views.failed"));
      }}>{t("views.update")}</button>}
      <Popover label={t("views.menu")} align="right" trigger={<MoreHorizontal aria-hidden size={16} />} panelClassName="w-44">
        {(close) => <>
          <button type="button" role="menuitem" className={menuItemClass} onClick={() => { void navigator.clipboard?.writeText(link).catch(() => null); setCopied(true); close(); }}>{t("views.copyLink")}</button>
          {view && canChange && <>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); setForm("edit"); }}>{t("views.edit")}</button>
            <button type="button" role="menuitem" className={`${menuItemClass} text-danger-text`} onClick={() => { close(); setForm("delete"); }}>{t("views.delete")}</button>
          </>}
          {copied && <span role="status" className="sr-only">{t("views.linkCopied")}</span>}
        </>}
      </Popover>
    </header>
    {view?.description && <p className="m-0 text-13 text-secondary">{view.description}</p>}
    {status && <p role="status" className="m-0 text-13 text-secondary">{status}</p>}
    {(pqlOpen || queryError !== null) && <PqlEditor text={params.q} error={queryError} onApply={(text) => update({ q: text })} generate={{ workspaceId: workspace.id }} />}
    {items !== null && <WorkspaceSheet items={items} projects={projects} states={states} labels={labels} people={people} workspaceSlug={workspace.slug} props={params.props} empty={t(params.q.trim() ? "layout.noMatch" : "workspaceViews.empty")} />}
    {form === "save" && <ViewFormModal mode="save" target={{ workspaceId: workspace.id }} settings={paramsToSettings(params)} onClose={() => setForm(null)} onSaved={(next) => { setForm(null); void reloadList(); navigate(paths.workspaceView(workspace.slug, next.id)); }} />}
    {form === "edit" && view && <ViewFormModal mode="edit" view={view} target={{ workspaceId: workspace.id }} onClose={() => setForm(null)} onSaved={(next) => { setForm(null); setView(next); void reloadList(); }} />}
    {form === "delete" && view && <DeleteViewModal view={view} onClose={() => setForm(null)} onDeleted={() => { setForm(null); void reloadList(); navigate(paths.workspaceView(workspace.slug, "all-issues")); }} />}
  </section>;
}
