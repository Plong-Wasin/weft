import { useIntegrationsEnabled } from "../integrations-flag";
import { adminState } from "../admin-state";
import { useOutboundWebhooksEnabled } from "../outbound-webhooks-flag";
import React from "react";
import { NavLink, useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText, Folder, GripVertical, MoreHorizontal, Plus, Star } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "../api";
import { ProjectNav } from "../project-nav";
import { paths } from "../routes";
import type { Member, Project, Workspace } from "../types";
import { useWorkspace } from "../layouts/workspace-layout";
import { AiSidebar } from "../ai-chat";
import { sectionOf } from "./app-rail";
import { WikiSidebar } from "./wiki-sidebar";
import { dropWithinGroup, moveWithinGroup, preferenceOf, sortProjects, useProjectPreferences, type ProjectPreference } from "./project-preferences";

export const projectsKey = (workspaceId: string) => ["projects", workspaceId] as const;
const favoritesKey = (workspaceId: string) => ["favorite-wiki-pages", workspaceId] as const;

const itemClass = ({ isActive }: { isActive: boolean }) => `flex items-center gap-2 rounded-md px-2.5 py-1.5 text-14 font-medium ${isActive ? "bg-layer-1-selected text-primary" : "text-secondary hover:bg-layer-transparent-hover"}`;
const heading = "px-2.5 pb-1 pt-3 text-12 font-medium text-tertiary";

/** What a project row can do to the order. The list owns the state; a row only reports the gesture. */
type Reorder = {
  move: (projectId: string, delta: -1 | 1) => void;
  drop: (fromId: string, toId: string) => void;
  star: (projectId: string, starred: boolean) => void;
  expand: (projectId: string, expanded: boolean) => void;
  reset: () => Promise<void>;
};

/** The project being dragged, so a drop target can refuse a drop into the other group. */
type Drag = React.MutableRefObject<{ id: string; starred: boolean } | null>;

