import React from 'react';
import type { ApiFn } from './generate';

// Advanced Smart List builder: nested AND/OR groups, relative dates and Milestone conditions.
// Everything is a native control, so Tab, Space, Enter and arrow keys cover the whole form.

const MAX_DEPTH = 4;
const MAX_CONDITIONS = 20;

type Condition = { kind: 'condition'; id: string; field: string; op: string; value: string };
type Group = { kind: 'group'; id: string; logic: 'and' | 'or'; children: Node[] };
type Node = Condition | Group;
type Option = { value: string; label: string };
export type BuilderList = { id: string; name: string; kind: 'manual' | 'smart'; query: { filters: { field: string; op: string; value: unknown }[]; logic: 'and' | 'or'; sort?: unknown[]; group?: string | null; columns?: string[] } };

const uid = () => crypto.randomUUID();
const newCondition = (): Condition => ({ kind: 'condition', id: uid(), field: 'status', op: 'eq', value: '' });
const newGroup = (): Group => ({ kind: 'group', id: uid(), logic: 'and', children: [newCondition()] });

const fields: Option[] = [
  { value: 'status', label: 'Status' }, { value: 'priority', label: 'Priority' },
  { value: 'due_date', label: 'Due date' }, { value: 'start_date', label: 'Start date' },
  { value: 'milestone', label: 'Milestone' }, { value: 'milestone_state', label: 'Milestone state' },
  { value: 'assignee', label: 'Assigned to me' },
];
const relativeValues: Option[] = [
  { value: 'today', label: 'Today' }, { value: 'overdue', label: 'Overdue' },
  { value: 'next_7_days', label: 'Next 7 days' }, { value: 'next_30_days', label: 'Next 30 days' },
  { value: 'this_week', label: 'This week' }, { value: 'next_week', label: 'Next week' },
  { value: 'this_month', label: 'This month' }, { value: 'next_month', label: 'Next month' },
];
const milestoneStates = ['planned', 'active', 'completed', 'canceled'];
const sortFields: Option[] = [
  { value: 'number', label: 'Task number' }, { value: 'title', label: 'Title' }, { value: 'due_date', label: 'Due date' },
  { value: 'milestone', label: 'Milestone' }, { value: 'milestone_state', label: 'Milestone state' },
];
const groupFields: Option[] = [
  { value: 'status', label: 'Status' }, { value: 'priority', label: 'Priority' },
  { value: 'milestone', label: 'Milestone' }, { value: 'milestone_state', label: 'Milestone state' },
];

const opsFor = (field: string): Option[] => {
  if (field === 'due_date' || field === 'start_date') return [{ value: 'relative', label: 'is' }, { value: 'before', label: 'is before' }, { value: 'after', label: 'is after' }, { value: 'eq', label: 'is on' }];
  if (field === 'assignee') return [{ value: 'eq', label: 'is' }];
  return [{ value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }];
};
const defaultValue = (field: string) => (field === 'due_date' || field === 'start_date' ? 'today' : field === 'assignee' ? 'me' : field === 'milestone_state' ? 'planned' : '');
const defaultOp = (field: string) => opsFor(field)[0].value;

function update(node: Group, id: string, change: (found: Node) => Node | null): Group {
  return { ...node, children: node.children.flatMap((child) => {
    if (child.id === id) { const next = change(child); return next ? [next] : []; }
    return [child.kind === 'group' ? update(child, id, change) : child];
  }) };
}
const countConditions = (node: Node): number => (node.kind === 'condition' ? 1 : node.children.reduce((sum, child) => sum + countConditions(child), 0));

// A condition with no value would match nothing, so the builder refuses it before it is sent.
const hasEmptyValue = (node: Node): boolean => (node.kind === 'group' ? node.children.some(hasEmptyValue) : node.value.trim() === '' && node.field !== 'milestone');

function serialize(group: Group): Record<string, unknown> {
  return {
    logic: group.logic,
    filters: group.children.map((child) => {
      if (child.kind === 'group') return serialize(child);
      let value: unknown = child.value;
      if (child.field === 'milestone' && child.value === '') value = null;
      return { field: child.field, op: child.op, value };
    }),
  };
}

