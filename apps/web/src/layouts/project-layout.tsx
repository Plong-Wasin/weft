import React from "react";
import { Link, Outlet, useMatch, useOutletContext, useParams } from "react-router";
import { ArrowLeft, Ellipsis } from "lucide-react";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { translate } from "@weft/shared";
import { action } from "../api";
import { useQueryClient } from "@tanstack/react-query";
import { projectsKey } from "../shell/sidebar";
import { paths } from "../routes";
import type { Project } from "../types";
import { useWorkspace } from "./workspace-layout";
import { PageHeader } from "../shell/page-header";

export type ProjectContext = { project: Project; reload: () => Promise<void> };
export const useProject = () => useOutletContext<ProjectContext>();

/** Loads the project addressed by the `:projectKey` route param. `reload` also refreshes the sidebar's project list, so a feature toggle shows in the menus at once. undefined = loading, null = not found. */
export function useRouteProject() {
  const { workspace } = useWorkspace();
  const { projectKey = "" } = useParams();
  const client = useQueryClient();
  const [project, setProject] = React.useState<Project | null | undefined>(undefined);
  const reload = React.useCallback(async () => {
    setProject(await action<Project>("get_project", { workspaceId: workspace.id, key: projectKey }));
    await client.invalidateQueries({ queryKey: projectsKey(workspace.id) });
  }, [workspace.id, projectKey, client]);
  React.useEffect(() => { setProject(undefined); void reload(); }, [reload]);
  return { project, reload };
}

/**
 * Project shell: loads the project by key, shows its header and menu, and renders the routed project screen.
 * Heading rule: exactly one h1 per route. Every route under this shell takes the project title below as its h1, so the screens it renders start their own titles at h2.
 * Project Settings is a separate route (ProjectSettingsLayout) and carries its own single h1 in SettingsHeader.
 * A Page (`pages/:pageId`) has no project header: its own breadcrumb leads back to the project's Pages, so the editor shows one breadcrumb and no Settings button.
 */
export function ProjectLayout() {
  const { workspace } = useWorkspace();
  const { project, reload } = useRouteProject();
  const onPage = useMatch("/:workspaceSlug/projects/:projectKey/pages/:pageId") !== null;
  const onWorkItems = useMatch("/:workspaceSlug/projects/:projectKey/issues") !== null;
  if (project === undefined) return null;
  if (project === null) return <section><p role="alert">{translate("projects.notFound")}</p><Link to={paths.home(workspace.slug)}>{translate("projects.back")}</Link></section>;
  if (onPage) return <section className="grid min-w-0 gap-4"><Outlet context={{ project, reload } satisfies ProjectContext} /></section>;
  const projectTitle = `${project.key} · ${project.name}`;
  const settingsPath = paths.projectSettings(workspace.slug, project.key);
  return <section className="grid min-w-0 gap-4 phone-layout:gap-1">
    <PageHeader className="phone-layout:flex-nowrap phone-layout:gap-2 phone-layout:[&>div:first-child]:shrink-0 phone-layout:[&>div:first-child]:basis-auto phone-layout:[&>h1]:text-base"
      title={<span title={projectTitle} className="[overflow-wrap:anywhere] phone-layout:truncate">{projectTitle}</span>}
      breadcrumb={<><Link to={paths.home(workspace.slug)} aria-label={translate("projects.back")} title={translate("projects.back")} className="text-muted-foreground hover:text-foreground phone-layout:inline-flex phone-layout:size-11 phone-layout:items-center phone-layout:justify-center"><ArrowLeft aria-hidden size={18} className="hidden phone-layout:block" /><span className="phone-layout:hidden">{translate("projects.back")}</span></Link><span className="text-muted-foreground phone-layout:hidden" aria-hidden>›</span></>}
      actions={onWorkItems ? undefined : <>
        <Link to={settingsPath} className="rounded-lg border border-border bg-card px-3 py-1.5 text-14 font-medium text-foreground no-underline hover:bg-accent phone-layout:hidden">{translate("projects.settings")}</Link>
        <div className="hidden phone-layout:block">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="ghost" />} aria-label={translate("projects.settingsTitle")} className="size-11 shrink-0">
              <Ellipsis aria-hidden size={18} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<Link to={settingsPath} />} className="min-h-11">{translate("projects.settings")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </>} />
    <Outlet context={{ project, reload } satisfies ProjectContext} />
  </section>;
}
