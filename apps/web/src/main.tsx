import React from "react";
import { createRoot } from "react-dom/client";
import { translate } from "@weft/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { registerSW } from "virtual:pwa-register";
import { createQueryClient } from "./query-client";
import { WorkItemViews } from "./work-item-views";
import { WorkItemSearch } from "./work-item-search";
import "./style.css";

registerSW({ immediate: true });
const queryClient = createQueryClient();

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
type Workspace = { id: string; name: string; slug: string };
type Member = { userId: string; name: string; email: string; role: "Admin" | "Member" | "Guest" };
const roles = ["Admin", "Member", "Guest"] as const;
const inviteToken = window.location.pathname.startsWith("/invite/") ? decodeURIComponent(window.location.pathname.split("/")[2] ?? "") : null;

async function action<T>(name: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.ok ? await response.json() as T : null;
}

function MembersPanel({ workspace, self }: { workspace: Workspace; self: string }) {
  const [members, setMembers] = React.useState<Member[]>([]);
  const [inviteRole, setInviteRole] = React.useState<Member["role"]>("Member");
  const [link, setLink] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setMembers(await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? []), [workspace.id]);
  React.useEffect(() => { void load(); }, [load]);
  const mine = members.find((member) => member.userId === self);
  const isAdmin = mine?.role === "Admin";
  const guard = async (result: unknown) => { setNote(result === null ? translate("members.failed") : null); await load(); };
  return <section>
    <h2>{translate("members.title")}</h2>
    <ul>{members.map((member) => <li key={member.userId}>
      {member.name} ({member.email}){" "}
      {isAdmin ? <select value={member.role} onChange={async (event) => guard(await action("change_member_role", { workspaceId: workspace.id, userId: member.userId, role: event.target.value }))}>
        {roles.map((role) => <option key={role} value={role}>{translate(`members.role.${role}`)}</option>)}
      </select> : <span>{translate(`members.role.${member.role}`)}</span>}
      {isAdmin && <button className="secondary" onClick={async () => guard(await action("remove_member", { workspaceId: workspace.id, userId: member.userId }))}>{translate("members.remove")}</button>}
    </li>)}</ul>
    {isAdmin && <div>
      <label>{translate("invite.role")}<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Member["role"])}>
        {roles.map((role) => <option key={role} value={role}>{translate(`members.role.${role}`)}</option>)}
      </select></label>
      <button onClick={async () => {
        const invite = await action<{ token: string }>("create_invite", { workspaceId: workspace.id, role: inviteRole });
        setLink(invite ? `${window.location.origin}/invite/${invite.token}` : null);
        if (!invite) setNote(translate("members.failed"));
      }}>{translate("invite.create")}</button>
      {link && <p><input readOnly value={link} onFocus={(event) => event.target.select()} />
        <button className="secondary" onClick={async () => { await navigator.clipboard.writeText(link); setNote(translate("invite.copied")); }}>{translate("invite.copy")}</button>
        <small> {translate("invite.expires")}</small></p>}
    </div>}
    {note && <p role="status">{note}</p>}
  </section>;
}
type Project = { id: string; key: string; name: string; visibility: "public" | "private"; archived: boolean; role: Member["role"] | null };
type Visibility = Project["visibility"];

