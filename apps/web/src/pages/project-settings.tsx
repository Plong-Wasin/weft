import React from "react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../api";
import { useNavigate } from "react-router";
import { paths } from "../routes";
import { FeatureToggles } from "../project-nav";
import { useProject } from "../layouts/project-layout";
import { useWorkspace } from "../layouts/workspace-layout";
import { roles, stateGroups, type Label, type Member, type Project, type WorkState } from "../types";

export function ProjectSettings() {
  const { workspace } = useWorkspace();
  const { project, reload } = useProject();
  const navigate = useNavigate();
  const [members, setMembers] = React.useState<Member[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = React.useState<Member[]>([]);
  const [name, setName] = React.useState(project.name);
  const [newKey, setNewKey] = React.useState(project.key);
  const [addUser, setAddUser] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    setMembers(await action<Member[]>("list_project_members", { projectId: project.id }) ?? []);
    setWorkspaceMembers(await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? []);
  }, [workspace.id, project.id]);
  React.useEffect(() => { void load(); }, [load]);
  const canAdmin = project.role === "Admin" || project.role === null; // role null here means a workspace Admin; the server decides
  const guard = async (result: unknown) => { setNote(result === null ? translate("projects.failed") : null); await Promise.all([load(), reload()]); };
  const rename = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await action<Project>("rename_project_key", { projectId: project.id, key: newKey });
    if (result) navigate(paths.projectSettings(workspace.slug, result.key), { replace: true }); else await guard(null);
  };
  return <section>
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
    <FeatureToggles features={project.features} canAdmin={canAdmin} onChange={async (feature, enabled) => {
      const result = await action("set_project_features", { projectId: project.id, features: { [feature]: enabled } });
      await reload();
      setNote(result === null ? translate("features.failed") : null);
    }} />
    <StatesPanel projectId={project.id} canAdmin={canAdmin} />
    <LabelsPanel projectId={project.id} canAdmin={canAdmin} />
    {note && <p role="alert">{note}</p>}
  </section>;
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
