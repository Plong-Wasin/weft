import React from "react";
import { Outlet, useLocation } from "react-router";
import { Command, X } from "lucide-react";
import { translate } from "@weft/shared";
import type { Current, Workspace } from "../types";
import { AppRail } from "./app-rail";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { SidecarDock, SidecarProvider } from "../sidecar";
import { openPaletteEvent } from "../command-palette";

/** The signed-in shell: top bar over rail + contextual sidebar + routed screen. Below 768px the rail and sidebar live in a drawer. */
export function Shell({ current, workspace, signOut, refresh }: { current: Current; workspace: Workspace; signOut: () => Promise<void>; refresh: () => Promise<void> }) {
  const [drawer, setDrawer] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => {
    try { return localStorage.getItem("weft:desktop-sidebar-collapsed") === "true"; } catch { return false; }
  });
  const [sidebarPeek, setSidebarPeek] = React.useState(false);
  const { pathname } = useLocation();
  React.useEffect(() => setDrawer(false), [pathname]);
  React.useEffect(() => {
    try { localStorage.setItem("weft:desktop-sidebar-collapsed", String(sidebarCollapsed)); } catch { /* Storage may be unavailable. */ }
  }, [sidebarCollapsed]);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "\\" || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      setSidebarCollapsed((value) => !value);
      setSidebarPeek(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  React.useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);
  return <SidecarProvider workspace={workspace} userId={current.user.id}><div className="flex h-screen flex-col bg-canvas text-primary">
    <a href="#main-content" className="skip-link rounded-md bg-accent-primary px-3 py-1.5 text-14 font-medium text-on-color">{translate("shell.skipToMain")}</a>
    <TopBar current={current} workspace={workspace} signOut={signOut} refresh={refresh} onOpenDrawer={() => setDrawer(true)} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => { setSidebarCollapsed((value) => !value); setSidebarPeek(false); }} onPeekSidebar={setSidebarPeek} />
    <div className="flex min-h-0 flex-1">
      <div className="max-md:hidden"><AppRail workspaceSlug={workspace.slug} /></div>
      <div className={`relative z-10 hidden shrink-0 transition-[width] duration-200 md:block ${sidebarCollapsed ? "w-0" : "w-64"}`} onPointerEnter={() => { if (sidebarCollapsed) setSidebarPeek(true); }} onPointerLeave={() => setSidebarPeek(false)} onFocusCapture={() => { if (sidebarCollapsed) setSidebarPeek(true); }} onBlurCapture={(event) => { if (sidebarCollapsed && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSidebarPeek(false); }}>
        {sidebarCollapsed && <div aria-hidden className="absolute inset-y-0 -left-2 z-20 w-3" />}
        <div id="desktop-sidebar" inert={sidebarCollapsed && !sidebarPeek} style={sidebarCollapsed && !sidebarPeek ? { transform: "translateX(calc(-100% - 4rem))" } : undefined} className={`absolute inset-y-0 left-0 flex w-64 transition-transform duration-200 ${sidebarCollapsed && !sidebarPeek ? "pointer-events-none" : "translate-x-0"}`}>
          <Sidebar workspace={workspace} />
        </div>
      </div>
      {drawer && <div className="fixed inset-0 z-40 md:hidden">
        <button type="button" aria-label={translate("shell.closeMenu")} onClick={() => setDrawer(false)} className="absolute inset-0 rounded-none bg-backdrop p-0 hover:bg-backdrop" />
        <aside role="dialog" aria-label={translate("shell.sidebar")} className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface-1 shadow-xl">
          <div className="flex items-center justify-end p-1"><button type="button" aria-label={translate("shell.closeMenu")} onClick={() => setDrawer(false)} className="bg-transparent p-1.5 text-secondary hover:bg-layer-transparent-hover"><X aria-hidden size={18} /></button></div>
          <AppRail workspaceSlug={workspace.slug} horizontal />
          <button type="button" onClick={() => { setDrawer(false); window.dispatchEvent(new Event(openPaletteEvent)); }} className="mx-2 mt-1 flex items-center gap-2 rounded-md bg-transparent px-2.5 py-2 text-left text-14 text-primary hover:bg-layer-transparent-hover"><Command aria-hidden size={16} />{translate("palette.menuLabel")}</button>
          <Sidebar workspace={workspace} />
        </aside>
      </div>}
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none overflow-y-auto p-[var(--padding-page-x)]"><Outlet /></main>
      <SidecarDock />
    </div>
  </div></SidecarProvider>;
}
