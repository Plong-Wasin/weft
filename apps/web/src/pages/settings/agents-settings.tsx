import React from "react";
import { formatDate, formatNumber, translate } from "@weft/shared";
import { action, actionResult } from "../../api";
import { Avatar } from "../../avatar";
import { capitalize, profileSummary, runtimeParts } from "../../agent-labels";
import { useWorkspace } from "../../layouts/workspace-layout";
import type { Member, Project } from "../../types";
import { dangerButton, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

export type AgentRecord = {
  id: string; userId: string; name: string; instructions: string; model: string; enabled: boolean; allProjects: boolean; projectIds: string[]; accessUserIds: string[];
  runtimeId: string | null; runtimeName: string | null; runtimeHostname?: string | null; runtimeCli?: string | null; runtimeOwnerName: string | null; runtimeShared: boolean; runtimeOnline: boolean; runtimeProfileId: string | null; runtimeProfileName: string | null; runtimeProfileSandbox: string | null; cliModel: string | null; maxConcurrentRuns: number; autopilot: boolean;
  skills: Array<{ id: string; name: string; description: string }>;
  maxToolCalls: number; maxTokens: number; timeoutSeconds: number; monthlyTokenBudget: number | null; monthlyTokensUsed: number;
};
type TriggerEvent = "work_item_created" | "work_item_updated" | "state_changed" | "assignee_changed" | "comment_added";
type TriggerRow = { id: string; projectId: string; eventType: TriggerEvent | null; schedule: "daily" | "weekly" | "monthly" | "cron" | null; expression: string | null; paused: boolean };

type RuntimeProfile = { id: string; runtimeId: string; name: string; sandbox: string; filesystemAllowlist: string[]; networkAllowlist: string[] };
type RuntimeOption = { id: string; hostname: string; agentCli: string; online: boolean; shared: boolean };
type Draft = { name: string; instructions: string; model: string; autopilot: boolean; maxToolCalls: string; maxTokens: string; timeoutSeconds: string; monthlyTokenBudget: string; runtimeId: string; cliModel: string; maxConcurrentRuns: string };
const emptyDraft: Draft = { name: "", instructions: "", model: "default", autopilot: false, maxToolCalls: "", maxTokens: "", timeoutSeconds: "", monthlyTokenBudget: "", runtimeId: "", cliModel: "", maxConcurrentRuns: "6" };
const toDraft = (agent: AgentRecord): Draft => ({
  name: agent.name, instructions: agent.instructions, model: agent.model, autopilot: agent.autopilot, maxToolCalls: String(agent.maxToolCalls), maxTokens: String(agent.maxTokens),
  timeoutSeconds: String(agent.timeoutSeconds), monthlyTokenBudget: agent.monthlyTokenBudget === null ? "" : String(agent.monthlyTokenBudget),
  runtimeId: agent.runtimeId ?? "", cliModel: agent.cliModel ?? "", maxConcurrentRuns: String(agent.maxConcurrentRuns),
});
const optionalInt = (value: string) => value.trim() === "" ? undefined : Number(value);

function AgentForm({ draft, onChange, onSubmit, onCancel, runtimes, allowAutopilot }: { draft: Draft; onChange: (draft: Draft) => void; onSubmit: () => void; onCancel?: () => void; runtimes: RuntimeOption[]; allowAutopilot: boolean }) {
  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange({ ...draft, [key]: event.target.value });
  const number = (key: "maxToolCalls" | "maxTokens" | "timeoutSeconds" | "monthlyTokenBudget", label: Parameters<typeof translate>[0]) =>
    <label>{translate(label)}<input type="number" min={1} value={draft[key]} onChange={set(key)} /></label>;
  return <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <label>{translate("agents.name")}<input required maxLength={100} value={draft.name} onChange={set("name")} /></label>
    <label>{translate("agents.instructions")}<textarea rows={4} value={draft.instructions} onChange={set("instructions")} /></label>
    <label>{translate("agents.model")}<input required value={draft.model} onChange={set("model")} /></label>
    <fieldset className="grid gap-1 border-0 p-0"><label className="flex items-center gap-2"><input type="checkbox" checked={draft.autopilot || !!draft.runtimeId} disabled={!!draft.runtimeId || !allowAutopilot} onChange={(event) => onChange({ ...draft, autopilot: event.target.checked })} />{translate("agents.autopilot")}</label><small className="text-12 text-secondary">{translate(draft.runtimeId ? "agents.runtimeAutopilot" : "agents.autopilotRisk")}</small></fieldset>
    <label>{translate("agents.runsOn")}<select value={draft.runtimeId} onChange={(event) => { const next = event.target.value; onChange({ ...draft, runtimeId: next, autopilot: next ? true : (allowAutopilot ? draft.autopilot : false) }); }}><option value="">{translate("agents.server")}</option>{runtimes.filter((runtime) => runtime.shared).map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.hostname} · {runtime.agentCli} · {translate(runtime.online ? "runtimes.online" : "runtimes.offline")}</option>)}</select></label>
    {draft.runtimeId && <small className="text-12 text-secondary">{translate("agents.runtimeProfileHelp")}</small>}
    {draft.runtimeId && <div className="grid gap-3 sm:grid-cols-2"><label>{translate("agents.cliModel")}<input value={draft.cliModel} onChange={set("cliModel")} /></label><label>{translate("agents.concurrency")}<input type="number" min={1} max={20} value={draft.maxConcurrentRuns} onChange={set("maxConcurrentRuns")} /></label></div>}
    <div className="grid gap-3 sm:grid-cols-2">
      {number("maxToolCalls", "agents.maxToolCalls")}{number("maxTokens", "agents.maxTokens")}
      {number("timeoutSeconds", "agents.timeoutSeconds")}{number("monthlyTokenBudget", "agents.monthlyBudget")}
    </div>
    <div className="flex gap-2"><button type="submit">{translate("agents.save")}</button>{onCancel && <button type="button" className="secondary" onClick={onCancel}>{translate("agents.cancel")}</button>}</div>
  </form>;
}

