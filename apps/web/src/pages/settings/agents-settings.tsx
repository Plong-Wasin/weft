import React from "react";
import { Link } from "react-router";
import { formatDate, formatNumber, translate } from "@weft/shared";
import { action, actionResult } from "../../api";
import { matchesProjectSearch } from "../../shell/project-preferences";
import { Avatar } from "../../avatar";
import { capitalize, profileSummary, runtimeParts } from "../../agent-labels";
import { useWorkspace } from "../../layouts/workspace-layout";
import { paths } from "../../routes";
import type { Member, Project } from "../../types";
import { dangerOutline, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

export type AgentRecord = {
  id: string; userId: string; name: string; instructions: string; model: string; enabled: boolean; allProjects: boolean; projectIds: string[]; accessUserIds: string[];
  runtimeId: string | null; runtimeName: string | null; runtimeHostname?: string | null; runtimeCli?: string | null; runtimeOwnerName: string | null; runtimeShared: boolean; runtimeOnline: boolean; runtimeProfileId: string | null; runtimeProfileName: string | null; runtimeProfileSandbox: string | null; cliModel: string | null; maxConcurrentRuns: number; autopilot: boolean; canWakeAgents: boolean;
  skills: Array<{ id: string; name: string; description: string }>;
  maxToolCalls: number; maxTokens: number; timeoutSeconds: number; monthlyTokenBudget: number | null; monthlyTokensUsed: number;
};
type TriggerEvent = "work_item_created" | "work_item_updated" | "state_changed" | "assignee_changed" | "comment_added" | "sub_items_closed";
type TriggerRow = { id: string; projectId: string; eventType: TriggerEvent | null; schedule: "daily" | "weekly" | "monthly" | "cron" | null; expression: string | null; paused: boolean };

type RuntimeProfile = { id: string; runtimeId: string; name: string; sandbox: string; filesystemAllowlist: string[]; networkAllowlist: string[] };
type RuntimeOption = { id: string; hostname: string; agentCli: string; online: boolean; shared: boolean };
type Draft = { name: string; instructions: string; model: string; autopilot: boolean; canWakeAgents: boolean; maxToolCalls: string; maxTokens: string; timeoutSeconds: string; monthlyTokenBudget: string; runtimeId: string; cliModel: string; maxConcurrentRuns: string };
const emptyDraft: Draft = { name: "", instructions: "", model: "default", autopilot: false, canWakeAgents: false, maxToolCalls: "", maxTokens: "", timeoutSeconds: "", monthlyTokenBudget: "", runtimeId: "", cliModel: "", maxConcurrentRuns: "6" };
const toDraft = (agent: AgentRecord): Draft => ({
  name: agent.name, instructions: agent.instructions, model: agent.model, autopilot: agent.autopilot, canWakeAgents: agent.canWakeAgents, maxToolCalls: String(agent.maxToolCalls), maxTokens: String(agent.maxTokens),
  timeoutSeconds: String(agent.timeoutSeconds), monthlyTokenBudget: agent.monthlyTokenBudget === null ? "" : String(agent.monthlyTokenBudget),
  runtimeId: agent.runtimeId ?? "", cliModel: agent.cliModel ?? "", maxConcurrentRuns: String(agent.maxConcurrentRuns),
});
const optionalInt = (value: string) => value.trim() === "" ? undefined : Number(value);

function AgentForm({ draft, onChange, onSubmit, onCancel, runtimes, allowAutopilot }: { draft: Draft; onChange: (draft: Draft) => void; onSubmit: () => void; onCancel?: () => void; runtimes: RuntimeOption[]; allowAutopilot: boolean }) {
  const { workspace } = useWorkspace();
  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange({ ...draft, [key]: event.target.value });
  const number = (key: "maxToolCalls" | "maxTokens" | "timeoutSeconds" | "monthlyTokenBudget", label: Parameters<typeof translate>[0]) =>
    <label>{translate(label)}<input type="number" min={1} value={draft[key]} onChange={set(key)} /></label>;
  const selectable = runtimes.filter((runtime) => runtime.shared);
  return <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <label>{translate("agents.name")}<input required maxLength={100} value={draft.name} onChange={set("name")} /></label>
    <label>{translate("agents.instructions")}<textarea rows={4} value={draft.instructions} onChange={set("instructions")} /></label>
    <label>{translate("agents.model")}<input required value={draft.model} onChange={set("model")} /></label>
    <fieldset className="grid gap-1 border-0 p-0"><label className="flex items-center gap-2"><input type="checkbox" checked={draft.autopilot || !!draft.runtimeId} disabled={!!draft.runtimeId || !allowAutopilot} onChange={(event) => onChange({ ...draft, autopilot: event.target.checked })} />{translate("agents.autopilot")}</label><small className="text-12 text-secondary">{translate(draft.runtimeId ? "agents.runtimeAutopilot" : "agents.autopilotRisk")}</small></fieldset>
    <label>{translate("agents.runsOn")}<select value={draft.runtimeId} onChange={(event) => { const next = event.target.value; onChange({ ...draft, runtimeId: next, autopilot: next ? true : (allowAutopilot ? draft.autopilot : false) }); }}><option value="">{translate("agents.server")}</option>{selectable.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.hostname} · {runtime.agentCli} · {translate(runtime.online ? "runtimes.online" : "runtimes.offline")}</option>)}</select></label>
    {selectable.length === 0 && (runtimes.length > 0
      ? <Link to={paths.workspaceRuntimes(workspace.slug)} className="text-13 text-accent-text underline">{translate("agents.shareRuntimeLink")}</Link>
      : <Link to={paths.workspaceConnectAi(workspace.slug)} className="text-13 text-accent-text underline">{translate("runtimes.connectLink")}</Link>)}
    {draft.runtimeId && <small className="text-12 text-secondary">{translate("agents.runtimeProfileHelp")}</small>}
    <fieldset className="grid gap-1 border-0 p-0"><label className="flex items-center gap-2"><input type="checkbox" checked={draft.canWakeAgents} onChange={(event) => onChange({ ...draft, canWakeAgents: event.target.checked })} />{translate("agents.canWakeAgents")}</label><small className="text-12 text-secondary">{translate("agents.canWakeAgentsHelp")}</small></fieldset>
    {draft.runtimeId && <div className="grid gap-3 sm:grid-cols-2"><label>{translate("agents.cliModel")}<input value={draft.cliModel} onChange={set("cliModel")} /></label><label>{translate("agents.concurrency")}<input type="number" min={1} max={20} value={draft.maxConcurrentRuns} onChange={set("maxConcurrentRuns")} /></label></div>}
    <details className="grid gap-3">
      <summary className="cursor-pointer text-13 font-medium text-secondary">{translate("agents.limits")}</summary>
      <div className="grid gap-3 sm:grid-cols-2">
        {number("maxToolCalls", "agents.maxToolCalls")}{number("maxTokens", "agents.maxTokens")}
        {number("timeoutSeconds", "agents.timeoutSeconds")}{number("monthlyTokenBudget", "agents.monthlyBudget")}
      </div>
    </details>
    <div className="flex gap-2"><button type="submit">{translate("agents.save")}</button>{onCancel && <button type="button" className="secondary" onClick={onCancel}>{translate("agents.cancel")}</button>}</div>
  </form>;
}