export function SmartListBuilder({ api, workspaceId, statuses, projects, onCreated }: { api: ApiFn; workspaceId: string; statuses: { id: string; name: string }[]; projects: { id: string; name: string }[]; onCreated: (list: BuilderList) => void }) {
  const [name, setName] = React.useState('');
  const [root, setRoot] = React.useState<Group>(() => ({ kind: 'group', id: uid(), logic: 'and', children: [] }));
  const [sort, setSort] = React.useState('number');
  const [direction, setDirection] = React.useState('asc');
  const [group, setGroup] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [milestones, setMilestones] = React.useState<Option[]>([]);
  // Edits replace controls, so focus moves to the new control (or the group's Add button) after the render.
  const pendingFocus = React.useRef<string | null>(null);
  React.useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    document.querySelector<HTMLElement>(`[data-focus="${key}"]`)?.focus();
    pendingFocus.current = null;
  });
  React.useEffect(() => {
    let current = true;
    Promise.all(projects.map((project) => api<{ milestones: { id: string; name: string; archived?: boolean }[] }>(`/projects/${project.id}/milestones`).then((result) => result.milestones.filter((item) => !item.archived).map((item) => ({ value: item.id, label: `${project.name}: ${item.name}` }))).catch(() => [])))
      .then((lists) => { if (current) setMilestones(lists.flat()); });
    return () => { current = false; };
  }, [api, projects]);

  const total = countConditions(root);
  const change = (id: string, next: (found: Node) => Node | null) => setRoot((current) => (id === current.id ? (next(current) as Group) : update(current, id, next)));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setMessage('Name the Smart List first.'); return; }
    if (hasEmptyValue(root)) { setMessage('Every condition needs a value.'); return; }
    try {
      const query = { ...serialize(root), sort: [{ field: sort, direction }], group: group || null, columns: ['title', 'status', 'priority'] };
      const created = await api<BuilderList>(`/workspaces/${workspaceId}/lists`, { method: 'POST', body: JSON.stringify({ name: name.trim(), kind: 'smart', query }) });
      setMessage(`Created Smart List ${created.name}.`); setName(''); onCreated(created);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not create the Smart List.'); }
  }

  function renderValue(condition: Condition, label: string) {
    const set = (value: string) => change(condition.id, (found) => ({ ...(found as Condition), value }));
    const select = (options: Option[], blank?: string) => <select aria-label={`${label} value`} value={condition.value} onChange={(event) => set(event.target.value)}>{blank !== undefined && <option value="">{blank}</option>}{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
    if (condition.field === 'status') return select(statuses.map((status) => ({ value: status.id, label: status.name })), 'Choose a Status');
    if (condition.field === 'priority') return select(['low', 'normal', 'high', 'urgent'].map((value) => ({ value, label: value })), 'Choose a Priority');
    if (condition.field === 'milestone') return select(milestones, 'No Milestone');
    if (condition.field === 'milestone_state') return select(milestoneStates.map((value) => ({ value, label: value })));
    if (condition.field === 'assignee') return <span>me</span>;
    if (condition.op === 'relative') return select(relativeValues);
    return <input type="date" aria-label={`${label} value`} value={condition.value} onChange={(event) => set(event.target.value)} />;
  }

  function renderNode(node: Node, path: string, depth: number, parent: Group): React.ReactNode {
    const remove = <button type="button" className="secondary" aria-label={`Remove ${node.kind} ${path}`} data-focus={`remove:${node.id}`} onClick={() => { pendingFocus.current = `add:${parent.id}`; change(parent.id, (found) => ({ ...(found as Group), children: (found as Group).children.filter((child) => child.id !== node.id) })); }}>Remove</button>;
    if (node.kind === 'condition') {
      const label = `Condition ${path}`;
      return <li key={node.id} className="smart-condition">
        <select aria-label={`${label} field`} data-focus={node.id} value={node.field} onChange={(event) => change(node.id, () => ({ ...node, field: event.target.value, op: defaultOp(event.target.value), value: defaultValue(event.target.value) }))}>{fields.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</select>
        <select aria-label={`${label} operator`} value={node.op} onChange={(event) => change(node.id, () => ({ ...node, op: event.target.value, value: event.target.value === 'relative' ? 'today' : node.op === 'relative' ? '' : node.value }))}>{opsFor(node.field).map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}</select>
        {renderValue(node, label)}{remove}
      </li>;
    }
    return <li key={node.id}>{renderGroup(node, path, depth, remove)}</li>;
  }

  function renderGroup(node: Group, path: string, depth: number, remove?: React.ReactNode): React.ReactNode {
    const label = path ? `Group ${path}` : 'Top group';
    return <fieldset className="smart-group" aria-label={label}>
      <legend>{label}</legend>
      <label>Combine<select aria-label={`${label} logic`} value={node.logic} onChange={(event) => change(node.id, () => ({ ...node, logic: event.target.value as 'and' | 'or' }))}><option value="and">Match all (AND)</option><option value="or">Match any (OR)</option></select></label>
      <ul>{node.children.map((child, index) => renderNode(child, path ? `${path}.${index + 1}` : `${index + 1}`, depth + 1, node))}</ul>
      <button type="button" className="secondary" aria-label={`Add condition to ${label}`} data-focus={`add:${node.id}`} disabled={total >= MAX_CONDITIONS} onClick={() => { const added = newCondition(); pendingFocus.current = added.id; change(node.id, () => ({ ...node, children: [...node.children, added] })); }}>Add condition</button>
      <button type="button" className="secondary" aria-label={`Add group to ${label}`} disabled={depth >= MAX_DEPTH || total >= MAX_CONDITIONS} onClick={() => { const added = newGroup(); pendingFocus.current = added.kind === 'group' ? (added.children[0] as Condition).id : added.id; change(node.id, () => ({ ...node, children: [...node.children, added] })); }}>Add group</button>
      {remove}
    </fieldset>;
  }

  return <details className="capture" aria-label="Advanced Smart List">
    <summary>Advanced Smart List</summary>
    <form onSubmit={save}>
      <label>Smart List name<input aria-label="Advanced Smart List name" value={name} onChange={(event) => setName(event.target.value)} /></label>
      {renderGroup(root, '', 1)}
      <label>Sort by<select aria-label="Advanced Smart List sort" value={sort} onChange={(event) => setSort(event.target.value)}>{sortFields.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</select></label>
      <label>Direction<select aria-label="Advanced Smart List sort direction" value={direction} onChange={(event) => setDirection(event.target.value)}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
      <label>Group by<select aria-label="Advanced Smart List group" value={group} onChange={(event) => setGroup(event.target.value)}><option value="">No group</option>{groupFields.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</select></label>
      <button type="submit">Create advanced Smart List</button>
      <p role="status" aria-live="polite">{message}</p>
    </form>
  </details>;
}
