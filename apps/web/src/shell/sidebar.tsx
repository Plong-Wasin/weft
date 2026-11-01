import React from "react";
import { NavLink, useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, Plus } from "lucide-react";
import { translate } from "@weft/shared";
import { action } from "../api";
import { ProjectNav } from "../project-nav";
import { paths } from "../routes";
import type { Project, Workspace } from "../types";
import { AiSidebar } from "../ai-chat";
import { sectionOf } from "./app-rail";

export const projectsKey = (workspaceId: string) => ["projects", workspaceId] as const;

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

/** Contextual sidebar: its content follows the rail section. Work lists the projects with their menus (a turned-off feature has no entry). */
export function Sidebar({ workspace }: { workspace: Workspace }) {
  const { pathname } = useLocation();
  const section = sectionOf(pathname, workspace.slug);
  const { projectKey } = useParams();
  const aiChatId = section === "ai" ? pathname.split("/")[3] ?? "" : "";
  const { data } = useQuery({ queryKey: projectsKey(workspace.id), queryFn: async () => await action<Project[]>("list_projects", { workspaceId: workspace.id, archived: false }) ?? [], enabled: section === "work" });
  return <nav aria-label={translate("shell.sidebar")} className="flex w-64 shrink-0 max-md:w-auto max-md:flex-1 max-md:border-r-0 flex-col gap-0.5 overflow-y-auto border-r border-subtle bg-surface-1 p-2">
    {section === "work" && <>
      <NavLink end to={paths.home(workspace.slug)} className={itemClass}>{translate("nav.home")}</NavLink>
      <div className="flex items-center justify-between"><p className={heading}>{translate("projects.title")}</p>
        <NavLink to={paths.projects(workspace.slug)} end aria-label={translate("sidebar.allProjects")} title={translate("sidebar.allProjects")} className="mt-2 rounded-md p-1 text-secondary hover:bg-layer-transparent-hover"><Plus aria-hidden size={14} /></NavLink></div>
      <ul className="grid gap-0.5">{(data ?? []).map((project) => <ProjectEntry key={project.id} workspace={workspace} project={project} current={project.key === projectKey} />)}</ul>
    </>}
    {section === "wiki" && <NavLink end to={paths.wiki(workspace.slug)} className={itemClass}>{translate("sidebar.allPages")}</NavLink>}
    {section === "ai" && <AiSidebar workspace={workspace} activeId={aiChatId} />}
    {section === "settings" && <>
      <p className={heading}>{translate("sidebar.workspace")}</p>
      <NavLink end to={paths.workspaceSettings(workspace.slug)} className={itemClass}>{translate("settings.general")}</NavLink>
      <NavLink to={paths.workspaceMembers(workspace.slug)} className={itemClass}>{translate("members.title")}</NavLink>
    </>}
  </nav>;
}
