import { action, actionResult } from "../api";
import { ActiveCyclesPage, CycleDetailPage, CyclesPage } from "../cycles";
import { IntakePage } from "../intake";
import { useProject } from "../layouts/project-layout";
import { useWorkspace } from "../layouts/workspace-layout";
import { ProjectPagesPage, WikiPageScreen } from "../wiki";
import { ModuleDetailPage, ModulesPage } from "../modules";
import { useParams } from "react-router";
import { ViewDetailPage, ViewsPage } from "../views";
import { canDecideIntake } from "../intake-permissions";
import { projectFeaturePermissions } from "../project-feature-permissions";
import { useWorkspaceRole } from "../workspace-role";

/** The props every project feature screen takes: where it lives and what the caller may do there. */
function useShared(feature: "cycles" | "modules") {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  const workspaceRole = useWorkspaceRole();
  return { workspaceId: workspace.id, workspaceSlug: workspace.slug, projectKey: project.key, projectId: project.id, ...projectFeaturePermissions(workspaceRole, project.role, project.archived), enabled: project.features[feature], action, run: actionResult };
}

export function ProjectCyclesRoute() { return <CyclesPage {...useShared("cycles")} />; }
export function ProjectCycleRoute() { const { cycleId = "" } = useParams(); return <CycleDetailPage {...useShared("cycles")} cycleId={cycleId} />; }
export function ProjectModulesRoute() { return <ModulesPage {...useShared("modules")} />; }
export function ProjectModuleRoute() { const { moduleId = "" } = useParams(); return <ModuleDetailPage {...useShared("modules")} moduleId={moduleId} />; }

export function ProjectIntakeRoute() {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  const workspaceRole = useWorkspaceRole();
  return <IntakePage workspaceId={workspace.id} workspaceSlug={workspace.slug} projectKey={project.key} projectId={project.id} canDecide={canDecideIntake(workspaceRole, project.role)} canAdmin={project.role === "Admin"} enabled={project.features.intake} action={action} />;
}

export function ProjectPagesRoute() { const { workspace } = useWorkspace(); const { project } = useProject(); return <ProjectPagesPage workspace={workspace} project={project} canWrite={project.role !== "Guest"} />; }
export function ProjectPageRoute() { const { workspace, selfId } = useWorkspace(); const { project } = useProject(); const { pageId = "" } = useParams(); return <WikiPageScreen workspace={workspace} self={selfId} pageId={pageId} projectKey={project.key} />; }

export function ProjectViewsRoute() { const { workspace, selfId } = useWorkspace(); const { project } = useProject(); return <ViewsPage workspaceSlug={workspace.slug} project={project} selfId={selfId} />; }
export function ProjectViewRoute() { const { workspace, selfId } = useWorkspace(); const { project } = useProject(); const { viewId = "" } = useParams(); return <ViewDetailPage workspaceSlug={workspace.slug} project={project} selfId={selfId} viewId={viewId} />; }
export function ActiveCyclesRoute() { const { workspace } = useWorkspace(); return <ActiveCyclesPage workspaceId={workspace.id} workspaceSlug={workspace.slug} action={action} />; }
