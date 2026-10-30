import React from 'react';
import type { ApiFn } from './generate';

// The Project overview: state, target dates, Milestones with progress, overdue Tasks and the count
// of blocked Tasks. The server computes every number with the viewer's own access; each item here
// opens the filtered Task list it summarises, inside this screen, so "back" returns to the item.

type Progress = { completed: number; total: number; percent: number | null; status: string; ready_to_confirm: boolean };
type OverviewMilestone = { id: string; name: string; state: string; target_date: string | null; progress: Progress; tasks_query: string };
type OverdueTask = { id: string; number: number; title: string; status: string; due_date: string | null };
export type Overview = {
  project: { id: string; name: string; state: string; target_start_date: string | null; target_end_date: string | null; role: string };
  today: string;
  time_zone: string;
  milestones: OverviewMilestone[];
  overdue: { count: number; tasks: OverdueTask[]; tasks_query: string };
  blocked: { count: number; tasks_query: string };
  all_tasks_query: string;
};
type ListedTask = { id: string; number: number; title: string; status: string; due_date: string | null };
type Opened = { title: string; query: string; opener: string };

const progressText = (progress: Progress) => progress.status === 'no_work_yet' ? 'No work yet' : `${progress.completed} of ${progress.total} done · ${progress.percent}%`;

function FilteredTasks({ api, workspaceId, opened, onBack, onOpenTask }: { api: ApiFn; workspaceId: string; opened: Opened; onBack: () => void; onOpenTask: (number: number, id: string) => void }) {
  const [tasks, setTasks] = React.useState<ListedTask[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    let current = true;
    setTasks(null);
    api<{ tasks: ListedTask[] }>(`/workspaces/${workspaceId}/tasks?${opened.query}`)
      .then((result) => { if (current) { setTasks(result.tasks); setFailed(false); } })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [api, workspaceId, opened.query]);
  React.useEffect(() => { heading.current?.focus(); }, [opened.query]);
  return <section aria-label="Filtered Task list" className="overview-list">
    <button type="button" className="secondary" onClick={onBack}>Back to overview</button>
    <h3 tabIndex={-1} ref={heading}>{opened.title}</h3>
    {failed && <p className="notice" role="alert">Could not load this list.</p>}
    {tasks === null ? <p className="muted" role="status">Loading Tasks…</p> : tasks.length === 0 ? <p className="muted" role="status">No Tasks match.</p> : <ul className="blocker-list">{tasks.map((task) => <li key={task.id}><button type="button" className="link-button" onClick={() => onOpenTask(task.number, task.id)}>Open Task #{task.number} {task.title}</button> <span className="muted">{task.status}{task.due_date ? ` · due ${task.due_date}` : ''}</span></li>)}</ul>}
  </section>;
}

export function ProjectOverview({ api, workspaceId, projects, liveTick, onOpenTask }: { api: ApiFn; workspaceId: string; projects: { id: string; name: string }[]; liveTick: number; onOpenTask: (number: number, id: string) => void }) {
  const [chosen, setChosen] = React.useState('');
  // The Project list can arrive after this screen mounts, so the default is derived, not stored.
  const projectId = projects.some((project) => project.id === chosen) ? chosen : projects[0]?.id ?? '';
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [opened, setOpened] = React.useState<Opened | null>(null);
  const screen = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (!projectId) return;
    let current = true;
    api<Overview>(`/projects/${projectId}/overview`)
      .then((result) => { if (current) { setOverview(result); setFailed(false); } })
      .catch(() => { if (current) { setOverview(null); setFailed(true); } });
    return () => { current = false; };
  }, [api, projectId, liveTick]);
  const open = (title: string, query: string, opener: string) => setOpened({ title, query, opener });
  const back = () => {
    const opener = opened?.opener;
    setOpened(null);
    // Return focus to the item that opened the list once the overview is rendered again.
    window.setTimeout(() => screen.current?.querySelector<HTMLElement>(`[data-opener="${opener}"]`)?.focus(), 0);
  };
  return <section className="task-list app-section project-overview" aria-label="Project overview" ref={screen}>
    <div className="table-heading"><div><h2>Project overview</h2><p className="muted">State, target dates, Milestones, overdue and blocked work for one Project.</p></div>
      <label>Project<select aria-label="Project" value={projectId} onChange={(event) => { setChosen(event.target.value); setOverview(null); setOpened(null); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
    {projects.length === 0 && <p className="muted" role="status">No Projects yet.</p>}
    {failed && <p className="notice" role="alert">Could not load this Project overview.</p>}
    {overview && opened && <FilteredTasks api={api} workspaceId={workspaceId} opened={opened} onBack={back} onOpenTask={onOpenTask} />}
    {overview && !opened && <>
      <dl className="overview-facts" aria-label="Project facts">
        <div><dt>State</dt><dd>{overview.project.state}</dd></div>
        <div><dt>Target start</dt><dd>{overview.project.target_start_date ?? 'Not set'}</dd></div>
        <div><dt>Target end</dt><dd>{overview.project.target_end_date ?? 'Not set'}</dd></div>
        <div><dt>Today</dt><dd>{overview.today} <span className="muted">({overview.time_zone})</span></dd></div>
      </dl>
      <h3>Milestones</h3>
      {overview.milestones.length === 0 ? <p className="muted">No Milestones yet.</p> : <ul className="blocker-list" aria-label="Milestones">{overview.milestones.map((milestone) => <li key={milestone.id}>
        <button type="button" className="link-button" data-opener={`milestone-${milestone.id}`} onClick={() => open(`Tasks in ${milestone.name}`, milestone.tasks_query, `milestone-${milestone.id}`)}>{milestone.name}</button> <span className="muted">{milestone.state} · target {milestone.target_date ?? 'not set'} · {progressText(milestone.progress)}</span>
        {milestone.progress.ready_to_confirm && <p className="notice" role="status">All work is done. Confirm delivery from the Milestones panel.</p>}
      </li>)}</ul>}
      <h3>Overdue Tasks</h3>
      <p><button type="button" className="secondary" data-opener="overdue" onClick={() => open('Overdue Tasks', overview.overdue.tasks_query, 'overdue')}>{overview.overdue.count} overdue {overview.overdue.count === 1 ? 'Task' : 'Tasks'}</button></p>
      {overview.overdue.tasks.length > 0 && <ul className="blocker-list" aria-label="Overdue Tasks">{overview.overdue.tasks.map((task) => <li key={task.id}><button type="button" className="link-button" onClick={() => onOpenTask(task.number, task.id)}>Open Task #{task.number} {task.title}</button> <span className="muted">due {task.due_date}</span></li>)}</ul>}
      <h3>Blocked Tasks</h3>
      <p><button type="button" className="secondary" data-opener="blocked" onClick={() => open('Blocked Tasks', overview.blocked.tasks_query, 'blocked')}>{overview.blocked.count} blocked {overview.blocked.count === 1 ? 'Task' : 'Tasks'}</button></p>
      <p><button type="button" className="secondary" data-opener="all" onClick={() => open('All Tasks in this Project', overview.all_tasks_query, 'all')}>All Tasks in this Project</button></p>
    </>}
  </section>;
}
