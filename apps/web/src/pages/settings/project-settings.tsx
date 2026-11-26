import { Button } from "@/ui/button";
import React from "react";
import { Link, Outlet, useNavigate } from "react-router";
import { MoreHorizontal } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "../../api";
import { paths } from "../../routes";
import { projectFeatureKeys, type ProjectFeatureKey } from "../../project-nav";
import { useProject, useRouteProject, type ProjectContext } from "../../layouts/project-layout";
import { useWorkspace } from "../../layouts/workspace-layout";
import { Avatar } from "../../avatar";
import { SortableList, SortMenu } from "../../sortable-list";
import { Popover, menuItemClass } from "../../shell/popover";
import { roles, stateGroupColors, stateGroups, type Label, type Member, type Project, type WorkState } from "../../types";
import { ProjectMergeSetting } from "./project-merge-setting";
import { dangerOutline, DangerZone, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";
import { WorkItemTypesSettings } from "./project-work-item-types";

import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";
/** Loads the project of `/settings/projects/:projectKey` and renders the routed section; the project name heads every section. */
export function ProjectSettingsLayout() {
  const { workspace } = useWorkspace();
  const { project, reload } = useRouteProject();
  if (project === undefined) return null;
  if (project === null) return <section><p role="alert">{translate("projects.notFound")}</p><Link to={paths.workspaceSettings(workspace.slug)}>{translate("settings.workspaceTitle")}</Link></section>;
  return <div className="w-full min-w-0">
    <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><Link to={paths.workItems(workspace.slug, project.key)}>{project.key} · {project.name}</Link>
      {project.archived && <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">{translate("projects.archivedBadge")}</span>}</p>
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
  const [visibility, setVisibility] = React.useState<Project["visibility"]>(project.visibility);
  const [renaming, setRenaming] = React.useState(false);
  const [newKey, setNewKey] = React.useState(project.key);
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const done = async (result: unknown, ok: MessageKey = "settings.saved") => { setNote(translate(result === null ? "projects.failed" : ok)); setFailed(result === null); await reload(); };
  const cancelRename = () => { setNewKey(project.key); setRenaming(false); };
  return <section>
    <SettingsHeader title={translate("settings.general")} description={translate("settings.projectGeneralDesc")} />
    <SettingsBlock title={translate("settings.generalInfo")}>
      <form className="my-0 max-w-md" onSubmit={async (event) => { event.preventDefault(); await done(await action("update_project", { projectId: project.id, name, visibility })); }}>
        <label>{translate("projects.name")}<Input required disabled={!canAdmin} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>{translate("projects.visibility")}<select disabled={!canAdmin} value={visibility} onChange={(event) => setVisibility(event.target.value as Project["visibility"])}>
          <option value="public">{translate("projects.visibility.public")}</option>
          <option value="private">{translate("projects.visibility.private")}</option>
        </select></label>
        {canAdmin && <div><Button>{translate("projects.save")}</Button></div>}
      </form>
    </SettingsBlock>
    <SettingsBlock title={translate("projects.key")} description={translate("projects.aliasNote")}>
      {renaming ? <form className="my-0 max-w-md" onSubmit={async (event) => {
        event.preventDefault();
        const result = await action<Project>("rename_project_key", { projectId: project.id, key: newKey });
        if (result) { setRenaming(false); navigate(paths.projectSettings(workspace.slug, result.key), { replace: true }); } else await done(null);
      }}>
        <label>{translate("projects.key")}<Input required autoFocus pattern="[A-Z][A-Z0-9]{1,11}" title={translate("projects.keyHint")} value={newKey} onChange={(event) => setNewKey(event.target.value.toUpperCase())} /></label>
        <div className="mt-3 flex flex-wrap gap-2"><Button>{translate("projects.renameConfirm")}</Button><Button type="button" onClick={cancelRename}>{translate("settings.cancel")}</Button></div>
      </form> : <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm text-foreground">{project.key}</span>
        {canAdmin && <Button type="button" onClick={() => setRenaming(true)}>{translate("projects.renameKey")}</Button>}
      </div>}
    </SettingsBlock>
    <Note note={note} error={failed} />
    {canAdmin && <DangerZone heading={project.archived ? "projects.unarchive" : "projects.archive"} description={translate(project.archived ? "settings.unarchiveDesc" : "settings.archiveDesc")}>
      <Button type="button" className={project.archived ? undefined : dangerOutline} onClick={async () => done(await action(project.archived ? "unarchive_project" : "archive_project", { projectId: project.id }))}>
        {translate(project.archived ? "projects.unarchive" : "projects.archive")}</Button>
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
  const [addRole, setAddRole] = React.useState<(typeof roles)[number]>("Member");
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
      <Avatar name={member.name} id={member.userId} agent={member.isAgent} />
      <span className="grid min-w-0 flex-1"><span className="thai-room truncate font-medium">{member.name}</span><span className="truncate text-sm text-muted-foreground">{member.email}</span></span>
      {canAdmin && !member.isAgent ? <select aria-label={`${translate("settings.roleOf")} ${member.name}`} value={member.role} onChange={async (event) => guard(await action("change_project_member_role", { projectId: project.id, userId: member.userId, role: event.target.value }))}>
        {roles.map((role) => <option key={role} value={role}>{translate(`projects.role.${role}`)}</option>)}
      </select> : <span className="text-muted-foreground">{translate(`projects.role.${member.role}`)}</span>}
      {canAdmin && !member.isAgent && <Button type="button" className="hover:!text-destructive" onClick={async () => guard(await action("remove_project_member", { projectId: project.id, userId: member.userId }))}>{translate("members.remove")}</Button>}
    </Row>)}</RowList>
    {canAdmin && <SettingsBlock title={translate("projects.addMember")} description={translate("projects.addMemberDesc")}>
      <div className="flex flex-wrap items-center gap-3">
        <select className="min-w-56" aria-label={translate("projects.addMember")} value={addUser} onChange={(event) => setAddUser(event.target.value)}>
          <option value="">{translate("projects.selectMember")}</option>
          {candidates.filter((candidate) => !candidate.isAgent && !members.some((member) => member.userId === candidate.userId)).map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.name} · {candidate.email}</option>)}
        </select>
        <select aria-label={translate("projects.newMemberRole")} value={addRole} onChange={(event) => setAddRole(event.target.value as typeof addRole)}>
          {roles.map((role) => <option key={role} value={role}>{translate(`projects.role.${role}`)}</option>)}
        </select>
        <Button type="button" disabled={!addUser} onClick={async () => { await guard(await action("add_project_member", { projectId: project.id, userId: addUser, role: addRole })); setAddUser(""); }}>{translate("projects.addMember")}</Button>
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
  const [labelQuery, setLabelQuery] = React.useState("");
  const load = React.useCallback(async () => setLabels(await action<Label[]>("list_labels", { projectId: project.id }) ?? []), [project.id]);
  React.useEffect(() => { void load(); }, [load]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("workItems.failed") : null); await load(); return result !== null; };
  const visibleLabels = labels.filter((label) => label.name.toLocaleLowerCase().includes(labelQuery.trim().toLocaleLowerCase()));
  // The order is the whole list's: with a search filter on, a drag or Move would only see some of the labels, so it waits until the filter is cleared.
  const reorderable = canAdmin && labelQuery.trim() === "";
  const reorderLabels = async (ids: string[]) => {
    setLabels((current) => ids.flatMap((id) => current.find((label) => label.id === id) ?? []));
    await guard(await action("reorder_labels", { projectId: project.id, labelIds: ids }));
  };
  return <section>
    <SettingsHeader title={translate("labels.title")} description={translate("settings.labelsDesc")} />
    {canAdmin && <form className="mb-5 mt-0 flex flex-wrap items-end gap-3" onSubmit={async (event) => { event.preventDefault(); if (await guard(await action("create_label", { projectId: project.id, name, color }))) setName(""); }}>
      <label>{translate("labels.name")}<Input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <input type="color" aria-label={translate("labels.color")} value={color} onChange={(event) => setColor(event.target.value)} className="h-8 w-10 rounded-md border border-border bg-card p-0.5" />
      <Button>{translate("labels.create")}</Button>
    </form>}
    {labels.length === 0 ? <p className="text-muted-foreground">{translate("labels.empty")}</p> : <>
    <search className="mb-3 block"><label className="grid max-w-sm gap-1 text-sm text-muted-foreground">{translate("picker.search")}<Input type="search" autoComplete="off" value={labelQuery} onChange={(event) => setLabelQuery(event.target.value)} /></label></search>
    {visibleLabels.length === 0 ? <p className="text-muted-foreground">{translate("picker.noMatches")}</p> : <SortableList ids={visibleLabels.map((label) => label.id)} disabled={!reorderable || editing !== null} label={(id) => labels.find((label) => label.id === id)?.name ?? ""}
      onReorder={reorderLabels}
      renderRow={(id, grip) => {
        const label = labels.find((candidate) => candidate.id === id)!;
        const index = labels.indexOf(label);
        const moveLabel = (delta: -1 | 1) => {
          const ids = labels.map((candidate) => candidate.id);
          [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
          void reorderLabels(ids);
        };
        return <>
          {canAdmin && grip}
        {editing?.id === label.id ? <form className="my-0 flex flex-1 flex-wrap items-center gap-2" onSubmit={async (event) => { event.preventDefault(); if (await guard(await action("update_label", { labelId: label.id, name: editing.name, color: editing.color }))) setEditing(null); }}>
          <Input required aria-label={translate("labels.name")} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
          <input type="color" aria-label={translate("labels.color")} value={editing.color} onChange={(event) => setEditing({ ...editing, color: event.target.value })} className="h-8 w-10 rounded-md border border-border bg-card p-0.5" />
          <Button>{translate("labels.save")}</Button>
          <Button type="button" onClick={() => setEditing(null)}>{translate("settings.cancel")}</Button>
        </form> : <>
          <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: label.color }} /><span className="flex-1 thai-room truncate">{label.name}</span>
          {canAdmin && <>
            <Button type="button" onClick={() => setEditing({ id: label.id, name: label.name, color: label.color })}>{translate("labels.edit")}</Button>
            <Button type="button" onClick={async () => guard(await action("delete_label", { labelId: label.id }))}>{translate("labels.delete")}</Button>
            <SortMenu name={label.name} canUp={reorderable && index > 0} canDown={reorderable && index < labels.length - 1} onMove={moveLabel} />
          </>}
        </>}
        </>;
      }} />}</>}
    <Note note={note} error />
  </section>;
}