/** Choose which projects an Agent is open to: opening a project makes the Agent a Member of it. */
function AccessEditor({ agent, projects, onSaved, onFailed }: { agent: AgentRecord; projects: Project[]; onSaved: () => void; onFailed: () => void }) {
  const [draft, setDraft] = React.useState({ allProjects: agent.allProjects, projectIds: agent.projectIds });
  const [base, setBase] = React.useState({ allProjects: agent.allProjects, projectIds: agent.projectIds });
  const [saving, setSaving] = React.useState(false);
  const [projectQuery, setProjectQuery] = React.useState("");
  const visibleProjects = projects.filter((project) => matchesProjectSearch(project, projectQuery));
  const dirty = draft.allProjects !== base.allProjects || [...draft.projectIds].sort().join() !== [...base.projectIds].sort().join();
  const save = async () => {
    setSaving(true);
    const result = await action<{ allProjects: boolean; projectIds: string[] }>("set_agent_project_access", { agentId: agent.id, ...draft, baseAllProjects: base.allProjects, baseProjectIds: base.projectIds });
    setSaving(false);
    if (result === null) return onFailed();
    const saved = { allProjects: result.allProjects, projectIds: result.projectIds };
    setDraft(saved);
    setBase(saved);
    onSaved();
  };
  return <fieldset className="grid gap-1 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("agents.access")}</legend>
    <label className="flex items-center gap-2"><input type="checkbox" checked={draft.allProjects} onChange={(event) => setDraft({ ...draft, allProjects: event.target.checked, projectIds: event.target.checked ? [] : draft.projectIds })} />{translate("agents.allProjects")}</label>
    {!draft.allProjects && <>
      <label className="grid gap-1 text-12 font-medium text-secondary">{translate("projects.find")}
        <input type="search" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder={translate("projects.searchPlaceholder")} className="px-2 py-1 text-13" />
      </label>
      {visibleProjects.map((project) => <label key={project.id} className="flex items-center gap-2">
        <input type="checkbox" checked={draft.projectIds.includes(project.id)} onChange={(event) => setDraft({ ...draft, projectIds: event.target.checked ? [...draft.projectIds, project.id] : draft.projectIds.filter((entry) => entry !== project.id) })} />{project.key} · {project.name}</label>)}
      {visibleProjects.length === 0 && projectQuery.trim() && <p role="status" className="m-0 text-12 text-secondary">{translate("projects.noSearchResults")}</p>}
    </>}
    <button type="button" disabled={!dirty || saving} onClick={() => void save()}>{translate("agents.save")}</button>
  </fieldset>;
}

