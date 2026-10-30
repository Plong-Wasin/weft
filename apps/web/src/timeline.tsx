import React from 'react';
import { addDays, daysBetween, isDate, type CalendarTask } from './calendar';

// The Timeline draws a bar per Task from its start to its due date. Dates are calendar dates
// ("YYYY-MM-DD"): every shift goes through the UTC day arithmetic of the Calendar, so neither the
// browser zone nor a daylight-saving change can move a bar by a day. Moving or resizing is one
// version-checked Task update, so it is one History entry and never touches another Task.

export type TimelineTask = CalendarTask & { project_id: string; milestone_id?: string | null; milestone?: { id: string; name: string; state: string; target_date: string | null } | null };
export type TimelineGrouping = 'milestone' | 'project';
type Link = { blocker_id: string; blocked_id: string };
type Stub = { task_id: string; direction: 'blocks' | 'blocked_by' };
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Group = { key: string; label: string; tasks: TimelineTask[] };
type Edge = 'start' | 'due';

const DAY_PX = 28;
const ROW = 34;
const HEAD = 30;

// List rows carry only the Milestone id; the name comes from the Project's Milestone list.
const milestoneOf = (task: TimelineTask, milestones: Map<string, MilestoneInfo>) => task.milestone ?? (task.milestone_id ? milestones.get(task.milestone_id) ?? { id: task.milestone_id, name: 'Milestone', target_date: null } : null);

const hasBar = (task: TimelineTask) => !!task.start_date && !!task.due_date && task.start_date <= task.due_date;

type MilestoneInfo = { id: string; name: string; target_date: string | null };

export function groupTasks(tasks: TimelineTask[], grouping: TimelineGrouping, projects: { id: string; name: string }[], milestones: Map<string, MilestoneInfo>): { groups: Group[]; unscheduled: TimelineTask[] } {
  const map = new Map<string, Group & { order: string }>();
  for (const task of tasks.filter(hasBar)) {
    const [key, label, order] = grouping === 'project'
      ? [task.project_id, projects.find((project) => project.id === task.project_id)?.name ?? 'Project', (projects.find((project) => project.id === task.project_id)?.name ?? 'Project').toLowerCase()]
      : milestoneOf(task, milestones) ? [milestoneOf(task, milestones)!.id, `Milestone ${milestoneOf(task, milestones)!.name}${milestoneOf(task, milestones)!.target_date ? ` · target ${milestoneOf(task, milestones)!.target_date}` : ''}`, `${milestoneOf(task, milestones)!.target_date ?? '9999-99-99'} ${milestoneOf(task, milestones)!.name.toLowerCase()}`] : ['none', 'No Milestone', '~'];
    const group = map.get(key) ?? { key, label, tasks: [], order };
    group.tasks.push(task);
    map.set(key, group);
  }
  const groups = [...map.values()].sort((a, b) => a.order.localeCompare(b.order)).map(({ order: _order, ...group }) => ({ ...group, tasks: group.tasks.sort((a, b) => a.start_date!.localeCompare(b.start_date!) || a.number - b.number) }));
  return { groups, unscheduled: tasks.filter((task) => !hasBar(task)) };
}

const describeFailure = (reason: unknown, fallback: string) => {
  const failure = reason as Error & { status?: number; body?: { error?: string; chain?: ({ number?: number; title?: string; unreadable?: boolean })[] } };
  if (failure.body?.error === 'relation_cycle') {
    const chain = (failure.body.chain ?? []).map((step) => (step.unreadable ? 'a Task you cannot read' : `#${step.number} ${step.title}`)).join(' → ');
    return `That dependency would form a loop: ${chain}.`;
  }
  return failure instanceof Error ? failure.message : fallback;
};

