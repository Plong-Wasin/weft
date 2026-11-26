import { Button } from "@/ui/button";
import React from "react";
import { Link } from "react-router";
import { formatDate, formatNumber, translate } from "@weft/shared";
import { action, actionResult } from "../../api";
import { matchesProjectSearch } from "../../shell/project-preferences";
import { Avatar } from "../../avatar";
import { capitalize, profileSummary, runtimeParts } from "../../agent-labels";
import { useWorkspace } from "../../layouts/workspace-layout";
import { paths } from "../../routes";
import { runFailureText } from "../../run-failure";
import type { Member, Project } from "../../types";
import { dangerOutline, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
export type AgentRecord = {
  id: string; userId: string; name: string; instructions: string; model: string; enabled: boolean; allProjects: boolean; projectIds: string[]; accessUserIds: string[];
  runtimeId: string | null; runtimeName: string | null; runtimeHostname?: string | null; runtimeCli?: string | null; runtimeOwnerName: string | null; runtimeShared: boolean; runtimeOnline: boolean; runtimeProfileId: string | null; runtimeProfileName: string | null; runtimeProfileSandbox: string | null; cliModel: string | null; maxConcurrentRuns: number; autopilot: boolean; canWakeAgents: boolean;
  skills: Array<{ id: string; name: string; description: string }>;
  maxToolCalls: number; maxTokens: number; timeoutSeconds: number; monthlyTokenBudget: number | null; monthlyTokensUsed: number;
};
type TriggerEvent = "work_item_created" | "work_item_updated" | "state_changed" | "assignee_changed" | "comment_added" | "sub_items_closed";
type TriggerRow = { id: string; projectId: string; eventType: TriggerEvent | null; schedule: "daily" | "weekly" | "monthly" | "cron" | null; expression: string | null; paused: boolean };

type RuntimeProfile = { id: string; runtimeId: string; name: string; sandbox: string; filesystemAllowlist: string[]; networkAllowlist: string[] };
type RuntimeOption = { id: string; ownerId: string; hostname: string; agentCli: string; online: boolean; shared: boolean };
type ManagedAgent = Pick<AgentRecord, "id" | "name" | "instructions" | "model" | "enabled" | "allProjects" | "projectIds" | "runtimeId" | "runtimeProfileId" | "runtimeProfileName" | "runtimeProfileSandbox" | "accessUserIds" | "cliModel" | "maxConcurrentRuns" | "maxToolCalls" | "maxTokens" | "timeoutSeconds" | "monthlyTokenBudget"> & { createdBy: string; memberOwned: boolean };
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
    <label>{translate(label)}<Input type="number" min={1} value={draft[key]} onChange={set(key)} /></label>;
  const selectable = runtimes.filter((runtime) => runtime.shared);
  return <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <label>{translate("agents.name")}<Input required maxLength={100} value={draft.name} onChange={set("name")} /></label>
    <label>{translate("agents.instructions")}<Textarea rows={4} value={draft.instructions} onChange={set("instructions")} /></label>
    <label>{translate("agents.model")}<Input required value={draft.model} onChange={set("model")} /></label>
    <fieldset className="grid gap-1 border-0 p-0"><label className="flex items-center gap-2"><Checkbox checked={draft.autopilot || !!draft.runtimeId} disabled={!!draft.runtimeId || !allowAutopilot} onChange={(event) => onChange({ ...draft, autopilot: event.target.checked })} />{translate("agents.autopilot")}</label><small className="text-xs text-muted-foreground">{translate(draft.runtimeId ? "agents.runtimeAutopilot" : "agents.autopilotRisk")}</small></fieldset>
    <label>{translate("agents.runsOn")}<select value={draft.runtimeId} onChange={(event) => { const next = event.target.value; onChange({ ...draft, runtimeId: next, autopilot: next ? true : (allowAutopilot ? draft.autopilot : false) }); }}><option value="">{translate("agents.server")}</option>{selectable.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.hostname} · {runtime.agentCli} · {translate(runtime.online ? "runtimes.online" : "runtimes.offline")}</option>)}</select></label>
    {selectable.length === 0 && (runtimes.length > 0
      ? <Link to={paths.workspaceRuntimes(workspace.slug)} className="text-sm text-foreground underline">{translate("agents.shareRuntimeLink")}</Link>
      : <Link to={paths.workspaceConnectAi(workspace.slug)} className="text-sm text-foreground underline">{translate("runtimes.connectLink")}</Link>)}
    {draft.runtimeId && <small className="text-xs text-muted-foreground">{translate("agents.runtimeProfileHelp")}</small>}
    <fieldset className="grid gap-1 border-0 p-0"><label className="flex items-center gap-2"><Checkbox checked={draft.canWakeAgents} onChange={(event) => onChange({ ...draft, canWakeAgents: event.target.checked })} />{translate("agents.canWakeAgents")}</label><small className="text-xs text-muted-foreground">{translate("agents.canWakeAgentsHelp")}</small></fieldset>
    {draft.runtimeId && <div className="grid gap-3 sm:grid-cols-2"><label>{translate("agents.cliModel")}<Input value={draft.cliModel} onChange={set("cliModel")} /></label><label>{translate("agents.concurrency")}<Input type="number" min={1} max={20} value={draft.maxConcurrentRuns} onChange={set("maxConcurrentRuns")} /></label></div>}
    <details className="grid gap-3">
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground">{translate("agents.limits")}</summary>
      <div className="grid gap-3 sm:grid-cols-2">
        {number("maxToolCalls", "agents.maxToolCalls")}{number("maxTokens", "agents.maxTokens")}
        {number("timeoutSeconds", "agents.timeoutSeconds")}{number("monthlyTokenBudget", "agents.monthlyBudget")}
      </div>
    </details>
    <div className="flex gap-2"><Button type="submit">{translate("agents.save")}</Button>{onCancel && <Button type="button" className="secondary" onClick={onCancel}>{translate("agents.cancel")}</Button>}</div>
  </form>;
}

