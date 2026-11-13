import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Star } from "lucide-react";
import { translate } from "@weft/shared";
import { action } from "../../api";
import { projectsKey } from "../../shell/sidebar";
import { moveWithinGroup, sortProjects, useProjectPreferences } from "../../shell/project-preferences";
import { useWorkspace } from "../../layouts/workspace-layout";
import type { Project } from "../../types";
import { Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

/**
 * Project stars and order without dragging, for phones. It lists the projects in the order the sidebar shows them, and each row
 * has labelled buttons for the same changes the sidebar offers.
 */
export function WorkspaceProjectOrder() {
  const { workspace } = useWorkspace();
  const { data: projects = [] } = useQuery({
    queryKey: projectsKey(workspace.id),
    queryFn: async () => await action<Project[]>("list_projects", { workspaceId: workspace.id, archived: false }) ?? [],
  });
  const { prefs, setPreference, setOrder, resetOrder } = useProjectPreferences(workspace.id);
  const { starred, others } = sortProjects(projects, prefs);
  const rows = [...starred.map((project) => ({ project, isStarred: true })), ...others.map((project) => ({ project, isStarred: false }))];
  const orderedWithinGroup = (projectId: string) => {
    const group = starred.some((project) => project.id === projectId) ? starred : others;
    return group.findIndex((project) => project.id === projectId);
  };
  const hasOrder = prefs.some((pref) => pref.position !== null);

  return <section>
    <SettingsHeader title={translate("settings.projectOrder")} description={translate("settings.projectOrderDesc")} />
    <SettingsBlock>
      {rows.length === 0 ? <p className="text-secondary">{translate("projects.empty")}</p> : <RowList>{rows.map(({ project, isStarred }) => {
        const index = orderedWithinGroup(project.id);
        const count = isStarred ? starred.length : others.length;
        const starLabel = translate(isStarred ? "sidebar.unstar" : "sidebar.star");
        return <Row key={project.id}>
          <span className="w-full text-14 font-medium"><span className="font-code text-12 text-tertiary">{project.key}</span> · {project.name}</span>
          <div className="flex w-full flex-wrap gap-2">
            <button type="button" aria-pressed={isStarred} aria-label={`${starLabel}: ${project.name}`} title={starLabel} onClick={() => void setPreference(project.id, { starred: !isStarred })} className="secondary inline-flex items-center gap-1.5">
              <Star aria-hidden size={14} fill={isStarred ? "currentColor" : "none"} />{isStarred ? translate("sidebar.starred") : translate("sidebar.star")}
            </button>
            <button type="button" disabled={index <= 0} aria-label={`${translate("sidebar.moveUp")}: ${project.name}`} onClick={() => { const order = moveWithinGroup(projects, prefs, project.id, -1); if (order) void setOrder(order); }} className="secondary inline-flex items-center gap-1.5">
              <ArrowUp aria-hidden size={14} />{translate("sidebar.moveUp")}
            </button>
            <button type="button" disabled={index >= count - 1} aria-label={`${translate("sidebar.moveDown")}: ${project.name}`} onClick={() => { const order = moveWithinGroup(projects, prefs, project.id, 1); if (order) void setOrder(order); }} className="secondary inline-flex items-center gap-1.5">
              <ArrowDown aria-hidden size={14} />{translate("sidebar.moveDown")}
            </button>
          </div>
        </Row>;
      })}</RowList>}
      {hasOrder && <button type="button" title={translate("sidebar.resetOrderTip")} onClick={() => void resetOrder()} className="secondary justify-self-start">{translate("sidebar.resetOrder")}</button>}
    </SettingsBlock>
  </section>;
}
