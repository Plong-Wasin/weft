import { copyText } from "./toast";
import React from "react";
import { Link, useNavigate } from "react-router";
import { BookmarkPlus, ChevronRight, Globe, Layers, Lock, MoreHorizontal, Plus, Search, X } from "lucide-react";
import { formatDate, translate, type MessageKey } from "@weft/shared";
import { action } from "./api";
import { paths } from "./routes";
import { Popover, menuItemClass } from "./shell/popover";
import { Avatar } from "./avatar";
import { serializeLayoutParams, type LayoutParams } from "./work-item-layout";
import { differsFromView, paramsToSettings, viewToParams, type SavedView } from "./view-params";
import { WorkItemLayouts } from "./work-item-layouts";
import { CreateWorkItemModal } from "./create-work-item-modal";
import type { Member, Project } from "./types";

const t = (key: string) => translate(key as MessageKey);
const primary = "rounded-md border-0 bg-accent-primary px-3 py-1 text-13 font-medium text-on-color hover:bg-accent-primary-hover disabled:opacity-60";
const ghost = "flex items-center gap-1.5 rounded-md border border-subtle bg-surface-1 px-2.5 py-1 text-13 font-medium text-primary hover:bg-layer-transparent-hover";

type Scope = { workspaceSlug: string; project: Project; selfId: string };
/** Owner, or an Admin (a project Admin or a workspace Admin, whose project role is null), may change a View. */
const canChange = (view: SavedView, scope: Scope) => view.ownerId === scope.selfId || scope.project.role === "Admin" || scope.project.role === null;

function AccessBadge({ access }: { access: SavedView["access"] }) {
  const Icon = access === "private" ? Lock : Globe;
  return <span title={t(`views.access.${access}`)} aria-label={t(`views.access.${access}`)} className="flex items-center text-secondary"><Icon aria-hidden size={14} /></span>;
}

/** Create, edit and Save-as-view all use one modal: name, description, access. */
export function ViewFormModal({ mode, view, target, settings, onClose, onSaved }: {
  mode: "create" | "edit" | "save"; view?: SavedView; target: { projectId: string } | { workspaceId: string }; settings?: ReturnType<typeof paramsToSettings>; onClose: () => void; onSaved: (view: SavedView) => void;
}) {
  const [name, setName] = React.useState(view?.name ?? "");
  const [description, setDescription] = React.useState(view?.description ?? "");
  const [access, setAccess] = React.useState<SavedView["access"]>(view?.access ?? "public");
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const title = t(mode === "edit" ? "views.form.editTitle" : mode === "save" ? "views.form.saveTitle" : "views.form.createTitle");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const saved = view
      ? await action<SavedView>("update_view", { viewId: view.id, name, description, access })
      : "workspaceId" in target
        ? await action<SavedView>("create_workspace_view", { workspaceId: target.workspaceId, name, description, access, ...settings })
        : await action<SavedView>("create_view", { projectId: target.projectId, name, description, access, ...settings });
    setBusy(false);
    if (!saved) { setNote(t("views.failed")); return; }
    onSaved(saved);
  };
  return <>
    <div aria-hidden className="fixed inset-0 z-40 bg-backdrop" onClick={onClose} />
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed left-1/2 top-[10vh] z-50 w-[calc(100vw-1.5rem)] max-w-lg -translate-x-1/2 overflow-auto rounded-lg border border-subtle bg-surface-1 shadow-xl">
      <form className="my-0 grid gap-4 p-5" onSubmit={(event) => void submit(event)}>
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex-1 text-18 font-semibold text-primary">{title}</h2>
          <button type="button" className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover" aria-label={t("views.cancel")} onClick={onClose}><X aria-hidden size={16} /></button>
        </div>
        <label className="grid gap-1 text-13 text-secondary">{t("views.name")}<input autoFocus required maxLength={100} value={name} className="w-full text-14" onChange={(event) => setName(event.target.value)} /></label>
        <label className="grid gap-1 text-13 text-secondary">{t("views.description")}<textarea rows={3} maxLength={2000} value={description} className="w-full text-14" onChange={(event) => setDescription(event.target.value)} /></label>
        <label className="grid gap-1 text-13 text-secondary">{t("views.access")}
          <select value={access} className="text-14" onChange={(event) => setAccess(event.target.value as SavedView["access"])}>
            {(["public", "private"] as const).map((value) => <option key={value} value={value}>{t(`views.access.${value}`)}</option>)}
          </select></label>
        {note && <p role="alert" className="m-0 text-13 text-danger-text">{note}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="secondary" onClick={onClose}>{t("views.cancel")}</button>
          <button type="submit" disabled={busy || name.trim() === ""} className={primary}>{t(mode === "edit" ? "views.save" : "views.create")}</button>
        </div>
      </form>
    </div>
  </>;
}