/** Choose which projects an Agent is open to: opening a project makes the Agent a Member of it. */
function AccessEditor({ agent, projects, onSaved, onFailed, canSetAllProjects = true, projectsLoaded = true }: { agent: Pick<AgentRecord, "id" | "allProjects" | "projectIds">; projects: Project[]; onSaved: () => void; onFailed: () => void; canSetAllProjects?: boolean; projectsLoaded?: boolean }) {
  const [draft, setDraft] = React.useState({ allProjects: canSetAllProjects ? agent.allProjects : false, projectIds: agent.projectIds });
  const [base, setBase] = React.useState({ allProjects: agent.allProjects, projectIds: agent.projectIds });
  const [saving, setSaving] = React.useState(false);
  const [projectQuery, setProjectQuery] = React.useState("");
  React.useEffect(() => {
    if (canSetAllProjects || !projectsLoaded) return;
    const writableIds = new Set(projects.map((project) => project.id));
    setDraft((current) => ({ allProjects: false, projectIds: current.projectIds.filter((projectId) => writableIds.has(projectId)) }));
  }, [canSetAllProjects, projects, projectsLoaded]);
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
  return <fieldset className="grid gap-1 border-0 p-0"><legend className="text-sm font-medium text-muted-foreground">{translate("agents.access")}</legend>
    {!canSetAllProjects && projectsLoaded && (agent.allProjects || agent.projectIds.some((projectId) => !projects.some((project) => project.id === projectId))) && <p role="status" className="text-xs text-muted-foreground">{translate("agents.revokedProjectAccess")}</p>}
    {canSetAllProjects && <label className="flex items-center gap-2"><Checkbox checked={draft.allProjects} onChange={(event) => setDraft({ ...draft, allProjects: event.target.checked, projectIds: event.target.checked ? [] : draft.projectIds })} />{translate("agents.allProjects")}</label>}
    {!draft.allProjects && <>
      <label className="grid gap-1 text-xs font-medium text-muted-foreground">{translate("projects.find")}
        <Input type="search" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder={translate("projects.searchPlaceholder")} className="px-2 py-1 text-sm" />
      </label>
      {visibleProjects.map((project) => <label key={project.id} className="flex items-center gap-2">
        <Checkbox checked={draft.projectIds.includes(project.id)} onChange={(event) => setDraft({ ...draft, projectIds: event.target.checked ? [...draft.projectIds, project.id] : draft.projectIds.filter((entry) => entry !== project.id) })} />{project.key} · {project.name}</label>)}
      {visibleProjects.length === 0 && projectQuery.trim() && <p role="status" className="m-0 text-xs text-muted-foreground">{translate("projects.noSearchResults")}</p>}
    </>}
    <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>{translate("agents.save")}</Button>
  </fieldset>;
}

