import React from "react";
import { Link } from "react-router";
import { CircleHelp, Menu } from "lucide-react";
import { translate } from "@weft/shared";
import { InboxLink } from "../inbox";
import { paths } from "../routes";
import type { Current, Workspace } from "../types";
import { WorkItemSearch } from "../work-item-search";
import { Brand } from "./brand";
import { Popover, menuItemClass } from "./popover";
import { ProfileMenu } from "./profile-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";

/** Top bar: workspace switcher, centered search, notifications, help, profile. On phones a button opens the sidebar drawer. */
export function TopBar({ current, workspace, signOut, refresh, onOpenDrawer }: { current: Current; workspace: Workspace; signOut: () => Promise<void>; refresh: () => Promise<void>; onOpenDrawer: () => void }) {
  return <header className="relative z-20 flex h-header shrink-0 items-center gap-2 border-b border-subtle bg-surface-1 px-3">
    <button type="button" aria-label={translate("shell.openMenu")} onClick={onOpenDrawer} className="rounded-md bg-transparent p-1.5 text-secondary hover:bg-layer-transparent-hover md:hidden"><Menu aria-hidden size={18} /></button>
    <Link to={paths.home(workspace.slug)} className="max-md:hidden" aria-label={translate("app.title")}><Brand /></Link>
    <WorkspaceSwitcher workspace={workspace} workspaces={current.workspaces} canCreate={current.canCreateWorkspace} refresh={refresh} />
    <div className="flex flex-1 justify-center px-2"><WorkItemSearch workspace={workspace} /></div>
    <InboxLink workspace={workspace} />
    <Popover label={translate("topbar.help")} align="right" trigger={<CircleHelp aria-hidden size={18} />}>
      {(close) => <>
        <Link role="menuitem" to={paths.ai(workspace.slug)} onClick={close} className={menuItemClass}>{translate("topbar.helpAskAi")}</Link>
        <Link role="menuitem" to={paths.wiki(workspace.slug)} onClick={close} className={menuItemClass}>{translate("topbar.helpWiki")}</Link>
      </>}
    </Popover>
    <ProfileMenu user={current.user} signOut={signOut} />
  </header>;
}
