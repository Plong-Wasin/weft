import React from "react";
import { action, actionResult } from "../api";
import { useProject } from "../layouts/project-layout";
import { useWorkspace } from "../layouts/workspace-layout";
import { WorkItemLayouts } from "../work-item-layouts";

export function ProjectWorkItems() {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  return <section>
    <WorkItemLayouts projectId={project.id} workspaceSlug={workspace.slug} action={action} run={actionResult} refreshKey={0} cyclesEnabled={project.features.cycles} modulesEnabled={project.features.modules} canWrite={project.role !== "Guest"} canCreate />
  </section>;
}
