import React from "react";
import { Plus } from "lucide-react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../api";
import { useProject } from "../layouts/project-layout";
import { useWorkspace } from "../layouts/workspace-layout";
import { CreateWorkItemModal } from "../create-work-item-modal";
import { WorkItemLayouts } from "../work-item-layouts";
import { SaveAsViewButton } from "../views";

export function ProjectWorkItems() {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  const [creating, setCreating] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const canWrite = project.role !== "Guest";
  return <section className="grid gap-3">
    {canWrite && !project.archived && <div className="flex justify-end">
      <button type="button" className="flex items-center gap-1.5" onClick={() => setCreating(true)}><Plus aria-hidden size={14} />{translate("workItems.addNew")}</button>
    </div>}
    <WorkItemLayouts projectId={project.id} workspaceSlug={workspace.slug} action={action} run={actionResult} refreshKey={refreshKey} cyclesEnabled={project.features.cycles} modulesEnabled={project.features.modules} typesEnabled={project.features.types} canWrite={canWrite} canCreate
      toolbarExtra={(params) => canWrite && !project.archived ? <SaveAsViewButton params={params} project={project} workspaceSlug={workspace.slug} /> : null} />
    {creating && <CreateWorkItemModal project={project} onClose={() => setCreating(false)} onCreated={() => setRefreshKey((key) => key + 1)} />}
  </section>;
}