export function ProjectStates() {
  const { project } = useProject();
  const groupLabelId = React.useId();
  const addStateButton = React.useRef<HTMLButtonElement>(null);
  const canAdmin = canAdminOf(project);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [newName, setNewName] = React.useState("");
  const [newGroup, setNewGroup] = React.useState<(typeof stateGroups)[number] | "">("");
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<{ id: string; name: string } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setStates(await action<WorkState[]>("list_states", { projectId: project.id }) ?? []), [project.id]);
  React.useEffect(() => { void load(); }, [load]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("states.failed") : null); await load(); return result !== null; };
  // The form unmounts on close, so focus goes back to the Add state button instead of falling to <body>.
  const closeAdd = () => { setNewName(""); setNewGroup(""); setAdding(false); requestAnimationFrame(() => addStateButton.current?.focus()); };
  const createState = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newGroup && await guard(await action("create_state", { projectId: project.id, group: newGroup, name: newName }))) closeAdd();
  };
  return <section>
    <SettingsHeader title={translate("states.title")} description={translate("settings.statesDesc")} />
    {canAdmin && <div className="mb-5 grid justify-items-start gap-3">
      <Button ref={addStateButton} type="button" data-testid="add-state" className="pointer-coarse:min-h-11" aria-expanded={adding} onClick={() => setAdding(!adding)}>{translate("states.add")}</Button>
      {adding && <form className="my-0 flex flex-wrap items-end gap-3" onSubmit={(event) => void createState(event)}>
        <label><span id={groupLabelId}>{translate("analytics.axis.stateGroup")}</span><select aria-labelledby={groupLabelId} required autoFocus className="h-9 min-w-40 pointer-coarse:min-h-11" value={newGroup} onChange={(event) => setNewGroup(event.target.value as (typeof stateGroups)[number])}>
          <option value="" disabled hidden />
          {stateGroups.map((group) => <option key={group} value={group}>{translate(`states.group.${group}`)}</option>)}
        </select></label>
        <label>{translate("states.name")}<Input required value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
        <Button className="pointer-coarse:min-h-11">{translate("states.create")}</Button>
        <Button type="button" className="pointer-coarse:min-h-11" onClick={closeAdd}>{translate("settings.cancel")}</Button>
      </form>}
    </div>}
    {stateGroups.map((group) => {
      const inGroup = states.filter((state) => state.group === group);
      const reorder = (ids: string[]) => action("reorder_states", { projectId: project.id, group, stateIds: ids });
      const move = (index: number, delta: number) => {
        const ids = inGroup.map((state) => state.id);
        [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
        return reorder(ids);
      };
      return <section key={group} className="mb-6 grid gap-2">
        <h2 className="m-0 flex items-center gap-2 text-sm font-medium text-muted-foreground"><span aria-hidden className="size-2.5 rounded-full" style={{ background: stateGroupColors[group] }} />{translate(`states.group.${group}`)}</h2>
        {inGroup.length > 0 && <SortableList ids={inGroup.map((state) => state.id)} disabled={!canAdmin || editing !== null} gripClassName="border-0 shadow-none pointer-coarse:size-11" label={(id) => inGroup.find((state) => state.id === id)?.name ?? ""}
          onReorder={async (ids) => { setStates((current) => [...current.filter((state) => state.group !== group), ...ids.map((id) => current.find((state) => state.id === id)!)]); await guard(await reorder(ids)); }}
          renderRow={(id, grip) => {
            const state = inGroup.find((candidate) => candidate.id === id)!;
            const index = inGroup.indexOf(state);
            return <>
              {canAdmin && grip}
              {editing?.id === state.id ? <form className="my-0 flex flex-1 flex-wrap items-center gap-2" onSubmit={async (event) => { event.preventDefault(); if (await guard(await action("update_state", { stateId: state.id, name: editing.name }))) setEditing(null); }}>
                <Input required aria-label={translate("states.name")} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
                <Button className="pointer-coarse:min-h-11">{translate("labels.save")}</Button>
                <Button type="button" className="pointer-coarse:min-h-11" onClick={() => setEditing(null)}>{translate("settings.cancel")}</Button>
              </form> : <>
                <span className="min-w-0 flex-1 thai-room truncate">{state.name}</span>
                {canAdmin && <Popover label={`${translate("sortable.actions")}: ${state.name}`} align="right" trigger={<MoreHorizontal aria-hidden size={16} />} panelClassName="w-44">
                  {(close) => <>
                    <Button type="button" role="menuitem" className={menuItemClass} disabled={index === 0} onClick={async () => { close(); await guard(await move(index, -1)); }}>{translate("states.moveUp")}</Button>
                    <Button type="button" role="menuitem" className={menuItemClass} disabled={index === inGroup.length - 1} onClick={async () => { close(); await guard(await move(index, 1)); }}>{translate("states.moveDown")}</Button>
                    <Button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); setEditing({ id: state.id, name: state.name }); }}>{translate("states.rename")}</Button>
                    <Button type="button" role="menuitem" className={`${menuItemClass} text-destructive`} onClick={async () => { close(); await guard(await action("delete_state", { stateId: state.id })); }}>{translate("states.remove")}</Button>
                  </>}
                </Popover>}
              </>}
            </>;
          }} />}
      </section>;
    })}
    <Note note={note} error />
  </section>;
}