/** Choose which projects an Agent is open to: opening a project makes the Agent a Member of it. */
function AccessEditor({ agent, projects, onSaved, onFailed }: { agent: AgentRecord; projects: Project[]; onSaved: () => void; onFailed: () => void }) {
  const save = async (allProjects: boolean, projectIds: string[]) => { (await action("set_agent_project_access", { agentId: agent.id, allProjects, projectIds })) === null ? onFailed() : onSaved(); };
  const toggle = (id: string, on: boolean) => save(false, on ? [...agent.projectIds, id] : agent.projectIds.filter((entry) => entry !== id));
  return <fieldset className="grid gap-1 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("agents.access")}</legend>
    <label className="flex items-center gap-2"><input type="checkbox" checked={agent.allProjects} onChange={(event) => void save(event.target.checked, [])} />{translate("agents.allProjects")}</label>
    {!agent.allProjects && projects.map((project) => <label key={project.id} className="flex items-center gap-2">
      <input type="checkbox" checked={agent.projectIds.includes(project.id)} onChange={(event) => void toggle(project.id, event.target.checked)} />{project.key} · {project.name}</label>)}
  </fieldset>;
}

function AgentPeopleAccess({ agent, members, onSaved, onFailed }: { agent: Pick<AgentRecord, "id" | "runtimeId" | "accessUserIds">; members: Member[]; onSaved: () => void; onFailed: () => void }) {
  const save = async (userIds: string[]) => (await action("set_agent_access", { agentId: agent.id, userIds })) === null ? onFailed() : onSaved();
  return <fieldset className="grid gap-1 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("agents.peopleAccess")}</legend>
    <p className="text-12 text-secondary">{translate(agent.runtimeId ? "agents.runtimeOwnerAccess" : "agents.adminAccess")}</p>
    {members.filter((member) => !member.isAgent).map((member) => <label key={member.userId} className="flex items-center gap-2">
      <input type="checkbox" aria-label={`${translate("agents.mayUse")} ${member.name}`} checked={agent.accessUserIds.includes(member.userId)} onChange={(event) => void save(event.target.checked ? [...agent.accessUserIds, member.userId] : agent.accessUserIds.filter((id) => id !== member.userId))} />
      <Avatar name={member.name} id={member.userId} />{member.name}
    </label>)}
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
  const [workspaceSkills, setWorkspaceSkills] = React.useState<Array<{ id: string; name: string; description: string }>>([]);
  const [creating, setCreating] = React.useState<Draft>(emptyDraft);
  const [editing, setEditing] = React.useState<{ id: string; draft: Draft } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [allowAutopilot, setAllowAutopilot] = React.useState(false);
  const load = React.useCallback(async () => {
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
      <div key={agent.id} className="grid gap-2 border-b border-subtle py-3"><div className="flex flex-wrap items-center gap-x-2"><Avatar name={agent.name} id={agent.id} agent /><strong>{agent.name}</strong><span className="text-13 text-secondary">{profileSummary(agent).join(" · ")}</span></div><AgentRuntimeProfile agent={agent} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} /><AgentPeopleAccess agent={agent} members={members} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} /></div>
    ))}
    {note && <Note note={note} />}
  </section>;
  return <section>
    {header}
    <SettingsBlock title={translate("agents.create")}>
      <AgentForm draft={creating} runtimes={runtimes} allowAutopilot={allowAutopilot} onChange={setCreating} onSubmit={async () => {
        const result = await action("create_agent", { workspaceId: workspace.id, name: creating.name, instructions: creating.instructions, model: creating.model, autopilot: creating.runtimeId ? undefined : creating.autopilot, runtimeId: creating.runtimeId || null, cliModel: creating.cliModel || null, maxConcurrentRuns: optionalInt(creating.maxConcurrentRuns), ...limits(creating), monthlyTokenBudget: optionalInt(creating.monthlyTokenBudget) ?? null });
        if (result !== null) setCreating(emptyDraft);
        await guard(result);
      }} />
    </SettingsBlock>
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
              await guard(await action("update_agent", { agentId: agent.id, name: draft.name, instructions: draft.instructions, model: draft.model, autopilot: draft.runtimeId ? undefined : draft.autopilot, runtimeId: draft.runtimeId || null, cliModel: draft.cliModel || null, maxConcurrentRuns: optionalInt(draft.maxConcurrentRuns), ...limits(draft), monthlyTokenBudget: optionalInt(draft.monthlyTokenBudget) ?? null }));
              setEditing(null);
            }} />
          : <><AccessEditor agent={agent} projects={projects} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} />
            {manageableAgentIds.includes(agent.id) ? <AgentPeopleAccess agent={agent} members={members} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} /> : <p className="text-12 text-secondary">{translate("agents.runtimeOwnerAccess")}</p>}</>}
          <fieldset className="grid gap-1 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("agents.skills")}</legend>
            {workspaceSkills.length === 0 ? <span className="text-13 text-secondary">{translate("agents.noSkills")}</span> : workspaceSkills.map((skill) => <label key={skill.id} className="flex items-center gap-2" title={skill.description}>
              <input type="checkbox" checked={agent.skills.some((attached) => attached.id === skill.id)} onChange={async (event) => {
                const ids = event.target.checked ? [...agent.skills.map((entry) => entry.id), skill.id] : agent.skills.filter((entry) => entry.id !== skill.id).map((entry) => entry.id);
                await guard(await action("set_agent_skills", { agentId: agent.id, skillIds: ids }));
              }} />{skill.name}</label>)}
          </fieldset>
          <TriggerSection agent={agent} projects={projects} />
          <AgentRuns agent={agent} />
          <div className="flex flex-wrap gap-2">
            {editing?.id !== agent.id && <button type="button" className="secondary" onClick={() => setEditing({ id: agent.id, draft: toDraft(agent) })}>{translate("agents.edit")}</button>}
            <button type="button" className="secondary" onClick={async () => guard(await action(agent.enabled ? "disable_agent" : "enable_agent", { agentId: agent.id }))}>{translate(agent.enabled ? "agents.disable" : "agents.enable")}</button>
            <button type="button" className={dangerButton} onClick={async () => { if (window.confirm(translate("agents.deleteConfirm"))) await guard(await action("delete_agent", { agentId: agent.id })); }}>{translate("agents.delete")}</button>
          </div>
        </div>
      </Row>; })}</RowList>}
    </SettingsBlock>
    <Note note={note} error />
  </section>;
}

