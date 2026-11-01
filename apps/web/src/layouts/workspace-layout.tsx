import React from "react";
import { useParams } from "react-router";
import type { Workspace } from "../types";
import { Shell } from "../shell/shell-layout";
import { WorkspaceChooser, useRoot } from "./root-layout";

const WorkspaceContext = React.createContext<{ workspace: Workspace; selfId: string } | null>(null);
export function useWorkspace() {
  const value = React.useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace outside a workspace route");
  return value;
}

/** Workspace route: provides the workspace and renders the shell around the routed screen. An unknown workspace slug shows the chooser instead. */
export function WorkspaceLayout() {
  const { current, languageSwitch, signOut, refresh } = useRoot();
  const { workspaceSlug = "" } = useParams();
  const workspace = current.workspaces.find((item) => item.slug === workspaceSlug);
  if (!workspace) return <WorkspaceChooser current={current} languageSwitch={languageSwitch} signOut={signOut} refresh={refresh} />;
  return <WorkspaceContext.Provider value={{ workspace, selfId: current.user.id }}>
    <Shell current={current} workspace={workspace} signOut={signOut} refresh={refresh} />
  </WorkspaceContext.Provider>;
}