function ProjectsPanel({ workspace }: { workspace: Workspace }) {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [showArchived, setShowArchived] = React.useState(false);
  const [name, setName] = React.useState("");
  const [key, setKey] = React.useState("");
  const [visibility, setVisibility] = React.useState<Visibility>("public");
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setProjects(await action<Project[]>("list_projects", { workspaceId: workspace.id, archived: showArchived }) ?? []), [workspace.id, showArchived]);
  React.useEffect(() => { void load(); }, [load]);
  return <section>
    <h2>{translate("projects.title")}</h2>
    <label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />{translate("projects.showArchived")}</label>
    {projects.length === 0 && <p>{translate("projects.empty")}</p>}
    <ul>{projects.map((project) => <li key={project.id}>
      <a href={`/${workspace.slug}/projects/${project.key}`}>{project.key} · {project.name}</a>{" "}
      <small>{translate(`projects.visibility.${project.visibility}`)}{project.archived ? ` · ${translate("projects.archivedBadge")}` : ""}</small>{" "}
      {project.role === null && !project.archived && project.visibility === "public" && <button className="secondary" onClick={async () => { await action("join_project", { projectId: project.id }); await load(); }}>{translate("projects.join")}</button>}
    </li>)}</ul>
    <form onSubmit={async (event) => {
      event.preventDefault();
      const created = await action<Project>("create_project", { workspaceId: workspace.id, name, key, visibility });
      setNote(created ? null : translate("projects.failed"));
      if (created) { setName(""); setKey(""); await load(); }
    }}>
      <label>{translate("projects.name")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{translate("projects.key")}<input required pattern="[A-Z][A-Z0-9]{1,11}" title={translate("projects.keyHint")} value={key} onChange={(event) => setKey(event.target.value.toUpperCase())} /></label>
      <label>{translate("projects.visibility")}<select value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)}>
        <option value="public">{translate("projects.visibility.public")}</option>
        <option value="private">{translate("projects.visibility.private")}</option>
      </select></label>
      <button>{translate("projects.create")}</button>
    </form>
    {note && <p role="alert">{note}</p>}
  </section>;
}

function ProjectSettings({ workspace, projectKey }: { workspace: Workspace; projectKey: string }) {
  const [project, setProject] = React.useState<Project | null | undefined>(undefined);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = React.useState<Member[]>([]);
  const [name, setName] = React.useState("");
  const [newKey, setNewKey] = React.useState("");
  const [addUser, setAddUser] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const found = await action<Project>("get_project", { workspaceId: workspace.id, key: projectKey });
    setProject(found);
    if (!found) return;
    setName(found.name); setNewKey(found.key);
    setMembers(await action<Member[]>("list_project_members", { projectId: found.id }) ?? []);
    setWorkspaceMembers(await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? []);
  }, [workspace.id, projectKey]);
  React.useEffect(() => { void load(); }, [load]);
  if (project === undefined) return null;
  if (project === null) return <section><p role="alert">{translate("projects.notFound")}</p><a href={`/${workspace.slug}`}>{translate("projects.back")}</a></section>;
  const canAdmin = project.role === "Admin" || project.role === null; // role null here means a workspace Admin; the server decides
  const guard = async (result: unknown) => { setNote(result === null ? translate("projects.failed") : null); await load(); };
  const rename = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await action<Project>("rename_project_key", { projectId: project.id, key: newKey });
    if (result) window.location.replace(`/${workspace.slug}/projects/${result.key}/settings`); else await guard(null);
  };
  return <section>
    <a href={`/${workspace.slug}/projects/${project.key}`}>{translate("workItems.back")}</a>
    <h2>{translate("projects.settingsTitle")}: {project.key}{project.archived ? ` (${translate("projects.archivedBadge")})` : ""}</h2>
    <form onSubmit={async (event) => { event.preventDefault(); await guard(await action("update_project", { projectId: project.id, name })); }}>
      <label>{translate("projects.name")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{translate("projects.visibility")}<select value={project.visibility} onChange={async (event) => guard(await action("update_project", { projectId: project.id, visibility: event.target.value }))}>
        <option value="public">{translate("projects.visibility.public")}</option>
        <option value="private">{translate("projects.visibility.private")}</option>
      </select></label>
      {canAdmin && <button>{translate("projects.save")}</button>}
    </form>
    {canAdmin && <form onSubmit={rename}>
      <label>{translate("projects.key")}<input required pattern="[A-Z][A-Z0-9]{1,11}" title={translate("projects.keyHint")} value={newKey} onChange={(event) => setNewKey(event.target.value.toUpperCase())} /></label>
      <small>{translate("projects.aliasNote")}</small>
      <button>{translate("projects.renameKey")}</button>
    </form>}
    {canAdmin && <button className="secondary" onClick={async () => guard(await action(project.archived ? "unarchive_project" : "archive_project", { projectId: project.id }))}>
      {translate(project.archived ? "projects.unarchive" : "projects.archive")}</button>}
    <h3>{translate("projects.members")}</h3>
    <ul>{members.map((member) => <li key={member.userId}>{member.name} ({member.email}){" "}
      {canAdmin ? <select value={member.role} onChange={async (event) => guard(await action("change_project_member_role", { projectId: project.id, userId: member.userId, role: event.target.value }))}>
        {roles.map((role) => <option key={role} value={role}>{translate(`projects.role.${role}`)}</option>)}
      </select> : <span>{translate(`projects.role.${member.role}`)}</span>}
      {canAdmin && <button className="secondary" onClick={async () => guard(await action("remove_project_member", { projectId: project.id, userId: member.userId }))}>{translate("members.remove")}</button>}
    </li>)}</ul>
    {canAdmin && <div>
      <label>{translate("projects.addMember")}<select value={addUser} onChange={(event) => setAddUser(event.target.value)}>
        <option value="">{translate("projects.selectMember")}</option>
        {workspaceMembers.filter((candidate) => !members.some((member) => member.userId === candidate.userId)).map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.name}</option>)}
      </select></label>
      <button disabled={!addUser} onClick={async () => { await guard(await action("add_project_member", { projectId: project.id, userId: addUser, role: "Member" })); setAddUser(""); }}>{translate("projects.addMember")}</button>
    </div>}
    <StatesPanel projectId={project.id} canAdmin={canAdmin} />
    <LabelsPanel projectId={project.id} canAdmin={canAdmin} />
    {note && <p role="alert">{note}</p>}
  </section>;
}
type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
const stateGroups: StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];
const priorities = ["urgent", "high", "medium", "low", "none"] as const;
type WorkState = { id: string; name: string; group: StateGroup };
type WorkItem = { id: string; projectId: string; displayId: string; title: string; descriptionText: string; stateId: string; priority: (typeof priorities)[number]; assigneeIds: string[]; labelIds: string[]; parentId: string | null; startDate: string | null; dueDate: string | null };
type Label = { id: string; projectId: string; name: string; color: string };
type ActivityRow = { id: string; field: string; oldValue: unknown; newValue: unknown; actorId: string; actorName: string; source: string; createdAt: string };