function MemberAgentSettings({ agent, onSaved, onFailed }: { agent: ManagedAgent; onSaved: () => void; onFailed: () => void }) {
  const [draft, setDraft] = React.useState({ name: agent.name, instructions: agent.instructions, model: agent.model, cliModel: agent.cliModel ?? "", maxConcurrentRuns: String(agent.maxConcurrentRuns), maxToolCalls: String(agent.maxToolCalls), maxTokens: String(agent.maxTokens), timeoutSeconds: String(agent.timeoutSeconds), monthlyTokenBudget: agent.monthlyTokenBudget === null ? "" : String(agent.monthlyTokenBudget) });
  const [saving, setSaving] = React.useState(false);
  const [retiring, setRetiring] = React.useState<Record<string, number> | null>(null);
  const set = (key: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft({ ...draft, [key]: event.target.value });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const result = await action("update_agent", { agentId: agent.id, ...draft, cliModel: draft.cliModel || null, maxConcurrentRuns: optionalInt(draft.maxConcurrentRuns), maxToolCalls: optionalInt(draft.maxToolCalls), maxTokens: optionalInt(draft.maxTokens), timeoutSeconds: optionalInt(draft.timeoutSeconds), monthlyTokenBudget: optionalInt(draft.monthlyTokenBudget) ?? null });
    setSaving(false);
    result === null ? onFailed() : onSaved();
  };
  return <form className="grid gap-3 border-y border-border py-3" onSubmit={(event) => void save(event)}>
    <strong>{translate("agents.myAgentSettings")}</strong>
    <label>{translate("agents.name")}<Input required maxLength={100} value={draft.name} onChange={set("name")} /></label>
    <label>{translate("agents.instructions")}<Textarea rows={4} value={draft.instructions} onChange={set("instructions")} /></label>
    <label>{translate("agents.model")}<Input required value={draft.model} onChange={set("model")} /></label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label>{translate("agents.cliModel")}<Input value={draft.cliModel} onChange={set("cliModel")} /></label>
      <label>{translate("agents.concurrency")}<Input type="number" min={1} max={20} value={draft.maxConcurrentRuns} onChange={set("maxConcurrentRuns")} /></label>
      <label>{translate("agents.maxToolCalls")}<Input type="number" min={1} max={100} value={draft.maxToolCalls} onChange={set("maxToolCalls")} /></label>
      <label>{translate("agents.maxTokens")}<Input type="number" min={1} max={1000000} value={draft.maxTokens} onChange={set("maxTokens")} /></label>
      <label>{translate("agents.timeoutSeconds")}<Input type="number" min={1} max={3600} value={draft.timeoutSeconds} onChange={set("timeoutSeconds")} /></label>
      <label>{translate("agents.monthlyBudget")}<Input type="number" min={1} value={draft.monthlyTokenBudget} onChange={set("monthlyTokenBudget")} /></label>
    </div>
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={saving}>{translate("agents.save")}</Button><Button type="button" className="secondary" onClick={async () => {
      const result = await action(agent.enabled ? "disable_agent" : "enable_agent", { agentId: agent.id });
      result === null ? onFailed() : onSaved();
    }}>{translate(agent.enabled ? "agents.disable" : "agents.enable")}</Button><Button type="button" className={dangerOutline} data-retire-trigger={agent.id} onClick={async () => {
      const counts = await action<{ blocked: boolean; counts: Record<string, number> }>("get_agent_content_counts", { agentId: agent.id });
      if (!counts) { onFailed(); return; }
      if (counts.blocked) { setRetiring(counts.counts); return; }
      if (window.confirm(translate("agents.deleteConfirm"))) {
        const result = await action("delete_agent", { agentId: agent.id });
        result === null ? onFailed() : onSaved();
      }
    }}>{translate("agents.delete")}</Button></div>
    {retiring && <RetirePanel agent={agent} counts={retiring} onClose={() => setRetiring(null)} onDisable={async () => {
      setRetiring(null);
      const result = await action("disable_agent", { agentId: agent.id });
      result === null ? onFailed() : onSaved();
    }} />}
  </form>;
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
  return <fieldset className="grid gap-1 border-0 p-0"><legend className="text-sm font-medium text-muted-foreground">{translate("agents.peopleAccess")}</legend>
    <p className="text-xs text-muted-foreground">{translate(agent.runtimeId ? "agents.runtimeOwnerAccess" : "agents.adminAccess")}</p>
    {members.filter((member) => !member.isAgent).map((member) => <label key={member.userId} className="flex items-center gap-2">
      <Checkbox aria-label={`${translate("agents.mayUse")} ${member.name}`} checked={draft.includes(member.userId)} onChange={(event) => setDraft(event.target.checked ? [...draft, member.userId] : draft.filter((id) => id !== member.userId))} />
      <Avatar name={member.name} id={member.userId} />{member.name}
    </label>)}
    <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>{translate("agents.save")}</Button>
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
  return <fieldset className="grid min-w-0 gap-1 border-0 p-0"><legend className="text-sm font-medium text-muted-foreground">{translate("agents.runtimeProfile")}</legend>
    <p className="text-xs text-muted-foreground">{translate("agents.runtimeProfileHelp")}</p>
    <div className="flex min-w-0 flex-wrap items-center gap-2"><select className="max-w-full min-w-0" aria-label={translate("agents.runtimeProfile")} value={selected} onChange={(event) => setSelected(event.target.value)}>{!agent.runtimeProfileId && <option value="">{translate("agents.profileDefault")}</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {translate(`runtimes.sandbox.${profile.sandbox}` as never)}{profile.sandbox === "full" ? ` · ${translate("runtimes.fullAccessWarning")}` : ""}</option>)}</select>
      <Button type="button" className="secondary" disabled={!selected || selected === agent.runtimeProfileId} onClick={async () => { const result = await action("set_agent_runtime_profile", { agentId: agent.id, profileId: selected }); result === null ? onFailed() : onSaved(); }}>{translate("agents.saveProfile")}</Button></div>
  </fieldset>;
}

