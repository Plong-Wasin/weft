import React from 'react';

// Client side of "Generate with AI": connection availability, the run lifecycle and the dialog
// where a member writes a goal, picks the scope and watches the run. The AI only ever proposes;
// the resulting Proposal is reviewed and approved on the Proposal screen.

export type ApiFn = <T>(path: string, init?: RequestInit) => Promise<T>;
export type AiConnection = { id: string; provider: string; billing_mode: string; model_default: string | null; state: string; state_reason: string; enabled: boolean };
export type AiAvailability =
  | { status: 'loading' }
  | { status: 'ready'; connection: AiConnection }
  | { status: 'unavailable'; reason: string };
export type AiCapability = 'generate' | 'split' | 'link' | 'summarize';
export type AiFocusTask = { id: string; number: number; title: string; project_id: string };
export type AiScope = { projects: string[]; tasks: string[]; vaults: string[] };
export type AiSource = { kind: string; id: string; label: string; task_number?: number | null };
export type AiPreview = { provider: string; model: string | null; billing_mode: string; sources: AiSource[] };
export type AiRun = {
  id: string;
  state: string;
  summary: string;
  pause_reason: string | null;
  sources_read: AiSource[];
  result: { proposal_id?: string; summary?: string; tool_activity?: { truncated?: boolean }[]; truncated?: boolean } | null;
  tool_activity?: { truncated?: boolean }[];
};
export type RunNotes = { provider: string; summary: string; read: AiSource[]; unread: AiSource[]; truncated: boolean };
export type GenerationContext = { connectionId: string; goal: string; scope: AiScope; notes: RunNotes };

export async function loadAiAvailability(api: ApiFn, workspaceId: string): Promise<AiAvailability> {
  try {
    const result = await api<{ connection: AiConnection | null }>(`/ai/defaults?workspace_id=${workspaceId}`);
    if (!result.connection) return { status: 'unavailable', reason: 'No AI connection is set up for this Workspace. Ask an admin to add one.' };
    if (!result.connection.enabled || result.connection.state !== 'ready') {
      return { status: 'unavailable', reason: `The AI connection is not ready: ${result.connection.state_reason || result.connection.state}.` };
    }
    return { status: 'ready', connection: result.connection };
  } catch {
    return { status: 'unavailable', reason: 'AI availability could not be checked right now.' };
  }
}

const runStateLabels: Record<string, string> = {
  queued: 'Waiting for a runner',
  running: 'Reading sources and planning',
  rate_limited: 'Waiting for the provider rate limit',
  waiting_for_approval: 'Plan ready',
  completed: 'Finished',
  needs_login: 'The provider needs a new sign-in',
  failed: 'The run failed',
  canceled: 'The run was canceled',
};

export function runStateLabel(state: string) {
  return runStateLabels[state] ?? state;
}

export class RunStopped extends Error {}

/** Starts a run and reconciles its state after run events. Resolves with its id and the run. */
export async function runGeneration(
  api: ApiFn,
  input: { workspaceId: string; connectionId: string; scope: AiScope; prompt: string; capability?: AiCapability },
  hooks: { onRun: (run: AiRun) => void; isStopped: () => boolean },
): Promise<{ proposalId: string; run: AiRun }> {
  const started = await api<{ id: string }>('/ai/runs', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: input.workspaceId, connection_id: input.connectionId, capability: input.capability ?? 'generate', scope: input.scope, prompt: input.prompt }),
  });
  hooks.onRun({ id: started.id, state: 'queued', summary: 'Waiting for an available runner', pause_reason: null, sources_read: [], result: null });
  const giveUp = Date.now() + 15 * 60_000;
  while (Date.now() < giveUp) {
    if (hooks.isStopped()) throw new RunStopped('Generation was canceled.');
    await waitForRunChange(api, input.workspaceId, started.id, hooks.isStopped);
    if (hooks.isStopped()) throw new RunStopped('Generation was canceled.');
    const run = await api<AiRun>(`/ai/runs/${started.id}`);
    hooks.onRun(run);
    if (['waiting_for_approval', 'completed'].includes(run.state)) {
      if (run.result?.proposal_id) return { proposalId: run.result.proposal_id, run };
      throw new Error(run.summary || 'The AI finished without a plan.');
    }
    if (['failed', 'canceled', 'needs_login'].includes(run.state)) throw new Error(run.pause_reason ? `${run.summary} (${run.pause_reason})` : run.summary);
  }
  throw new Error('The run is taking too long. Check it again later.');
}

