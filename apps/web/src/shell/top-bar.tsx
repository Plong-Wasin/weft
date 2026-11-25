import React from "react";
import { Link } from "react-router";
import { CircleHelp, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { translate } from "@weft/shared";
import { paths } from "../routes";
import { InboxLink } from "../inbox";
import type { Current, Workspace } from "../types";
import { WorkItemSearch } from "../work-item-search";
import { Popover, menuItemClass } from "./popover";
import { ProfileMenu } from "./profile-menu";
import { SidecarToggle } from "../sidecar";
import { AiOnly } from "../ai-flag";
import { CommandPaletteButton } from "../command-palette";
import { formatShortcut, isMacPlatform, openPaletteShortcut } from "../command-palette-model";
import { WorkspaceSwitcher } from "./workspace-switcher";

/** Top bar: workspace switcher, centered search, notifications, help, profile. On phones a button opens the sidebar drawer. */
export function TopBar({ current, workspace, signOut, refresh, onOpenDrawer, sidebarCollapsed, onToggleSidebar, onPeekSidebar }: { current: Current; workspace: Workspace; signOut: () => Promise<void>; refresh: () => Promise<void>; onOpenDrawer: () => void; sidebarCollapsed: boolean; onToggleSidebar: () => void; onPeekSidebar: (peek: boolean) => void }) {
  return <header className="relative z-20 flex h-header shrink-0 items-center gap-3 border-b border-subtle bg-surface-1 px-4 max-md:gap-2 max-md:px-3">
    <button type="button" aria-label={translate("shell.openMenu")} onClick={onOpenDrawer} className="inset-row-hover min-h-11 min-w-11 rounded-lg bg-transparent p-2.5 text-secondary md:hidden"><Menu aria-hidden size={18} /></button>
    <button type="button" aria-label={translate(sidebarCollapsed ? "shell.expandSidebar" : "shell.collapseSidebar")} title={`${translate(sidebarCollapsed ? "shell.expandSidebar" : "shell.collapseSidebar")} (Ctrl/⌘+\\)`} aria-expanded={!sidebarCollapsed} aria-controls="desktop-sidebar" onFocus={() => { if (sidebarCollapsed) onPeekSidebar(true); }} onBlur={() => { if (sidebarCollapsed) onPeekSidebar(false); }} onClick={onToggleSidebar} className="inset-row-hover hidden rounded-lg bg-transparent p-2 text-secondary md:inline-flex">
      {sidebarCollapsed ? <PanelLeftOpen aria-hidden size={18} /> : <PanelLeftClose aria-hidden size={18} />}
    </button>
    <WorkspaceSwitcher workspace={workspace} workspaces={current.workspaces} canCreate={current.canCreateWorkspace} refresh={refresh} />
    <div className="flex min-w-0 flex-1 justify-center px-2 max-md:justify-end max-md:px-0"><WorkItemSearch workspace={workspace} /></div>
    {/* Phones have no Ctrl K and no room in the bar; the drawer offers the palette there. */}
    <div className="flex max-md:hidden"><CommandPaletteButton shortcut={formatShortcut(openPaletteShortcut.keys, isMacPlatform(navigator.userAgent))} /></div>
    <AiOnly><SidecarToggle /></AiOnly>
    <InboxLink workspace={workspace} />
    <Popover label={translate("topbar.help")} align="right" trigger={<CircleHelp aria-hidden size={18} />}>
      {(close) => <>
        <AiOnly><Link role="menuitem" to={paths.ai(workspace.slug)} onClick={close} className={menuItemClass}>{translate("topbar.helpAskAi")}</Link></AiOnly>
        <Link role="menuitem" to={paths.wiki(workspace.slug)} onClick={close} className={menuItemClass}>{translate("topbar.helpWiki")}</Link>
      </>}
    </Popover>
    <ProfileMenu user={current.user} signOut={signOut} />
  </header>;
}
