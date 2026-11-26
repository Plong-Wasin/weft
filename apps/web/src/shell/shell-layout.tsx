import { Button } from "@/ui/button";
import React from "react";
import { Outlet, useLocation } from "react-router";
import { Command } from "lucide-react";
import { translate } from "@weft/shared";
import type { Current, Workspace } from "../types";
import { AppRail } from "./app-rail";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { SidecarDock, SidecarProvider } from "../sidecar";
import { openPaletteEvent } from "../command-palette";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";

/** The signed-in shell: top bar over rail + contextual sidebar + routed screen. Below 768px the rail and sidebar live in a drawer. */
const compactQuery = "(max-width: 1099px)";
/** Only the user's own choice is stored; the width-driven collapse is derived from the viewport, so widening the window restores the sidebar. */
const sidebarPreferenceKey = "weft:desktop-sidebar-preference";
function storedSidebarCollapsed() {
  try { return localStorage.getItem(sidebarPreferenceKey) === "true"; } catch { return false; }
}
export function Shell({ current, workspace, signOut, refresh }: { current: Current; workspace: Workspace; signOut: () => Promise<void>; refresh: () => Promise<void> }) {
  const [drawer, setDrawer] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => {
    try { return window.matchMedia(compactQuery).matches || storedSidebarCollapsed(); } catch { return false; }
  });
  const [sidebarPeek, setSidebarPeek] = React.useState(false);
  const { pathname } = useLocation();
  React.useEffect(() => setDrawer(false), [pathname]);
  React.useEffect(() => {
    const compact = window.matchMedia(compactQuery);
    const followWidth = () => setSidebarCollapsed(compact.matches || storedSidebarCollapsed());
    compact.addEventListener("change", followWidth);
    return () => compact.removeEventListener("change", followWidth);
  }, []);
  const toggleSidebarRef = React.useRef<() => void>(() => {});
  toggleSidebarRef.current = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    setSidebarPeek(false);
    try { localStorage.setItem(sidebarPreferenceKey, String(next)); } catch { /* Storage may be unavailable. */ }
  };
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "\\" || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      toggleSidebarRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return <SidecarProvider workspace={workspace} userId={current.user.id}><div className="flex h-dvh flex-col bg-background text-foreground">
    <a href="#main-content" className="skip-link rounded-md bg-primary px-3 py-1.5 text-[14px] font-medium text-primary-foreground">{translate("shell.skipToMain")}</a>
    <TopBar current={current} workspace={workspace} signOut={signOut} refresh={refresh} onOpenDrawer={() => setDrawer(true)} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => toggleSidebarRef.current()} onPeekSidebar={setSidebarPeek} />
    <div className="flex min-h-0 flex-1">
      <div className="max-md:hidden"><AppRail workspaceSlug={workspace.slug} /></div>
      <div className={`relative z-10 hidden shrink-0 transition-[width] duration-200 md:block ${sidebarCollapsed ? "w-0" : "w-64"}`} onPointerEnter={() => { if (sidebarCollapsed) setSidebarPeek(true); }} onPointerLeave={() => setSidebarPeek(false)} onFocusCapture={() => { if (sidebarCollapsed) setSidebarPeek(true); }} onBlurCapture={(event) => { if (sidebarCollapsed && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSidebarPeek(false); }}>
        {sidebarCollapsed && <div aria-hidden className="absolute inset-y-0 -left-2 z-20 w-3" />}
        <div id="desktop-sidebar" inert={sidebarCollapsed && !sidebarPeek} style={sidebarCollapsed && !sidebarPeek ? { transform: "translateX(calc(-100% - 4rem))" } : undefined} className={`absolute inset-y-0 left-0 flex w-64 transition-transform duration-200 ${sidebarCollapsed && !sidebarPeek ? "pointer-events-none" : "translate-x-0"}`}>
          <Sidebar workspace={workspace} />
        </div>
      </div>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" closeLabel={translate("shell.closeMenu")} aria-label={translate("shell.sidebar")} className="md:hidden">
          <SheetTitle className="sr-only">{translate("shell.sidebar")}</SheetTitle>
          <AppRail workspaceSlug={workspace.slug} horizontal />
          <Button type="button" onClick={() => { setDrawer(false); window.dispatchEvent(new Event(openPaletteEvent)); }} className="transition-colors hover:bg-accent mx-3 mt-2 flex min-h-11 items-center gap-2 rounded-lg bg-transparent px-3 text-left text-[14px] text-foreground"><Command aria-hidden size={16} />{translate("palette.menuLabel")}</Button>
          <Sidebar workspace={workspace} />
        </SheetContent>
      </Sheet>
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none overflow-y-auto p-[var(--padding-page-x)]"><div className="mx-auto w-full min-w-0 max-w-[1440px]"><Outlet /></div></main>
      <SidecarDock />
    </div>
  </div></SidecarProvider>;
}