export function DeleteViewModal({ view, onClose, onDeleted }: { view: SavedView; onClose: () => void; onDeleted: () => void }) {
  const [note, setNote] = React.useState<string | null>(null);
  const label = t("views.delete");
  return <>
    <div aria-hidden className="fixed inset-0 z-40 bg-backdrop" onClick={onClose} />
    <div role="alertdialog" aria-modal="true" aria-label={label} className="fixed left-1/2 top-[15vh] z-50 grid w-[calc(100vw-1.5rem)] max-w-md -translate-x-1/2 gap-4 rounded-lg border border-subtle bg-surface-1 p-5 shadow-xl">
      <h2 className="m-0 text-18 font-semibold text-primary">{label}</h2>
      <p className="m-0 text-14 text-secondary">{t("views.deleteConfirm").replace("{name}", view.name)}</p>
      {note && <p role="alert" className="m-0 text-13 text-danger-text">{note}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="secondary" onClick={onClose}>{t("views.cancel")}</button>
        <button type="button" className={primary} onClick={async () => { if ((await action("delete_view", { viewId: view.id })) === null) setNote(t("views.failed")); else onDeleted(); }}>{t("views.deleteAction")}</button>
      </div>
    </div>
  </>;
}

/** The menu of a View: edit and delete for the owner or an Admin, copy link for anyone. */
function ViewMenu({ view, scope, onEdit, onDelete }: { view: SavedView; scope: Scope; onEdit: () => void; onDelete: () => void }) {
  const link = `${window.location.origin}${paths.view(scope.workspaceSlug, scope.project.key, view.id)}`;
  return <Popover label={t("views.menu")} align="right" trigger={<MoreHorizontal aria-hidden size={16} />} panelClassName="w-44">
    {(close) => <>
      <button type="button" role="menuitem" className={menuItemClass} onClick={() => { void copyText(link, t("views.linkCopied"), t("comments.copyFailed")); close(); }}>{t("views.copyLink")}</button>
      {canChange(view, scope) && <>
        <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onEdit(); }}>{t("views.edit")}</button>
        <button type="button" role="menuitem" className={`${menuItemClass} text-danger-text`} onClick={() => { close(); onDelete(); }}>{t("views.delete")}</button>
      </>}
    </>}
  </Popover>;
}