function AgentPeopleAccess({ agent, members, onSaved, onFailed }: { agent: Pick<AgentRecord, "id" | "runtimeId" | "accessUserIds">; members: Member[]; onSaved: () => void; onFailed: () => void }) {
  const [draft, setDraft] = React.useState(agent.accessUserIds);
  const [base, setBase] = React.useState(agent.accessUserIds);
  const [saving, setSaving] = React.useState(false);
  const dirty = [...draft].sort().join() !== [...base].sort().join();
  const save = async () => {
    setSaving(true);
    const result = await action<{ accessUserIds: string[] }>("set_agent_access", { agentId: agent.id, userIds: draft, baseUserIds: base });
    setSaving(false);
    if (result === null) return onFailed();
    setDraft(result.accessUserIds);
    setBase(result.accessUserIds);
    onSaved();
  };
  return <fieldset className="grid gap-1 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("agents.peopleAccess")}</legend>
    <p className="text-12 text-secondary">{translate(agent.runtimeId ? "agents.runtimeOwnerAccess" : "agents.adminAccess")}</p>
    {members.filter((member) => !member.isAgent).map((member) => <label key={member.userId} className="flex items-center gap-2">
      <input type="checkbox" aria-label={`${translate("agents.mayUse")} ${member.name}`} checked={draft.includes(member.userId)} onChange={(event) => setDraft(event.target.checked ? [...draft, member.userId] : draft.filter((id) => id !== member.userId))} />
      <Avatar name={member.name} id={member.userId} />{member.name}
    </label>)}
    <button type="button" disabled={!dirty || saving} onClick={() => void save()}>{translate("agents.save")}</button>
  </fieldset>;
}

function AgentRuntimeProfile({ agent, onSaved, onFailed }: { agent: Pick<AgentRecord, "id" | "runtimeId" | "runtimeProfileId" | "runtimeProfileName" | "runtimeProfileSandbox">; onSaved: () => void; onFailed: () => void }) {
  const [profiles, setProfiles] = React.useState<RuntimeProfile[]>([]);
  const [selected, setSelected] = React.useState(agent.runtimeProfileId ?? "");
  React.useEffect(() => {
    if (!agent.runtimeId) return;
    void action<RuntimeProfile[]>("list_runtime_profiles", { runtimeId: agent.runtimeId }).then((rows) => setProfiles(rows ?? []));
  }, [agent.runtimeId]);
  if (!agent.runtimeId) return null;
  return <fieldset className="grid min-w-0 gap-1 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("agents.runtimeProfile")}</legend>
    <p className="text-12 text-secondary">{translate("agents.runtimeProfileHelp")}</p>
    <div className="flex min-w-0 flex-wrap items-center gap-2"><select className="max-w-full min-w-0" aria-label={translate("agents.runtimeProfile")} value={selected} onChange={(event) => setSelected(event.target.value)}>{!agent.runtimeProfileId && <option value="">{translate("agents.profileDefault")}</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {translate(`runtimes.sandbox.${profile.sandbox}` as never)}{profile.sandbox === "full" ? ` · ${translate("runtimes.fullAccessWarning")}` : ""}</option>)}</select>
      <button type="button" className="secondary" disabled={!selected || selected === agent.runtimeProfileId} onClick={async () => { const result = await action("set_agent_runtime_profile", { agentId: agent.id, profileId: selected }); result === null ? onFailed() : onSaved(); }}>{translate("agents.saveProfile")}</button></div>
  </fieldset>;
}

