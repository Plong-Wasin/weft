import React from "react";
import { formatNumber, translate } from "@weft/shared";
import { action } from "../../api";
import { useWorkspace } from "../../layouts/workspace-layout";
import type { Member, Project } from "../../types";
import { dangerButton, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

export type AgentRecord = {
  id: string; userId: string; name: string; instructions: string; model: string; enabled: boolean; allProjects: boolean; projectIds: string[];
  skills: Array<{ id: string; name: string; description: string }>;
  maxToolCalls: number; maxTokens: number; timeoutSeconds: number; monthlyTokenBudget: number | null; monthlyTokensUsed: number;
};

type Draft = { name: string; instructions: string; model: string; maxToolCalls: string; maxTokens: string; timeoutSeconds: string; monthlyTokenBudget: string };
const emptyDraft: Draft = { name: "", instructions: "", model: "default", maxToolCalls: "", maxTokens: "", timeoutSeconds: "", monthlyTokenBudget: "" };
const toDraft = (agent: AgentRecord): Draft => ({
  name: agent.name, instructions: agent.instructions, model: agent.model, maxToolCalls: String(agent.maxToolCalls), maxTokens: String(agent.maxTokens),
  timeoutSeconds: String(agent.timeoutSeconds), monthlyTokenBudget: agent.monthlyTokenBudget === null ? "" : String(agent.monthlyTokenBudget),
});
const optionalInt = (value: string) => value.trim() === "" ? undefined : Number(value);

function AgentForm({ draft, onChange, onSubmit, onCancel }: { draft: Draft; onChange: (draft: Draft) => void; onSubmit: () => void; onCancel?: () => void }) {
  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...draft, [key]: event.target.value });
  const number = (key: "maxToolCalls" | "maxTokens" | "timeoutSeconds" | "monthlyTokenBudget", label: Parameters<typeof translate>[0]) =>
    <label>{translate(label)}<input type="number" min={1} value={draft[key]} onChange={set(key)} /></label>;
  return <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <label>{translate("agents.name")}<input required maxLength={100} value={draft.name} onChange={set("name")} /></label>
    <label>{translate("agents.instructions")}<textarea rows={4} value={draft.instructions} onChange={set("instructions")} /></label>
    <label>{translate("agents.model")}<input required value={draft.model} onChange={set("model")} /></label>
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

/** Workspace Admins create, configure, enable, disable and delete Agents, and open them to projects. */
export function WorkspaceAgents() {
  const { workspace, selfId } = useWorkspace();
  const [isAdmin, setIsAdmin] = React.useState<boolean | null>(null);
  const [agents, setAgents] = React.useState<AgentRecord[]>([]);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [workspaceSkills, setWorkspaceSkills] = React.useState<Array<{ id: string; name: string; description: string }>>([]);
  const [creating, setCreating] = React.useState<Draft>(emptyDraft);
  const [editing, setEditing] = React.useState<{ id: string; draft: Draft } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const members = await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? [];
    const admin = members.find((member) => member.userId === selfId)?.role === "Admin";
    setIsAdmin(admin);
    if (!admin) return;
    setAgents(await action<AgentRecord[]>("list_agents", { workspaceId: workspace.id }) ?? []);
    setWorkspaceSkills((await action<Array<{ id: string; name: string; description: string; scope: string }>>("list_skills", { workspaceId: workspace.id }) ?? []).filter((skill) => skill.scope === "workspace"));
    setProjects((await action<Project[]>("list_projects", { workspaceId: workspace.id }) ?? []).filter((project) => !project.archived));
  }, [workspace.id, selfId]);
  React.useEffect(() => { void load(); }, [load]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("agents.failed") : null); await load(); };
  const limits = (draft: Draft) => ({ maxToolCalls: optionalInt(draft.maxToolCalls), maxTokens: optionalInt(draft.maxTokens), timeoutSeconds: optionalInt(draft.timeoutSeconds) });
  const header = <SettingsHeader title={translate("agents.title")} description={translate("agents.desc")} />;
  if (isAdmin === null) return <section>{header}</section>;
  if (!isAdmin) return <section>{header}<p role="status" className="text-secondary">{translate("agents.adminOnly")}</p></section>;
  return <section>
    {header}
    <SettingsBlock title={translate("agents.create")}>
      <AgentForm draft={creating} onChange={setCreating} onSubmit={async () => {
        const result = await action("create_agent", { workspaceId: workspace.id, name: creating.name, instructions: creating.instructions, model: creating.model, ...limits(creating), monthlyTokenBudget: optionalInt(creating.monthlyTokenBudget) ?? null });
        if (result !== null) setCreating(emptyDraft);
        await guard(result);
      }} />
    </SettingsBlock>
    <SettingsBlock>
      {agents.length === 0 ? <p className="text-secondary">{translate("agents.none")}</p> : <RowList>{agents.map((agent) => <Row key={agent.id}>
        <div className="grid min-w-0 flex-1 gap-2" data-agent={agent.name}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{agent.name}</span>
            <span className="text-13 text-secondary">{translate(agent.enabled ? "agents.enabled" : "agents.disabled")} · {agent.model} · {translate("agents.usage").replace("{used}", formatNumber(agent.monthlyTokensUsed))}</span>
          </div>
          {editing?.id === agent.id
            ? <AgentForm draft={editing.draft} onChange={(draft) => setEditing({ id: agent.id, draft })} onCancel={() => setEditing(null)} onSubmit={async () => {
              const draft = editing.draft;
              await guard(await action("update_agent", { agentId: agent.id, name: draft.name, instructions: draft.instructions, model: draft.model, ...limits(draft), monthlyTokenBudget: optionalInt(draft.monthlyTokenBudget) ?? null }));
              setEditing(null);
            }} />
            : <AccessEditor agent={agent} projects={projects} onSaved={() => void load()} onFailed={() => setNote(translate("agents.failed"))} />}
          <fieldset className="grid gap-1 border-0 p-0"><legend className="text-13 font-medium text-secondary">{translate("agents.skills")}</legend>
            {workspaceSkills.length === 0 ? <span className="text-13 text-secondary">{translate("agents.noSkills")}</span> : workspaceSkills.map((skill) => <label key={skill.id} className="flex items-center gap-2" title={skill.description}>
              <input type="checkbox" checked={agent.skills.some((attached) => attached.id === skill.id)} onChange={async (event) => {
                const ids = event.target.checked ? [...agent.skills.map((entry) => entry.id), skill.id] : agent.skills.filter((entry) => entry.id !== skill.id).map((entry) => entry.id);
                await guard(await action("set_agent_skills", { agentId: agent.id, skillIds: ids }));
              }} />{skill.name}</label>)}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            {editing?.id !== agent.id && <button type="button" className="secondary" onClick={() => setEditing({ id: agent.id, draft: toDraft(agent) })}>{translate("agents.edit")}</button>}
            <button type="button" className="secondary" onClick={async () => guard(await action(agent.enabled ? "disable_agent" : "enable_agent", { agentId: agent.id }))}>{translate(agent.enabled ? "agents.disable" : "agents.enable")}</button>
            <button type="button" className={dangerButton} onClick={async () => { if (window.confirm(translate("agents.deleteConfirm"))) await guard(await action("delete_agent", { agentId: agent.id })); }}>{translate("agents.delete")}</button>
          </div>
        </div>
      </Row>)}</RowList>}
    </SettingsBlock>
    <Note note={note} error />
  </section>;
}
