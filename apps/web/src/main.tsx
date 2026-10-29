import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Workspace = { id: string; name: string; role: string };
type Skill = { id: string; name: string; description: string; body?: string; enabled: boolean; version: number };
type Project = { id: string; name: string; visibility: string };
type Member = { id: string; email: string; role: string };
type ChecklistItem = { id: string; title: string; checked: boolean; position: number; version: number };
type TaskRelation = { task_id: string; number: number; title: string; kind: string };
type Task = { id: string; number: number; workspace_id: string; project_id: string; parent_task_id: string | null; title: string; description: string; status: string; priority: string; start_date: string | null; due_date: string | null; watchers: string[]; assignees: Assignee[]; subtasks: { id: string; number: number; title: string }[]; checklist: ChecklistItem[]; relations: TaskRelation[]; version: number; archived_at: string | null };
type Team = { id: string; name: string };
type Assignee = { type: 'user' | 'team'; id: string; name: string };
type TeamGrant = { team_id: string; name: string; role: string };
type MovePreview = { destination_visibility: string; subtasks_affected: number; relations_affected: number; destination_members: { user_id: string; role: string }[] };

function csrf() {
  return document.cookie.split('; ').find((item) => item.startsWith('weft_csrf='))?.split('=')[1] ?? '';
}

