import React from "react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../api";
import { useProject } from "../layouts/project-layout";
import { useWorkspace } from "../layouts/workspace-layout";
import { WorkItemViews } from "../work-item-views";
import { priorities, type WorkItem, type WorkState } from "../types";

function docOf(text: string) {
  return { type: "doc", content: text.split("\n").map((line) => line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }) };
}

export function ProjectWorkItems() {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [stateId, setStateId] = React.useState("");
  const [priority, setPriority] = React.useState<WorkItem["priority"]>("none");
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => { void action<WorkState[]>("list_states", { projectId: project.id }).then((found) => setStates(found ?? [])); }, [project.id]);
  return <section>
    <WorkItemViews projectId={project.id} workspaceSlug={workspace.slug} action={action} run={actionResult} refreshKey={refreshKey} modulesEnabled={project.features.modules} />
    <form onSubmit={async (event) => {
      event.preventDefault();
      const created = await action<WorkItem>("create_work_item", { projectId: project.id, title, priority, ...(stateId ? { stateId } : {}), ...(description ? { description: docOf(description) } : {}) });
      setNote(created ? null : translate("workItems.failed"));
      if (created) { setTitle(""); setDescription(""); setRefreshKey((key) => key + 1); }
    }}>
      <label>{translate("workItems.titleField")}<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{translate("workItems.description")}<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>{translate("workItems.state")}<select value={stateId} onChange={(event) => setStateId(event.target.value)}>
        <option value="">{states[0]?.name}</option>
        {states.slice(1).map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
      </select></label>
      <label>{translate("workItems.priority")}<select value={priority} onChange={(event) => setPriority(event.target.value as WorkItem["priority"])}>
        {priorities.map((value) => <option key={value} value={value}>{translate(`workItems.priority.${value}`)}</option>)}
      </select></label>
      <button>{translate("workItems.create")}</button>
    </form>
    {note && <p role="alert">{note}</p>}
  </section>;
}