function docOf(text: string) {
  return { type: "doc", content: text.split("\n").map((line) => line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }) };
}

function LabelsPanel({ projectId, canAdmin }: { projectId: string; canAdmin: boolean }) {
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState("#6b7280");
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setLabels(await action<Label[]>("list_labels", { projectId }) ?? []), [projectId]);
  React.useEffect(() => { void load(); }, [load]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("workItems.failed") : null); await load(); };
  return <section>
    <h3>{translate("labels.title")}</h3>
    <ul>{labels.map((label) => <li key={label.id}><span style={{ color: label.color }}>{label.name}</span>{" "}
      {canAdmin && <button className="secondary" onClick={async () => guard(await action("delete_label", { labelId: label.id }))}>{translate("labels.delete")}</button>}</li>)}</ul>
    {canAdmin && <form onSubmit={async (event) => { event.preventDefault(); await guard(await action("create_label", { projectId, name, color })); setName(""); }}>
      <label>{translate("labels.name")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <input type="color" aria-label={translate("labels.name")} value={color} onChange={(event) => setColor(event.target.value)} />
      <button>{translate("labels.create")}</button>
    </form>}
    {note && <p role="alert">{note}</p>}
  </section>;
}

function StatesPanel({ projectId, canAdmin }: { projectId: string; canAdmin: boolean }) {
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [newName, setNewName] = React.useState<Record<string, string>>({});
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setStates(await action<WorkState[]>("list_states", { projectId }) ?? []), [projectId]);
  React.useEffect(() => { void load(); }, [load]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("states.failed") : null); await load(); };
  return <section>
    <h3>{translate("states.title")}</h3>
    {stateGroups.map((group) => {
      const inGroup = states.filter((state) => state.group === group);
      const move = (index: number, delta: number) => {
        const ids = inGroup.map((state) => state.id);
        [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
        return action("reorder_states", { projectId, group, stateIds: ids });
      };
      return <div key={group}>
        <h4>{translate(`states.group.${group}`)}</h4>
        <ul>{inGroup.map((state, index) => <li key={state.id}>{state.name}{canAdmin && <>{" "}
          <button className="secondary" disabled={index === 0} onClick={async () => guard(await move(index, -1))}>{translate("states.moveUp")}</button>
          <button className="secondary" disabled={index === inGroup.length - 1} onClick={async () => guard(await move(index, 1))}>{translate("states.moveDown")}</button>
          <button className="secondary" onClick={async () => {
            const name = window.prompt(translate("states.name"), state.name);
            if (name) guard(await action("update_state", { stateId: state.id, name }));
          }}>{translate("states.rename")}</button>
          <button className="secondary" onClick={async () => guard(await action("delete_state", { stateId: state.id }))}>{translate("states.remove")}</button></>}</li>)}</ul>
        {canAdmin && <form onSubmit={async (event) => {
          event.preventDefault();
          await guard(await action("create_state", { projectId, group, name: newName[group] ?? "" }));
          setNewName({ ...newName, [group]: "" });
        }}>
          <label>{translate("states.name")}<input required value={newName[group] ?? ""} onChange={(event) => setNewName({ ...newName, [group]: event.target.value })} /></label>
          <button>{translate("states.add")}</button>
        </form>}
      </div>;
    })}
    {note && <p role="alert">{note}</p>}
  </section>;
}