/** Only the Runtime owner can replace these values; reads return names only, never existing secret values. */
function AgentRuntimeEnvironment({ agent, onFailed }: { agent: Pick<AgentRecord, "id" | "runtimeId">; onFailed: () => void }) {
  const [names, setNames] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<Array<{ key: string; value: string }>>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  React.useEffect(() => {
    if (!agent.runtimeId) return;
    void action<{ variables: string[] }>("get_agent_runtime_environment", { agentId: agent.id }).then((result) => {
      if (result) { setNames(result.variables); setRows(result.variables.length ? result.variables.map((key) => ({ key, value: "" })) : [{ key: "", value: "" }]); }
      setLoaded(true);
    });
  }, [agent.id, agent.runtimeId]);
  if (!agent.runtimeId || !loaded) return null;
  return <fieldset data-runtime-environment className="grid min-w-0 gap-2 border-0 p-0">
    <legend className="text-13 font-medium text-secondary">{translate("agents.runtimeEnvironment")}</legend>
    <p className="text-12 text-secondary">{translate("agents.runtimeEnvironmentHelp")}</p>
    {names.length > 0 && <p className="text-12 text-secondary">{translate("agents.runtimeEnvironmentConfigured").replace("{names}", names.join(", "))}</p>}
    {rows.map((row, index) => <div key={index} className="grid min-w-0 gap-2 sm:grid-cols-2">
      <label>{translate("agents.environmentName")}<input value={row.key} autoComplete="off" onChange={(event) => setRows((current) => current.map((entry, i) => i === index ? { ...entry, key: event.target.value } : entry))} /></label>
      <label>{translate("agents.environmentValue")}<input type="password" autoComplete="new-password" value={row.value} onChange={(event) => setRows((current) => current.map((entry, i) => i === index ? { ...entry, value: event.target.value } : entry))} /></label>
    </div>)}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="secondary" onClick={() => setRows((current) => [...current, { key: "", value: "" }])}>{translate("agents.environmentAdd")}</button>
      <button type="button" disabled={rows.some((row) => !row.key || !row.value)} onClick={async () => {
        const variables = Object.fromEntries(rows.map(({ key, value }) => [key.trim(), value]));
        const result = await action<{ variables: string[] }>("set_agent_runtime_environment", { agentId: agent.id, variables });
        if (!result) { onFailed(); return; }
        setNames(result.variables); setRows(result.variables.map((key) => ({ key, value: "" }))); setSaved(true);
      }}>{translate("agents.environmentSave")}</button>
      <button type="button" className="secondary" disabled={!names.length} onClick={async () => {
        const result = await action<{ variables: string[] }>("set_agent_runtime_environment", { agentId: agent.id, variables: {} });
        if (!result) { onFailed(); return; }
        setNames([]); setRows([{ key: "", value: "" }]); setSaved(false);
      }}>{translate("agents.environmentClear")}</button>
    </div>
    {saved && <p role="status" className="text-12 text-secondary">{translate("agents.environmentSaved")}</p>}
  </fieldset>;
}

/** Why an Agent cannot be deleted: what it wrote, with the biggest kinds first, and Disable as the way out. Focus moves here on open and back to Delete on close. */
function RetirePanel({ agent, counts, onClose, onDisable }: { agent: { id: string; name: string; enabled: boolean }; counts: Record<string, number>; onClose: () => void; onDisable: () => void }) {
  const panel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { panel.current?.focus(); }, []);
  const close = () => { onClose(); document.querySelector<HTMLElement>(`[data-retire-trigger="${agent.id}"]`)?.focus(); };
  const kinds = Object.entries(counts).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  const shown = kinds.slice(0, 5);
  const hidden = kinds.slice(5);
  return <div ref={panel} tabIndex={-1} role="alertdialog" aria-labelledby={`retire-${agent.id}`} onKeyDown={(event) => { if (event.key === "Escape") close(); }} className="grid gap-2 rounded-md border border-danger-strong bg-danger-subtle p-3 outline-none">
    <strong id={`retire-${agent.id}`} className="text-14 text-danger-text">{translate("agents.retire.title").replace("{name}", () => agent.name)}</strong>
    <ul className="m-0 grid list-none gap-0.5 p-0 text-13" data-testid="retire-counts">
      {shown.map(([kind, value]) => <li key={kind}>{translate(`agents.retire.kind.${kind}` as Parameters<typeof translate>[0])}: {value}</li>)}
      {hidden.length > 0 && <li className="text-secondary">{translate("agents.retire.more").replace("{count}", String(hidden.reduce((sum, [, value]) => sum + value, 0)))}</li>}
    </ul>
    <p className="m-0 text-13 text-secondary">{translate(agent.enabled ? "agents.retire.help" : "agents.retire.helpDisabled")}</p>
    <div className="flex flex-wrap gap-2">
      {agent.enabled && <button type="button" onClick={() => { onDisable(); document.querySelector<HTMLElement>(`[data-retire-trigger="${agent.id}"]`)?.focus(); }}>{translate("agents.disable")}</button>}
      <button type="button" className="secondary" onClick={close}>{translate("agents.retire.close")}</button>
    </div>
  </div>;
}