async function waitForRunChange(api: ApiFn, workspaceId: string, runId: string, isStopped: () => boolean) {
  const snapshot = await api<{ cursor: number }>(`/workspaces/${workspaceId}/realtime/snapshot`);
  await new Promise<void>((resolve) => {
    const source = new EventSource(`/api/v1/workspaces/${workspaceId}/realtime/events?after=${snapshot.cursor}`, { withCredentials: true });
    let timeout = 0;
    let canceled = 0;
    const finish = () => { source.close(); window.clearTimeout(timeout); window.clearInterval(canceled); resolve(); };
    timeout = window.setTimeout(finish, 10_000);
    canceled = window.setInterval(() => { if (isStopped()) finish(); }, 250);
    source.addEventListener('change', (event) => {
      const change = JSON.parse((event as MessageEvent<string>).data) as { entity_type?: string; entity_id?: string };
      if (change.entity_type === 'run' && change.entity_id === runId) finish();
    });
    source.addEventListener('scope_revoked', finish);
    source.onerror = finish;
  });
}

export function notesFromRun(run: AiRun, preview: AiPreview | null, provider: string): RunNotes {
  const readIds = new Set(run.sources_read.map((source) => source.id));
  const unread = (preview?.sources ?? []).filter((source) => source.kind !== 'project' && !readIds.has(source.id));
  const truncated = run.result?.truncated === true || (run.result?.tool_activity ?? []).some((entry) => entry.truncated);
  return { provider, summary: run.result?.summary ?? run.summary, read: run.sources_read, unread, truncated };
}

const capabilityText: Record<AiCapability, { title: string; field: string; submit: string; busy: string; placeholder: string; intro: string }> = {
  generate: { title: 'Generate with AI', field: 'Goal', submit: 'Generate plan', busy: 'Generating…', placeholder: 'Open work for the subscription system: API, Web and QA, with UAT', intro: 'The AI reads only what you choose and proposes a plan. Nothing is created until you review and approve it.' },
  split: { title: 'Suggest split', field: 'Instructions', submit: 'Suggest split', busy: 'Suggesting…', placeholder: 'Optional: split by platform, keep QA in the original', intro: 'The AI reads this Task and proposes subtasks or peer Tasks. The original Task, its comments and attachments stay where they are. Nothing changes until you approve.' },
  link: { title: 'Suggest links', field: 'Instructions', submit: 'Suggest links', busy: 'Suggesting…', placeholder: 'Optional: look for duplicates and blockers', intro: 'The AI reads this Task and the Tasks you can open, then proposes related, duplicate, blocks and parent links. Nothing changes until you approve.' },
  summarize: { title: 'Summarize discussion', field: 'Focus', submit: 'Start summary', busy: 'Summarizing…', placeholder: 'Summarize the discussion, progress and blockers.', intro: 'The AI reads this Task chat and related Tasks in the selected scope. Comments are untrusted data. This run only returns a summary and makes no changes.' },
};

/** The text sent to the AI for a split or link run on one Task; members can edit it before starting. */
export function defaultFocusPrompt(capability: AiCapability, task: AiFocusTask) {
  if (capability === 'summarize') return `Summarize discussion, progress and blockers for task #${task.number} "${task.title}". Read the Task chat and related Tasks in scope. Cite the sources you used and say when any source was truncated.`;
  return capability === 'split'
    ? `Suggest how to split task #${task.number} "${task.title}" into smaller subtasks or peer Tasks, and say what stays in the original.`
    : `Suggest links for task #${task.number} "${task.title}": related, duplicate, blocks and parent links with other Tasks I can read.`;
}

