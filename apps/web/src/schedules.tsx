import React from 'react';

// Workspace admin screen for scheduled AI reviews and the emergency switch. Everything is a
// plain button, select or input, so the whole screen works by keyboard. The server decides who may
// do what; this file only shows state and sends the explicit actions.

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
export type ScheduleItem = {
  id: string; name: string; state: string; stop_reason: string | null; stop_detail: string | null; next_run_at: string | null; last_run_at: string | null;
  last_result?: { state: string; reason: string | null; scheduled_for: string; proposal_id: string | null } | null;
  principal: { id: string; name: string }; connection_id: string; frequency: { kind: string; time?: string };
};
export type ConnectionItem = { id: string; scope: string; workspace_id: string | null; owner_id?: string | null; provider: string; state: string; state_reason: string; enabled: boolean };
type Principal = { id: string; name: string; revoked: boolean };
type RunItem = { id: string; scheduled_for: string; state: string; reason: string | null; run_state: string | null; result: string | null; usage: { tool_calls: number | null; characters: number | null } };
type ProjectOption = { id: string; name: string };

export function useScheduleAdmin(api: Api, workspaceId: string | undefined, enabled: boolean, onError: (message: string) => void) {
  const [schedules, setSchedules] = React.useState<ScheduleItem[]>([]);
  const [connections, setConnections] = React.useState<ConnectionItem[]>([]);
  const [principals, setPrincipals] = React.useState<Principal[]>([]);
  const [message, setMessage] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);
  const [userId, setUserId] = React.useState<string | null>(null);
  const reload = React.useCallback(async () => {
    if (!workspaceId) return;
    // Every member loads the Connections they can see: an owner of a personal Connection may
    // disable it without being a Workspace admin. Schedules and principals stay admin-only.
    try {
      const conns = await api<{ connections: ConnectionItem[] }>('/ai/connections');
      setConnections(conns.connections.filter((item) => item.workspace_id === workspaceId || item.scope === 'personal'));
      if (enabled) {
        const [list, people] = await Promise.all([
          api<{ schedules: ScheduleItem[] }>(`/workspaces/${workspaceId}/ai/schedules`),
          api<{ principals: Principal[] }>(`/workspaces/${workspaceId}/ai/service-principals`),
        ]);
        setSchedules(list.schedules);
        setPrincipals(people.principals);
      }
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not load schedules.'); }
    setLoaded(true);
  }, [api, workspaceId, enabled, onError]);
  React.useEffect(() => {
    if (!workspaceId) return undefined;
    let active = true;
    api<{ user_id: string }>('/auth/me').then((me) => { if (active) setUserId(me.user_id); }).catch(() => undefined);
    return () => { active = false; };
  }, [api, workspaceId]);
  React.useEffect(() => { void reload(); }, [reload]);

  async function act(path: string, done: string, init: RequestInit = { method: 'POST' }) {
    try { await api(path, init); await reload(); setMessage(done); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'The action failed.'); }
  }
  const base = `/workspaces/${workspaceId}/ai/schedules`;
  return {
    schedules, connections, principals, loaded, message, setMessage, reload,
    // Connections the caller owns: the API lets an owner disable them, admin or not.
    ownConnections: connections.filter((item) => item.scope === 'personal' && !!userId && item.owner_id === userId),
    disableSchedule: (item: ScheduleItem) => act(`${base}/${item.id}/disable`, `Schedule “${item.name}” disabled. Queued runs were cancelled and running ones asked to stop.`),
    enableSchedule: (item: ScheduleItem) => act(`${base}/${item.id}/enable`, `Schedule “${item.name}” enabled.`),
    disableConnection: (item: ConnectionItem) => act(`/ai/connections/${item.id}/disable`, `AI Connection ${item.provider} disabled. Its queued and running runs were cancelled.`),
    enableConnection: (item: ConnectionItem) => act(`/ai/connections/${item.id}/enable`, `AI Connection ${item.provider} enabled.`),
    createPrincipal: (name: string) => act(`/workspaces/${workspaceId}/ai/service-principals`, `Execution principal “${name}” created.`, { method: 'POST', body: JSON.stringify({ name }) }),
    createSchedule: (body: Record<string, unknown>) => act(base, 'Schedule created. It stays off until you enable it.', { method: 'POST', body: JSON.stringify(body) }),
  };
}
export type ScheduleAdmin = ReturnType<typeof useScheduleAdmin>;

