import { Button, buttonVariants } from "@/ui/button";
import React from "react";
import { Link } from "react-router";
import { BookmarkPlus, Plus } from "lucide-react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../api";
import { useProject } from "../layouts/project-layout";
import { useWorkspace } from "../layouts/workspace-layout";
import { CreateWorkItemModal } from "../create-work-item-modal";
import { WorkItemLayouts } from "../work-item-layouts";
import { SaveAsViewModal } from "../views";
import { paths } from "../routes";
import type { LayoutParams } from "../work-item-layout";
import { cn } from "../lib/utils";

const toolbarSecondarySm = cn(buttonVariants({ variant: "secondary", size: "sm" }), "bg-transparent text-foreground");

export function ProjectWorkItems() {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  const [creating, setCreating] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [savingView, setSavingView] = React.useState<LayoutParams | null>(null);
  const canWrite = project.role !== "Guest";
  const canAdd = canWrite && !project.archived;
  return <section className="project-work-items grid gap-3 phone-layout:gap-1">
    <WorkItemLayouts projectId={project.id} workspaceSlug={workspace.slug} action={action} run={actionResult} refreshKey={refreshKey} cyclesEnabled={project.features.cycles} modulesEnabled={project.features.modules} typesEnabled={project.features.types} canWrite={canWrite} canCreate onAddItem={() => setCreating(true)}
      phoneToolbar={{ onSaveView: canAdd ? setSavingView : undefined, settingsPath: paths.projectSettings(workspace.slug, project.key) }}
      toolbarExtra={(params) => <div className="flex items-center gap-2 phone-layout:hidden">
        {canAdd && <>
          <Button type="button" variant="primary" size="sm" className="gap-1.5" onClick={() => setCreating(true)}><Plus aria-hidden size={14} /><span>{translate("workItems.addNew")}</span></Button>
          <Button type="button" variant="ghost" className="max-sm:min-h-9" aria-label={translate("views.saveAs")} title={translate("views.saveAs")} onClick={(event) => { event.currentTarget.focus(); setSavingView(params); }}><BookmarkPlus aria-hidden size={14} /><span className="max-sm:sr-only">{translate("views.saveAs")}</span></Button>
        </>}
        <Link to={paths.projectSettings(workspace.slug, project.key)} className={`${toolbarSecondarySm} no-underline`}>{translate("projects.settings")}</Link>
      </div>} />
    {canAdd && <Button type="button" variant="primary" aria-label={translate("workItems.addNew")} className="project-work-items-fab hidden size-11 rounded-full p-0 shadow-md phone-layout:inline-flex" onClick={() => setCreating(true)}>
      <Plus aria-hidden size={20} />
    </Button>}
    {savingView && <SaveAsViewModal params={savingView} project={project} workspaceSlug={workspace.slug} onClose={() => setSavingView(null)} />}
    {creating && <CreateWorkItemModal project={project} onClose={() => setCreating(false)} onCreated={() => setRefreshKey((key) => key + 1)} />}
  </section>;
}
