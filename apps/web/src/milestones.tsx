import React from 'react';

export type Milestone = { id: string; project_id: string; name: string; description: string; target_date: string | null; state: string; version: number; archived: boolean; task_count?: number };
export type TaskMilestone = { id: string; name: string; state: string; target_date: string | null };
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export const milestoneStates = ['planned', 'active', 'completed', 'canceled'];
const stateLabel = (state: string) => state.charAt(0).toUpperCase() + state.slice(1);

// One list per Project and epoch: a table with many rows asks the server once, and a realtime
// event (or a local change) bumps the epoch so the next render asks again.
const lists = new Map<string, { epoch: number; promise: Promise<Milestone[]> }>();

function loadMilestones(api: Api, project: string, epoch: number): Promise<Milestone[]> {
  const cached = lists.get(project);
  if (cached && cached.epoch === epoch) return cached.promise;
  const promise = api<{ milestones: Milestone[] }>(`/projects/${project}/milestones?include_archived=true`).then((result) => result.milestones);
  promise.catch(() => { if (lists.get(project)?.promise === promise) lists.delete(project); });
  lists.set(project, { epoch, promise });
  return promise;
}

export function useMilestones(api: Api, project: string | undefined, epoch: number) {
  const [items, setItems] = React.useState<Milestone[]>([]);
  React.useEffect(() => {
    let active = true;
    if (!project) { setItems([]); return; }
    loadMilestones(api, project, epoch).then((result) => { if (active) setItems(result); }).catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, [api, project, epoch]);
  return items;
}

export function MilestoneSelect({ api, project, epoch, value, label, onChange }: { api: Api; project: string; epoch: number; value: TaskMilestone | null | undefined; label: string; onChange: (milestone: string | null) => void }) {
  const items = useMilestones(api, project, epoch).filter((item) => !item.archived);
  const options = value && !items.some((item) => item.id === value.id) ? [{ id: value.id, name: value.name }, ...items] : items;
  return <select aria-label={label} value={value?.id ?? ''} onChange={(event) => onChange(event.target.value || null)}><option value="">No Milestone</option>{options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>;
}

export function PaletteMilestones({ api, project, epoch, filter, taskNumber, onPick }: { api: Api; project: string; epoch: number; filter: string; taskNumber: number; onPick: (milestone: string | null) => void }) {
  const wanted = filter.trim().toLowerCase();
  const items = useMilestones(api, project, epoch).filter((item) => !item.archived && item.name.toLowerCase().includes(wanted));
  return <>{items.map((item) => <button type="button" role="option" key={item.id} onClick={() => onPick(item.id)}><strong>Set Milestone to {item.name}</strong><span className="muted">Task #{taskNumber}</span></button>)}<button type="button" role="option" onClick={() => onPick(null)}><strong>Clear Milestone</strong><span className="muted">Task #{taskNumber}</span></button></>;
}

export function MilestonePanel({ api, project, projectName, epoch, onChanged, onPlan }: { api: Api; project: string; projectName: string; epoch: number; onChanged: () => void; onPlan?: () => void }) {
  const items = useMilestones(api, project, epoch);
  const [role, setRole] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [targetDate, setTargetDate] = React.useState('');
  const [state, setState] = React.useState('planned');
  const [archiving, setArchiving] = React.useState<{ id: string; count: number } | null>(null);
  const manager = role === 'manager';
  React.useEffect(() => {
    let active = true;
    setRole(''); setArchiving(null);
    api<{ role: string }>(`/projects/${project}`).then((result) => { if (active) setRole(result.role); }).catch(() => { if (active) setRole(''); });
    return () => { active = false; };
  }, [api, project]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    try { await action(); setMessage(''); lists.delete(project); onChanged(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : fallback); }
  }
  const create = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    void run(async () => {
      await api(`/projects/${project}/milestones`, { method: 'POST', body: JSON.stringify({ name: name.trim(), description, target_date: targetDate || null, state }) });
      setName(''); setDescription(''); setTargetDate(''); setState('planned');
    }, 'Could not create the Milestone.');
  };
  const patch = (item: Milestone, body: Record<string, unknown>) => void run(() => api(`/milestones/${item.id}`, { method: 'PATCH', body: JSON.stringify({ expected_version: item.version, ...body }) }), 'Could not change the Milestone.');
  const askArchive = async (item: Milestone) => {
    try { const preview = await api<{ task_count: number }>(`/milestones/${item.id}/archive-preview`); setArchiving({ id: item.id, count: preview.task_count }); setMessage(''); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not preview the archive.'); }
  };
  const active = items.filter((item) => !item.archived);
  const archived = items.filter((item) => item.archived);
  return <section className="milestones" aria-label="Milestones"><h2>Milestones · {projectName}</h2>
    {message && <p role="alert" className="notice">{message}</p>}
    {manager && <form className="capture milestone-create" onSubmit={create}>
      <label>Milestone name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="New Milestone" required /></label>
      <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>Target date<input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
      <label>State<select value={state} onChange={(event) => setState(event.target.value)}>{milestoneStates.map((value) => <option key={value} value={value}>{stateLabel(value)}</option>)}</select></label>
      <button>Create Milestone</button></form>}
    {manager && onPlan && <p><button type="button" className="secondary" onClick={onPlan}>Plan milestones with AI</button></p>}
    {!manager && role && <p className="muted">Read-only · Project Managers manage Milestones.</p>}
    {active.length === 0 ? <p className="muted">No Milestones yet.</p> : <ul className="settings-list">{active.map((item) => <li key={item.id}>
      <div><strong>{item.name}</strong>{item.description && <p className="muted">{item.description}</p>}<span className="muted">{item.task_count ?? 0} Tasks{item.target_date ? ` · target ${item.target_date}` : ''}</span></div>
      {manager ? <div className="actions">
        <label>State of {item.name}<select value={item.state} onChange={(event) => patch(item, { state: event.target.value })}>{milestoneStates.map((value) => <option key={value} value={value}>{stateLabel(value)}</option>)}</select></label>
        <label>Target date of {item.name}<input type="date" value={item.target_date ?? ''} onChange={(event) => patch(item, { target_date: event.target.value || null })} /></label>
        {archiving?.id === item.id
          ? <span role="group" aria-label={`Archive ${item.name}`}><span>{archiving.count} Tasks hold this Milestone.</span><button type="button" onClick={() => void run(() => api(`/milestones/${item.id}/archive`, { method: 'POST', body: JSON.stringify({ detach_tasks: true }) }), 'Could not archive the Milestone.')}>Detach {archiving.count} Tasks and archive</button><button type="button" className="secondary" onClick={() => setArchiving(null)}>Keep Milestone</button></span>
          : <button type="button" className="secondary" onClick={() => void askArchive(item)}>Archive {item.name}</button>}
      </div> : <span className="muted">{stateLabel(item.state)}</span>}
    </li>)}</ul>}
    {archived.length > 0 && <details><summary>{archived.length} archived</summary><ul className="settings-list">{archived.map((item) => <li key={item.id}><span>{item.name}</span>{manager && <span className="actions"><button type="button" className="secondary" onClick={() => void run(() => api(`/milestones/${item.id}/restore`, { method: 'POST', body: JSON.stringify({}) }), 'Could not restore the Milestone.')}>Restore {item.name}</button><button type="button" className="secondary" onClick={() => void run(() => api(`/milestones/${item.id}/restore`, { method: 'POST', body: JSON.stringify({ reattach_tasks: true }) }), 'Could not restore the Milestone.')}>Restore {item.name} with its Tasks</button></span>}</li>)}</ul></details>}
  </section>;
}