/** Palette commands: "schedules", "emergency disable <schedule or connection>", "disable schedule …", "disable connection …". */
export function scheduleCommands(query: string, admin: ScheduleAdmin, show: () => void, isAdmin = true) {
  const text = query.trim().toLowerCase();
  if (!/^(sched|emerg|disable|ai connection|connection)/.test(text)) return [];
  const all: { id: string; label: string; detail: string; run: () => void | Promise<void> }[] = [
    ...(isAdmin ? [{ id: 'open', label: 'Schedules: open the AI schedules screen', detail: 'Schedules, run history and AI Connections', run: show }] : []),
    ...(isAdmin ? admin.schedules : []).filter((item) => item.state !== 'stopped').map((item) => ({ id: `ds-${item.id}`, label: `Emergency disable Schedule: ${item.name}`, detail: `${item.state} · cancels queued and running runs`, run: () => admin.disableSchedule(item) })),
    ...(isAdmin ? admin.connections : admin.ownConnections).filter((item) => item.enabled).map((item) => ({ id: `dc-${item.id}`, label: `Emergency disable AI Connection: ${item.provider} ${item.id.slice(0, 8)}`, detail: `${item.state} · cancels queued and running runs`, run: () => admin.disableConnection(item) })),
  ];
  const rest = text.replace(/^(schedules?|emergency disable|emergency|disable|ai connection|connection)\s*/, '');
  return all.filter((item) => !rest || item.id === 'open' || item.label.toLowerCase().includes(rest));
}

function ScheduleRuns({ api, workspaceId, schedule }: { api: Api; workspaceId: string; schedule: ScheduleItem }) {
  const [runs, setRuns] = React.useState<RunItem[] | null>(null);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let active = true;
    api<{ runs: RunItem[] }>(`/workspaces/${workspaceId}/ai/schedules/${schedule.id}/runs`).then((result) => { if (active) setRuns(result.runs); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load runs.'); });
    return () => { active = false; };
  }, [api, workspaceId, schedule.id, schedule.state, schedule.last_run_at]);
  if (error) return <p role="alert">{error}</p>;
  if (!runs) return <p role="status">Loading runs…</p>;
  if (runs.length === 0) return <p className="muted">No runs yet.</p>;
  return <table aria-label={`Run history for ${schedule.name}`}><thead><tr><th>Scheduled</th><th>State</th><th>Result</th><th>Usage</th></tr></thead><tbody>
    {runs.map((run) => <tr key={run.id}><td>{run.scheduled_for}</td><td>{run.run_state ?? run.state}{run.reason ? ` · ${run.reason}` : ''}</td><td>{run.result ?? '—'}</td><td>{run.usage.tool_calls ?? 0} tool calls · {run.usage.characters ?? 0} characters</td></tr>)}
  </tbody></table>;
}

/** What a non-admin Connection owner sees: only their own Connections, with the same emergency switch. */
export function MyConnectionsScreen({ admin }: { admin: ScheduleAdmin }) {
  const own = admin.ownConnections;
  return <section aria-label="My AI Connections"><h3>My AI Connections</h3>
    <p className="muted">You own these AI Connections. Disabling one cancels its queued and running runs at once; enabling again is a separate action.</p>
    {admin.message && <p role="status" className="settings-message">{admin.message}</p>}
    {!admin.loaded ? <p role="status">Loading…</p> : own.length === 0 ? <p>You own no AI Connections.</p> : <ul className="settings-list">{own.map((item) => <li key={item.id} aria-label={`AI Connection ${item.provider} ${item.id.slice(0, 8)}`}>
      <span><strong>{item.provider} {item.id.slice(0, 8)}</strong><span>State: {item.state}{item.enabled ? '' : ' · disabled'}</span><span className="muted">{item.state_reason}</span></span>
      <div className="settings-fields">{item.enabled
        ? <button type="button" className="danger" onClick={() => void admin.disableConnection(item)}>Disable AI Connection {item.provider} {item.id.slice(0, 8)}</button>
        : <button type="button" className="secondary" onClick={() => void admin.enableConnection(item)}>Enable AI Connection {item.provider} {item.id.slice(0, 8)}</button>}</div>
    </li>)}</ul>}
  </section>;
}