export function useTimeline({ workspaceId, api, tasks, projects, active, liveTick, onUpdated, onRefresh, onUndo, onError, showView }: {
  workspaceId: string | undefined;
  api: Api;
  tasks: TimelineTask[];
  projects: { id: string; name: string }[];
  active: boolean;
  liveTick: number;
  onUpdated: (task: TimelineTask) => void;
  onRefresh: () => Promise<void>;
  onUndo: () => Promise<void>;
  onError: (message: string) => void;
  showView: () => void;
}) {
  const [grouping, setGrouping] = React.useState<TimelineGrouping>('milestone');
  const [links, setLinks] = React.useState<Link[]>([]);
  const [stubs, setStubs] = React.useState<Stub[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [linkSource, setLinkSource] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState('');
  const [canUndo, setCanUndo] = React.useState(false);
  const [epoch, setEpoch] = React.useState(0);
  const [milestones, setMilestones] = React.useState<Map<string, MilestoneInfo>>(new Map());
  const pendingFocus = React.useRef<string | null>(null);

  // A link change bumps the version of both Tasks, so a changed sum also covers undo and other tabs.
  const versions = tasks.reduce((sum, item) => sum + item.version, 0);
  React.useEffect(() => {
    if (!workspaceId || !active) return;
    let current = true;
    api<{ links: Link[]; stubs: Stub[] }>(`/workspaces/${workspaceId}/timeline-links`)
      .then((result) => { if (current) { setLinks(result.links); setStubs(result.stubs); } })
      .catch(() => { if (current) setMessage('Could not load dependency lines.'); });
    return () => { current = false; };
  }, [api, workspaceId, active, epoch, liveTick, versions]);
  const milestoneProjects = [...new Set(tasks.filter((item) => item.milestone_id).map((item) => item.project_id))].sort().join(',');
  React.useEffect(() => {
    if (!active || !milestoneProjects) return;
    let current = true;
    Promise.all(milestoneProjects.split(',').map((project) => api<{ milestones: MilestoneInfo[] }>(`/projects/${project}/milestones?include_archived=true`).then((result) => result.milestones, () => [] as MilestoneInfo[])))
      .then((lists) => { if (current) setMilestones(new Map(lists.flat().map((item) => [item.id, item]))); });
    return () => { current = false; };
  }, [api, active, milestoneProjects, liveTick, epoch]);
  React.useEffect(() => { setLinkSource(null); setMessage(''); setCanUndo(false); setSelectedId(null); }, [workspaceId]);

  const { groups, unscheduled } = React.useMemo(() => groupTasks(tasks, grouping, projects, milestones), [tasks, grouping, projects, milestones]);
  const byNumber = (number: number) => tasks.find((item) => item.number === number);
  const selected = tasks.find((item) => item.id === selectedId) ?? null;

  async function setDates(task: TimelineTask, start: string, due: string, what: string) {
    if (!workspaceId || !isDate(start) || !isDate(due)) return;
    if (start > due) { setMessage(`Task #${task.number} cannot start after it is due.`); return; }
    const body: Record<string, unknown> = { expected_version: task.version };
    if (start !== task.start_date) body.start_date = start;
    if (due !== task.due_date) body.due_date = due;
    if (Object.keys(body).length === 1) return;
    try {
      const updated = await api<TimelineTask>(`/workspaces/${workspaceId}/tasks/${task.number}`, { method: 'PATCH', body: JSON.stringify(body) });
      onUpdated(updated); setCanUndo(true); setSelectedId(task.id); pendingFocus.current = task.id;
      setMessage(`${what} Task #${task.number}: ${updated.start_date} to ${updated.due_date}. Undo is available.`);
    } catch (reason) {
      const failure = reason as Error & { status?: number };
      if (failure.status === 409) setMessage(`Task #${task.number} changed on the server. Nothing was applied; try again on the current dates.`);
      else onError(describeFailure(reason, 'Could not change the dates.'));
    }
  }
  const move = (task: TimelineTask, days: number) => task.start_date && task.due_date ? setDates(task, addDays(task.start_date, days), addDays(task.due_date, days), 'Moved') : Promise.resolve();
  const resize = (task: TimelineTask, edge: Edge, days: number) => task.start_date && task.due_date
    ? setDates(task, edge === 'start' ? addDays(task.start_date, days) : task.start_date, edge === 'due' ? addDays(task.due_date, days) : task.due_date, 'Resized')
    : Promise.resolve();

  async function addLink(blocker: TimelineTask, blocked: TimelineTask) {
    if (!workspaceId || blocker.id === blocked.id) return;
    try {
      await api(`/tasks/${blocker.id}/relations`, { method: 'POST', body: JSON.stringify({ target_task_id: blocked.id, kind: 'blocks' }) });
      setLinkSource(null); setCanUndo(true); setEpoch((value) => value + 1); pendingFocus.current = blocked.id; await onRefresh();
      setMessage(`Task #${blocker.number} now blocks Task #${blocked.number}. Undo is available.`);
    } catch (reason) {
      const failure = reason as Error & { status?: number; body?: { error?: string } };
      setMessage(failure.body?.error === 'relation_already_exists' ? `Task #${blocker.number} already blocks Task #${blocked.number}.` : describeFailure(reason, 'Could not add the dependency.'));
    }
  }
  async function removeLink(blocker: TimelineTask, blocked: TimelineTask) {
    if (!workspaceId) return;
    try {
      await api(`/tasks/${blocker.id}/relations/${blocked.id}/blocks`, { method: 'DELETE' });
      setLinkSource(null); setCanUndo(true); setEpoch((value) => value + 1); pendingFocus.current = blocked.id; await onRefresh();
      setMessage(`Task #${blocker.number} no longer blocks Task #${blocked.number}. Undo is available.`);
    } catch (reason) { setMessage(describeFailure(reason, 'Could not remove the dependency.')); }
  }
  async function undo() {
    await onUndo(); setEpoch((value) => value + 1); setCanUndo(false); setMessage('Change undone.');
  }

  return { grouping, setGrouping, groups, unscheduled, links, stubs, selected, selectedId, setSelectedId, linkSource, setLinkSource, message, setMessage, canUndo,
    pendingFocus, byNumber, setDates, move, resize, addLink, removeLink, undo, showView, tasks };
}
export type Timeline = ReturnType<typeof useTimeline>;

/** Palette commands: "timeline show|group milestone|group project|move N|resize start|due N|link A blocks B|unlink A blocks B|undo". */
export function timelineCommands(query: string, tl: Timeline, open: (task: TimelineTask) => void) {
  const text = query.trim().toLowerCase();
  if (!/^ti(m(e(l(i(n(e)?)?)?)?)?)?\b/.test(text)) return [];
  const rest = text.replace(/^timeline\s*|^tim\w*\s*|^ti\s*/, '');
  const all: { id: string; label: string; detail: string; run: () => void | Promise<void> }[] = [
    { id: 'show', label: 'Timeline: show', detail: 'Switch the Task list to the Timeline', run: () => tl.showView() },
    { id: 'group milestone', label: 'Timeline: group by Milestone', detail: 'One lane per Milestone', run: () => { tl.showView(); tl.setGrouping('milestone'); } },
    { id: 'group project', label: 'Timeline: group by Project', detail: 'One lane per Project', run: () => { tl.showView(); tl.setGrouping('project'); } },
    { id: 'undo', label: 'Timeline: undo last change', detail: 'Undo the last Workspace change', run: () => tl.undo() },
  ];
  const target = tl.selected;
  const shift = rest.match(/^move\s+(-?\d+)$/);
  if (shift) all.push(target ? { id: 'move', label: `Timeline: move Task #${target.number} by ${shift[1]} days`, detail: target.title, run: () => tl.move(target, Number(shift[1])) } : { id: 'move', label: 'Timeline: focus a bar first', detail: 'Choose a bar, then run this again', run: () => tl.showView() });
  const size = rest.match(/^resize\s+(start|due)\s+(-?\d+)$/);
  if (size) all.push(target ? { id: 'resize', label: `Timeline: ${size[1]} date of Task #${target.number} by ${size[2]} days`, detail: target.title, run: () => tl.resize(target, size[1] as Edge, Number(size[2])) } : { id: 'resize', label: 'Timeline: focus a bar first', detail: 'Choose a bar, then run this again', run: () => tl.showView() });
  const pair = rest.match(/^(link|unlink)\s+#?(\d+)\s+(?:blocks|before)\s+#?(\d+)$/);
  if (pair) {
    const [blocker, blocked] = [tl.byNumber(Number(pair[2])), tl.byNumber(Number(pair[3]))];
    all.push(blocker && blocked
      ? { id: pair[1], label: `Timeline: ${pair[1] === 'link' ? 'Task #' + blocker.number + ' blocks #' + blocked.number : 'remove #' + blocker.number + ' blocks #' + blocked.number}`, detail: `${blocker.title} → ${blocked.title}`, run: () => (pair[1] === 'link' ? tl.addLink(blocker, blocked) : tl.removeLink(blocker, blocked)) }
      : { id: pair[1], label: 'Timeline: both Tasks must be in the current view', detail: 'Use Task numbers such as “timeline link 3 blocks 5”', run: () => tl.showView() });
  }
  if (target) all.push({ id: 'open-task', label: `Timeline: open Task #${target.number}`, detail: target.title, run: () => open(target) });
  return all.filter((item) => !rest || ['move', 'resize', 'link', 'unlink'].includes(item.id) || item.label.toLowerCase().includes(rest) || item.id.startsWith(rest));
}

function usePhone() {
  const query = '(max-width: 640px)';
  const [phone, setPhone] = React.useState(() => window.matchMedia(query).matches);
  React.useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setPhone(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return phone;
}

const barLabel = (tl: Timeline, task: TimelineTask) => {
  const notes = [
    tl.links.some((link) => link.blocked_id === task.id) ? `blocked by ${tl.links.filter((link) => link.blocked_id === task.id).map((link) => `#${tl.tasks.find((item) => item.id === link.blocker_id)?.number ?? '?'}`).join(', ')}` : '',
    tl.links.some((link) => link.blocker_id === task.id) ? `blocks ${tl.links.filter((link) => link.blocker_id === task.id).map((link) => `#${tl.tasks.find((item) => item.id === link.blocked_id)?.number ?? '?'}`).join(', ')}` : '',
    tl.stubs.some((stub) => stub.task_id === task.id && stub.direction === 'blocked_by') ? 'blocked by a Task you cannot read' : '',
    tl.stubs.some((stub) => stub.task_id === task.id && stub.direction === 'blocks') ? 'blocks a Task you cannot read' : '',
    tl.linkSource === task.id ? 'chosen as blocker' : '',
  ].filter(Boolean);
  return `Task #${task.number} ${task.title}, ${task.start_date} to ${task.due_date}${notes.length ? `, ${notes.join(', ')}` : ''}`;
};

export function TimelineView({ tl, onOpen }: { tl: Timeline; onOpen: (task: TimelineTask) => void }) {
  const phone = usePhone();
  const surface = React.useRef<HTMLDivElement>(null);
  const { groups, unscheduled, links, stubs } = tl;

  React.useEffect(() => {
    const id = tl.pendingFocus.current;
    if (!id) return;
    const target = document.querySelector<HTMLElement>(`[data-bar="${id}"],[data-timeline-task="${id}"]`);
    if (target) { target.focus(); tl.pendingFocus.current = null; }
  });

  const flat = groups.flatMap((group) => group.tasks);
  const first = flat.length ? flat.reduce((min, task) => (task.start_date! < min ? task.start_date! : min), flat[0].start_date!) : '';
  const last = flat.length ? flat.reduce((max, task) => (task.due_date! > max ? task.due_date! : max), flat[0].due_date!) : '';
  const origin = first ? addDays(first, -2) : '';
  const days = first ? daysBetween(origin, last) + 3 : 0;

  // Row geometry: a heading row per group, then one row per bar.
  const rows = new Map<string, number>();
  let y = 0;
  for (const group of groups) { y += HEAD; for (const task of group.tasks) { rows.set(task.id, y); y += ROW; } }
  const height = y;
  const left = (task: TimelineTask) => daysBetween(origin, task.start_date!) * DAY_PX;
  const right = (task: TimelineTask) => (daysBetween(origin, task.due_date!) + 1) * DAY_PX;

  function focusBar(task: TimelineTask | undefined) { if (task) surface.current?.querySelector<HTMLElement>(`[data-bar="${task.id}"]`)?.focus(); }

  function barKey(event: React.KeyboardEvent<HTMLElement>, task: TimelineTask) {
    if (event.ctrlKey || event.metaKey) return;
    const index = flat.findIndex((item) => item.id === task.id);
    const done = () => event.preventDefault();
    const arrows: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.shiftKey && event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { done(); void tl.resize(task, 'due', arrows[event.key]); return; }
    if (event.shiftKey && !event.altKey && arrows[event.key]) { done(); void tl.move(task, arrows[event.key]); return; }
    if (event.altKey) return;
    if (event.key === 'ArrowDown' && !event.shiftKey) { done(); focusBar(flat[index + 1]); }
    else if (event.key === 'ArrowUp' && !event.shiftKey) { done(); focusBar(flat[index - 1]); }
    else if (event.key === '[') { done(); void tl.resize(task, 'start', -1); }
    else if (event.key === ']') { done(); void tl.resize(task, 'start', 1); }
    else if (event.key === '{') { done(); void tl.resize(task, 'due', -1); }
    else if (event.key === '}') { done(); void tl.resize(task, 'due', 1); }
    else if (event.key === 'Enter') { done(); onOpen(task); }
    else if (event.key.toLowerCase() === 'l') {
      done();
      const source = tl.linkSource && tl.tasks.find((item) => item.id === tl.linkSource);
      if (!source || source.id === task.id) { tl.setLinkSource(task.id); tl.setMessage(`Task #${task.number} is the blocker. Focus the Task it blocks and press L; Escape cancels.`); }
      else void tl.addLink(source, task);
    } else if (event.key.toLowerCase() === 'u') {
      done();
      const source = tl.linkSource && tl.tasks.find((item) => item.id === tl.linkSource);
      if (source) void tl.removeLink(source, task); else tl.setMessage('Press L on the blocker first, then focus the blocked Task and press U to remove the dependency.');
    } else if (event.key === 'Escape' && tl.linkSource) { done(); event.stopPropagation(); tl.setLinkSource(null); tl.setMessage('Dependency edit canceled.'); }
  }

  const grouped = (
    <div className="timeline-grouping" role="group" aria-label="Group Timeline by">
      <button type="button" className={tl.grouping === 'milestone' ? 'selected' : 'secondary'} aria-pressed={tl.grouping === 'milestone'} onClick={() => tl.setGrouping('milestone')}>Group by Milestone</button>
      <button type="button" className={tl.grouping === 'project' ? 'selected' : 'secondary'} aria-pressed={tl.grouping === 'project'} onClick={() => tl.setGrouping('project')}>Group by Project</button>
    </div>
  );
  const status = <p role="status" className="calendar-status">{tl.message}{tl.canUndo && <> <button type="button" className="link-button" onClick={() => void tl.undo()}>Undo</button></>}</p>;
  const empty = groups.length === 0 && unscheduled.length === 0;

  return <div className="timeline" aria-label="Timeline">
    <div className="calendar-toolbar"><h3>Timeline</h3>{grouped}</div>
    <p className="muted" id="timeline-help">Arrow Up and Down choose a bar. Shift+Left and Right move it a day, Shift+Up and Down a week; {'[ and ] move its start, { and } its due date.'} L marks a blocker, then L on another bar makes it blocked; U removes that dependency; Escape cancels. Enter opens the Task. Palette: “timeline …”.</p>
    {status}
    {empty && <p className="muted">No Tasks in this view.</p>}
    {phone ? <div className="timeline-list" aria-label="Timeline list">
      {groups.map((group) => <section key={group.key} aria-label={group.label}><h4>{group.label}</h4><ul>{group.tasks.map((task) => {
        const blockers = links.filter((link) => link.blocked_id === task.id).map((link) => tl.tasks.find((item) => item.id === link.blocker_id)).filter((item): item is TimelineTask => !!item);
        const candidates = flat.filter((item) => item.id !== task.id && !blockers.some((blocker) => blocker.id === item.id));
        return <li key={task.id} className="timeline-item">
          <button type="button" className="secondary" data-timeline-task={task.id} onFocus={() => tl.setSelectedId(task.id)} onClick={() => onOpen(task)}><span className="number">#{task.number}</span> {task.title}</button>
          <label>Start of Task #{task.number}<input type="date" value={task.start_date!} onChange={(event) => void tl.setDates(task, event.target.value, task.due_date!, 'Resized')} /></label>
          <label>Due of Task #{task.number}<input type="date" value={task.due_date!} onChange={(event) => void tl.setDates(task, task.start_date!, event.target.value, 'Resized')} /></label>
          <div className="actions"><button type="button" className="secondary" onClick={() => void tl.move(task, -1)}>Move #{task.number} one day earlier</button><button type="button" className="secondary" onClick={() => void tl.move(task, 1)}>Move #{task.number} one day later</button></div>
          {stubs.some((stub) => stub.task_id === task.id && stub.direction === 'blocked_by') && <p className="muted">Blocked by a Task you cannot read</p>}
          {stubs.some((stub) => stub.task_id === task.id && stub.direction === 'blocks') && <p className="muted">Blocks a Task you cannot read</p>}
          {blockers.map((blocker) => <p key={blocker.id}>Blocked by #{blocker.number} {blocker.title} <button type="button" className="link-button" onClick={() => void tl.removeLink(blocker, task)}>Remove dependency on #{blocker.number}</button></p>)}
          <label>Add blocker for Task #{task.number}<select value="" onChange={(event) => { const picked = flat.find((item) => item.id === event.target.value); if (picked) void tl.addLink(picked, task); }}><option value="">Choose a Task</option>{candidates.map((item) => <option key={item.id} value={item.id}>#{item.number} {item.title}</option>)}</select></label>
        </li>;
      })}</ul></section>)}
    </div> : groups.length > 0 && <div className="timeline-scroll"><div className="timeline-surface" ref={surface} role="group" aria-label="Timeline bars" aria-describedby="timeline-help" style={{ width: days * DAY_PX, height }}>
      <svg className="timeline-links" width={days * DAY_PX} height={height} aria-hidden="true" focusable="false">
        <defs><marker id="timeline-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#49796d" /></marker></defs>
        {Array.from({ length: Math.ceil(days / 7) + 1 }, (_, week) => <line key={week} x1={week * 7 * DAY_PX} x2={week * 7 * DAY_PX} y1={0} y2={height} className="timeline-grid" />)}
        {links.map((link) => {
          const from = flat.find((item) => item.id === link.blocker_id); const to = flat.find((item) => item.id === link.blocked_id);
          if (!from || !to) return null;
          const x1 = right(from); const y1 = rows.get(from.id)! + ROW / 2; const x2 = left(to); const y2 = rows.get(to.id)! + ROW / 2;
          const bend = Math.max(x1 + 8, x2 - 8);
          return <path key={`${link.blocker_id}:${link.blocked_id}`} data-link={`${from.number}>${to.number}`} d={`M${x1},${y1} H${bend} V${y2} H${x2}`} className="timeline-link" markerEnd="url(#timeline-arrow)" />;
        })}
        {stubs.map((stub) => {
          const task = flat.find((item) => item.id === stub.task_id); if (!task) return null;
          const yy = rows.get(task.id)! + ROW / 2;
          return stub.direction === 'blocks'
            ? <line key={`${stub.task_id}:blocks`} data-stub="blocks" x1={right(task)} x2={right(task) + 14} y1={yy} y2={yy} className="timeline-stub" />
            : <line key={`${stub.task_id}:blocked_by`} data-stub="blocked_by" x1={left(task) - 14} x2={left(task)} y1={yy} y2={yy} className="timeline-stub" />;
        })}
      </svg>
      {groups.map((group) => {
        const headY = rows.get(group.tasks[0].id)! - HEAD;
        return <React.Fragment key={group.key}>
          <h4 className="timeline-group" style={{ top: headY }}>{group.label}</h4>
          {group.tasks.map((task, index) => <button type="button" key={task.id} data-bar={task.id} className={`timeline-bar${tl.linkSource === task.id ? ' source' : ''}${tl.selectedId === task.id ? ' chosen' : ''}`} style={{ top: rows.get(task.id)! + 3, left: left(task), width: right(task) - left(task) }} aria-label={barLabel(tl, task)} tabIndex={tl.selectedId === task.id || (!tl.selectedId && group === groups[0] && index === 0) ? 0 : -1} onFocus={() => tl.setSelectedId(task.id)} onClick={() => tl.setSelectedId(task.id)} onDoubleClick={() => onOpen(task)} onKeyDown={(event) => barKey(event, task)}><span aria-hidden="true">#{task.number} {task.title}</span></button>)}
        </React.Fragment>;
      })}
    </div></div>}
    {unscheduled.length > 0 && <section aria-label="Tasks without both dates"><h4>Not on the Timeline</h4><p className="muted">A bar needs a start and a due date. Open the Task to set them.</p><ul>{unscheduled.map((task) => <li key={task.id}><button type="button" className="link-button" onClick={() => onOpen(task)}>#{task.number} {task.title}</button></li>)}</ul></section>}
  </div>;
}