function ProjectWorkItems({ workspace, projectKey }: { workspace: Workspace; projectKey: string }) {
  const [project, setProject] = React.useState<Project | null | undefined>(undefined);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [stateId, setStateId] = React.useState("");
  const [priority, setPriority] = React.useState<WorkItem["priority"]>("none");
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const found = await action<Project>("get_project", { workspaceId: workspace.id, key: projectKey });
    setProject(found);
    if (!found) return;
    setStates(await action<WorkState[]>("list_states", { projectId: found.id }) ?? []);
  }, [workspace.id, projectKey]);
  React.useEffect(() => { void load(); }, [load]);
  if (project === undefined) return null;
  if (project === null) return <section><p role="alert">{translate("projects.notFound")}</p><a href={`/${workspace.slug}`}>{translate("projects.back")}</a></section>;
  return <section>
    <a href={`/${workspace.slug}`}>{translate("projects.back")}</a>
    <h2>{project.key} · {project.name}</h2>
    <a href={`/${workspace.slug}/projects/${project.key}/settings`}>{translate("projects.settings")}</a>
    <h3>{translate("workItems.title")}</h3>
    <WorkItemViews projectId={project.id} workspaceSlug={workspace.slug} action={action} refreshKey={refreshKey} />
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

function WorkItemDetail({ workspace, displayId }: { workspace: Workspace; displayId: string }) {
  const [item, setItem] = React.useState<WorkItem | null | undefined>(undefined);
  const [project, setProject] = React.useState<Project | null>(null);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [log, setLog] = React.useState<ActivityRow[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [subItems, setSubItems] = React.useState<WorkItem[]>([]);
  const [projectItems, setProjectItems] = React.useState<WorkItem[]>([]);
  const [subTitle, setSubTitle] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const found = await action<WorkItem>("get_work_item", { workspaceId: workspace.id, displayId });
    setItem(found);
    if (!found) return;
    // The server returns the current key: rewrite an old-alias URL to the canonical one.
    if (found.displayId !== displayId.toUpperCase()) window.history.replaceState(null, "", `/${workspace.slug}/work-items/${found.displayId}`);
    setTitle(found.title); setDescription(found.descriptionText);
    const projects = await action<Project[]>("list_projects", { workspaceId: workspace.id }) ?? [];
    setProject(projects.find((candidate) => candidate.id === found.projectId) ?? null);
    setStates(await action<WorkState[]>("list_states", { projectId: found.projectId }) ?? []);
    setLog(await action<ActivityRow[]>("list_work_item_activities", { workItemId: found.id }) ?? []);
    setLabels(await action<Label[]>("list_labels", { projectId: found.projectId }) ?? []);
    setPeople(await action<Member[]>("list_project_members", { projectId: found.projectId }) ?? []);
    setSubItems(await action<WorkItem[]>("list_sub_work_items", { workItemId: found.id }) ?? []);
    setProjectItems(await action<WorkItem[]>("list_work_items", { projectId: found.projectId }) ?? []);
  }, [workspace.id, workspace.slug, displayId]);
  React.useEffect(() => { void load(); }, [load]);
  if (item === undefined) return null;
  if (item === null) return <section><p role="alert">{translate("workItems.notFound")}</p><a href={`/${workspace.slug}`}>{translate("projects.back")}</a></section>;
  const guard = async (result: unknown) => { setNote(result === null ? translate("workItems.failed") : null); await load(); };
  const back = project ? `/${workspace.slug}/projects/${project.key}` : `/${workspace.slug}`;
  return <section>
    <a href={back}>{translate("workItems.back")}</a>
    <h2>{item.displayId}</h2>
    <form onSubmit={async (event) => {
      event.preventDefault();
      await guard(await action("update_work_item", { workItemId: item.id, title, description: docOf(description) }));
    }}>
      <label>{translate("workItems.titleField")}<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{translate("workItems.description")}<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
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
    <ul>{subItems.map((sub) => <li key={sub.id}><a href={`/${workspace.slug}/work-items/${sub.displayId}`}>{sub.displayId} {sub.title}</a></li>)}</ul>
    <form onSubmit={async (event) => { event.preventDefault(); await guard(await action("create_work_item", { projectId: item.projectId, title: subTitle, parentId: item.id })); setSubTitle(""); }}>
      <label>{translate("workItems.titleField")}<input required value={subTitle} onChange={(event) => setSubTitle(event.target.value)} /></label>
      <button>{translate("workItems.subItems.add")}</button>
    </form>
    <button className="secondary" onClick={async () => {
      const result = await action("delete_work_item", { workItemId: item.id });
      if (result === null) setNote(translate("workItems.failed")); else window.location.assign(back);
    }}>{translate("workItems.delete")}</button>
    <h3>{translate("workItems.activity")}</h3>
    <ul>{log.map((row) => <li key={row.id}>
      <strong>{row.actorName}</strong>{" "}
      {row.field === "created" ? translate("workItems.activity.created") : row.field === "deleted" ? translate("workItems.activity.deleted") : translate("workItems.activity.changed").replace("{field}", row.field)}{" "}
      <small>{translate("workItems.via").replace("{source}", row.source)} · {new Date(row.createdAt).toLocaleString()}</small>
    </li>)}</ul>
    {note && <p role="alert">{note}</p>}
  </section>;
}