/** Opens a project's menu once, when the person navigates into it. Later the person may close it again. */
function useOpenWhenCurrent(current: boolean, expanded: boolean, projectId: string, expand: Reorder["expand"]) {
  const expandedRef = React.useRef(expanded);
  expandedRef.current = expanded;
  React.useEffect(() => {
    if (current && !expandedRef.current) expand(projectId, true);
  }, [current, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
}

function ProjectEntry({ workspace, project, current, starred, expanded, canMoveUp, canMoveDown, reorder, drag }: {
  workspace: Workspace; project: Project; current: boolean; starred: boolean; expanded: boolean; canMoveUp: boolean; canMoveDown: boolean; reorder: Reorder; drag: Drag;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  useOpenWhenCurrent(current, expanded, project.id, reorder.expand);
  const starLabel = translate(starred ? "sidebar.unstar" : "sidebar.star");
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    reorder.move(project.id, event.key === "ArrowUp" ? -1 : 1);
  };
  return <li draggable
    onDragStart={(event) => { drag.current = { id: project.id, starred }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", project.id); }}
    onDragOver={(event) => { if (drag.current && drag.current.starred === starred && drag.current.id !== project.id) event.preventDefault(); }}
    onDrop={(event) => { event.preventDefault(); const from = drag.current; drag.current = null; if (from && from.starred === starred) reorder.drop(from.id, project.id); }}
    onDragEnd={() => { drag.current = null; }}>
    <div className="flex items-center gap-0.5 rounded-md hover:bg-layer-transparent-hover">
      <span aria-hidden title={translate("sidebar.dragHandle")} className="flex shrink-0 cursor-grab items-center px-0.5 text-tertiary max-md:hidden"><GripVertical size={14} /></span>
      <button type="button" aria-pressed={starred} aria-label={`${starLabel}: ${project.name}`} title={starLabel} onClick={() => reorder.star(project.id, !starred)} className="shrink-0 bg-transparent p-1 text-tertiary hover:bg-transparent hover:text-primary">
        <Star aria-hidden size={14} className={starred ? "text-accent-primary" : undefined} fill={starred ? "currentColor" : "none"} />
      </button>
      <button type="button" data-project-toggle={project.id} aria-expanded={expanded} aria-label={`${translate("sidebar.toggleProject")}: ${project.name}`} title={translate("sidebar.reorderHint")} onKeyDown={onKeyDown} onClick={() => reorder.expand(project.id, !expanded)}
        className="flex min-w-0 flex-1 items-center gap-2 bg-transparent px-1 py-1.5 text-left text-14 font-medium text-primary hover:bg-transparent">
        <Folder aria-hidden size={14} className="shrink-0 text-secondary" /><span className="flex-1 truncate">{project.name}</span>
        <ChevronRight aria-hidden size={14} className={`shrink-0 text-tertiary transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      <button type="button" aria-expanded={menuOpen} aria-label={`${translate("sidebar.projectOptions")}: ${project.name}`} title={translate("sidebar.projectOptions")} onClick={() => setMenuOpen((value) => !value)} className="shrink-0 bg-transparent p-1 text-tertiary hover:bg-transparent hover:text-primary">
        <MoreHorizontal aria-hidden size={14} />
      </button>
    </div>
    {menuOpen && <div role="group" aria-label={`${translate("sidebar.projectOptions")}: ${project.name}`} className="ml-6 mt-0.5 grid gap-0.5 rounded-md border border-subtle bg-surface-1 p-1">
      <button type="button" disabled={!canMoveUp} onClick={() => reorder.move(project.id, -1)} className="justify-start bg-transparent px-2 py-1 text-left text-13 text-primary hover:bg-layer-transparent-hover disabled:text-tertiary">{translate("sidebar.moveUp")}</button>
      <button type="button" disabled={!canMoveDown} onClick={() => reorder.move(project.id, 1)} className="justify-start bg-transparent px-2 py-1 text-left text-13 text-primary hover:bg-layer-transparent-hover disabled:text-tertiary">{translate("sidebar.moveDown")}</button>
      <button type="button" aria-pressed={starred} onClick={() => reorder.star(project.id, !starred)} className="justify-start bg-transparent px-2 py-1 text-left text-13 text-primary hover:bg-layer-transparent-hover">{starLabel}</button>
    </div>}
    {expanded && <ProjectNav workspace={workspace.slug} projectKey={project.key} features={project.features} />}
  </li>;
}

const settingsSections: Array<{ path: string; label: MessageKey }> = [
  { path: "", label: "settings.general" }, { path: "members", label: "members.title" }, { path: "features", label: "settings.features" },
  { path: "states", label: "states.title" }, { path: "labels", label: "labels.title" }, { path: "estimates", label: "estimates.title" }, { path: "recurrences", label: "recurrences.title" }, { path: "automation", label: "autoRules.navLabel" },
];

/** A project in the settings sidebar, with its five settings sections. */
function SettingsProjectEntry({ workspace, project, current, expanded, expand }: { workspace: Workspace; project: Project; current: boolean; expanded: boolean; expand: Reorder["expand"] }) {
  useOpenWhenCurrent(current, expanded, project.id, expand);
  return <li>
    <button type="button" data-project-toggle={project.id} aria-expanded={expanded} aria-label={`${translate("sidebar.toggleProject")}: ${project.name}`} onClick={() => expand(project.id, !expanded)} className="flex w-full items-center gap-2 rounded-md bg-transparent px-2.5 py-1.5 text-left text-14 font-medium text-primary hover:bg-layer-transparent-hover">
      <Folder aria-hidden size={14} className="text-secondary" /><span className="flex-1 truncate">{project.name}</span>
      <ChevronRight aria-hidden size={14} className={`text-tertiary transition-transform ${expanded ? "rotate-90" : ""}`} />
    </button>
    {expanded && <nav aria-label={`${translate("settings.label")} ${project.key}`}><ul className="ml-4 grid gap-0.5 border-l border-subtle pl-2">
      {settingsSections.map((section) => <li key={section.label}><NavLink end to={paths.projectSettings(workspace.slug, project.key, section.path)}
        className={({ isActive }) => `flex items-center rounded-md px-2.5 py-1 text-13 font-medium ${isActive ? "bg-layer-1-selected text-primary" : "text-secondary hover:bg-layer-transparent-hover"}`}>{translate(section.label)}</NavLink></li>)}
    </ul></nav>}
  </li>;
}

/** The Starred group (hidden when empty), then every other project, with the reset link once any order is saved. */
function ProjectGroups({ workspace, projects, prefs, projectKey, reorder, drag }: { workspace: Workspace; projects: Project[]; prefs: ProjectPreference[]; projectKey?: string; reorder: Reorder; drag: Drag }) {
  const { starred, others } = sortProjects(projects, prefs);
  const expandedOf = (projectId: string) => preferenceOf(prefs, projectId)?.expanded ?? false;
  const entry = (project: Project, isStarred: boolean, index: number, count: number) => <ProjectEntry key={project.id} workspace={workspace} project={project} current={project.key === projectKey}
    starred={isStarred} expanded={expandedOf(project.id)} canMoveUp={index > 0} canMoveDown={index < count - 1} reorder={reorder} drag={drag} />;
  return <>
    {starred.length > 0 && <>
      <p className={heading}>{translate("sidebar.starred")}</p>
      <ul aria-label={translate("sidebar.starred")} className="grid gap-0.5">{starred.map((project, index) => entry(project, true, index, starred.length))}</ul>
    </>}
    <div className="flex items-center justify-between"><p className={heading}>{translate("projects.title")}</p>
      <NavLink to={paths.projects(workspace.slug)} end aria-label={translate("sidebar.allProjects")} title={translate("sidebar.allProjects")} className="mt-2 rounded-md p-1 text-secondary hover:bg-layer-transparent-hover"><Plus aria-hidden size={14} /></NavLink></div>
    <ul aria-label={translate("projects.title")} className="grid gap-0.5">{others.map((project, index) => entry(project, false, index, others.length))}</ul>
    {prefs.some((pref) => pref.position !== null) && <button type="button" title={translate("sidebar.resetOrderTip")} onClick={() => void reorder.reset()} className="mx-2.5 mt-1 justify-self-start bg-transparent px-0 py-1 text-12 font-medium text-secondary hover:bg-transparent hover:text-primary">{translate("sidebar.resetOrder")}</button>}
  </>;
}

/** Contextual sidebar: its content follows the rail section. Work lists the projects with their menus (a turned-off feature has no entry). */
export function Sidebar({ workspace }: { workspace: Workspace }) {
  const integrationsOn = useIntegrationsEnabled();
  const webhooksOn = useOutboundWebhooksEnabled();
  const { pathname } = useLocation();
  const section = sectionOf(pathname, workspace.slug);
  const { projectKey } = useParams();
  const { selfId } = useWorkspace();
  // Analytics is for workspace Admins and Members; a Guest gets no entry (the Actions refuse a Guest anyway).
  const { data: members } = useQuery({ queryKey: ["workspace-members", workspace.id], queryFn: async () => await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? [], enabled: section === "work" || section === "settings" });
  const canSeeAnalytics = (members ?? []).some((member) => member.userId === selfId && member.role !== "Guest");
  const isWorkspaceAdmin = adminState(members ?? null, selfId) === "admin";
  const aiChatId = section === "ai" ? pathname.split("/")[3] ?? "" : "";
  const { data } = useQuery({ queryKey: projectsKey(workspace.id), queryFn: async () => await action<Project[]>("list_projects", { workspaceId: workspace.id, archived: false }) ?? [], enabled: section === "work" || section === "settings" || section === "wiki" });
  const projectList = data ?? [];
  const { prefs, setPreference, setOrder, resetOrder } = useProjectPreferences(workspace.id, section === "work" || section === "settings");
  const projectSort = sortProjects(projectList, prefs);
  const settingsEntry = (project: Project) => <SettingsProjectEntry key={project.id} workspace={workspace} project={project} current={project.key === projectKey} expanded={preferenceOf(prefs, project.id)?.expanded ?? false} expand={(projectId, expanded) => void setPreference(projectId, { expanded })} />;
  const drag = React.useRef<{ id: string; starred: boolean } | null>(null);
  // A keyboard move keeps focus on the moved project: the list re-sorts, so focus is set once the new order is in the cache.
  const focusAfterMove = React.useRef<string | null>(null);
  React.useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = null;
    document.querySelector<HTMLElement>(`[data-project-toggle="${id}"]`)?.focus();
  }, [prefs]);
  const reorder: Reorder = {
    move: (projectId, delta) => {
      const order = moveWithinGroup(projectList, prefs, projectId, delta);
      if (!order) return;
      focusAfterMove.current = projectId;
      void setOrder(order);
    },
    drop: (fromId, toId) => {
      const order = dropWithinGroup(projectList, prefs, fromId, toId);
      if (order) void setOrder(order);
    },
    star: (projectId, starred) => void setPreference(projectId, { starred }),
    expand: (projectId, expanded) => void setPreference(projectId, { expanded }),
    reset: async () => { await resetOrder(); },
  };
  const { data: favorites = [] } = useQuery({ queryKey: favoritesKey(workspace.id), queryFn: async () => await action<Array<{ id: string; title: string; projectId: string | null }>>("list_favorite_wiki_pages", { workspaceId: workspace.id }) ?? [], enabled: section === "work" || section === "wiki" });
  return <nav aria-label={translate("shell.sidebar")} className="flex w-64 shrink-0 max-md:w-auto max-md:flex-1 max-md:border-r-0 flex-col gap-0.5 overflow-y-auto border-r border-subtle bg-surface-1 p-2">
    {section === "work" && <>
      <NavLink end to={paths.home(workspace.slug)} className={itemClass}>{translate("nav.home")}</NavLink>
      <NavLink to={paths.workspaceViews(workspace.slug)} className={itemClass}>{translate("views.title")}</NavLink>
      <NavLink to={paths.activeCycles(workspace.slug)} className={itemClass}>{translate("cycles.activeTitle")}</NavLink>
      {canSeeAnalytics && <NavLink to={paths.analytics(workspace.slug)} className={itemClass}>{translate("analytics.title")}</NavLink>}
      <ProjectGroups workspace={workspace} projects={projectList} prefs={prefs} projectKey={projectKey} reorder={reorder} drag={drag} />
      {favorites.length > 0 && <>
        <p className={heading}>{translate("sidebar.favorites")}</p>
        <ul className="grid gap-0.5">{favorites.map((page) => <li key={page.id}><NavLink to={page.projectId ? paths.page(workspace.slug, (data ?? []).find((project) => project.id === page.projectId)?.key ?? "", page.id) : paths.wikiPage(workspace.slug, page.id)} className={itemClass}><FileText aria-hidden size={14} /><span className="truncate">{page.title}</span></NavLink></li>)}</ul>
      </>}
    </>}
    {section === "wiki" && <>
      <WikiSidebar workspace={workspace} selfId={selfId} />
      {favorites.length > 0 && <>
        <p className={heading}>{translate("sidebar.favorites")}</p>
        <ul className="grid gap-0.5">{favorites.map((page) => <li key={page.id}><NavLink to={page.projectId ? paths.page(workspace.slug, (data ?? []).find((project) => project.id === page.projectId)?.key ?? "", page.id) : paths.wikiPage(workspace.slug, page.id)} className={itemClass}><FileText aria-hidden size={14} /><span className="truncate">{page.title}</span></NavLink></li>)}</ul>
      </>}
    </>}
    {section === "ai" && <AiSidebar workspace={workspace} activeId={aiChatId} />}
    {section === "settings" && <>
      <p className={heading}>{translate("sidebar.workspace")}</p>
      <NavLink end to={paths.workspaceSettings(workspace.slug)} className={itemClass}>{translate("settings.general")}</NavLink>
      <NavLink to={paths.workspaceMembers(workspace.slug)} className={itemClass}>{translate("members.title")}</NavLink>
      <NavLink to={paths.workspaceInvites(workspace.slug)} className={itemClass}>{translate("settings.invites")}</NavLink>
      {isWorkspaceAdmin && <NavLink to={paths.workspaceAudit(workspace.slug)} className={itemClass}>{translate("account.auditTitle")}</NavLink>}
      <NavLink to={paths.workspaceAgents(workspace.slug)} className={itemClass}>{translate("settings.agents")}</NavLink>
      <NavLink to={paths.workspaceRuntimes(workspace.slug)} className={itemClass}>{translate("runtimes.title")}</NavLink>
      <NavLink to={paths.workspaceSkills(workspace.slug)} className={itemClass}>{translate("settings.skills")}</NavLink>
      <NavLink to={paths.workspaceExports(workspace.slug)} className={itemClass}>{translate("settings.exports")}</NavLink>
      {isWorkspaceAdmin && <NavLink to={paths.workspaceUsage(workspace.slug)} className={itemClass}>{translate("settings.usage")}</NavLink>}
      <NavLink to={paths.workspaceAi(workspace.slug)} className={itemClass}>{translate("aiStatus.title")}</NavLink>
      {integrationsOn && <NavLink to={paths.workspaceIntegrations(workspace.slug)} className={itemClass}>{translate("integrations.title")}</NavLink>}
      {webhooksOn && <NavLink to={paths.workspaceWebhooks(workspace.slug)} className={itemClass}>{translate("outboundWebhooks.nav")}</NavLink>}
      {projectSort.starred.length > 0 && <>
        <p className={heading}>{translate("sidebar.starred")}</p>
        <ul className="grid gap-0.5">{projectSort.starred.map((project) => settingsEntry(project))}</ul>
      </>}
      <p className={heading}>{translate("projects.title")}</p>
      <NavLink to={paths.workspaceProjectOrder(workspace.slug)} className={itemClass}>{translate("settings.projectOrder")}</NavLink>
      <ul className="grid gap-0.5">{projectSort.others.map((project) => settingsEntry(project))}</ul>
    </>}
  </nav>;
}
