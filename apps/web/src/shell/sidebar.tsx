import React from "react";
import { NavLink, useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText, Folder, Plus } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "../api";
import { ProjectNav } from "../project-nav";
import { paths } from "../routes";
import type { Member, Project, Workspace } from "../types";
import { useWorkspace } from "../layouts/workspace-layout";
import { AiSidebar } from "../ai-chat";
import { sectionOf } from "./app-rail";
import { WikiSidebar } from "./wiki-sidebar";

export const projectsKey = (workspaceId: string) => ["projects", workspaceId] as const;
const favoritesKey = (workspaceId: string) => ["favorite-wiki-pages", workspaceId] as const;

const itemClass = ({ isActive }: { isActive: boolean }) => `flex items-center gap-2 rounded-md px-2.5 py-1.5 text-14 font-medium ${isActive ? "bg-layer-1-selected text-primary" : "text-secondary hover:bg-layer-transparent-hover"}`;
const heading = "px-2.5 pb-1 pt-3 text-12 font-medium text-tertiary";

function ProjectEntry({ workspace, project, current }: { workspace: Workspace; project: Project; current: boolean }) {
  const [open, setOpen] = React.useState(current);
  React.useEffect(() => { if (current) setOpen(true); }, [current]);
  return <li>
    <div className="flex items-center rounded-md hover:bg-layer-transparent-hover">
      <button type="button" aria-expanded={open} aria-label={`${translate("sidebar.toggleProject")}: ${project.name}`} onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-2 bg-transparent px-2.5 py-1.5 text-left text-14 font-medium text-primary hover:bg-transparent">
        <Folder aria-hidden size={14} className="text-secondary" /><span className="flex-1 truncate">{project.name}</span>
        <ChevronRight aria-hidden size={14} className={`text-tertiary transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
    </div>
    {open && <ProjectNav workspace={workspace.slug} projectKey={project.key} features={project.features} />}
  </li>;
}

const settingsSections: Array<{ path: string; label: MessageKey }> = [
  { path: "", label: "settings.general" }, { path: "members", label: "members.title" }, { path: "features", label: "settings.features" },
  { path: "states", label: "states.title" }, { path: "labels", label: "labels.title" }, { path: "estimates", label: "estimates.title" },
];

/** A project in the settings sidebar, with its five settings sections. */
function SettingsProjectEntry({ workspace, project, current }: { workspace: Workspace; project: Project; current: boolean }) {
  const [open, setOpen] = React.useState(current);
  React.useEffect(() => { if (current) setOpen(true); }, [current]);
  return <li>
    <button type="button" aria-expanded={open} aria-label={`${translate("sidebar.toggleProject")}: ${project.name}`} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-md bg-transparent px-2.5 py-1.5 text-left text-14 font-medium text-primary hover:bg-layer-transparent-hover">
      <Folder aria-hidden size={14} className="text-secondary" /><span className="flex-1 truncate">{project.name}</span>
      <ChevronRight aria-hidden size={14} className={`text-tertiary transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
    {open && <nav aria-label={`${translate("settings.label")} ${project.key}`}><ul className="ml-4 grid gap-0.5 border-l border-subtle pl-2">
      {settingsSections.map((section) => <li key={section.label}><NavLink end to={paths.projectSettings(workspace.slug, project.key, section.path)}
        className={({ isActive }) => `flex items-center rounded-md px-2.5 py-1 text-13 font-medium ${isActive ? "bg-layer-1-selected text-primary" : "text-secondary hover:bg-layer-transparent-hover"}`}>{translate(section.label)}</NavLink></li>)}
    </ul></nav>}
  </li>;
}

/** Contextual sidebar: its content follows the rail section. Work lists the projects with their menus (a turned-off feature has no entry). */
export function Sidebar({ workspace }: { workspace: Workspace }) {
  const { pathname } = useLocation();
  const section = sectionOf(pathname, workspace.slug);
  const { projectKey } = useParams();
  const { selfId } = useWorkspace();
  // Analytics is for workspace Admins and Members; a Guest gets no entry (the Actions refuse a Guest anyway).
  const { data: members } = useQuery({ queryKey: ["workspace-members", workspace.id], queryFn: async () => await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? [], enabled: section === "work" });
  const canSeeAnalytics = (members ?? []).some((member) => member.userId === selfId && member.role !== "Guest");
  const aiChatId = section === "ai" ? pathname.split("/")[3] ?? "" : "";
  const { data } = useQuery({ queryKey: projectsKey(workspace.id), queryFn: async () => await action<Project[]>("list_projects", { workspaceId: workspace.id, archived: false }) ?? [], enabled: section === "work" || section === "settings" || section === "wiki" });
  const { data: favorites = [] } = useQuery({ queryKey: favoritesKey(workspace.id), queryFn: async () => await action<Array<{ id: string; title: string; projectId: string | null }>>("list_favorite_wiki_pages", { workspaceId: workspace.id }) ?? [], enabled: section === "work" || section === "wiki" });
  return <nav aria-label={translate("shell.sidebar")} className="flex w-64 shrink-0 max-md:w-auto max-md:flex-1 max-md:border-r-0 flex-col gap-0.5 overflow-y-auto border-r border-subtle bg-surface-1 p-2">
    {section === "work" && <>
      <NavLink end to={paths.home(workspace.slug)} className={itemClass}>{translate("nav.home")}</NavLink>
      <NavLink to={paths.workspaceViews(workspace.slug)} className={itemClass}>{translate("views.title")}</NavLink>
      <NavLink to={paths.activeCycles(workspace.slug)} className={itemClass}>{translate("cycles.activeTitle")}</NavLink>
      {canSeeAnalytics && <NavLink to={paths.analytics(workspace.slug)} className={itemClass}>{translate("analytics.title")}</NavLink>}
      <div className="flex items-center justify-between"><p className={heading}>{translate("projects.title")}</p>
        <NavLink to={paths.projects(workspace.slug)} end aria-label={translate("sidebar.allProjects")} title={translate("sidebar.allProjects")} className="mt-2 rounded-md p-1 text-secondary hover:bg-layer-transparent-hover"><Plus aria-hidden size={14} /></NavLink></div>
      <ul className="grid gap-0.5">{(data ?? []).map((project) => <ProjectEntry key={project.id} workspace={workspace} project={project} current={project.key === projectKey} />)}</ul>
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
      <NavLink to={paths.workspaceAgents(workspace.slug)} className={itemClass}>{translate("settings.agents")}</NavLink>
      <NavLink to={paths.workspaceSkills(workspace.slug)} className={itemClass}>{translate("settings.skills")}</NavLink>
      <NavLink to={paths.workspaceExports(workspace.slug)} className={itemClass}>{translate("settings.exports")}</NavLink>
      <NavLink to={paths.workspaceAi(workspace.slug)} className={itemClass}>{translate("aiStatus.title")}</NavLink>
      <p className={heading}>{translate("projects.title")}</p>
      <ul className="grid gap-0.5">{(data ?? []).map((project) => <SettingsProjectEntry key={project.id} workspace={workspace} project={project} current={project.key === projectKey} />)}</ul>
    </>}
  </nav>;
}
