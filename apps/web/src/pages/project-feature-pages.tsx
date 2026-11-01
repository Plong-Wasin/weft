import React from "react";
import { action, actionResult } from "../api";
import { CycleDetailPage, CyclesPage } from "../cycles";
import { IntakePage } from "../intake";
import { useProject } from "../layouts/project-layout";
import { useWorkspace } from "../layouts/workspace-layout";
import { ProjectPagesPage, WikiPageScreen } from "../wiki";
import { ModuleDetailPage, ModulesPage } from "../modules";
import { useParams } from "react-router";

/** The props every project feature screen takes: where it lives and what the caller may do there. */
function useShared(feature: "cycles" | "modules") {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  return { workspaceSlug: workspace.slug, projectKey: project.key, projectId: project.id, canWrite: project.role !== "Guest", canAdmin: project.role === "Admin" || project.role === null, enabled: project.features[feature], action, run: actionResult };
}

export function ProjectCyclesRoute() { return <CyclesPage {...useShared("cycles")} />; }
export function ProjectCycleRoute() { const { cycleId = "" } = useParams(); return <CycleDetailPage {...useShared("cycles")} cycleId={cycleId} />; }
export function ProjectModulesRoute() { return <ModulesPage {...useShared("modules")} />; }
export function ProjectModuleRoute() { const { moduleId = "" } = useParams(); return <ModuleDetailPage {...useShared("modules")} moduleId={moduleId} />; }

export function ProjectIntakeRoute() {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  return <IntakePage workspaceId={workspace.id} workspaceSlug={workspace.slug} projectKey={project.key} projectId={project.id} canDecide={project.role !== "Guest"} enabled={project.features.intake} action={action} />;
}

export function ProjectPagesRoute() { const { workspace } = useWorkspace(); const { project } = useProject(); return <ProjectPagesPage workspace={workspace} project={project} canWrite={project.role !== "Guest"} />; }
export function ProjectPageRoute() { const { workspace, selfId } = useWorkspace(); const { project } = useProject(); const { pageId = "" } = useParams(); return <WikiPageScreen workspace={workspace} self={selfId} pageId={pageId} projectKey={project.key} />; }
