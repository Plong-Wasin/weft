import React from "react";
import { Outlet, useLocation } from "react-router";
import { X } from "lucide-react";
import { translate } from "@weft/shared";
import type { Current, Workspace } from "../types";
import { AppRail } from "./app-rail";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

/** The signed-in shell: top bar over rail + contextual sidebar + routed screen. Below 768px the rail and sidebar live in a drawer. */
export function Shell({ current, workspace, signOut, refresh }: { current: Current; workspace: Workspace; signOut: () => Promise<void>; refresh: () => Promise<void> }) {
  const [drawer, setDrawer] = React.useState(false);
  const { pathname } = useLocation();
  React.useEffect(() => setDrawer(false), [pathname]);
  React.useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);
  return <div className="flex h-screen flex-col bg-canvas text-primary">
    <TopBar current={current} workspace={workspace} signOut={signOut} refresh={refresh} onOpenDrawer={() => setDrawer(true)} />
    <div className="flex min-h-0 flex-1">
      <div className="max-md:hidden"><AppRail workspaceSlug={workspace.slug} /></div>
      <div className="max-md:hidden flex"><Sidebar workspace={workspace} /></div>
      {drawer && <div className="fixed inset-0 z-40 md:hidden">
        <button type="button" aria-label={translate("shell.closeMenu")} onClick={() => setDrawer(false)} className="absolute inset-0 rounded-none bg-backdrop p-0 hover:bg-backdrop" />
        <aside role="dialog" aria-label={translate("shell.sidebar")} className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface-1 shadow-xl">
          <div className="flex items-center justify-end p-1"><button type="button" aria-label={translate("shell.closeMenu")} onClick={() => setDrawer(false)} className="bg-transparent p-1.5 text-secondary hover:bg-layer-transparent-hover"><X aria-hidden size={18} /></button></div>
          <AppRail workspaceSlug={workspace.slug} horizontal />
          <Sidebar workspace={workspace} />
        </aside>
      </div>}
      <main className="min-w-0 flex-1 overflow-y-auto p-[var(--padding-page-x)]"><Outlet /></main>
    </div>
  </div>;
}
