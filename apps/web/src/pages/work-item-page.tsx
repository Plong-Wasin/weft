import React from "react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../api";
import { Link, useNavigate, useParams } from "react-router";
import { paths } from "../routes";
import { TimelinePanel } from "../comments-panel";
import { RelationsPanel } from "../relations-panel";
import { Sidecar } from "../sidecar";
import { AttachmentsPanel } from "../asset-images";
import { DescriptionEditor } from "../description-editor";
import { useWorkspace } from "../layouts/workspace-layout";
import { priorities, type Label, type Member, type Project, type WorkItem, type WorkState } from "../types";

export function WorkItemPage() {
  const { workspace, selfId } = useWorkspace();
  const { displayId = "" } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = React.useState<WorkItem | null | undefined>(undefined);
  const [project, setProject] = React.useState<Project | null>(null);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [subItems, setSubItems] = React.useState<WorkItem[]>([]);
  const [projectItems, setProjectItems] = React.useState<WorkItem[]>([]);
  const [subTitle, setSubTitle] = React.useState("");
  const [title, setTitle] = React.useState("");
  const description = React.useRef<unknown>(null);
  const descriptionFor = React.useRef<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const found = await action<WorkItem>("get_work_item", { workspaceId: workspace.id, displayId });
    setItem(found);
    if (!found) return;
    // The server returns the current key: rewrite an old-alias URL to the canonical one.
    if (found.displayId !== displayId.toUpperCase()) navigate(`${paths.workItem(workspace.slug, found.displayId)}${window.location.hash}`, { replace: true });
    setTitle(found.title); if (descriptionFor.current !== found.id) { descriptionFor.current = found.id; description.current = found.description ?? null; }
    const projects = await action<Project[]>("list_projects", { workspaceId: workspace.id }) ?? [];
    setProject(projects.find((candidate) => candidate.id === found.projectId) ?? null);
    setStates(await action<WorkState[]>("list_states", { projectId: found.projectId }) ?? []);
    setLabels(await action<Label[]>("list_labels", { projectId: found.projectId }) ?? []);
    setPeople(await action<Member[]>("list_project_members", { projectId: found.projectId }) ?? []);
    setSubItems(await action<WorkItem[]>("list_sub_work_items", { workItemId: found.id }) ?? []);
    setProjectItems(await action<WorkItem[]>("list_work_items", { projectId: found.projectId }) ?? []);
  }, [workspace.id, workspace.slug, displayId, navigate]);
  React.useEffect(() => { void load(); }, [load]);
  if (item === undefined) return null;
  if (item === null) return <section><p role="alert">{translate("workItems.notFound")}</p><Link to={paths.home(workspace.slug)}>{translate("projects.back")}</Link></section>;
  const guard = async (result: unknown) => { setNote(result === null ? translate("workItems.failed") : null); await load(); };
  const canComment = project?.role !== "Guest" && !project?.archived;
  const back = project ? paths.workItems(workspace.slug, project.key) : paths.home(workspace.slug);
  return <section>
    <Link to={back}>{translate("workItems.back")}</Link>
    <h2>{item.displayId}</h2>
    <form onSubmit={async (event) => {
      event.preventDefault();
      await guard(await action("update_work_item", { workItemId: item.id, title, ...(description.current ? { description: description.current } : {}) }));
    }}>
      <label>{translate("workItems.titleField")}<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <DescriptionEditor key={item.id} workItemId={item.id} initial={item.description} editable={canComment} onChange={(doc) => { description.current = doc; }} />
      <button>{translate("workItems.save")}</button>
    </form>
    <label>{translate("workItems.state")}<select value={item.stateId} onChange={async (event) => guard(await action("update_work_item", { workItemId: item.id, stateId: event.target.value }))}>
      {states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
    </select></label>
    <label>{translate("workItems.priority")}<select value={item.priority} onChange={async (event) => guard(await action("update_work_item", { workItemId: item.id, priority: event.target.value }))}>
      {priorities.map((value) => <option key={value} value={value}>{translate(`workItems.priority.${value}`)}</option>)}
    </select></label>
    <fieldset>
      <legend>{translate("workItems.assignees")}</legend>
      {people.map((person) => <label key={person.userId}><input type="checkbox" checked={item.assigneeIds.includes(person.userId)}
        onChange={async (event) => guard(await action("update_work_item", { workItemId: item.id, assigneeIds: event.target.checked ? [...item.assigneeIds, person.userId] : item.assigneeIds.filter((id) => id !== person.userId) }))} />{person.name}</label>)}
    </fieldset>
    <fieldset>
      <legend>{translate("workItems.labels")}</legend>
      {labels.map((label) => <label key={label.id}><input type="checkbox" checked={item.labelIds.includes(label.id)}
        onChange={async (event) => guard(await action("update_work_item", { workItemId: item.id, labelIds: event.target.checked ? [...item.labelIds, label.id] : item.labelIds.filter((id) => id !== label.id) }))} />{label.name}</label>)}
    </fieldset>
    <label>{translate("workItems.startDate")}<input type="date" value={item.startDate ?? ""} onChange={async (event) => guard(await action("update_work_item", { workItemId: item.id, startDate: event.target.value || null }))} /></label>
    <label>{translate("workItems.dueDate")}<input type="date" value={item.dueDate ?? ""} onChange={async (event) => guard(await action("update_work_item", { workItemId: item.id, dueDate: event.target.value || null }))} /></label>
    <label>{translate("workItems.parent")}<select value={item.parentId ?? ""} onChange={async (event) => guard(await action("update_work_item", { workItemId: item.id, parentId: event.target.value || null }))}>
      <option value="">{translate("workItems.noParent")}</option>
      {projectItems.filter((candidate) => candidate.id !== item.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayId} {candidate.title}</option>)}
    </select></label>
    <h3>{translate("workItems.subItems")}</h3>
    {subItems.length === 0 && <p>{translate("workItems.subItems.empty")}</p>}
    <ul>{subItems.map((sub) => <li key={sub.id}><Link to={paths.workItem(workspace.slug, sub.displayId)}>{sub.displayId} {sub.title}</Link></li>)}</ul>
    <form onSubmit={async (event) => { event.preventDefault(); await guard(await action("create_work_item", { projectId: item.projectId, title: subTitle, parentId: item.id })); setSubTitle(""); }}>
      <label>{translate("workItems.titleField")}<input required value={subTitle} onChange={(event) => setSubTitle(event.target.value)} /></label>
      <button>{translate("workItems.subItems.add")}</button>
    </form>
    <button className="secondary" onClick={async () => {
      const result = await action("delete_work_item", { workItemId: item.id });
      if (result === null) setNote(translate("workItems.failed")); else navigate(back);
    }}>{translate("workItems.delete")}</button>
    <Sidecar workspace={workspace} context={{ type: "work_item", id: item.displayId, title: item.title }} />
    <RelationsPanel workspaceSlug={workspace.slug} workItemId={item.id} candidates={projectItems.filter((candidate) => candidate.id !== item.id)} canWrite={canComment} action={action} onChange={() => void load()} />
    <AttachmentsPanel workItemId={item.id} canWrite={canComment} action={action} onChange={() => void load()} />
    <TimelinePanel workItemId={item.id} projectId={item.projectId} selfId={selfId} canComment={canComment} linkBase={paths.workItem(workspace.slug, item.displayId)} action={action} onChange={() => void load()} />
    {note && <p role="alert">{note}</p>}
  </section>;
}
