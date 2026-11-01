import React from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import { Bot, BookOpen, Folder, Home, LogOut, Settings } from "lucide-react";
import { translate } from "@weft/shared";
import { InboxLink } from "../inbox";
import { paths } from "../routes";
import type { Workspace } from "../types";
import { WorkItemSearch } from "../work-item-search";
import { WorkspaceChooser, useRoot } from "./root-layout";

const WorkspaceContext = React.createContext<{ workspace: Workspace; selfId: string } | null>(null);
export function useWorkspace() {
  const value = React.useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace outside a workspace route");
  return value;
}

const navClass = ({ isActive }: { isActive: boolean }) => `flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-14 font-medium ${isActive ? "bg-layer-1-selected text-primary" : "text-secondary hover:bg-layer-1-hover"}`;

/** Workspace shell: header, section links, and the routed screen. An unknown workspace slug shows the chooser instead. */
export function WorkspaceLayout() {
  const { current, languageSwitch, themeSwitch, signOut, refresh } = useRoot();
  const { workspaceSlug = "" } = useParams();
  const navigate = useNavigate();
  const workspace = current.workspaces.find((item) => item.slug === workspaceSlug);
  if (!workspace) return <WorkspaceChooser current={current} languageSwitch={languageSwitch} signOut={signOut} refresh={refresh} />;
  return <WorkspaceContext.Provider value={{ workspace, selfId: current.user.id }}>
    <div className="min-h-screen bg-canvas text-primary">
      <header className="flex min-h-header flex-wrap items-center gap-3 border-b border-subtle bg-surface-1 px-4 py-2">
        <h1 className="text-18 font-semibold">{workspace.name}</h1>
        <WorkItemSearch workspace={workspace} />
        {languageSwitch}{themeSwitch}
        <button className="secondary flex items-center gap-1.5" onClick={() => void signOut()}><LogOut aria-hidden size={14} />{translate("auth.signOut")}</button>
      </header>
      <div className="flex flex-col md:flex-row">
        <nav aria-label={translate("nav.label")} className="flex gap-1 border-b border-subtle bg-surface-1 p-2 md:w-52 md:flex-col md:border-b-0 md:border-r">
          <NavLink end to={paths.home(workspace.slug)} className={navClass}><Home aria-hidden size={16} />{translate("nav.home")}</NavLink>
          <NavLink to={paths.projects(workspace.slug)} className={navClass}><Folder aria-hidden size={16} />{translate("projects.title")}</NavLink>
          <NavLink to={paths.wiki(workspace.slug)} className={navClass}><BookOpen aria-hidden size={16} />{translate("wiki.title")}</NavLink>
          <NavLink to={paths.ai(workspace.slug)} className={navClass}><Bot aria-hidden size={16} />{translate("ai.title")}</NavLink>
          <InboxLink workspace={workspace} />
          <NavLink to={paths.workspaceSettings(workspace.slug)} className={navClass}><Settings aria-hidden size={16} />{translate("nav.settings")}</NavLink>
          {current.workspaces.length > 1 && <label className="grid gap-1 px-2.5 py-1.5 text-12 text-secondary">{translate("workspace.switch")}
            <select value={workspace.slug} onChange={(event) => navigate(paths.home(event.target.value))}>
              {current.workspaces.map((item) => <option value={item.slug} key={item.id}>{item.name}</option>)}
            </select></label>}
        </nav>
        <main className="min-w-0 flex-1 p-[var(--padding-page-x)]"><Outlet /></main>
      </div>
    </div>
  </WorkspaceContext.Provider>;
}
