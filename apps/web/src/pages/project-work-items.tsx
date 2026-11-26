import { Button } from "@/ui/button";
import React from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../api";
import { useProject } from "../layouts/project-layout";
import { useWorkspace } from "../layouts/workspace-layout";
import { CreateWorkItemModal } from "../create-work-item-modal";
import { WorkItemLayouts } from "../work-item-layouts";
import { SaveAsViewButton } from "../views";
import { paths } from "../routes";

export function ProjectWorkItems() {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  const [creating, setCreating] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const canWrite = project.role !== "Guest";
  return <section className="grid gap-3">
    <WorkItemLayouts projectId={project.id} workspaceSlug={workspace.slug} action={action} run={actionResult} refreshKey={refreshKey} cyclesEnabled={project.features.cycles} modulesEnabled={project.features.modules} typesEnabled={project.features.types} canWrite={canWrite} canCreate onAddItem={() => setCreating(true)}
      toolbarExtra={(params) => <div className="flex items-center gap-2">
        {canWrite && !project.archived && <>
          <Button type="button" className="flex items-center gap-1.5" onClick={() => setCreating(true)}><Plus aria-hidden size={14} /><span>{translate("workItems.addNew")}</span></Button>
          <SaveAsViewButton params={params} project={project} workspaceSlug={workspace.slug} />
        </>}
        <Link to={paths.projectSettings(workspace.slug, project.key)} className="secondary no-underline">{translate("projects.settings")}</Link>
      </div>} />
    {creating && <CreateWorkItemModal project={project} onClose={() => setCreating(false)} onCreated={() => setRefreshKey((key) => key + 1)} />}
  </section>;
}