/** Workspace Admins create, configure, enable, disable and delete Agents, and open them to projects. */
export function WorkspaceAgents() {
  const { workspace, selfId } = useWorkspace();
  const [isAdmin, setIsAdmin] = React.useState<boolean | null>(null);
  const [agents, setAgents] = React.useState<AgentRecord[]>([]);
  const [askable, setAskable] = React.useState<Array<{ id: string; name: string; codeCapable: boolean; ownerName: string | null; hasAccess: boolean }>>([]);
  const [ownerAgents, setOwnerAgents] = React.useState<Array<Pick<AgentRecord, "id" | "name" | "runtimeId" | "runtimeProfileId" | "runtimeProfileName" | "runtimeProfileSandbox" | "accessUserIds">>>([]);
  const [manageableAgentIds, setManageableAgentIds] = React.useState<string[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [runtimes, setRuntimes] = React.useState<RuntimeOption[]>([]);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = React.useState(false);
  const [workspaceSkills, setWorkspaceSkills] = React.useState<Array<{ id: string; name: string; description: string }>>([]);
  const [creating, setCreating] = React.useState<Draft>(emptyDraft);
  const [creatingOpen, setCreatingOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<{ id: string; draft: Draft } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  // The Agent whose delete the content check refused, with what it wrote or created.
  const [retiring, setRetiring] = React.useState<{ id: string; counts: Record<string, number> } | null>(null);
  const [allowAutopilot, setAllowAutopilot] = React.useState(false);
  const load = React.useCallback(async () => {
    setProjectsLoaded(false);
    const members = await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? [];
    setMembers(members);
    const admin = members.find((member) => member.userId === selfId)?.role === "Admin";
    setIsAdmin(admin);
    if (!admin) {
      setOwnerAgents(await action<Array<Pick<AgentRecord, "id" | "name" | "runtimeId" | "runtimeProfileId" | "runtimeProfileName" | "runtimeProfileSandbox" | "accessUserIds">>>("list_manageable_agent_access", { workspaceId: workspace.id }) ?? []);
      setAskable(await action<Array<{ id: string; name: string; codeCapable: boolean; ownerName: string | null; hasAccess: boolean }>>("list_agents_for_viewer", { workspaceId: workspace.id }) ?? []);
      return;
    }
    setOwnerAgents([]);
    setManageableAgentIds((await action<Array<{ id: string }>>("list_manageable_agent_access", { workspaceId: workspace.id }) ?? []).map((agent) => agent.id));
    setAllowAutopilot((await action<{ allowAutopilot: boolean }>("get_autopilot_setting", { workspaceId: workspace.id }))?.allowAutopilot === true);
    setAgents(await action<AgentRecord[]>("list_agents", { workspaceId: workspace.id }) ?? []);
    setRuntimes(await action<RuntimeOption[]>("list_runtimes", { workspaceId: workspace.id }) ?? []);
    setWorkspaceSkills((await action<Array<{ id: string; name: string; description: string; scope: string }>>("list_skills", { workspaceId: workspace.id }) ?? []).filter((skill) => skill.scope === "workspace"));
    setProjects((await action<Project[]>("list_projects", { workspaceId: workspace.id }) ?? []).filter((project) => !project.archived));
    setProjectsLoaded(true);
  }, [workspace.id, selfId]);
  React.useEffect(() => { void load(); }, [load]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("agents.failed") : null); await load(); };
  const limits = (draft: Draft) => ({ maxToolCalls: optionalInt(draft.maxToolCalls), maxTokens: optionalInt(draft.maxTokens), timeoutSeconds: optionalInt(draft.timeoutSeconds) });
  const header = <SettingsHeader title={translate("agents.title")} description={translate("agents.desc")} />;
  if (isAdmin === null) return <section>{header}</section>;
  if (!isAdmin) return <section>{header}
    <SettingsBlock title={translate("agents.askableTitle")}>
      <p className="text-13 text-secondary">{translate("agents.askableHelp")}</p>
      {askable.length === 0 ? <p className="text-secondary">{translate("agents.askableEmpty")}</p> : <RowList>{askable.map((agent) => <Row key={agent.id}>
        <div className="mr-auto grid min-w-0 gap-0.5"><span className="flex items-center gap-2"><Avatar name={agent.name} id={agent.id} agent size="md" /><span className={agent.hasAccess ? "font-medium" : "font-medium text-tertiary"}>{agent.name}</span></span><span className="text-13 text-secondary">{agent.codeCapable && agent.ownerName ? translate("agents.askableOwner").replace("{name}", agent.ownerName) : translate("agents.askableServer")}</span></div>
        <span className="text-13 text-secondary">{agent.hasAccess ? translate("agents.askableUsable") : agent.ownerName ? translate("agents.askableAsk").replace("{name}", agent.ownerName) : translate("agents.askableAskAdmin")}</span>
      </Row>)}</RowList>}
    </SettingsBlock>
    {ownerAgents.map((agent) => (
      <div key={agent.id} className="grid gap-2 border-b border-subtle py-3"><div className="flex flex-wrap items-center gap-x-2"><Avatar name={agent.name} id={agent.id} agent /><strong>{agent.name}</strong><span className="text-13 text-secondary">{profileSummary(agent).join(" · ")}</span></div><AgentRuntimeProfile agent={agent} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} /><AgentRuntimeEnvironment agent={agent} onFailed={() => setNote(translate("agents.failed"))} /><AgentPeopleAccess agent={agent} members={members} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} /></div>
    ))}
    {note && <Note note={note} />}
  </section>;
  return <section>
    <SettingsHeader title={translate("agents.title")} description={translate("agents.desc")}>
      {!creatingOpen && <button type="button" onClick={() => setCreatingOpen(true)}>{translate("agents.newAgent")}</button>}
    </SettingsHeader>
    {creatingOpen && <SettingsBlock title={translate("agents.create")}>
      <AgentForm draft={creating} runtimes={runtimes} allowAutopilot={allowAutopilot} onChange={setCreating} onCancel={() => { setCreating(emptyDraft); setCreatingOpen(false); }} onSubmit={async () => {
        const result = await action("create_agent", { workspaceId: workspace.id, name: creating.name, instructions: creating.instructions, model: creating.model, autopilot: creating.runtimeId ? undefined : creating.autopilot, canWakeAgents: creating.canWakeAgents, runtimeId: creating.runtimeId || null, cliModel: creating.cliModel || null, maxConcurrentRuns: optionalInt(creating.maxConcurrentRuns), ...limits(creating), monthlyTokenBudget: optionalInt(creating.monthlyTokenBudget) ?? null });
        if (result !== null) { setCreating(emptyDraft); setCreatingOpen(false); }
        await guard(result);
      }} />
    </SettingsBlock>}
    <SettingsBlock>
      {agents.length === 0 ? <p className="text-secondary">{translate("agents.none")}</p> : <RowList>{agents.map((agent) => { const runtime = runtimeParts(agent); return <Row key={agent.id}>
        <div className="grid min-w-0 flex-1 gap-2" data-agent={agent.name}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2"><Avatar name={agent.name} id={agent.id} agent size="md" /><span className="font-medium">{agent.name}</span></span>
            <span className="text-13 text-secondary">{translate(agent.enabled ? "agents.enabled" : "agents.disabled")} · {agent.model === "default" ? translate("agents.defaultModel") : agent.model} · {runtime ? [translate("agents.metaComputer").replace("{name}", runtime.computer), agent.runtimeOwnerName ? translate("agents.metaOwner").replace("{name}", agent.runtimeOwnerName) : null, runtime.tool ? translate("agents.metaTool").replace("{name}", capitalize(runtime.tool)) : null, translate(agent.runtimeOnline ? "agents.metaOnline" : "agents.metaOffline"), ...profileSummary(agent)].filter(Boolean).join(" · ") : translate("agents.server")} · {translate("agents.usage").replace("{used}", formatNumber(agent.monthlyTokensUsed))}</span>
          </div>
          {editing?.id === agent.id
            ? <AgentForm draft={editing.draft} runtimes={runtimes} allowAutopilot={allowAutopilot} onChange={(draft) => setEditing({ id: agent.id, draft })} onCancel={() => setEditing(null)} onSubmit={async () => {
              const draft = editing.draft;
              await guard(await action("update_agent", { agentId: agent.id, name: draft.name, instructions: draft.instructions, model: draft.model, autopilot: draft.runtimeId ? undefined : draft.autopilot, canWakeAgents: draft.canWakeAgents, runtimeId: draft.runtimeId || null, cliModel: draft.cliModel || null, maxConcurrentRuns: optionalInt(draft.maxConcurrentRuns), ...limits(draft), monthlyTokenBudget: optionalInt(draft.monthlyTokenBudget) ?? null }));
              setEditing(null);
            }} />
          : <><AccessEditor agent={agent} projects={projects} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} />
            {manageableAgentIds.includes(agent.id) ? <AgentPeopleAccess agent={agent} members={members} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} /> : <p className="text-12 text-secondary">{translate("agents.runtimeOwnerAccess")}</p>}</>}
          {manageableAgentIds.includes(agent.id) && agent.runtimeId && <AgentRuntimeEnvironment agent={agent} onFailed={() => setNote(translate("agents.failed"))} />}
          <fieldset className="grid gap-1 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("agents.skills")}</legend>
            {workspaceSkills.length === 0 ? <span className="text-13 text-secondary">{translate("agents.noSkills")}</span> : workspaceSkills.map((skill) => <label key={skill.id} className="flex items-center gap-2" title={skill.description}>
              <input type="checkbox" checked={agent.skills.some((attached) => attached.id === skill.id)} onChange={async (event) => {
                const ids = event.target.checked ? [...agent.skills.map((entry) => entry.id), skill.id] : agent.skills.filter((entry) => entry.id !== skill.id).map((entry) => entry.id);
                await guard(await action("set_agent_skills", { agentId: agent.id, skillIds: ids }));
              }} />{skill.name}</label>)}
          </fieldset>
          <TriggerSection agent={agent} projects={projects} projectsLoaded={projectsLoaded} />
          <AgentRuns agent={agent} />
          <p className="text-13 text-secondary">{translate("agents.retire.hint")}</p>
          <div className="flex flex-wrap gap-2">
            {editing?.id !== agent.id && <button type="button" className="secondary" onClick={() => setEditing({ id: agent.id, draft: toDraft(agent) })}>{translate("agents.edit")}</button>}
            <button type="button" className="secondary" onClick={async () => { setRetiring(null); await guard(await action(agent.enabled ? "disable_agent" : "enable_agent", { agentId: agent.id })); }}>{translate(agent.enabled ? "agents.disable" : "agents.enable")}</button>
            <button type="button" className={dangerOutline} data-retire-trigger={agent.id} onClick={async () => {
              // The same counts the server refuses with: a refused Agent gets the dialog instead of a failed request.
              const check = await action<{ blocked: boolean; counts: Record<string, number> }>("get_agent_content_counts", { agentId: agent.id });
              if (check === null) { setNote(translate("agents.failed")); return; }
              if (check.blocked) { setRetiring({ id: agent.id, counts: check.counts }); return; }
              setRetiring(null);
              if (window.confirm(translate("agents.deleteConfirm"))) await guard(await action("delete_agent", { agentId: agent.id }));
            }}>{translate("agents.delete")}</button>
          </div>
          {retiring?.id === agent.id && <RetirePanel agent={agent} counts={retiring.counts} onClose={() => setRetiring(null)} onDisable={async () => { setRetiring(null); await guard(await action("disable_agent", { agentId: agent.id })); }} />}
        </div>
      </Row>; })}</RowList>}
    </SettingsBlock>
    <Note note={note} error />
  </section>;
}