export function ProjectFeatures() {
  const { project, reload } = useProject();
  const canAdmin = canAdminOf(project);
  const [note, setNote] = React.useState<string | null>(null);
  /** A switch-off of Pages or Views waits here until the admin has seen what it hides. */
  const [pending, setPending] = React.useState<{ feature: "pages" | "views"; names: string[] } | null>(null);
  const save = async (feature: ProjectFeatureKey, enabled: boolean) => {
    const result = await action("set_project_features", { projectId: project.id, features: { [feature]: enabled } });
    await reload(); // also refreshes the sidebar, so the menu appears or disappears at once
    setNote(result === null ? translate("features.failed") : null);
  };
  const requestChange = async (feature: ProjectFeatureKey, enabled: boolean) => {
    if (!enabled && (feature === "pages" || feature === "views")) {
      const names = feature === "pages"
        ? ((await action<Array<{ title: string }>>("list_project_wiki_pages", { projectId: project.id })) ?? []).map((row) => row.title)
        : ((await action<Array<{ name: string }>>("list_views", { projectId: project.id })) ?? []).map((row) => row.name);
      if (names.length > 0) return setPending({ feature, names });
    }
    setPending(null);
    await save(feature, enabled);
  };
  return <section>
    <SettingsHeader title={translate("settings.features")} description={translate("settings.featuresDesc")} />
    <p className="m-0 text-sm text-muted-foreground">{translate("features.adminOnly")}</p>
    <RowList>{projectFeatureKeys.map((feature) => <Row key={feature}>
      <span className="grid flex-1 gap-0.5">
        <span className="font-medium">{translate(`features.${feature}` as MessageKey)}</span>
        <span className="text-sm text-muted-foreground">{translate(`features.${feature}Desc` as MessageKey)}</span>
        <span className="text-xs text-muted-foreground">{translate(`features.${feature}Suits` as MessageKey)}</span>
        {pending?.feature === feature && <span role="group" aria-label={translate("features.confirmOffHeading")} className="mt-2 grid gap-2 rounded-md border border-border bg-muted p-3">
          <span className="font-medium">{translate("features.confirmOffHeading")}</span>
          <span className="text-sm text-muted-foreground">{translate("features.confirmOffBody")}</span>
          <span className="text-sm text-muted-foreground">{translate("features.confirmOffInUse")} {pending.names.join(", ")}</span>
          <span className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void save(feature, false).then(() => setPending(null))}>{translate("features.confirmTurnOff")}</Button>
            <Button type="button" onClick={() => setPending(null)}>{translate("features.confirmKeep")}</Button>
          </span>
        </span>}
      </span>
      <label className="flex-row items-center gap-2"><Switch disabled={!canAdmin} checked={project.features[feature]} aria-label={translate(`features.${feature}` as MessageKey)} onChange={(event) => void requestChange(feature, event.target.checked)} /></label>
    </Row>)}</RowList>
    {project.features.types && <div className="mt-6"><WorkItemTypesSettings project={project} /></div>}
    <ProjectMergeSetting projectId={project.id} canAdmin={canAdmin} onNote={setNote} />
    <Note note={note} error />
  </section>;
}

