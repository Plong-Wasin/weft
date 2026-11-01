import React from "react";
import { Link, Outlet, useNavigate } from "react-router";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "../../api";
import { paths } from "../../routes";
import { projectFeatureKeys, type ProjectFeatureKey } from "../../project-nav";
import { useProject, useRouteProject, type ProjectContext } from "../../layouts/project-layout";
import { useWorkspace } from "../../layouts/workspace-layout";
import { roles, stateGroups, type Label, type Member, type Project, type WorkState } from "../../types";
import { dangerButton, DangerZone, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

/** Loads the project of `/settings/projects/:projectKey` and renders the routed section; the project name heads every section. */
export function ProjectSettingsLayout() {
  const { workspace } = useWorkspace();
  const { project, reload } = useRouteProject();
  if (project === undefined) return null;
  if (project === null) return <section><p role="alert">{translate("projects.notFound")}</p><Link to={paths.workspaceSettings(workspace.slug)}>{translate("settings.workspaceTitle")}</Link></section>;
  return <div className="mx-auto w-full max-w-[900px]">
    <p className="mb-2 flex items-center gap-2 text-13 text-secondary"><Link to={paths.workItems(workspace.slug, project.key)}>{project.key} · {project.name}</Link>
      {project.archived && <span className="rounded-sm bg-layer-1 px-1.5 py-0.5 text-11">{translate("projects.archivedBadge")}</span>}</p>
    <Outlet context={{ project, reload } satisfies ProjectContext} />
  </div>;
}

/** Role null means a workspace Admin who is no project member; the server decides. */
const canAdminOf = (project: Project) => project.role === "Admin" || project.role === null;

export function ProjectGeneral() {
  const { workspace } = useWorkspace();
  const { project, reload } = useProject();
  const navigate = useNavigate();
  const canAdmin = canAdminOf(project);
  const [name, setName] = React.useState(project.name);
  const [newKey, setNewKey] = React.useState(project.key);
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const done = async (result: unknown, ok = "settings.saved" as MessageKey) => { setNote(translate(result === null ? "projects.failed" : ok)); setFailed(result === null); await reload(); };
  return <section>
    <SettingsHeader title={translate("settings.general")} description={translate("settings.projectGeneralDesc")} />
    <SettingsBlock>
      <form className="my-0 max-w-md" onSubmit={async (event) => { event.preventDefault(); await done(await action("update_project", { projectId: project.id, name })); }}>
        <label>{translate("projects.name")}<input required disabled={!canAdmin} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>{translate("projects.visibility")}<select disabled={!canAdmin} value={project.visibility} onChange={async (event) => done(await action("update_project", { projectId: project.id, visibility: event.target.value }))}>
          <option value="public">{translate("projects.visibility.public")}</option>
          <option value="private">{translate("projects.visibility.private")}</option>
        </select></label>
        {canAdmin && <div><button>{translate("projects.save")}</button></div>}
      </form>
      {canAdmin && <form className="my-0 max-w-md" onSubmit={async (event) => {
        event.preventDefault();
        const result = await action<Project>("rename_project_key", { projectId: project.id, key: newKey });
        if (result) navigate(paths.projectSettings(workspace.slug, result.key), { replace: true }); else await done(null);
      }}>
        <label>{translate("projects.key")}<input required pattern="[A-Z][A-Z0-9]{1,11}" title={translate("projects.keyHint")} value={newKey} onChange={(event) => setNewKey(event.target.value.toUpperCase())} /></label>
        <p className="text-13 text-secondary">{translate("projects.aliasNote")}</p>
        <div><button>{translate("projects.renameKey")}</button></div>
      </form>}
    </SettingsBlock>
    <Note note={note} error={failed} />
    {canAdmin && <DangerZone heading={project.archived ? "projects.unarchive" : "projects.archive"} description={translate(project.archived ? "settings.unarchiveDesc" : "settings.archiveDesc")}>
      <button type="button" className={project.archived ? "secondary" : dangerButton} onClick={async () => done(await action(project.archived ? "unarchive_project" : "archive_project", { projectId: project.id }))}>
        {translate(project.archived ? "projects.unarchive" : "projects.archive")}</button>
    </DangerZone>}
  </section>;
}

export function ProjectMembers() {
  const { workspace } = useWorkspace();
  const { project, reload } = useProject();
  const canAdmin = canAdminOf(project);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [candidates, setCandidates] = React.useState<Member[]>([]);
  const [addUser, setAddUser] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    setMembers(await action<Member[]>("list_project_members", { projectId: project.id }) ?? []);
    setCandidates(await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? []);
  }, [workspace.id, project.id]);
  React.useEffect(() => { void load(); }, [load]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("projects.failed") : null); await Promise.all([load(), reload()]); };
  return <section>
    <SettingsHeader title={translate("projects.members")} description={translate("settings.projectMembersDesc")} />
    <RowList>{members.map((member) => <Row key={member.userId}>
      <span className="grid min-w-0 flex-1"><span className="truncate font-medium">{member.name}</span><span className="truncate text-13 text-secondary">{member.email}</span></span>
      {canAdmin ? <select aria-label={`${translate("settings.roleOf")} ${member.name}`} value={member.role} onChange={async (event) => guard(await action("change_project_member_role", { projectId: project.id, userId: member.userId, role: event.target.value }))}>
        {roles.map((role) => <option key={role} value={role}>{translate(`projects.role.${role}`)}</option>)}
      </select> : <span className="text-secondary">{translate(`projects.role.${member.role}`)}</span>}
      {canAdmin && <button type="button" className="secondary" onClick={async () => guard(await action("remove_project_member", { projectId: project.id, userId: member.userId }))}>{translate("members.remove")}</button>}
    </Row>)}</RowList>
    {canAdmin && <SettingsBlock>
      <div className="flex flex-wrap items-end gap-3">
        <label>{translate("projects.addMember")}<select aria-label={translate("projects.addMember")} value={addUser} onChange={(event) => setAddUser(event.target.value)}>
          <option value="">{translate("projects.selectMember")}</option>
          {candidates.filter((candidate) => !members.some((member) => member.userId === candidate.userId)).map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.name}</option>)}
        </select></label>
        <button type="button" disabled={!addUser} onClick={async () => { await guard(await action("add_project_member", { projectId: project.id, userId: addUser, role: "Member" })); setAddUser(""); }}>{translate("projects.addMember")}</button>
      </div>
    </SettingsBlock>}
    <Note note={note} error />
  </section>;
}