type Current = { user: { id: string; name: string; email: string }; workspaces: Workspace[]; canCreateWorkspace: boolean };

function App() {
  const [current, setCurrent] = React.useState<Current | null>(null);
  const [mode, setMode] = React.useState<"sign-in" | "sign-up">("sign-up");
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [workspaceName, setWorkspaceName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const pathParts = window.location.pathname.split("/").map((part) => decodeURIComponent(part));
  const currentSlug = pathParts[1] ?? "";
  const projectKey = pathParts[2] === "projects" ? (pathParts[3] ?? "") : "";
  const projectView = pathParts[4] === "settings" ? "settings" : "items";
  const displayId = pathParts[2] === "work-items" ? (pathParts[3] ?? "") : "";

  async function refresh() {
    const response = await fetch(`${api}/api/me`, { credentials: "include" });
    if (response.ok) {
      const data = await response.json() as Current;
      setCurrent(data);
      if (inviteToken) {
        const joined = await action<{ slug: string }>("accept_invite", { token: inviteToken });
        if (joined) window.location.replace(`/${joined.slug}`); else setError(translate("invite.failed"));
        return;
      }
      if (window.location.pathname === "/" && data.workspaces.length > 0) window.location.replace(`/${data.workspaces[0]!.slug}`);
    }
    else setCurrent(null);
  }
  React.useEffect(() => { void refresh(); }, []);

  async function authenticate(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    const endpoint = mode === "sign-up" ? "sign-up/email" : "sign-in/email";
    const response = await fetch(`${api}/api/auth/${endpoint}`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify(mode === "sign-up" ? { name, email, password } : { email, password }),
    });
    if (!response.ok) { setError(translate("auth.failed")); return; }
    await refresh();
  }

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    const response = await fetch(`${api}/actions/create_workspace`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: workspaceName, slug }),
    });
    if (!response.ok) { setError(translate("workspace.createFailed")); return; }
    const workspace = await response.json() as Workspace;
    window.location.assign(`/${workspace.slug}`);
  }

  async function signOut() {
    await fetch(`${api}/api/auth/sign-out`, { method: "POST", credentials: "include" });
    setCurrent(null);
  }

  if (current === null) return <main>
    <h1>{translate("app.title")}</h1><p>{translate("app.welcome")}</p>
    <form onSubmit={authenticate}>
      {mode === "sign-up" && <label>{translate("auth.name")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>}
      <label>{translate("auth.email")}<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>{translate("auth.password")}<input required type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button>{translate(mode === "sign-up" ? "auth.signUp" : "auth.signIn")}</button>
    </form>
    <button className="secondary" onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}>
      {translate(mode === "sign-up" ? "auth.haveAccount" : "auth.needAccount")}
    </button>
    {error && <p role="alert">{error}</p>}
  </main>;

  if (inviteToken) return <main><p role={error ? "alert" : "status"}>{error ?? translate("invite.joining")}</p></main>;

  const workspace = current.workspaces.find((item) => item.slug === currentSlug);
  if (workspace) return <main>
    <header><h1>{workspace.name}</h1><WorkItemSearch workspace={workspace} /><button className="secondary" onClick={() => void signOut()}>{translate("auth.signOut")}</button></header>
    <p>{translate("app.welcome")}</p>
    {current.workspaces.length > 1 && <label>{translate("workspace.switch")}
      <select value={workspace.slug} onChange={(event) => window.location.assign(`/${event.target.value}`)}>
        {current.workspaces.map((item) => <option value={item.slug} key={item.id}>{item.name}</option>)}
      </select></label>}
    {displayId ? <WorkItemDetail workspace={workspace} displayId={displayId} />
      : projectKey ? (projectView === "settings" ? <ProjectSettings workspace={workspace} projectKey={projectKey} /> : <ProjectWorkItems workspace={workspace} projectKey={projectKey} />)
      : <ProjectsPanel workspace={workspace} />}
    <MembersPanel workspace={workspace} self={current.user.id} />
  </main>;

  const needsFirstWorkspace = current.workspaces.length === 0;
  return <main>
    <header><h1>{needsFirstWorkspace ? translate("workspace.firstTitle") : translate("workspace.yourWorkspaces")}</h1><button className="secondary" onClick={() => void signOut()}>{translate("auth.signOut")}</button></header>
    {current.workspaces.map((item) => <p key={item.id}><a href={`/${item.slug}`}>{item.name}</a></p>)}
    {current.canCreateWorkspace && <form onSubmit={createWorkspace}>
      <label>{translate("workspace.name")}<input required value={workspaceName} onChange={(event) => {
        const value = event.target.value; setWorkspaceName(value);
        if (!slug || slug === slugify(workspaceName)) setSlug(slugify(value));
      }} /></label>
      <label>{translate("workspace.slug")}<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
      <button>{translate("workspace.create")}</button>
    </form>}
    {!current.canCreateWorkspace && <p>{translate("workspace.noAccess")}</p>}
    {error && <p role="alert">{error}</p>}
  </main>;
}

function slugify(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