/** Only the Runtime owner can manage these values; reads return names and classifications, never existing values. */
function AgentRuntimeEnvironment({ agent, onFailed }: { agent: Pick<AgentRecord, "id" | "runtimeId">; onFailed: () => void }) {
  const [classifications, setClassifications] = React.useState<Array<{ name: string; classification: "secret" | "non-secret" }>>([]);
  const [savedClassifications, setSavedClassifications] = React.useState<Array<{ name: string; classification: "secret" | "non-secret" }>>([]);
  const [revision, setRevision] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);
  const [value, setValue] = React.useState("");
  const [newName, setNewName] = React.useState("");
  const [newValue, setNewValue] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  React.useEffect(() => {
    if (!agent.runtimeId) return;
    void action<{ revision: string; variables: Array<{ name: string; classification: "secret" | "non-secret" }> }>("get_agent_runtime_environment_editor", { agentId: agent.id }).then((result) => {
      if (result) { setRevision(result.revision); setClassifications(result.variables); setSavedClassifications(result.variables); }
      setLoaded(true);
    });
  }, [agent.id, agent.runtimeId]);
  if (!agent.runtimeId || !loaded) return null;
  const apply = async (set: Record<string, string>, remove: string[] = []) => {
    const result = await action<{ revision: string; variables: typeof classifications }>("update_agent_runtime_environment", { agentId: agent.id, revision, set, remove });
    if (!result) {
      const latest = await action<{ revision: string; variables: typeof classifications }>("get_agent_runtime_environment_editor", { agentId: agent.id });
      if (latest) { setRevision(latest.revision); setClassifications(latest.variables); setSavedClassifications(latest.variables); }
      setEditing(null); setValue(""); setNewName(""); setNewValue(""); onFailed(); return false;
    }
    setRevision(result.revision); setClassifications(result.variables); setSavedClassifications(result.variables); setEditing(null); setValue(""); setNewName(""); setNewValue(""); setSaved(true); return true;
  };
  const classificationDirty = JSON.stringify(classifications) !== JSON.stringify(savedClassifications);
  return <fieldset data-runtime-environment className="grid min-w-0 gap-2 border-0 p-0">
    <legend className="text-sm font-medium text-muted-foreground">{translate("agents.runtimeEnvironment")}</legend>
    <p className="text-xs text-muted-foreground">{translate("agents.runtimeEnvironmentHelp")}</p>
    {classifications.length > 0 && <div role="group" className="grid gap-2" aria-label={translate("agents.runtimeEnvironmentClassifications")}>
      {classifications.map(({ name, classification }) => <div key={name} data-environment-name={name} className="grid min-w-0 gap-2 rounded-md border border-border p-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <strong className="break-all text-sm">{name}</strong>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs">{translate("agents.environmentClassification")}
            <select aria-label={`${name} ${translate("agents.environmentClassification")}`} value={classification} onChange={(event) => setClassifications((current) => current.map((entry) => entry.name === name ? { ...entry, classification: event.target.value as "secret" | "non-secret" } : entry))}>
              <option value="secret">{translate("agents.environmentSecret")}</option><option value="non-secret">{translate("agents.environmentNonSecret")}</option>
            </select>
          </label>
          {editing === name ? <>
            <label className="min-w-[12rem] flex-1 text-xs">{translate("agents.environmentValue")}<Input id={`environment-value-${agent.id}`} type="password" autoComplete="new-password" aria-describedby={`environment-value-help-${agent.id}`} value={value} onChange={(event) => setValue(event.target.value)} /></label>
            <small id={`environment-value-help-${agent.id}`} className="text-muted-foreground">{translate("agents.environmentUnchanged")}</small>
            <Button type="button" onClick={() => void apply({ [name]: value })}>{translate("agents.environmentUpdate")}</Button>
            <Button type="button" className="secondary" onClick={() => { setEditing(null); setValue(""); }}>{translate("agents.cancel")}</Button>
          </> : <Button type="button" className="secondary" disabled={classificationDirty} onClick={() => { setEditing(name); setValue(""); }}>{translate("agents.environmentChangeValue")}</Button>}
          <Button type="button" className="secondary" disabled={classificationDirty} onClick={() => void apply({}, [name])}>{translate("agents.environmentRemove")}</Button>
        </div>
      </div>)}
      <Button type="button" className="secondary justify-self-start" disabled={!classificationDirty} onClick={async () => {
        const result = await action<{ variables: typeof classifications }>("classify_agent_runtime_environment", { agentId: agent.id, classifications: Object.fromEntries(classifications.map(({ name, classification }) => [name, classification])) });
        if (!result) { onFailed(); return; }
        setClassifications(result.variables); setSavedClassifications(result.variables);
        const latest = await action<{ revision: string }>("get_agent_runtime_environment_editor", { agentId: agent.id });
        if (latest) setRevision(latest.revision);
        setSaved(true);
      }}>{translate("agents.environmentSaveClassifications")}</Button>
    </div>}
    <form method="post" className="grid min-w-0 gap-2 rounded-md border border-border p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); void apply({ [newName.trim()]: newValue }); }}>
      <label>{translate("agents.environmentName")}<Input name="variable-name" required value={newName} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(event) => setNewName(event.target.value)} /></label>
      <label>{translate("agents.environmentValue")}<Input name="variable-value" type="password" autoComplete="new-password" required value={newValue} onChange={(event) => setNewValue(event.target.value)} /></label>
      <Button type="submit" disabled={classificationDirty}>{translate("agents.environmentAdd")}</Button>
    </form>
    {saved && <p role="status" className="text-xs text-muted-foreground">{translate("agents.environmentSaved")}</p>}
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
  return <div ref={panel} tabIndex={-1} role="alertdialog" aria-labelledby={`retire-${agent.id}`} onKeyDown={(event) => { if (event.key === "Escape") close(); }} className="grid gap-2 rounded-md border border-destructive bg-destructive/10 p-3 outline-none">
    <strong id={`retire-${agent.id}`} className="text-sm text-destructive">{translate("agents.retire.title").replace("{name}", () => agent.name)}</strong>
    <ul className="m-0 grid list-none gap-0.5 p-0 text-sm" data-testid="retire-counts">
      {shown.map(([kind, value]) => <li key={kind}>{translate(`agents.retire.kind.${kind}` as Parameters<typeof translate>[0])}: {value}</li>)}
      {hidden.length > 0 && <li className="text-muted-foreground">{translate("agents.retire.more").replace("{count}", String(hidden.reduce((sum, [, value]) => sum + value, 0)))}</li>}
    </ul>
    <p className="m-0 text-sm text-muted-foreground">{translate(agent.enabled ? "agents.retire.help" : "agents.retire.helpDisabled")}</p>
    <div className="flex flex-wrap gap-2">
      {agent.enabled && <Button type="button" onClick={() => { onDisable(); document.querySelector<HTMLElement>(`[data-retire-trigger="${agent.id}"]`)?.focus(); }}>{translate("agents.disable")}</Button>}
      <Button type="button" className="secondary" onClick={close}>{translate("agents.retire.close")}</Button>
    </div>
  </div>;
}