export function SchedulesScreen({ api, workspaceId, projects, projectsReady, admin, onOpenProposal }: { onOpenProposal?: (proposalId: string) => void; api: Api; workspaceId: string; projects: ProjectOption[]; projectsReady: boolean; admin: ScheduleAdmin }) {
  const [name, setName] = React.useState('');
  const [principal, setPrincipal] = React.useState('');
  const [connection, setConnection] = React.useState('');
  const [project, setProject] = React.useState('');
  const [time, setTime] = React.useState('09:00');
  const [principalName, setPrincipalName] = React.useState('');
  const [openRuns, setOpenRuns] = React.useState<string | null>(null);
  const usable = admin.connections.filter((item) => item.enabled);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    await admin.createSchedule({
      name, principal_id: principal || admin.principals.find((item) => !item.revoked)?.id, connection_id: connection || usable[0]?.id,
      scope: { projects: [project || projects[0]?.id].filter(Boolean) }, frequency: { kind: 'daily', time },
      limits: { runs_per_day: 3, characters: 100000, tool_calls: 40 },
    });
    setName('');
  }

  return <section aria-label="AI schedules"><h3>AI schedules</h3>
    <p className="muted">A Schedule is off until you enable it. A scheduled run only puts a Proposal in the approval queue. The emergency disable stops queued and running work at once; enabling again is always a separate action.</p>
    {admin.message && <p role="status" className="settings-message">{admin.message}</p>}
    <h4>Schedules</h4>
    {admin.schedules.length === 0 ? <p>No Schedules yet.</p> : <ul className="settings-list">{admin.schedules.map((item) => <li key={item.id} aria-label={`Schedule ${item.name}`}>
      <span><strong>{item.name}</strong><span>State: {item.state}{item.stop_reason ? ` · ${item.stop_reason}` : ''}</span>{item.stop_detail && <span className="muted">{item.stop_detail}</span>}{item.last_result && item.last_result.state !== 'started' && <span className="muted" aria-label={`Last result of ${item.name}`}>Last result: {item.last_result.state}{item.last_result.reason ? ` · ${item.last_result.reason}` : ''}{item.last_result.reason === 'previous_proposal_pending' && ' (waiting for a decision on the previous Proposal)'}</span>}<span className="muted">Principal {item.principal.name} · {item.frequency.kind}{item.frequency.time ? ` ${item.frequency.time}` : ''}{item.next_run_at ? ` · next ${item.next_run_at}` : ''}</span></span>
      <div className="settings-fields">
        {item.state === 'active'
          ? <button type="button" className="danger" onClick={() => void admin.disableSchedule(item)}>Disable Schedule {item.name}</button>
          : <button type="button" className="secondary" onClick={() => void admin.enableSchedule(item)}>Enable Schedule {item.name}</button>}
        {item.last_result?.proposal_id && onOpenProposal && <button type="button" className="secondary" onClick={() => onOpenProposal(item.last_result!.proposal_id!)}>Open blocking Proposal for {item.name}</button>}
        <button type="button" className="secondary" aria-expanded={openRuns === item.id} onClick={() => setOpenRuns(openRuns === item.id ? null : item.id)}>Run history for {item.name}</button>
      </div>
      {openRuns === item.id && <ScheduleRuns api={api} workspaceId={workspaceId} schedule={item} />}
    </li>)}</ul>}
    <h4>New Schedule</h4>
    {!admin.loaded || !projectsReady ? <p role="status">Loading…</p> : <form className="settings-create" onSubmit={create}>
      <label>Schedule name<input aria-label="Schedule name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
      <label>Execution principal<select aria-label="Execution principal" value={principal} onChange={(event) => setPrincipal(event.target.value)}>{admin.principals.filter((item) => !item.revoked).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>AI Connection<select aria-label="Schedule AI Connection" value={connection} onChange={(event) => setConnection(event.target.value)}>{usable.map((item) => <option key={item.id} value={item.id}>{item.provider} {item.id.slice(0, 8)}</option>)}</select></label>
      <label>Project<select aria-label="Schedule Project" value={project} onChange={(event) => setProject(event.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Daily at<input aria-label="Daily run time" type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label>
      <button type="submit" disabled={admin.principals.every((item) => item.revoked) || usable.length === 0}>Create Schedule</button>
    </form>}
    <form className="settings-create" onSubmit={(event) => { event.preventDefault(); void admin.createPrincipal(principalName).then(() => setPrincipalName('')); }}>
      <label>New execution principal<input aria-label="New execution principal name" value={principalName} onChange={(event) => setPrincipalName(event.target.value)} required maxLength={120} /></label>
      <button type="submit" className="secondary">Create principal</button>
    </form>
    <h4>AI Connections</h4>
    {admin.connections.length === 0 ? <p>No AI Connections.</p> : <ul className="settings-list">{admin.connections.map((item) => <li key={item.id} aria-label={`AI Connection ${item.provider} ${item.id.slice(0, 8)}`}>
      <span><strong>{item.provider} {item.id.slice(0, 8)}</strong><span>State: {item.state}{item.enabled ? '' : ' · disabled'}</span><span className="muted">{item.state_reason}</span></span>
      <div className="settings-fields">{item.enabled
        ? <button type="button" className="danger" onClick={() => void admin.disableConnection(item)}>Disable AI Connection {item.provider} {item.id.slice(0, 8)}</button>
        : <button type="button" className="secondary" onClick={() => void admin.enableConnection(item)}>Enable AI Connection {item.provider} {item.id.slice(0, 8)}</button>}</div>
    </li>)}</ul>}
  </section>;
}
