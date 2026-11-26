import React from "react";
import { Link, Outlet, useMatch, useOutletContext, useParams } from "react-router";
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
  if (project === undefined) return null;
  if (project === null) return <section><p role="alert">{translate("projects.notFound")}</p><Link to={paths.home(workspace.slug)}>{translate("projects.back")}</Link></section>;
  if (onPage) return <section className="grid min-w-0 gap-4"><Outlet context={{ project, reload } satisfies ProjectContext} /></section>;
  return <section className="grid min-w-0 gap-4">
    <PageHeader title={<span className="[overflow-wrap:anywhere]">{project.key} · {project.name}</span>} breadcrumb={<><Link to={paths.home(workspace.slug)} className="text-muted-foreground hover:text-foreground">{translate("projects.back")}</Link><span className="text-muted-foreground" aria-hidden>›</span></>} actions={<Link to={paths.projectSettings(workspace.slug, project.key)} className="secondary no-underline">{translate("projects.settings")}</Link>} />
    <Outlet context={{ project, reload } satisfies ProjectContext} />
  </section>;
}