/** Project Views page: one row per View the caller may see. */
export function ViewsPage({ workspaceSlug, project, selfId }: Scope) {
  const scope = { workspaceSlug, project, selfId };
  const [views, setViews] = React.useState<SavedView[] | null>(null);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [search, setSearch] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<SavedView | null>(null);
  const [deleting, setDeleting] = React.useState<SavedView | null>(null);
  const canWrite = project.role !== "Guest" && !project.archived;
  const load = React.useCallback(async () => setViews(await action<SavedView[]>("list_views", { projectId: project.id }) ?? []), [project.id]);
  React.useEffect(() => { void load(); void action<Member[]>("list_project_members", { projectId: project.id }).then((rows) => setPeople(rows ?? [])); }, [load, project.id]);
  const needle = search.trim().toLowerCase();
  const shown = (views ?? []).filter((view) => !needle || view.name.toLowerCase().includes(needle));
  const ownerOf = (view: SavedView) => people.find((person) => person.userId === view.ownerId)?.name ?? "";
  return <section className="grid gap-0">
    <header className="flex flex-wrap items-center gap-2 border-b border-subtle pb-3">
      <nav aria-label={t("views.breadcrumb")} className="flex min-w-0 flex-1 items-center gap-1.5 text-14 text-secondary">
        <Link to={paths.workItems(workspaceSlug, project.key)} className="truncate text-secondary hover:text-primary">{project.name}</Link>
        <ChevronRight aria-hidden size={14} /><Layers aria-hidden size={14} /><h2 className="m-0 text-14 font-medium text-primary">{t("views.title")}</h2>
      </nav>
      <label className="relative my-0 block"><span className="sr-only">{t("views.search")}</span>
        <Search aria-hidden size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-tertiary" />
        <input type="search" value={search} placeholder={t("views.search")} className="w-48 pl-7 text-13" onChange={(event) => setSearch(event.target.value)} /></label>
      {canWrite && <button type="button" className={`${primary} flex items-center gap-1.5`} onClick={() => setCreating(true)}><Plus aria-hidden size={14} />{t("views.add")}</button>}
    </header>
    {views !== null && shown.length === 0 && <p role="status" className="px-3 py-6 text-14 text-secondary">{t(views.length === 0 ? "views.empty" : "views.noMatch")}</p>}
    <ul aria-label={t("views.title")} className="m-0 list-none p-0">{shown.map((view) => <li key={view.id} data-testid={`view-row-${view.name}`} className="flex items-center gap-3 border-b border-subtle px-3 py-3 hover:bg-layer-transparent-hover">
      <Layers aria-hidden size={16} className="shrink-0 text-secondary" />
      <div className="grid min-w-0 flex-1">
        <Link to={paths.view(workspaceSlug, project.key, view.id)} className="truncate text-14 font-medium text-primary">{view.name}</Link>
        {view.description && <span className="truncate text-12 text-tertiary">{view.description}</span>}
      </div>
      <span className="hidden text-12 text-tertiary sm:inline">{t("views.updatedAt").replace("{date}", formatDate(view.updatedAt))}</span>
      <AccessBadge access={view.access} />
      <span className="flex items-center gap-1.5 text-12 text-secondary" title={t("views.owner")}>{ownerOf(view) && <><Avatar name={ownerOf(view)} id={view.ownerId} /><span className="hidden max-w-28 truncate md:inline">{ownerOf(view)}</span></>}</span>
      <ViewMenu view={view} scope={scope} onEdit={() => setEditing(view)} onDelete={() => setDeleting(view)} />
    </li>)}</ul>
    {creating && <ViewFormModal mode="create" target={{ projectId: project.id }} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void load(); }} />}
    {editing && <ViewFormModal mode="edit" view={editing} target={{ projectId: project.id }} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    {deleting && <DeleteViewModal view={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); void load(); }} />}
  </section>;
}

/** "Save as view" next to the filter and display controls: saves what is applied now as a new View and opens it. */
export function SaveAsViewButton({ params, project, workspaceSlug }: { params: LayoutParams; project: Project; workspaceSlug: string }) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  return <>
    <button type="button" className={ghost} onClick={() => setOpen(true)}><BookmarkPlus aria-hidden size={14} />{t("views.saveAs")}</button>
    {open && <ViewFormModal mode="save" target={{ projectId: project.id }} settings={paramsToSettings(params)} onClose={() => setOpen(false)} onSaved={(view) => { setOpen(false); navigate(paths.view(workspaceSlug, project.key, view.id)); }} />}
  </>;
}