type DialogProps = {
  capability?: AiCapability;
  focusTask?: AiFocusTask | null;
  api: ApiFn;
  workspaceId: string;
  connection: AiConnection;
  projects: { id: string; name: string }[];
  vaults: { id: string; name: string }[];
  selectedTaskIds: string[];
  defaultProjectId: string;
  initialGoal: string;
  onClose: () => void;
  onDone: (proposalId: string, context: GenerationContext) => void;
};

export function GenerateDialog({ capability = 'generate', focusTask = null, api, workspaceId, connection, projects, vaults, selectedTaskIds, defaultProjectId, initialGoal, onClose, onDone }: DialogProps) {
  const [goal, setGoal] = React.useState(initialGoal);
  const [projectIds, setProjectIds] = React.useState<string[]>(defaultProjectId ? [defaultProjectId] : []);
  const [vaultIds, setVaultIds] = React.useState<string[]>([]);
  const [useTasks, setUseTasks] = React.useState(focusTask !== null);
  const text = capabilityText[capability];
  const [preview, setPreview] = React.useState<AiPreview | null>(null);
  const [previewError, setPreviewError] = React.useState('');
  const [run, setRun] = React.useState<AiRun | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const stopped = React.useRef(false);
  const dialogRef = React.useRef<HTMLElement>(null);
  const goalRef = React.useRef<HTMLTextAreaElement>(null);
  const previewRef = React.useRef<AiPreview | null>(null);
  const scope: AiScope = React.useMemo(() => ({ projects: projectIds, tasks: useTasks ? selectedTaskIds : [], vaults: vaultIds }), [projectIds, useTasks, selectedTaskIds, vaultIds]);
  const scopeKey = JSON.stringify(scope);

  React.useEffect(() => { goalRef.current?.focus(); return () => { stopped.current = true; }; }, []);

  React.useEffect(() => {
    let active = true;
    setPreviewError('');
    if (scope.projects.length === 0) { setPreview(null); previewRef.current = null; return; }
    api<AiPreview>('/ai/runs/preview', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, connection_id: connection.id, scope }) })
      .then((value) => { if (active) { setPreview(value); previewRef.current = value; } })
      .catch((reason) => { if (active) { setPreview(null); previewRef.current = null; setPreviewError(reason instanceof Error ? reason.message : 'Could not preview the sources.'); } });
    return () => { active = false; };
    // The scope key stands in for the scope object.
  }, [scopeKey, api, workspaceId, connection.id]);

  function toggle(list: string[], id: string, on: boolean) {
    return on ? [...list, id] : list.filter((item) => item !== id);
  }

  function keydown(event: React.KeyboardEvent) {
    // The dialog is modal: keep its keys away from the page shortcuts underneath.
    event.nativeEvent.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); return; }
    if (event.key === 'Tab') {
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])') ?? []);
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !goal.trim() || scope.projects.length === 0) return;
    setBusy(true); setError(''); stopped.current = false;
    try {
      if (capability === 'summarize') {
        const started = await api<{ id: string }>('/ai/runs', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, connection_id: connection.id, capability, scope, prompt: goal.trim() }) });
        setRun({ id: started.id, state: 'queued', summary: 'Waiting for a runner', pause_reason: null, sources_read: [], result: null });
        const deadline = Date.now() + 15 * 60_000;
        while (Date.now() < deadline) {
          if (stopped.current) throw new RunStopped('Summary was canceled.');
          await new Promise((resolve) => setTimeout(resolve, 500));
          const current = await api<AiRun>(`/ai/runs/${started.id}`);
          setRun(current);
          if (current.state === 'completed') { setBusy(false); return; }
          if (['failed', 'canceled', 'needs_login'].includes(current.state)) throw new Error(current.pause_reason ? `${current.summary} (${current.pause_reason})` : current.summary);
        }
        throw new Error('The summary is taking too long. Check it again later.');
      }
      const { proposalId, run: finished } = await runGeneration(api, { workspaceId, connectionId: connection.id, scope, prompt: goal.trim(), capability }, { onRun: setRun, isStopped: () => stopped.current });
      onDone(proposalId, { connectionId: connection.id, goal: goal.trim(), scope, notes: notesFromRun(finished, previewRef.current, connection.provider) });
    } catch (reason) {
      if (!(reason instanceof RunStopped)) setError(reason instanceof Error ? reason.message : 'Could not generate a plan.');
      setBusy(false);
    }
  }

  async function cancel() {
    stopped.current = true;
    if (run) await api(`/ai/runs/${run.id}/cancel`, { method: 'POST', body: '{}' }).catch(() => undefined);
    setBusy(false); setRun(null); setError('Generation was canceled. Nothing was changed.');
  }

  const providerLine = `${connection.provider} · ${connection.model_default ?? 'default model'} · ${connection.billing_mode} billing`;
  return <div className="overlay-backdrop generate-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="generate-dialog" role="dialog" aria-modal="true" aria-label={text.title} onKeyDown={keydown}>
      <h2>{text.title}</h2>
      <p className="muted">{text.intro}</p>
      <form onSubmit={(event) => void start(event)}>
        <label htmlFor="ai-goal">{text.field}</label>
        <textarea id="ai-goal" ref={goalRef} rows={4} maxLength={8000} required disabled={busy} placeholder={text.placeholder} value={goal} onChange={(event) => setGoal(event.target.value)} />
        <fieldset disabled={busy}>
          <legend>Scope</legend>
          {projects.length === 0 && <p className="muted">Create a Project first.</p>}
          {projects.map((project) => <label key={project.id} className="check"><input type="checkbox" checked={projectIds.includes(project.id)} onChange={(event) => setProjectIds((items) => toggle(items, project.id, event.target.checked))} />Project: {project.name}</label>)}
          {vaults.map((vault) => <label key={vault.id} className="check"><input type="checkbox" checked={vaultIds.includes(vault.id)} onChange={(event) => setVaultIds((items) => toggle(items, vault.id, event.target.checked))} />Knowledge Vault: {vault.name}</label>)}
          {focusTask ? <p className="check">Task: #{focusTask.number} {focusTask.title}</p> : selectedTaskIds.length > 0 && <label className="check"><input type="checkbox" checked={useTasks} onChange={(event) => setUseTasks(event.target.checked)} />The {selectedTaskIds.length} selected {selectedTaskIds.length === 1 ? 'task' : 'tasks'}</label>}
        </fieldset>
        <section className="generate-preview" aria-label="Sources and provider" aria-live="polite">
          <h3>Sources and provider</h3>
          <p>Provider: <strong>{providerLine}</strong></p>
          {scope.projects.length === 0 ? <p className="muted">Choose at least one Project.</p> : previewError ? <p role="alert" className="error">{previewError}</p> : !preview ? <p className="muted">Checking sources…</p> : <><p className="muted">These sources can be read by the AI, limited to what you can open yourself:</p><ul>{preview.sources.map((source) => <li key={`${source.kind}:${source.id}`}>{source.kind}: {source.label}</li>)}</ul></>}
        </section>
        {run && <section className="generate-progress" aria-label="Run progress" role="status" aria-live="polite">
          <strong>{runStateLabel(run.state)}</strong>
          <span>{run.pause_reason ?? run.summary}</span>
          <span className="muted">Sources read so far: {run.sources_read.length}</span>
        </section>}
        {capability === 'summarize' && run?.state === 'completed' && <section aria-label="Task discussion summary"><h3>Summary</h3><p>{run.result?.summary ?? run.summary}</p>{run.sources_read.length > 0 && <><h4>Sources</h4><ul>{run.sources_read.map((source) => <li key={`${source.kind}:${source.id}`}>{source.task_number ? <a href={`/w/${workspaceId}/tasks/${source.task_number}`}>{source.label}</a> : source.label}</li>)}</ul></>}{run.tool_activity?.some((entry) => entry.truncated) && <p role="note">The AI read only part of a source. This summary may be incomplete.</p>}</section>}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions">
          {busy ? <button type="button" className="secondary" onClick={() => void cancel()}>Cancel run</button> : <button type="button" className="secondary" onClick={onClose}>Close</button>}
          <button type="submit" disabled={busy || !goal.trim() || scope.projects.length === 0}>{busy ? text.busy : text.submit}</button>
        </div>
      </form>
    </section>
  </div>;
}