/** Workspace Admins create, configure, enable, disable and delete Agents, and open them to projects. */
export function WorkspaceAgents() {
  const { workspace, selfId } = useWorkspace();
  const [workspaceRole, setWorkspaceRole] = React.useState<Member["role"] | null>(null);
  const [agents, setAgents] = React.useState<AgentRecord[]>([]);
  const [askable, setAskable] = React.useState<Array<{ id: string; name: string; codeCapable: boolean; ownerName: string | null; hasAccess: boolean }>>([]);
  const [ownerAgents, setOwnerAgents] = React.useState<ManagedAgent[]>([]);
  const [manageableAgentIds, setManageableAgentIds] = React.useState<string[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [runtimes, setRuntimes] = React.useState<RuntimeOption[]>([]);
  const [memberAgent, setMemberAgent] = React.useState({ name: "", instructions: "", model: "default", runtimeId: "" });
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
    const role = members.find((member) => member.userId === selfId)?.role ?? null;
    setWorkspaceRole(role);
    const admin = role === "Admin";
    if (!admin) {
      const [runtimeRows, ownedAgents, visibleProjects] = await Promise.all([
        action<RuntimeOption[]>("list_runtimes", { workspaceId: workspace.id }),
        action<ManagedAgent[]>("list_manageable_agent_access", { workspaceId: workspace.id }),
        action<Project[]>("list_projects", { workspaceId: workspace.id }),
      ]);
      setRuntimes(runtimeRows ?? []);
      setOwnerAgents(ownedAgents ?? []);
      setProjects((visibleProjects ?? []).filter((project) => !project.archived));
      setAskable(await action<Array<{ id: string; name: string; codeCapable: boolean; ownerName: string | null; hasAccess: boolean }>>("list_agents_for_viewer", { workspaceId: workspace.id }) ?? []);
      setProjectsLoaded(true);
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
  if (workspaceRole === null) return <section>{header}</section>;
  if (workspaceRole !== "Admin") return <section>{header}
    {workspaceRole === "Member" && <SettingsBlock title={translate("agents.memberCreateTitle")}>
      <p className="text-sm text-muted-foreground">{translate("agents.memberCreateHelp")}</p>
      {runtimes.filter((runtime) => runtime.ownerId === selfId && runtime.shared).length === 0
        ? <p className="text-sm text-muted-foreground">{translate("agents.memberNoRuntime")}</p>
        : <form className="grid gap-3" onSubmit={async (event) => {
          event.preventDefault();
          const result = await action("create_agent", { workspaceId: workspace.id, ...memberAgent, runtimeId: memberAgent.runtimeId });
          if (result !== null) setMemberAgent({ name: "", instructions: "", model: "default", runtimeId: "" });
          await guard(result);
        }}>
          <label>{translate("agents.name")}<Input required maxLength={100} value={memberAgent.name} onChange={(event) => setMemberAgent({ ...memberAgent, name: event.target.value })} /></label>
          <label>{translate("agents.instructions")}<Textarea rows={4} value={memberAgent.instructions} onChange={(event) => setMemberAgent({ ...memberAgent, instructions: event.target.value })} /></label>
          <label>{translate("agents.model")}<Input required value={memberAgent.model} onChange={(event) => setMemberAgent({ ...memberAgent, model: event.target.value })} /></label>
          <label>{translate("agents.runsOn")}<select required value={memberAgent.runtimeId} onChange={(event) => setMemberAgent({ ...memberAgent, runtimeId: event.target.value })}><option value="">{translate("agents.selectOwnRuntime")}</option>{runtimes.filter((runtime) => runtime.ownerId === selfId && runtime.shared).map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.hostname} · {runtime.agentCli} · {translate(runtime.online ? "runtimes.online" : "runtimes.offline")}</option>)}</select></label>
          <Button type="submit">{translate("agents.create")}</Button>
        </form>}
    </SettingsBlock>}
    <SettingsBlock title={translate("agents.askableTitle")}>
      <p className="text-sm text-muted-foreground">{translate("agents.askableHelp")}</p>
      {askable.length === 0 ? <p className="text-muted-foreground">{translate("agents.askableEmpty")}</p> : <RowList>{askable.map((agent) => <Row key={agent.id}>
        <div className="mr-auto grid min-w-0 gap-0.5"><span className="flex items-center gap-2"><Avatar name={agent.name} id={agent.id} agent size="md" /><span className={agent.hasAccess ? "font-medium" : "font-medium text-muted-foreground"}>{agent.name}</span></span><span className="text-sm text-muted-foreground">{agent.codeCapable && agent.ownerName ? translate("agents.askableOwner").replace("{name}", agent.ownerName) : translate("agents.askableServer")}</span></div>
        <span className="text-sm text-muted-foreground">{agent.hasAccess ? translate("agents.askableUsable") : agent.ownerName ? translate("agents.askableAsk").replace("{name}", agent.ownerName) : translate("agents.askableAskAdmin")}</span>
      </Row>)}</RowList>}
    </SettingsBlock>
    {workspaceRole === "Member" && ownerAgents.map((agent) => (
      <div key={agent.id} data-owner-agent={agent.name} className="grid gap-2 border-b border-border py-3"><div className="flex flex-wrap items-center gap-x-2"><Avatar name={agent.name} id={agent.id} agent /><strong>{agent.name}</strong><span className="text-sm text-muted-foreground">{profileSummary(agent).join(" · ")}</span></div>
        {workspaceRole === "Member" && agent.memberOwned && agent.createdBy === selfId && <MemberAgentSettings agent={agent} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} />}
        {workspaceRole === "Member" && agent.memberOwned && agent.createdBy === selfId && <AccessEditor agent={agent} projects={projects.filter((project) => project.role === "Admin" || project.role === "Member")} canSetAllProjects={false} projectsLoaded={projectsLoaded} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} />}
        <AgentRuntimeProfile agent={agent} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} /><AgentRuntimeEnvironment agent={agent} onFailed={() => setNote(translate("agents.failed"))} /><AgentPeopleAccess agent={agent} members={members} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} />
      </div>
    ))}
    {note && <Note note={note} />}
  </section>;
  return <section>
    <SettingsHeader title={translate("agents.title")} description={translate("agents.desc")}>
      {!creatingOpen && <Button type="button" onClick={() => setCreatingOpen(true)}>{translate("agents.newAgent")}</Button>}
    </SettingsHeader>
    {creatingOpen && <SettingsBlock title={translate("agents.create")}>
      <AgentForm draft={creating} runtimes={runtimes} allowAutopilot={allowAutopilot} onChange={setCreating} onCancel={() => { setCreating(emptyDraft); setCreatingOpen(false); }} onSubmit={async () => {
        const result = await action("create_agent", { workspaceId: workspace.id, name: creating.name, instructions: creating.instructions, model: creating.model, autopilot: creating.runtimeId ? undefined : creating.autopilot, canWakeAgents: creating.canWakeAgents, runtimeId: creating.runtimeId || null, cliModel: creating.cliModel || null, maxConcurrentRuns: optionalInt(creating.maxConcurrentRuns), ...limits(creating), monthlyTokenBudget: optionalInt(creating.monthlyTokenBudget) ?? null });
        if (result !== null) { setCreating(emptyDraft); setCreatingOpen(false); }
        await guard(result);
      }} />
    </SettingsBlock>}
    <SettingsBlock>
      {agents.length === 0 ? <p className="text-muted-foreground">{translate("agents.none")}</p> : <RowList>{agents.map((agent) => { const runtime = runtimeParts(agent); return <Row key={agent.id}>
        <div className="grid min-w-0 flex-1 gap-2" data-agent={agent.name}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2"><Avatar name={agent.name} id={agent.id} agent size="md" /><span className="font-medium">{agent.name}</span></span>
            <span className="text-sm text-muted-foreground">{translate(agent.enabled ? "agents.enabled" : "agents.disabled")} · {agent.model === "default" ? translate("agents.defaultModel") : agent.model} · {runtime ? [translate("agents.metaComputer").replace("{name}", runtime.computer), agent.runtimeOwnerName ? translate("agents.metaOwner").replace("{name}", agent.runtimeOwnerName) : null, runtime.tool ? translate("agents.metaTool").replace("{name}", capitalize(runtime.tool)) : null, translate(agent.runtimeOnline ? "agents.metaOnline" : "agents.metaOffline"), ...profileSummary(agent)].filter(Boolean).join(" · ") : translate("agents.server")} · {translate("agents.usage").replace("{used}", formatNumber(agent.monthlyTokensUsed))}</span>
          </div>
          {editing?.id === agent.id
            ? <AgentForm draft={editing.draft} runtimes={runtimes} allowAutopilot={allowAutopilot} onChange={(draft) => setEditing({ id: agent.id, draft })} onCancel={() => setEditing(null)} onSubmit={async () => {
              const draft = editing.draft;
              await guard(await action("update_agent", { agentId: agent.id, name: draft.name, instructions: draft.instructions, model: draft.model, autopilot: draft.runtimeId ? undefined : draft.autopilot, canWakeAgents: draft.canWakeAgents, runtimeId: draft.runtimeId || null, cliModel: draft.cliModel || null, maxConcurrentRuns: optionalInt(draft.maxConcurrentRuns), ...limits(draft), monthlyTokenBudget: optionalInt(draft.monthlyTokenBudget) ?? null }));
              setEditing(null);
            }} />
          : <><AccessEditor agent={agent} projects={projects} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} />
            {manageableAgentIds.includes(agent.id) ? <AgentPeopleAccess agent={agent} members={members} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} /> : <p className="text-xs text-muted-foreground">{translate("agents.runtimeOwnerAccess")}</p>}</>}
          {manageableAgentIds.includes(agent.id) && agent.runtimeId && <AgentRuntimeProfile agent={agent} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} />}
          {manageableAgentIds.includes(agent.id) && agent.runtimeId && <AgentRuntimeEnvironment agent={agent} onFailed={() => setNote(translate("agents.failed"))} />}
          <fieldset className="grid gap-1 border-0 p-0"><legend className="text-sm font-medium text-muted-foreground">{translate("agents.skills")}</legend>
            {workspaceSkills.length === 0 ? <span className="text-sm text-muted-foreground">{translate("agents.noSkills")}</span> : workspaceSkills.map((skill) => <label key={skill.id} className="flex items-center gap-2" title={skill.description}>
              <Checkbox checked={agent.skills.some((attached) => attached.id === skill.id)} onChange={async (event) => {
                const ids = event.target.checked ? [...agent.skills.map((entry) => entry.id), skill.id] : agent.skills.filter((entry) => entry.id !== skill.id).map((entry) => entry.id);
                await guard(await action("set_agent_skills", { agentId: agent.id, skillIds: ids }));
              }} />{skill.name}</label>)}
          </fieldset>
          <TriggerSection agent={agent} projects={projects} projectsLoaded={projectsLoaded} />
          <AgentRuns agent={agent} />
          <p className="text-sm text-muted-foreground">{translate("agents.retire.hint")}</p>
          <div className="flex flex-wrap gap-2">
            {editing?.id !== agent.id && <Button type="button" className="secondary" onClick={() => setEditing({ id: agent.id, draft: toDraft(agent) })}>{translate("agents.edit")}</Button>}
            <Button type="button" className="secondary" onClick={async () => { setRetiring(null); await guard(await action(agent.enabled ? "disable_agent" : "enable_agent", { agentId: agent.id })); }}>{translate(agent.enabled ? "agents.disable" : "agents.enable")}</Button>
            <Button type="button" className={dangerOutline} data-retire-trigger={agent.id} onClick={async () => {
              // The same counts the server refuses with: a refused Agent gets the dialog instead of a failed request.
              const check = await action<{ blocked: boolean; counts: Record<string, number> }>("get_agent_content_counts", { agentId: agent.id });
              if (check === null) { setNote(translate("agents.failed")); return; }
              if (check.blocked) { setRetiring({ id: agent.id, counts: check.counts }); return; }
              setRetiring(null);
              if (window.confirm(translate("agents.deleteConfirm"))) await guard(await action("delete_agent", { agentId: agent.id }));
            }}>{translate("agents.delete")}</Button>
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
  return <fieldset className="grid gap-2 border-0 p-0"><legend className="text-sm font-medium text-muted-foreground">{translate("triggers.title")}</legend>
    <div className="flex flex-wrap gap-2">
      <label className="grid gap-1 text-xs text-muted-foreground">{translate("triggers.project")}<select aria-label={translate("triggers.project")} value={projectId} disabled={!projectsLoaded || availableProjects.length === 0} onChange={(e) => setProjectId(e.target.value)}>
        {!projectsLoaded && <option value="">{translate("triggers.projectsLoading")}</option>}
        {projectsLoaded && availableProjects.length === 0 && <option value="">{translate("triggers.noAccessibleProjects")}</option>}
        {availableProjects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
      </select></label>
      <label className="grid gap-1 text-xs text-muted-foreground">{translate("triggers.kind")}<select aria-label={translate("triggers.kind")} value={kind} onChange={(e) => setKind(e.target.value)}><option value="event">{translate("triggers.eventKind")}</option><option value="schedule">{translate("triggers.scheduleKind")}</option></select></label>
      {kind === "event" ? <label className="grid gap-1 text-xs text-muted-foreground">{translate("triggers.event")}<select aria-label={translate("triggers.event")} value={eventType} onChange={(e) => setEventType(e.target.value)}>{(["work_item_created", "work_item_updated", "state_changed", "assignee_changed", "comment_added", "sub_items_closed"] as TriggerEvent[]).map((event) => <option key={event} value={event}>{translate(`triggers.${event}`)}</option>)}</select></label> : <><label className="grid gap-1 text-xs text-muted-foreground">{translate("triggers.schedule")}<select aria-label={translate("triggers.schedule")} value={schedule} onChange={(e) => setSchedule(e.target.value)}>{(["daily", "weekly", "monthly", "cron"] as const).map((entry) => <option key={entry} value={entry}>{translate(`triggers.${entry}`)}</option>)}</select></label>{schedule === "cron" && <label className="grid gap-1 text-xs text-muted-foreground">{translate("triggers.cron")}<Input aria-label={translate("triggers.cron")} value={expression} onChange={(e) => setExpression(e.target.value)} /></label>}</>}
      <Button type="button" onClick={() => void create()} disabled={!projectsLoaded || !availableProjects.some((project) => project.id === projectId)}>{translate("triggers.add")}</Button>
    </div>
    {!projectsLoaded ? <p role="status" className="m-0 text-xs text-muted-foreground">{translate("triggers.projectsLoading")}</p>
      : availableProjects.length === 0 ? <p role="status" className="m-0 text-xs text-muted-foreground">{translate(projects.length === 0 ? "triggers.noProjects" : "triggers.noAccessibleProjectsHelp")}</p> : null}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {rows.map((trigger) => <div key={trigger.id} className="flex gap-2 text-sm"><span>{projects.find((p) => p.id === trigger.projectId)?.key} · {trigger.schedule ? `${translate(`triggers.${trigger.schedule}`)}${trigger.expression ? ` (${trigger.expression})` : ""}` : translate(`triggers.${trigger.eventType ?? "work_item_created"}`)}</span>
      <Button type="button" className="secondary" onClick={async () => { await action("pause_trigger", { triggerId: trigger.id, paused: !trigger.paused }); await reload(); }}>{translate(trigger.paused ? "triggers.resume" : "triggers.pause")}</Button>
      <Button type="button" className="secondary" onClick={async () => { await action("delete_trigger", { triggerId: trigger.id }); await reload(); }}>{translate("triggers.delete")}</Button></div>)}
  </fieldset>;
}

function AgentRuns({ agent }: { agent: AgentRecord }) {
  type TranscriptStep = { seq: number; kind: "thought" | "answer" | "question" | "error" | "person" | "tool_call"; text?: string; author?: string; toolName?: string; input?: unknown; result?: unknown; failed?: boolean };
  type Transcript = {
    steps: TranscriptStep[];
    runtimeProfile: { name: string; sandbox: string; enforceSandbox: boolean } | null;
    failureMessage: string | null;
    failureReason: string | null;
    confirmations: Array<{ id: string; action: string; input: unknown; status: string; expiresAt: string }>;
  };
  type RunRow = { id: string; workItemId: string | null; workItem: { displayId: string; title: string } | null; status: string; createdAt: string };
  const [rows, setRows] = React.useState<RunRow[] | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [transcript, setTranscript] = React.useState<Record<string, Transcript>>({});
  const [transcriptLoading, setTranscriptLoading] = React.useState<Record<string, boolean>>({});
  const [transcriptFailed, setTranscriptFailed] = React.useState<Record<string, boolean>>({});
  const reload = React.useCallback(async () => {
    setLoadFailed(false);
    const loaded = await action<RunRow[]>("list_agent_runs", { agentId: agent.id });
    if (loaded === null) { setLoadFailed(true); return; }
    setRows(loaded);
  }, [agent.id]);
  React.useEffect(() => { void reload(); }, [reload]);
  const loadTranscript = async (runId: string) => {
    setTranscriptLoading((old) => ({ ...old, [runId]: true }));
    setTranscriptFailed((old) => ({ ...old, [runId]: false }));
    const loaded = await action<Transcript>("get_run_transcript", { runId });
    if (loaded) setTranscript((old) => ({ ...old, [runId]: loaded }));
    else setTranscriptFailed((old) => ({ ...old, [runId]: true }));
    setTranscriptLoading((old) => ({ ...old, [runId]: false }));
  };
  const statusTone = (status: string) => status === "completed" ? "text-green-700" : ["failed", "stale"].includes(status) ? "text-destructive" : ["running", "dispatched", "waiting_confirmation", "awaiting_input"].includes(status) ? "text-foreground" : "text-muted-foreground";
  const confirmationStatus = (status: string) => ({ pending: "agents.logConfirmationPending", confirmed: "agents.logConfirmationConfirmed", rejected: "agents.logConfirmationRejected", expired: "agents.logConfirmationExpired" } as const)[status as "pending" | "confirmed" | "rejected" | "expired"];
  const pretty = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <fieldset data-testid="agent-log" aria-busy={rows === null && !loadFailed} className="grid gap-2 border-0 p-0">
    <legend className="text-sm font-medium text-muted-foreground">{translate("agents.logTitle")}</legend>
    {rows === null && !loadFailed && <p role="status" className="m-0 text-sm text-muted-foreground">{translate("agents.logLoading")}</p>}
    {loadFailed && <p role="alert" className="m-0 text-sm text-destructive">{translate("agents.logFailed")} <Button type="button" className="secondary" onClick={() => void reload()}>{translate("agents.logRetry")}</Button></p>}
    {rows?.length === 0 && <p role="status" className="m-0 text-sm text-muted-foreground">{translate("agents.runsEmpty")}</p>}
    {rows?.map((run) => <details key={run.id} data-agent-log-run className="min-w-0 rounded-md border border-border bg-card px-3 py-2" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !transcript[run.id] && !transcriptLoading[run.id]) void loadTranscript(run.id); }}>
      <summary className="flex min-w-0 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="min-w-0 flex-1 break-words font-medium">{run.workItem ? <>{run.workItem.displayId} · {run.workItem.title}</> : run.workItemId ? translate("agents.logWorkItemUnavailable") : translate("runs.scheduled")}</span>
        <span className={`whitespace-nowrap font-medium ${statusTone(run.status)}`}>{translate(`runs.status.${run.status}` as "runs.status.queued")}</span>
        <time className="text-xs text-muted-foreground" dateTime={run.createdAt}>{formatDate(run.createdAt)}</time>
      </summary>
      <div className="mt-2 border-t border-border pt-2 text-sm">
        {transcriptLoading[run.id] && <p role="status" className="m-0 text-muted-foreground">{translate("agents.logTranscriptLoading")}</p>}
        {transcriptFailed[run.id] && <p role="alert" className="m-0 text-destructive">{translate("agents.logTranscriptFailed")} <Button type="button" className="secondary" onClick={() => void loadTranscript(run.id)}>{translate("agents.logRetry")}</Button></p>}
        {transcript[run.id]?.runtimeProfile && <p className="m-0 text-xs text-muted-foreground"><strong>{translate("agents.logRuntimeProfile")}:</strong> {transcript[run.id]!.runtimeProfile!.name} · {translate(transcript[run.id]!.runtimeProfile!.sandbox === "full" ? "runtimes.fullAccessWarning" : "runtimes.sandboxEnabled")} · {translate(transcript[run.id]!.runtimeProfile!.enforceSandbox ? "agents.logSandboxEnforced" : "agents.logSandboxNotEnforced")}</p>}
        {transcript[run.id]?.failureReason && <div role="alert" className="text-destructive"><strong>{translate("agents.logFailure")}:</strong> {runFailureText(transcript[run.id]!.failureReason) ?? translate("runs.failed")}{transcript[run.id]!.failureMessage && <p className="m-0 text-muted-foreground">{translate("runs.failureDetail").replace("{detail}", () => transcript[run.id]!.failureMessage!)}</p>}</div>}
        {transcript[run.id]?.steps.length === 0 && <p className="m-0 text-muted-foreground">{translate("runs.noSteps")}</p>}
        <ol className="m-0 grid list-none gap-2 p-0">
          {transcript[run.id]?.steps.map((step) => step.kind === "tool_call" ? <li key={step.seq} className="grid min-w-0 gap-1">
            <span className="font-medium">{translate("runs.tool")}: {step.toolName}{step.failed ? ` · ${translate("runs.toolFailed")}` : ""}</span>
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{translate("agents.logToolDetails")}</summary>
              {step.input === null && step.result === null ? <p className="m-0">{translate("runs.hidden")}</p> : <>
                {step.input !== undefined && step.input !== null && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2">{pretty(step.input)}</pre>}
              {step.result !== undefined && step.result !== null && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2">{pretty(step.result)}</pre>}
              </>}
            </details>
          </li> : <li key={step.seq} className="min-w-0 break-words">{step.kind === "person" ? <><span className="font-medium">{translate("runs.personMessage").replace("{name}", () => step.author ?? "")}: </span>{step.text}</> : <><span className="font-medium">{translate(`runs.${step.kind}` as "runs.answer")}: </span>{step.text}</>}</li>)}
        </ol>
        {(transcript[run.id]?.confirmations.length ?? 0) > 0 && <section className="mt-2 grid gap-1 border-t border-border pt-2" aria-label={translate("agents.logConfirmations")}>
          <h4 className="m-0 text-xs font-medium">{translate("agents.logConfirmations")}</h4>
          {transcript[run.id]!.confirmations.map((confirmation) => <details key={confirmation.id} className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{confirmation.action} · {confirmationStatus(confirmation.status) ? translate(confirmationStatus(confirmation.status)!) : confirmation.status} · {translate("agents.logExpiresAt")} <time dateTime={confirmation.expiresAt}>{formatDate(confirmation.expiresAt)}</time></summary>
            <p className="m-0">{translate("agents.logConfirmationDetails")}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2">{pretty(confirmation.input)}</pre>
          </details>)}
        </section>}
      </div>
    </details>)}
  </fieldset>;
}