function TriggerSection({ agent, projects, projectsLoaded }: { agent: AgentRecord; projects: Project[]; projectsLoaded: boolean }) {
  const [rows, setRows] = React.useState<TriggerRow[]>([]);
  const availableProjects = projects.filter((project) => agent.allProjects || agent.projectIds.includes(project.id));
  const [projectId, setProjectId] = React.useState("");
  const [eventType, setEventType] = React.useState("work_item_created");
  const [kind, setKind] = React.useState("event");
  const [schedule, setSchedule] = React.useState("daily");
  const [expression, setExpression] = React.useState("0 9 * * *");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!projectsLoaded) return;
    setProjectId((current) => availableProjects.some((project) => project.id === current) ? current : availableProjects[0]?.id ?? "");
  }, [agent.id, projectsLoaded, projects, agent.allProjects, agent.projectIds]);
  const reload = React.useCallback(async () => setRows(await action<TriggerRow[]>("list_triggers", { agentId: agent.id }) ?? []), [agent.id]);
  React.useEffect(() => { void reload(); }, [reload]);
  const create = async () => {
    const result = await actionResult<TriggerRow>("create_trigger", { agentId: agent.id, projectId, ...(kind === "event" ? { eventType } : { schedule, ...(schedule === "cron" ? { expression } : {}) }) });
    setError("error" in result ? result.error : null); if ("data" in result) await reload();
  };
  return <fieldset className="grid gap-2 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("triggers.title")}</legend>
    <div className="flex flex-wrap gap-2">
      <label className="grid gap-1 text-12 text-secondary">{translate("triggers.project")}<select aria-label={translate("triggers.project")} value={projectId} disabled={!projectsLoaded || availableProjects.length === 0} onChange={(e) => setProjectId(e.target.value)}>
        {!projectsLoaded && <option value="">{translate("triggers.projectsLoading")}</option>}
        {projectsLoaded && availableProjects.length === 0 && <option value="">{translate("triggers.noAccessibleProjects")}</option>}
        {availableProjects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
      </select></label>
      <label className="grid gap-1 text-12 text-secondary">{translate("triggers.kind")}<select aria-label={translate("triggers.kind")} value={kind} onChange={(e) => setKind(e.target.value)}><option value="event">{translate("triggers.eventKind")}</option><option value="schedule">{translate("triggers.scheduleKind")}</option></select></label>
      {kind === "event" ? <label className="grid gap-1 text-12 text-secondary">{translate("triggers.event")}<select aria-label={translate("triggers.event")} value={eventType} onChange={(e) => setEventType(e.target.value)}>{(["work_item_created", "work_item_updated", "state_changed", "assignee_changed", "comment_added", "sub_items_closed"] as TriggerEvent[]).map((event) => <option key={event} value={event}>{translate(`triggers.${event}`)}</option>)}</select></label> : <><label className="grid gap-1 text-12 text-secondary">{translate("triggers.schedule")}<select aria-label={translate("triggers.schedule")} value={schedule} onChange={(e) => setSchedule(e.target.value)}>{(["daily", "weekly", "monthly", "cron"] as const).map((entry) => <option key={entry} value={entry}>{translate(`triggers.${entry}`)}</option>)}</select></label>{schedule === "cron" && <label className="grid gap-1 text-12 text-secondary">{translate("triggers.cron")}<input aria-label={translate("triggers.cron")} value={expression} onChange={(e) => setExpression(e.target.value)} /></label>}</>}
      <button type="button" onClick={() => void create()} disabled={!projectsLoaded || !availableProjects.some((project) => project.id === projectId)}>{translate("triggers.add")}</button>
    </div>
    {!projectsLoaded ? <p role="status" className="m-0 text-12 text-secondary">{translate("triggers.projectsLoading")}</p>
      : availableProjects.length === 0 ? <p role="status" className="m-0 text-12 text-secondary">{translate(projects.length === 0 ? "triggers.noProjects" : "triggers.noAccessibleProjectsHelp")}</p> : null}
    {error && <p role="alert" className="text-13 text-danger-text">{error}</p>}
    {rows.map((trigger) => <div key={trigger.id} className="flex gap-2 text-13"><span>{projects.find((p) => p.id === trigger.projectId)?.key} · {trigger.schedule ? `${translate(`triggers.${trigger.schedule}`)}${trigger.expression ? ` (${trigger.expression})` : ""}` : translate(`triggers.${trigger.eventType ?? "work_item_created"}`)}</span>
      <button type="button" className="secondary" onClick={async () => { await action("pause_trigger", { triggerId: trigger.id, paused: !trigger.paused }); await reload(); }}>{translate(trigger.paused ? "triggers.resume" : "triggers.pause")}</button>
      <button type="button" className="secondary" onClick={async () => { await action("delete_trigger", { triggerId: trigger.id }); await reload(); }}>{translate("triggers.delete")}</button></div>)}
  </fieldset>;
}

function AgentRuns({ agent }: { agent: AgentRecord }) {
  const [rows, setRows] = React.useState<Array<{ id: string; workItemId: string | null; status: string; createdAt: string }>>([]);
  const [transcript, setTranscript] = React.useState<Record<string, unknown>>({});
  const reload = React.useCallback(async () => setRows(await action<typeof rows>("list_agent_runs", { agentId: agent.id }) ?? []), [agent.id]);
  React.useEffect(() => { void reload(); }, [reload]);
  return <fieldset className="grid gap-2 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("runs.title")}</legend>
    {rows.length === 0 && <span className="text-13 text-secondary">{translate("agents.runsEmpty")}</span>}
    {rows.map((run) => <details key={run.id} onToggle={async (event) => { if ((event.currentTarget as HTMLDetailsElement).open && !transcript[run.id]) { const result = await action("get_run_transcript", { runId: run.id }); setTranscript((old) => ({ ...old, [run.id]: result })); } }}><summary className="cursor-pointer text-13">{run.workItemId ? run.workItemId : translate("runs.scheduled")} · {run.status} · {formatDate(run.createdAt)}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-12">{JSON.stringify(transcript[run.id] ?? {}, null, 2)}</pre></details>)}
  </fieldset>;
}
