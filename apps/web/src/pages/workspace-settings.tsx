import { Link, NavLink, Outlet } from "react-router";
import { translate } from "@weft/shared";
import { useWorkspace } from "../layouts/workspace-layout";
import { paths } from "../routes";

const tab = ({ isActive }: { isActive: boolean }) => `border-b-2 px-3 py-2 text-14 font-medium ${isActive ? "border-accent-strong text-accent-text" : "border-transparent text-secondary"}`;

/** Workspace settings shell: General and Members tabs. */
export function WorkspaceSettings() {
  const { workspace } = useWorkspace();
  return <section className="grid gap-4">
    <h2 className="text-20 font-semibold">{translate("settings.workspaceTitle")}</h2>
    <nav aria-label={translate("settings.label")} className="flex border-b border-subtle">
      <NavLink end to={paths.workspaceSettings(workspace.slug)} className={tab}>{translate("settings.general")}</NavLink>
      <NavLink to={paths.workspaceMembers(workspace.slug)} className={tab}>{translate("members.title")}</NavLink>
    </nav>
    <Outlet />
  </section>;
}

export function WorkspaceGeneral() {
  const { workspace } = useWorkspace();
  return <section><p>{workspace.name}</p><p className="text-secondary">{workspace.slug}</p><Link to={paths.workspaceMembers(workspace.slug)}>{translate("members.title")}</Link></section>;
}