export function ProjectLabels() {
  const { project } = useProject();
  const canAdmin = canAdminOf(project);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState("#6b7280");
  const [editing, setEditing] = React.useState<{ id: string; name: string; color: string } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setLabels(await action<Label[]>("list_labels", { projectId: project.id }) ?? []), [project.id]);
  React.useEffect(() => { void load(); }, [load]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("workItems.failed") : null); await load(); return result !== null; };
  return <section>
    <SettingsHeader title={translate("labels.title")} description={translate("settings.labelsDesc")} />
    {canAdmin && <form className="mb-5 mt-0 flex flex-wrap items-end gap-3" onSubmit={async (event) => { event.preventDefault(); if (await guard(await action("create_label", { projectId: project.id, name, color }))) setName(""); }}>
      <label>{translate("labels.name")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <input type="color" aria-label={translate("labels.color")} value={color} onChange={(event) => setColor(event.target.value)} className="h-8 w-10 rounded-md border border-strong bg-surface-1 p-0.5" />
      <button>{translate("labels.create")}</button>
    </form>}
    {labels.length === 0 ? <p className="text-secondary">{translate("labels.empty")}</p> : <RowList>{labels.map((label) => <Row key={label.id}>
      {editing?.id === label.id ? <form className="my-0 flex flex-1 flex-wrap items-center gap-2" onSubmit={async (event) => { event.preventDefault(); if (await guard(await action("update_label", { labelId: label.id, name: editing.name, color: editing.color }))) setEditing(null); }}>
        <input required aria-label={translate("labels.name")} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
        <input type="color" aria-label={translate("labels.color")} value={editing.color} onChange={(event) => setEditing({ ...editing, color: event.target.value })} className="h-8 w-10 rounded-md border border-strong bg-surface-1 p-0.5" />
        <button>{translate("labels.save")}</button>
        <button type="button" className="secondary" onClick={() => setEditing(null)}>{translate("settings.cancel")}</button>
      </form> : <>
        <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: label.color }} /><span className="flex-1 truncate">{label.name}</span>
        {canAdmin && <>
          <button type="button" className="secondary" onClick={() => setEditing({ id: label.id, name: label.name, color: label.color })}>{translate("labels.edit")}</button>
          <button type="button" className="secondary" onClick={async () => guard(await action("delete_label", { labelId: label.id }))}>{translate("labels.delete")}</button>
        </>}
      </>}
    </Row>)}</RowList>}
    <Note note={note} error />
  </section>;
}