function renderSkillBody(body: string, workspaceId: string) {
  const parts = body.split(/(#[0-9]+|@[A-Za-z0-9_-]+)/g);
  return parts.map((part, index) => {
    if (/^#[0-9]+$/.test(part)) return <a key={index} href={`/w/${workspaceId}/tasks/${part.slice(1)}`}>{part}</a>;
    if (/^@[A-Za-z0-9_-]+$/.test(part)) return <a key={index} href={`/w/${workspaceId}/teams?name=${encodeURIComponent(part.slice(1))}`}>{part}</a>;
    return <React.Fragment key={index}>{part.split('\n').map((line, lineIndex) => <React.Fragment key={lineIndex}>{lineIndex > 0 && <br />}{line}</React.Fragment>)}</React.Fragment>;
  });
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (['POST', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) headers.set('x-csrf-token', csrf());
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw Object.assign(new Error(body?.error ?? `Request failed (${response.status})`), { status: response.status, body });
  return body as T;
}

function App() {
  const [workspace, setWorkspace] = React.useState<Workspace | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [teams, setTeams] = React.useState<Team[]>([]);
  const [skills, setSkills] = React.useState<Skill[]>([]);
  const [selectedSkill, setSelectedSkill] = React.useState<Skill | null>(null);
  const [skillDraft, setSkillDraft] = React.useState({ name: '', description: '', body: '' });
  const [editingSkill, setEditingSkill] = React.useState(false);
  const [showSkills, setShowSkills] = React.useState(false);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [workTasks, setWorkTasks] = React.useState<Task[]>([]);
  const [viaTeamTasks, setViaTeamTasks] = React.useState<Task[]>([]);
  const [teamQueue, setTeamQueue] = React.useState<Task[]>([]);
  const [activeView, setActiveView] = React.useState<'all' | 'my-work' | 'team-queue'>('all');
  const [selectedTeam, setSelectedTeam] = React.useState('');
  const [teamName, setTeamName] = React.useState('');
  const [teamMembers, setTeamMembers] = React.useState<Record<string, Member[]>>({});
  const [teamMemberDrafts, setTeamMemberDrafts] = React.useState<Record<string, string>>({});
  const [teamGrants, setTeamGrants] = React.useState<TeamGrant[]>([]);
  const [grantTeam, setGrantTeam] = React.useState('');
  const [grantRole, setGrantRole] = React.useState('viewer');
  const [selectedProject, setSelectedProject] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [task, setTask] = React.useState<Task | null>(null);
  const [draft, setDraft] = React.useState<Task | null>(null);
  const [error, setError] = React.useState('');
  const [conflict, setConflict] = React.useState<Task | null>(null);
  const [moveTarget, setMoveTarget] = React.useState('');
  const [preview, setPreview] = React.useState<MovePreview | null>(null);
  const [fullPage, setFullPage] = React.useState(location.pathname.includes('/tasks/'));
  const [signedIn, setSignedIn] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [subtaskTitle, setSubtaskTitle] = React.useState('');
  const [checklistTitle, setChecklistTitle] = React.useState('');
  const [relationTarget, setRelationTarget] = React.useState('');
  const [relationKind, setRelationKind] = React.useState('blocks');

  const refresh = React.useCallback(async (workspaceId: string) => {
    const [projectResult, taskResult, memberResult, teamResult, myWorkResult, skillResult] = await Promise.all([
      api<{ projects: Project[] }>(`/workspaces/${workspaceId}/projects`),
      api<{ tasks: Task[] }>(`/workspaces/${workspaceId}/tasks`),
      api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`),
      api<{ teams: Team[] }>(`/workspaces/${workspaceId}/teams`),
      api<{ direct_tasks: Task[]; via_team_tasks: Task[] }>(`/workspaces/${workspaceId}/my-work`),
      api<{ skills: Skill[] }>(`/workspaces/${workspaceId}/skills`),
    ]);
    setProjects(projectResult.projects);
    setTasks(taskResult.tasks);
    setMembers(memberResult.members);
    setTeams(teamResult.teams);
    setSkills(skillResult.skills);
    setWorkTasks(myWorkResult.direct_tasks);
    setViaTeamTasks(myWorkResult.via_team_tasks);
    setSelectedProject((current) => current || projectResult.projects[0]?.id || '');
  }, []);

  const loadTask = React.useCallback(async (workspaceId: string, number: number) => {
    const loaded = await api<Task>(`/workspaces/${workspaceId}/tasks/${number}`);
    setTask(loaded);
    setDraft(loaded);
    setConflict(null);
    setMoveTarget(loaded.project_id);
    setPreview(null);
    setError('');
    void api<{ teams: TeamGrant[] }>(`/projects/${loaded.project_id}/teams`).then((result) => setTeamGrants(result.teams)).catch(() => setTeamGrants([]));
  }, []);

  React.useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/service-worker.js');
    const pathTask = location.pathname.match(/^\/w\/([^/]+)\/tasks\/(\d+)$/);
    void api<{ user_id: string; workspaces: Workspace[] }>('/auth/me').then(async (me) => {
      const found = me.workspaces[0];
      if (!found) return;
      setSignedIn(true); setWorkspace(found);
      await refresh(found.id);
      if (pathTask) await loadTask(pathTask[1], Number(pathTask[2]));
    }).catch(() => setSignedIn(false));
    const pop = () => {
      const match = location.pathname.match(/^\/w\/([^/]+)\/tasks\/(\d+)$/);
      setFullPage(Boolean(match));
      if (match) void loadTask(match[1], Number(match[2])).catch(() => setError('Task is unavailable.'));
      else setTask(null);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, [loadTask, refresh]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try {
      await api('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email, password }) });
      const me = await api<{ workspaces: Workspace[] }>('/auth/me');
      const found = me.workspaces[0];
      if (!found) throw new Error('No Workspace is available for this account.');
      setWorkspace(found); setSignedIn(true); await refresh(found.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign-in failed.'); }
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !selectedProject || !title.trim()) return;
    try {
      const created = await api<Task>(`/workspaces/${workspace.id}/tasks`, { method: 'POST', body: JSON.stringify({ project_id: selectedProject, title: title.trim() }) });
      setTitle(''); setTasks((items) => [...items, created]); openPanel(created);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create task.'); }
  }

  function openPanel(value: Task) {
    if (!workspace) return;
    history.pushState({}, '', `/w/${workspace.id}/tasks/${value.number}`);
    setTask(value); setDraft(value); setFullPage(false); setConflict(null); setMoveTarget(value.project_id); setPreview(null); setError('');
  }

  async function saveTask(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !draft) return;
    try {
      const updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${draft.number}`, { method: 'PATCH', body: JSON.stringify({ expected_version: task?.version, title: draft.title, description: draft.description, status: draft.status, priority: draft.priority, start_date: draft.start_date, due_date: draft.due_date, assignees: draft.assignees.map(({ type, id }) => ({ type, id })), project_id: moveTarget !== task?.project_id ? moveTarget : undefined, confirm_move: moveTarget !== task?.project_id ? true : undefined }) });
      setTask(updated); setDraft(updated); setConflict(null); setPreview(null); setTasks((items) => items.map((item) => item.number === updated.number ? updated : item));
    } catch (reason) {
      const failure = reason as Error & { status?: number; body?: { current?: Task } };
      setError(failure.message);
      if (failure.status === 409) setConflict(failure.body?.current ?? null);
    }
  }

  async function previewMove() {
    if (!task || !moveTarget) return;
    try { setPreview(await api<MovePreview>(`/tasks/${task.id}/move-preview`, { method: 'POST', body: JSON.stringify({ project_id: moveTarget }) })); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not preview move.'); }
  }

  async function archive(restore = false) {
    if (!workspace || !task) return;
    try {
      const updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${task.number}/${restore ? 'restore' : 'archive'}`, { method: 'POST', body: JSON.stringify({ expected_version: task.version }) });
      setTask(updated); setDraft(updated); await refresh(workspace.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update task.'); }
  }

  async function duplicate() {
    if (!workspace || !task) return;
    try { const copied = await api<Task>(`/workspaces/${workspace.id}/tasks/${task.number}/duplicate`, { method: 'POST', body: '{}' }); setTasks((items) => [...items, copied]); openPanel(copied); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not duplicate task.'); }
  }

  function taskDepth(value: Task) {
    const byId = new Map(tasks.map((item) => [item.id, item]));
    let depth = 0;
    let parentId = value.parent_task_id;
    while (parentId && depth < 6) { depth += 1; parentId = byId.get(parentId)?.parent_task_id ?? null; }
    return depth;
  }

  async function createSubtask(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !task || !subtaskTitle.trim()) return;
    try {
      const created = await api<Task>(`/workspaces/${workspace.id}/tasks`, { method: 'POST', body: JSON.stringify({ project_id: task.project_id, parent_task_id: task.id, title: subtaskTitle.trim() }) });
      setSubtaskTitle(''); setTasks((items) => [...items, created]); await loadTask(workspace.id, task.number);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create subtask.'); }
  }

  async function createChecklistItem(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !task || !checklistTitle.trim()) return;
    try {
      await api(`/tasks/${task.id}/checklist`, { method: 'POST', body: JSON.stringify({ title: checklistTitle.trim() }) });
      setChecklistTitle(''); await loadTask(workspace.id, task.number);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not add checklist item.'); }
  }

  async function toggleChecklist(item: ChecklistItem) {
    if (!workspace || !task) return;
    try {
      await api(`/tasks/${task.id}/checklist/${item.id}`, { method: 'PATCH', body: JSON.stringify({ expected_version: item.version, checked: !item.checked }) });
      await loadTask(workspace.id, task.number);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update checklist item.'); }
  }

  async function addRelation(event: React.FormEvent) {
    event.preventDefault(); if (!task || !relationTarget) return;
    try {
      await api(`/tasks/${task.id}/relations`, { method: 'POST', body: JSON.stringify({ target_task_id: relationTarget, kind: relationKind }) });
      if (workspace) await loadTask(workspace.id, task.number);
      setRelationTarget('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not add relation.'); }
  }

  async function removeRelation(relation: TaskRelation) {
    if (!workspace || !task) return;
    const reverse = relation.kind === 'blocked_by' || relation.kind === 'duplicated_by';
    const source = reverse ? relation.task_id : task.id;
    const target = reverse ? task.id : relation.task_id;
    const kind = relation.kind === 'blocked_by' ? 'blocks' : relation.kind === 'duplicated_by' ? 'duplicate' : relation.kind;
    try {
      await api(`/tasks/${source}/relations/${target}/${kind}`, { method: 'DELETE' });
      await loadTask(workspace.id, task.number);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove relation.'); }
  }

  async function takeTask() {
    if (!workspace || !task) return;
    try {
      const updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${task.number}/take`, { method: 'POST', body: JSON.stringify({ expected_version: task.version }) });
      setTask(updated); setDraft(updated); setTasks((items) => items.map((item) => item.number === updated.number ? updated : item));
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not take this task.'); }
  }

  async function refreshTeams() {
    if (!workspace) return;
    const result = await api<{ teams: Team[] }>(`/workspaces/${workspace.id}/teams`);
    setTeams(result.teams);
  }

  async function createTeam(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !teamName.trim()) return;
    try { await api(`/workspaces/${workspace.id}/teams`, { method: 'POST', body: JSON.stringify({ name: teamName.trim() }) }); setTeamName(''); await refreshTeams(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create Team.'); }
  }

  async function renameTeam(team: Team) {
    const name = window.prompt('Team name', team.name)?.trim();
    if (!name || name === team.name) return;
    try { await api(`/teams/${team.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); await refreshTeams(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not rename Team.'); }
  }

  async function deleteTeam(team: Team) {
    try { await api(`/teams/${team.id}`, { method: 'DELETE' }); setTeamMembers((current) => { const next = { ...current }; delete next[team.id]; return next; }); await refreshTeams(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete Team.'); }
  }

  async function loadTeamMembers(team: Team) {
    try { const result = await api<{ members: Member[] }>(`/teams/${team.id}/members`); setTeamMembers((current) => ({ ...current, [team.id]: result.members })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load Team members.'); }
  }

  async function changeTeamMember(team: Team, memberId: string, add: boolean) {
    try {
      if (add) await api(`/teams/${team.id}/members`, { method: 'POST', body: JSON.stringify({ user_id: memberId }) });
      else await api(`/teams/${team.id}/members/${memberId}`, { method: 'DELETE' });
      await loadTeamMembers(team);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update Team members.'); }
  }

  async function showMyWork() {
    if (!workspace) return;
    try { const result = await api<{ direct_tasks: Task[]; via_team_tasks: Task[] }>(`/workspaces/${workspace.id}/my-work?include_via_team=true`); setWorkTasks(result.direct_tasks); setViaTeamTasks(result.via_team_tasks); setActiveView('my-work'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load My work.'); }
  }

  async function showTeamQueue(teamId: string) {
    if (!teamId) return;
    try { const result = await api<{ tasks: Task[] }>(`/teams/${teamId}/queue`); setTeamQueue(result.tasks); setSelectedTeam(teamId); setActiveView('team-queue'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load the Team queue.'); }
  }

  async function addProjectTeamGrant() {
    if (!task || !grantTeam) return;
    try {
      await api(`/projects/${task.project_id}/teams`, { method: 'POST', body: JSON.stringify({ team_id: grantTeam, role: grantRole }) });
      const result = await api<{ teams: TeamGrant[] }>(`/projects/${task.project_id}/teams`); setTeamGrants(result.teams);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not grant Project access.'); }
  }

  async function removeProjectTeamGrant(teamId: string) {
    if (!task) return;
    try { await api(`/projects/${task.project_id}/teams/${teamId}`, { method: 'DELETE' }); setTeamGrants((grants) => grants.filter((grant) => grant.team_id !== teamId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove Project access.'); }
  }

  async function saveSkill(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace) return;
    try {
      const saved = selectedSkill
        ? await api<Skill & { body: string }>(`/workspaces/${workspace.id}/skills/${selectedSkill.id}`, { method: 'PATCH', body: JSON.stringify({ ...skillDraft, expected_version: selectedSkill.version }) })
        : await api<Skill & { body: string }>(`/workspaces/${workspace.id}/skills`, { method: 'POST', body: JSON.stringify(skillDraft) });
      setSelectedSkill(saved); setSkillDraft({ name: saved.name, description: saved.description, body: saved.body ?? '' }); setEditingSkill(false);
      setSkills((items) => [...items.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save Skill.'); }
  }

  function openSkill(skill: Skill) {
    if (!workspace) return;
    void api<Skill & { body: string }>(`/workspaces/${workspace.id}/skills/${skill.id}`).then((loaded) => {
      setSelectedSkill(loaded); setSkillDraft({ name: loaded.name, description: loaded.description, body: loaded.body }); setEditingSkill(false); setShowSkills(true); setError('');
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not read Skill.'));
  }

  async function archiveSkill() {
    if (!workspace || !selectedSkill) return;
    try {
      await api(`/workspaces/${workspace.id}/skills/${selectedSkill.id}`, { method: 'DELETE', body: JSON.stringify({ expected_version: selectedSkill.version }) });
      setSkills((items) => items.filter((item) => item.id !== selectedSkill.id)); setSelectedSkill(null); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not archive Skill.'); }
  }

  if (!signedIn) return <main className="shell"><p className="eyebrow">WEFT · WORKSPACE</p><h1>Work moves forward, together.</h1><p className="intro">Sign in to open your Workspace tasks.</p><form className="signin" onSubmit={signIn}><label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label><button>Sign in</button>{error && <p role="alert">{error}</p>}</form></main>;

  const taskUrl = (value: Task) => `/w/${value.workspace_id}/tasks/${value.number}`;
  const renderTasks = (items: Task[]) => items.length === 0
    ? <p className="muted">No tasks in this view.</p>
    : <ul>{items.map((item) => <li key={item.id}><a href={taskUrl(item)} onClick={(event) => { event.preventDefault(); openPanel(item); }}><span className="number">#{item.number}</span><strong>{item.title}</strong><span className="status">{item.status.replace('_', ' ')}</span><span className="muted">{item.assignees.map((assignee) => `${assignee.type === 'team' ? '@' : ''}${assignee.name}`).join(', ') || 'Unassigned'}</span></a></li>)}</ul>;
  return <main className="shell app-shell">
    <header><div><p className="eyebrow">WEFT · {workspace?.name.toUpperCase()}</p><h1>{showSkills ? 'Workspace Skills' : 'Tasks'}</h1></div><div className="actions"><button type="button" className="secondary" onClick={() => { setShowSkills(!showSkills); setSelectedSkill(null); setEditingSkill(false); }}>{showSkills ? 'Tasks' : 'Skills'}</button>{!showSkills && <span className="count">{tasks.length} tasks</span>}</div></header>
    {error && <p className="notice" role="alert">{error}</p>}
    {showSkills && <section className="skill-browser" aria-label="Workspace Skills"><aside><h2>Skills</h2><ul>{skills.map((skill) => <li key={skill.id}><button type="button" className="link-button" onClick={() => openSkill(skill)}><strong>{skill.name}{!skill.enabled && ' · Disabled'}</strong><span className="muted">{skill.description}</span></button></li>)}</ul>{['owner','admin'].includes(workspace?.role ?? '') && <button type="button" onClick={() => { setSelectedSkill(null); setSkillDraft({ name: '', description: '', body: '' }); setEditingSkill(true); }}>Create Skill</button>}</aside>
      <div className="skill-content">{editingSkill ? <form className="task-form" onSubmit={saveSkill}><h2>{selectedSkill ? 'Edit Skill' : 'New Skill'}</h2><p className="notice">Everyone in this Workspace, including Viewers, and the AI can read enabled Skills. Never include passwords, tokens, or other secrets.</p><label>Name<input value={skillDraft.name} onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })} required /></label><label>Short description<input value={skillDraft.description} onChange={(event) => setSkillDraft({ ...skillDraft, description: event.target.value })} required maxLength={300} /></label><label>Markdown body<textarea rows={16} value={skillDraft.body} onChange={(event) => setSkillDraft({ ...skillDraft, body: event.target.value })} /></label><div className="actions"><button>Save Skill</button><button type="button" className="secondary" onClick={() => setEditingSkill(false)}>Cancel</button></div></form> : selectedSkill ? <article><h2>{selectedSkill.name}{!selectedSkill.enabled && ' · Disabled'}</h2><p className="muted">{selectedSkill.description}</p><div className="skill-markdown">{renderSkillBody(selectedSkill.body ?? '', workspace!.id)}</div>{['owner','admin'].includes(workspace?.role ?? '') && <div className="actions"><button type="button" onClick={() => { setSkillDraft({ name: selectedSkill.name, description: selectedSkill.description, body: selectedSkill.body ?? '' }); setEditingSkill(true); }}>Edit</button><button type="button" className="secondary" onClick={() => void api<Skill>(`/workspaces/${workspace!.id}/skills/${selectedSkill.id}`, { method: 'PATCH', body: JSON.stringify({ expected_version: selectedSkill.version, enabled: !selectedSkill.enabled }) }).then((saved) => { setSelectedSkill({ ...selectedSkill, ...saved }); setSkills((items) => items.map((item) => item.id === saved.id ? saved : item)); }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not update Skill.'))}>{selectedSkill.enabled ? 'Disable' : 'Enable'}</button>{selectedSkill.enabled && <button type="button" className="danger" onClick={() => void archiveSkill()}>Archive</button>}</div>}</article> : <p className="muted">Choose a Skill to read it.</p>}</div>
    </section>}
    {!showSkills && !task && <>
      <nav className="view-nav" aria-label="Task views"><button className={activeView === 'all' ? 'selected' : 'secondary'} onClick={() => setActiveView('all')}>All tasks</button><button className={activeView === 'my-work' ? 'selected' : 'secondary'} onClick={() => void showMyWork()}>My work</button><label>Team queue<select aria-label="Team queue" value={selectedTeam} onChange={(event) => void showTeamQueue(event.target.value)}><option value="">Choose a Team</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label></nav>
      <form className="capture" onSubmit={createTask}><label className="sr-only" htmlFor="task-title">Task title</label><input id="task-title" placeholder="Add a task…" value={title} onChange={(e) => setTitle(e.target.value)} required /><select aria-label="Project" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)} required><option value="" disabled>Select a Project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button disabled={!selectedProject}>Create task</button></form>
      <section className="task-list" aria-label="Tasks">
        {activeView === 'all' && <><h2>Readable tasks</h2>{tasks.length === 0 ? <p className="muted">No tasks yet. Add one above.</p> : renderTasks(tasks)}</>}
        {activeView === 'my-work' && <><h2>Assigned to me</h2>{renderTasks(workTasks)}<h2>Via Team</h2>{renderTasks(viaTeamTasks)}</>}
        {activeView === 'team-queue' && <><h2>{teams.find((team) => team.id === selectedTeam)?.name ?? 'Team'} queue</h2>{renderTasks(teamQueue)}</>}
      </section>
      {(workspace?.role === 'owner' || workspace?.role === 'admin') && <section className="team-admin" aria-label="Team management"><h2>Teams</h2><form className="capture" onSubmit={createTeam}><label className="sr-only" htmlFor="team-name">New Team name</label><input id="team-name" value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="New Team name" required /><button>Create Team</button></form>{teams.length === 0 ? <p className="muted">No Teams yet.</p> : teams.map((team) => <details key={team.id} onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) void loadTeamMembers(team); }}><summary>{team.name}</summary><div className="team-actions"><button className="secondary" onClick={() => void renameTeam(team)}>Rename</button><button className="danger" onClick={() => void deleteTeam(team)}>Delete Team</button></div><form className="capture" onSubmit={(event) => { event.preventDefault(); const memberId = teamMemberDrafts[team.id]; if (memberId) void changeTeamMember(team, memberId, true); }}><label>Add member<select aria-label={`Add member to ${team.name}`} value={teamMemberDrafts[team.id] ?? ''} onChange={(event) => setTeamMemberDrafts((drafts) => ({ ...drafts, [team.id]: event.target.value }))}><option value="">Choose a Workspace member</option>{members.filter((member) => !teamMembers[team.id]?.some((item) => item.id === member.id)).map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select></label><button disabled={!teamMemberDrafts[team.id]}>Add</button></form><ul>{(teamMembers[team.id] ?? []).map((member) => <li key={member.id}><span>{member.email}</span><button className="link-button" onClick={() => void changeTeamMember(team, member.id, false)}>Remove</button></li>)}</ul></details>)}</section>}
    </>}
    {!showSkills && task && draft && <section className={`task-detail ${fullPage ? 'full-page' : 'side-panel'}`} aria-label={`Task #${task.number}`}><div className="detail-top"><span className="number">#{task.number}</span><div><a href={taskUrl(task)} onClick={(event) => { event.preventDefault(); history.pushState({}, '', taskUrl(task)); setFullPage(true); }}>Open full page</a>{fullPage && <button className="link-button" onClick={() => { history.pushState({}, '', '/'); setFullPage(false); }}>Back to list</button>}</div></div>
      <form onSubmit={saveTask} className="task-form"><label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label><label>Description <span className="muted">Markdown</span><textarea rows={6} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label><div className="form-grid"><label>Status<select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{['backlog','not_started','active','completed','canceled'].map((s) => <option key={s} value={s}>{s.replace('_',' ')}</option>)}</select></label><label>Priority<select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>{['low','normal','high','urgent'].map((p) => <option key={p}>{p}</option>)}</select></label><label>Start date<input type="date" value={draft.start_date ?? ''} onChange={(e) => setDraft({ ...draft, start_date: e.target.value || null })} /></label><label>Due date<input type="date" value={draft.due_date ?? ''} onChange={(e) => setDraft({ ...draft, due_date: e.target.value || null })} /></label></div><label>Watchers<select multiple size={Math.min(Math.max(members.length, 2), 5)} value={draft.watchers} onChange={(e) => setDraft({ ...draft, watchers: Array.from(e.target.selectedOptions, (option) => option.value) })}>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select><span className="muted">Use Ctrl or Command to select multiple people.</span></label><label>Assignees<select multiple size={Math.min(Math.max(members.length + teams.length, 2), 6)} value={draft.assignees.map(({ type, id }) => `${type}:${id}`)} onChange={(e) => setDraft({ ...draft, assignees: Array.from(e.target.selectedOptions, (option) => { const [type, id] = option.value.split(':'); return { type: type as 'user' | 'team', id, name: option.textContent ?? '' }; }) })}>{members.map((member) => <option key={`user:${member.id}`} value={`user:${member.id}`}>{member.email}</option>)}{teams.map((team) => <option key={`team:${team.id}`} value={`team:${team.id}`}>@{team.name}</option>)}</select><span className="muted">Assignees do not receive access from assignment.</span></label><label>Move to Project<select value={moveTarget} onChange={(e) => { setMoveTarget(e.target.value); setPreview(null); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.visibility}</option>)}</select></label>{moveTarget !== task.project_id && <div className="move-preview"><button type="button" className="secondary" onClick={previewMove}>Preview move effects</button>{preview && <div role="status"><strong>Review before confirming</strong><p>Destination is {preview.destination_visibility}; {preview.subtasks_affected} subtasks and {preview.relations_affected} relations are affected.</p><p>Destination members: {preview.destination_members.length}. Save task to confirm this move.</p></div>}</div>}
      <section className="team-grants" aria-label="Project Team access"><h3>Project Team access</h3><div className="capture"><label>Team<select value={grantTeam} onChange={(event) => setGrantTeam(event.target.value)}><option value="">Choose a Team</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label>Access<select value={grantRole} onChange={(event) => setGrantRole(event.target.value)}><option value="viewer">Viewer</option><option value="contributor">Contributor</option><option value="manager">Manager</option></select></label><button type="button" disabled={!grantTeam} onClick={() => void addProjectTeamGrant()}>Grant access</button></div><ul>{teamGrants.map((grant) => <li key={grant.team_id}><span>{grant.name} · {grant.role}</span><button type="button" className="link-button" onClick={() => void removeProjectTeamGrant(grant.team_id)}>Remove</button></li>)}</ul></section>
      {conflict && <div className="conflict" role="alert"><strong>This task changed on the server.</strong><p>Your draft is still in the editor. Current title: “{conflict.title}” (version {conflict.version}). Copy your draft or reload before saving again.</p><button type="button" className="secondary" onClick={() => { setDraft(conflict); setTask(conflict); setConflict(null); }}>Load current version</button></div>}
      <div className="actions"><button type="submit" disabled={moveTarget !== task.project_id && !preview}>Save changes</button><button type="button" className="secondary" onClick={() => void takeTask()}>Take</button><button type="button" className="secondary" onClick={duplicate}>Duplicate</button>{task.archived_at ? <button type="button" className="secondary" onClick={() => void archive(true)}>Restore</button> : <button type="button" className="danger" onClick={() => void archive()}>Archive</button>}</div></form>
      <section className="task-structure" aria-label="Subtasks and checklist">
        <h2>Subtasks</h2>
        {task.subtasks.length > 0 && <ul>{task.subtasks.map((child) => <li key={child.id}><a href={`/w/${task.workspace_id}/tasks/${child.number}`} onClick={(event) => { event.preventDefault(); const found = tasks.find((item) => item.id === child.id); if (found) openPanel(found); }}>{`#${child.number} ${child.title}`}</a></li>)}</ul>}
        {taskDepth(task) < 4 ? <form className="inline-form" onSubmit={createSubtask}><label className="sr-only" htmlFor="subtask-title">Subtask title</label><input id="subtask-title" value={subtaskTitle} onChange={(event) => setSubtaskTitle(event.target.value)} placeholder="Add a subtask…" required /><button type="submit">Add subtask</button></form> : <p className="muted">The five-level subtask limit has been reached.</p>}
      </section>
      <section className="task-structure" aria-label="Checklist">
        <h2>Checklist</h2>
        {task.checklist.length > 0 && <ul>{task.checklist.map((item) => <li key={item.id}><label className="checklist-item"><input type="checkbox" checked={item.checked} onChange={() => void toggleChecklist(item)} /><span>{item.title}</span></label></li>)}</ul>}
        <form className="inline-form" onSubmit={createChecklistItem}><label className="sr-only" htmlFor="checklist-title">Checklist item</label><input id="checklist-title" value={checklistTitle} onChange={(event) => setChecklistTitle(event.target.value)} placeholder="Add a checklist item…" required /><button type="submit">Add item</button></form>
      </section>
      <section className="task-structure" aria-label="Relations">
        <h2>Relations</h2>
        {task.relations.length > 0 && <ul>{task.relations.map((relation) => <li key={`${relation.kind}-${relation.task_id}`}>{relation.kind.replace('_', ' ')} · <a href={`/w/${task.workspace_id}/tasks/${relation.number}`}>{`#${relation.number} ${relation.title}`}</a> <button type="button" className="link-button" aria-label={`Remove ${relation.kind} relation to task ${relation.number}`} onClick={() => void removeRelation(relation)}>Remove</button></li>)}</ul>}
        <form className="inline-form relation-form" onSubmit={addRelation}><label className="sr-only" htmlFor="relation-kind">Relation type</label><select id="relation-kind" value={relationKind} onChange={(event) => setRelationKind(event.target.value)}><option value="blocks">Blocks</option><option value="related">Related</option><option value="duplicate">Duplicate of</option></select><label className="sr-only" htmlFor="relation-target">Related task</label><select id="relation-target" value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)}><option value="">Choose a task</option>{tasks.filter((item) => item.id !== task.id).map((item) => <option key={item.id} value={item.id}>#{item.number} {item.title}</option>)}</select><button type="submit" disabled={!relationTarget}>Add relation</button></form>
      </section>
      <p className="muted">Stable URL: <code>{taskUrl(task)}</code> · version {task.version}</p>
    </section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