type AutoRuleSettings = { autoCloseAfterDays: number | null; autoCloseFromStateIds: string[]; autoCloseToStateId: string | null; autoArchiveAfterDays: number | null };
const openGroups = ["backlog", "unstarted", "started"];
const closedGroups = ["completed", "cancelled"];

/** Automatic closing and archiving: off by default, a dry-run preview, and the same rules the daily run applies. */
export function ProjectAutomation() {
  const { project } = useProject();
  const canAdmin = canAdminOf(project);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [closeOn, setCloseOn] = React.useState(false);
  const [closeAfter, setCloseAfter] = React.useState("30");
  const [watched, setWatched] = React.useState<string[]>([]);
  const [target, setTarget] = React.useState("");
  const [archiveOn, setArchiveOn] = React.useState(false);
  const [archiveAfter, setArchiveAfter] = React.useState("30");
  const [preview, setPreview] = React.useState<{ toClose: number; toArchive: number } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    void Promise.all([action<WorkState[]>("list_states", { projectId: project.id }), action<AutoRuleSettings>("get_auto_rules", { projectId: project.id })]).then(([list, current]) => {
      setStates(list ?? []);
      if (!current) return;
      setCloseOn(current.autoCloseAfterDays !== null);
      setCloseAfter(String(current.autoCloseAfterDays ?? 30));
      setWatched(current.autoCloseFromStateIds);
      setTarget(current.autoCloseToStateId ?? "");
      setArchiveOn(current.autoArchiveAfterDays !== null);
      setArchiveAfter(String(current.autoArchiveAfterDays ?? 30));
    });
  }, [project.id]);
  const openStates = states.filter((state) => openGroups.includes(state.group));
  const closingStates = states.filter((state) => closedGroups.includes(state.group));
  const payload = () => ({
    projectId: project.id,
    autoCloseAfterDays: closeOn ? Number(closeAfter) : null,
    autoCloseFromStateIds: closeOn ? watched : [],
    autoCloseToStateId: closeOn && target ? target : null,
    autoArchiveAfterDays: archiveOn ? Number(archiveAfter) : null,
  });
  const toggleWatched = (id: string) => setWatched((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  return <section>
    <SettingsHeader title={translate("autoRules.title")} description={translate("autoRules.desc")} />
    <form className="my-0 grid max-w-2xl gap-6" onSubmit={async (event) => {
      event.preventDefault();
      const result = await action<AutoRuleSettings>("update_auto_rules", payload());
      setFailed(result === null);
      setNote(translate(result === null ? "autoRules.failed" : "autoRules.saved"));
      setPreview(null);
    }}>
      <SettingsBlock title={translate("autoRules.closeTitle")} description={translate("autoRules.closeDesc")}>
        <label className="flex items-center gap-2"><Switch disabled={!canAdmin} checked={closeOn} onChange={(event) => setCloseOn(event.target.checked)} />{translate("autoRules.closeOn")}</label>
        <label>{translate("autoRules.closeAfter")}<Input type="number" min={1} max={3650} required={closeOn} disabled={!canAdmin || !closeOn} value={closeAfter} onChange={(event) => setCloseAfter(event.target.value)} className="max-w-32" /></label>
        <fieldset className="grid gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-muted-foreground">{translate("autoRules.watchStates")}</legend>
          {openStates.length === 0 ? <p className="text-muted-foreground">{translate("autoRules.noOpenStates")}</p> : openStates.map((state) => <label key={state.id} className="flex items-center gap-2">
            <Checkbox disabled={!canAdmin || !closeOn} checked={watched.includes(state.id)} onChange={() => toggleWatched(state.id)} />{state.name}</label>)}
        </fieldset>
        <label>{translate("autoRules.moveTo")}
          <select disabled={!canAdmin || !closeOn} value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">{translate("autoRules.pickState")}</option>
            {closingStates.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
          </select>
        </label>
      </SettingsBlock>
      <SettingsBlock title={translate("autoRules.archiveTitle")} description={translate("autoRules.archiveDesc")}>
        <label className="flex items-center gap-2"><Switch disabled={!canAdmin} checked={archiveOn} onChange={(event) => setArchiveOn(event.target.checked)} />{translate("autoRules.archiveOn")}</label>
        <label>{translate("autoRules.archiveAfter")}<Input type="number" min={1} max={3650} required={archiveOn} disabled={!canAdmin || !archiveOn} value={archiveAfter} onChange={(event) => setArchiveAfter(event.target.value)} className="max-w-32" /></label>
      </SettingsBlock>
      {preview && <p role="status" className="text-sm text-foreground">{translate("autoRules.previewResult").replace("{close}", String(preview.toClose)).replace("{archive}", String(preview.toArchive))}</p>}
      {canAdmin && <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={async () => {
          const result = await action<{ toClose: number; toArchive: number }>("preview_auto_rules", payload());
          setPreview(result);
          setFailed(result === null);
          setNote(result === null ? translate("autoRules.previewFailed") : null);
        }}>{translate("autoRules.preview")}</Button>
        <Button>{translate("autoRules.save")}</Button>
      </div>}
    </form>
    <Note note={note} error={failed} />
  </section>;
}