/** One View: its saved settings are applied to the URL once, then the usual layouts run on them; changes can be saved back with Update view. */
export function ViewDetailPage({ workspaceSlug, project, selfId, viewId }: Scope & { viewId: string }) {
  const navigate = useNavigate();
  const [view, setView] = React.useState<SavedView | null | undefined>(undefined);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [ready, setReady] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const scope = { workspaceSlug, project, selfId };
  React.useEffect(() => {
    let live = true;
    setView(undefined); setReady(false);
    void action<SavedView>("get_view", { viewId }).then((loaded) => {
      if (!live) return;
      // A View of another project, or a workspace View, opened under this project's route is treated as missing.
      const found = loaded && loaded.projectId === project.id ? loaded : null;
      // A bare URL opens the View as saved; a URL that already carries settings is a reload of unsaved changes and is kept.
      if (found && window.location.search === "") window.history.replaceState(null, "", `${window.location.pathname}${serializeLayoutParams(viewToParams(found))}`);
      setView(found); setReady(true);
    });
    void action<Member[]>("list_project_members", { projectId: project.id }).then((rows) => { if (live) setPeople(rows ?? []); });
    return () => { live = false; };
  }, [viewId, project.id]);
  if (view === undefined) return null;
  if (view === null) return <section><p role="alert">{t("views.notFound")}</p><Link to={paths.views(workspaceSlug, project.key)}>{t("views.back")}</Link></section>;
  const canWrite = project.role !== "Guest";
  const owner = people.find((person) => person.userId === view.ownerId)?.name;
  return <section className="grid gap-3">
    <header className="flex flex-wrap items-center gap-2 border-b border-subtle pb-3">
      <nav aria-label={t("views.breadcrumb")} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-14 text-secondary">
        <Link to={paths.workItems(workspaceSlug, project.key)} className="text-secondary hover:text-primary">{project.name}</Link><ChevronRight aria-hidden size={14} />
        <Link to={paths.views(workspaceSlug, project.key)} className="flex items-center gap-1.5 text-secondary hover:text-primary"><Layers aria-hidden size={14} />{t("views.title")}</Link><ChevronRight aria-hidden size={14} />
        <h3 className="m-0 text-14 font-medium text-primary [overflow-wrap:anywhere]">{view.name}</h3><AccessBadge access={view.access} />
        {owner && <span className="hidden items-center gap-1.5 text-12 text-tertiary md:flex"><Avatar name={owner} id={view.ownerId} />{owner}</span>}
      </nav>
      {canWrite && !project.archived && <button type="button" className={`${primary} flex items-center gap-1.5`} onClick={() => setCreating(true)}><Plus aria-hidden size={14} />{t("workItems.addNew")}</button>}
      <ViewMenu view={view} scope={scope} onEdit={() => setEditing(true)} onDelete={() => setDeleting(true)} />
    </header>
    {view.description && <p className="m-0 text-13 text-secondary">{view.description}</p>}
    {status && <p role="status" className="m-0 text-13 text-secondary">{status}</p>}
    {ready && <WorkItemLayouts key={`${view.id}`} projectId={project.id} workspaceSlug={workspaceSlug} action={action} refreshKey={refreshKey} cyclesEnabled={project.features.cycles} modulesEnabled={project.features.modules} canWrite={canWrite} canCreate
      toolbarExtra={(params) => canChange(view, scope) && differsFromView(view, params) ? <button type="button" className={primary} onClick={async () => {
        const saved = await action<SavedView>("update_view", { viewId: view.id, ...paramsToSettings(params) });
        if (saved) { setView(saved); setStatus(t("views.updated")); } else setStatus(t("views.failed"));
      }}>{t("views.update")}</button> : null} />}
    {creating && <CreateWorkItemModal project={project} onClose={() => setCreating(false)} onCreated={() => setRefreshKey((key) => key + 1)} />}
    {editing && <ViewFormModal mode="edit" view={view} target={{ projectId: project.id }} onClose={() => setEditing(false)} onSaved={(saved) => { setEditing(false); setView(saved); }} />}
    {deleting && <DeleteViewModal view={view} onClose={() => setDeleting(false)} onDeleted={() => navigate(paths.views(workspaceSlug, project.key))} />}
  </section>;
}
