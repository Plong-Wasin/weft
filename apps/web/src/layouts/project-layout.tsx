import React from "react";
import { Link, Outlet, useOutletContext, useParams } from "react-router";
import { translate } from "@weft/shared";
import { action } from "../api";
import { useQueryClient } from "@tanstack/react-query";
import { projectsKey } from "../shell/sidebar";
import { paths } from "../routes";
import type { Project } from "../types";
import { useWorkspace } from "./workspace-layout";

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

/** Project shell: loads the project by key, shows its header and menu, and renders the routed project screen. */
export function ProjectLayout() {
  const { workspace } = useWorkspace();
  const { project, reload } = useRouteProject();
  if (project === undefined) return null;
  if (project === null) return <section><p role="alert">{translate("projects.notFound")}</p><Link to={paths.home(workspace.slug)}>{translate("projects.back")}</Link></section>;
  return <section className="grid gap-4">
    <header className="flex items-center gap-3">
      <Link to={paths.home(workspace.slug)}>{translate("projects.back")}</Link>
      <h2 className="text-20 font-semibold">{project.key} · {project.name}</h2>
      <Link to={paths.projectSettings(workspace.slug, project.key)}>{translate("projects.settings")}</Link>
    </header>
    <Outlet context={{ project, reload } satisfies ProjectContext} />
  </section>;
}