const groupDot: Record<(typeof stateGroups)[number], string> = { backlog: "#a3a3a3", unstarted: "#737373", started: "#f59e0b", completed: "#16a34a", cancelled: "#dc2626" };

export function ProjectStates() {
  const { project } = useProject();
  const canAdmin = canAdminOf(project);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [newName, setNewName] = React.useState<Record<string, string>>({});
  const [editing, setEditing] = React.useState<{ id: string; name: string } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setStates(await action<WorkState[]>("list_states", { projectId: project.id }) ?? []), [project.id]);
  React.useEffect(() => { void load(); }, [load]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("states.failed") : null); await load(); return result !== null; };
  return <section>
    <SettingsHeader title={translate("states.title")} description={translate("settings.statesDesc")} />
    {stateGroups.map((group) => {
      const inGroup = states.filter((state) => state.group === group);
      const move = (index: number, delta: number) => {
        const ids = inGroup.map((state) => state.id);
        [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
        return action("reorder_states", { projectId: project.id, group, stateIds: ids });
      };
      return <SettingsBlock key={group}>
        <h3 className="flex items-center gap-2 text-14 font-medium text-secondary"><span aria-hidden className="size-2.5 rounded-full" style={{ background: groupDot[group] }} />{translate(`states.group.${group}`)}</h3>
        {inGroup.length > 0 && <RowList>{inGroup.map((state, index) => <Row key={state.id}>
          {editing?.id === state.id ? <form className="my-0 flex flex-1 flex-wrap items-center gap-2" onSubmit={async (event) => { event.preventDefault(); if (await guard(await action("update_state", { stateId: state.id, name: editing.name }))) setEditing(null); }}>
            <input required aria-label={translate("states.name")} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
            <button>{translate("labels.save")}</button>
            <button type="button" className="secondary" onClick={() => setEditing(null)}>{translate("settings.cancel")}</button>
          </form> : <>
            <span className="flex-1 truncate">{state.name}</span>
            {canAdmin && <>
              <button type="button" className="secondary" disabled={index === 0} onClick={async () => guard(await move(index, -1))}>{translate("states.moveUp")}</button>
              <button type="button" className="secondary" disabled={index === inGroup.length - 1} onClick={async () => guard(await move(index, 1))}>{translate("states.moveDown")}</button>
              <button type="button" className="secondary" onClick={() => setEditing({ id: state.id, name: state.name })}>{translate("states.rename")}</button>
              <button type="button" className="secondary" onClick={async () => guard(await action("delete_state", { stateId: state.id }))}>{translate("states.remove")}</button>
            </>}
          </>}
        </Row>)}</RowList>}
        {canAdmin && <form className="my-0 flex flex-wrap items-end gap-3" onSubmit={async (event) => {
          event.preventDefault();
          if (await guard(await action("create_state", { projectId: project.id, group, name: newName[group] ?? "" }))) setNewName({ ...newName, [group]: "" });
        }}>
          <label>{translate("states.name")}<input required value={newName[group] ?? ""} onChange={(event) => setNewName({ ...newName, [group]: event.target.value })} /></label>
          <button>{translate("states.add")}</button>
        </form>}
      </SettingsBlock>;
    })}
    <Note note={note} error />
  </section>;
}

export function ProjectFeatures() {
  const { project, reload } = useProject();
  const canAdmin = canAdminOf(project);
  const [note, setNote] = React.useState<string | null>(null);
  const toggle = async (feature: ProjectFeatureKey, enabled: boolean) => {
    const result = await action("set_project_features", { projectId: project.id, features: { [feature]: enabled } });
    await reload(); // also refreshes the sidebar, so the menu appears or disappears at once
    setNote(result === null ? translate("features.failed") : null);
  };
  return <section>
    <SettingsHeader title={translate("settings.features")} description={translate("settings.featuresDesc")} />
    <RowList>{projectFeatureKeys.map((feature) => <Row key={feature}>
      <span className="grid flex-1"><span className="font-medium">{translate(`features.${feature}` as MessageKey)}</span><span className="text-13 text-secondary">{translate(`features.${feature}Desc` as MessageKey)}</span></span>
      <label className="flex-row items-center gap-2"><input type="checkbox" role="switch" disabled={!canAdmin} checked={project.features[feature]} aria-label={translate(`features.${feature}` as MessageKey)} onChange={(event) => void toggle(feature, event.target.checked)} /></label>
    </Row>)}</RowList>
    <Note note={note} error />
  </section>;
}