function TriggerSection({ agent, projects }: { agent: AgentRecord; projects: Project[] }) {
  const [rows, setRows] = React.useState<TriggerRow[]>([]);
  const [projectId, setProjectId] = React.useState(agent.projectIds[0] ?? projects[0]?.id ?? "");
  const [eventType, setEventType] = React.useState("work_item_created");
  const [kind, setKind] = React.useState("event");
  const [schedule, setSchedule] = React.useState("daily");
  const [expression, setExpression] = React.useState("0 9 * * *");
  const [error, setError] = React.useState<string | null>(null);
  const reload = React.useCallback(async () => setRows(await action<TriggerRow[]>("list_triggers", { agentId: agent.id }) ?? []), [agent.id]);
  React.useEffect(() => { void reload(); }, [reload]);
  const create = async () => {
    const result = await actionResult<TriggerRow>("create_trigger", { agentId: agent.id, projectId, ...(kind === "event" ? { eventType } : { schedule, ...(schedule === "cron" ? { expression } : {}) }) });
    setError("error" in result ? result.error : null); if ("data" in result) await reload();
  };
  return <fieldset className="grid gap-2 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("triggers.title")}</legend>
    <div className="flex flex-wrap gap-2">
      <label className="grid gap-1 text-12 text-secondary">{translate("triggers.project")}<select aria-label={translate("triggers.project")} value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.filter((p) => agent.allProjects || agent.projectIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</select></label>
      <label className="grid gap-1 text-12 text-secondary">{translate("triggers.kind")}<select aria-label={translate("triggers.kind")} value={kind} onChange={(e) => setKind(e.target.value)}><option value="event">{translate("triggers.eventKind")}</option><option value="schedule">{translate("triggers.scheduleKind")}</option></select></label>
      {kind === "event" ? <label className="grid gap-1 text-12 text-secondary">{translate("triggers.event")}<select aria-label={translate("triggers.event")} value={eventType} onChange={(e) => setEventType(e.target.value)}>{(["work_item_created", "work_item_updated", "state_changed", "assignee_changed", "comment_added"] as TriggerEvent[]).map((event) => <option key={event} value={event}>{translate(`triggers.${event}`)}</option>)}</select></label> : <><label className="grid gap-1 text-12 text-secondary">{translate("triggers.schedule")}<select aria-label={translate("triggers.schedule")} value={schedule} onChange={(e) => setSchedule(e.target.value)}>{(["daily", "weekly", "monthly", "cron"] as const).map((entry) => <option key={entry} value={entry}>{translate(`triggers.${entry}`)}</option>)}</select></label>{schedule === "cron" && <label className="grid gap-1 text-12 text-secondary">{translate("triggers.cron")}<input aria-label={translate("triggers.cron")} value={expression} onChange={(e) => setExpression(e.target.value)} /></label>}</>}
      <button type="button" onClick={() => void create()} disabled={!projectId}>{translate("triggers.add")}</button>
    </div>
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
