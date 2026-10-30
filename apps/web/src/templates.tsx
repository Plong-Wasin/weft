import React from 'react';

type ApiFn = <T>(path: string, init?: RequestInit) => Promise<T>;
type StatusChoice = { key: string; name: string };
type SubtaskTemplate = { title_pattern: string; description?: string; status?: string | null; checklist?: string[] };
type TaskTemplate = { id: string; name: string; title_pattern: string; description: string; priority: string; default_status: string | null; checklist: string[]; subtasks: SubtaskTemplate[] };
type ProjectTemplate = { id: string; name: string; description: string; statuses: string[]; milestones: { name: string; description: string; offset_days: number }[]; task_templates: string[] };
type Missing = { kind: string; key: string; reason: string };
type Created = { group_id: string; tasks: { number: number; title: string }[]; milestones_pending?: { name: string; target_date: string }[] };

export type TemplatesDialogProps = {
  workspaceId: string;
  isAdmin: boolean;
  projects: { id: string; name: string }[];
  statuses: StatusChoice[];
  api: ApiFn;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onUndo: () => Promise<void>;
};

const variableNames = (texts: string[]) => {
  const names: string[] = [];
  for (const text of texts) for (const match of text.matchAll(/\{\{\s*([\p{L}\p{N}_-]+)\s*\}\}/gu)) if (!names.includes(match[1])) names.push(match[1]);
  return names;
};

const taskTexts = (template: TaskTemplate) => [template.title_pattern, template.description, ...template.checklist, ...template.subtasks.flatMap((subtask) => [subtask.title_pattern, subtask.description ?? '', ...(subtask.checklist ?? [])])];

const describeMissing = (item: Missing) => {
  if (item.kind === 'status') return `Status "${item.key}" is archived or gone`;
  if (item.kind === 'attribute') return `Attribute ${item.key}: ${item.reason.replace(/_/g, ' ')}`;
  if (item.kind === 'variable') return `Value for {{${item.key}}} is missing`;
  if (item.kind === 'task_template') return `Task template ${item.key} was deleted`;
  return `${item.kind} ${item.key}: ${item.reason.replace(/_/g, ' ')}`;
};

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

export function TemplatesDialog({ workspaceId, isAdmin, projects, statuses, api, onClose, onChanged, onUndo }: TemplatesDialogProps) {
  const [taskTemplates, setTaskTemplates] = React.useState<TaskTemplate[]>([]);
  const [projectTemplates, setProjectTemplates] = React.useState<ProjectTemplate[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [choice, setChoice] = React.useState('');
  const [projectId, setProjectId] = React.useState(projects[0]?.id ?? '');
  const [projectName, setProjectName] = React.useState('');
  const [visibility, setVisibility] = React.useState('restricted');
  const [startDate, setStartDate] = React.useState('');
  const [variables, setVariables] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [missing, setMissing] = React.useState<Missing[]>([]);
  const [created, setCreated] = React.useState<Created | null>(null);
  const [undone, setUndone] = React.useState(false);
  const [error, setError] = React.useState('');
  const [taskDraft, setTaskDraft] = React.useState({ name: '', title: '', description: '', status: '', checklist: '', subtasks: '' });
  const [projectDraft, setProjectDraft] = React.useState({ name: '', description: '', milestones: '', tasks: [] as string[] });
  const firstField = React.useRef<HTMLSelectElement>(null);

  const reload = React.useCallback(async () => {
    const [tasks, projectsResult] = await Promise.all([
      api<{ templates: TaskTemplate[] }>(`/workspaces/${workspaceId}/task-templates`),
      api<{ templates: ProjectTemplate[] }>(`/workspaces/${workspaceId}/project-templates`),
    ]);
    setTaskTemplates(tasks.templates);
    setProjectTemplates(projectsResult.templates);
    setLoaded(true);
  }, [api, workspaceId]);

  React.useEffect(() => { reload().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load templates.')); }, [reload]);
  React.useEffect(() => { if (loaded) firstField.current?.focus(); }, [loaded]);

  const selectedTask = choice.startsWith('task:') ? taskTemplates.find((item) => item.id === choice.slice(5)) : undefined;
  const selectedProject = choice.startsWith('project:') ? projectTemplates.find((item) => item.id === choice.slice(8)) : undefined;
  const needed = selectedTask
    ? variableNames(taskTexts(selectedTask))
    : selectedProject
      ? variableNames(selectedProject.task_templates.flatMap((id) => { const template = taskTemplates.find((item) => item.id === id); return template ? taskTexts(template) : []; }))
      : [];

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy || (!selectedTask && !selectedProject)) return;
    setBusy(true); setError(''); setMissing([]); setCreated(null); setUndone(false); setMessage('');
    const values = Object.fromEntries(needed.map((name) => [name, variables[name] ?? '']));
    try {
      const result = selectedTask
        ? await api<Created>(`/workspaces/${workspaceId}/task-templates/${selectedTask.id}/instantiate`, { method: 'POST', body: JSON.stringify({ project_id: projectId, variables: values }) })
        : await api<Created>(`/workspaces/${workspaceId}/project-templates/${selectedProject!.id}/instantiate`, { method: 'POST', body: JSON.stringify({ name: projectName, visibility, start_date: startDate || null, variables: values }) });
      setCreated(result);
      setMessage(`Created ${result.tasks.length} ${result.tasks.length === 1 ? 'task' : 'tasks'} as one group.`);
      await onChanged();
    } catch (reason) {
      const body = (reason as { body?: { error?: string; missing?: Missing[] } }).body;
      if (body?.error === 'template_unresolved' && body.missing) { setMissing(body.missing); setError('Nothing was created. The template needs things this Workspace no longer has.'); }
      else setError(reason instanceof Error ? reason.message : 'Could not create from the template.');
    } finally { setBusy(false); }
  }

  async function undoCreated() {
    setBusy(true); setError('');
    try { await onUndo(); setUndone(true); setCreated(null); setMessage('Undone: the whole group is gone.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not undo.'); }
    finally { setBusy(false); }
  }

  async function saveTaskTemplate(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setMessage('');
    try {
      await api(`/workspaces/${workspaceId}/task-templates`, { method: 'POST', body: JSON.stringify({ name: taskDraft.name, title_pattern: taskDraft.title, description: taskDraft.description, default_status: taskDraft.status || null, checklist: lines(taskDraft.checklist), subtasks: lines(taskDraft.subtasks).map((title) => ({ title_pattern: title })) }) });
      setTaskDraft({ name: '', title: '', description: '', status: '', checklist: '', subtasks: '' });
      setMessage('Task template saved.');
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save the template.'); }
  }

  async function saveProjectTemplate(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setMessage('');
    try {
      const milestones = lines(projectDraft.milestones).map((line) => { const [name, days] = line.split('|').map((part) => part.trim()); return { name, offset_days: Number(days ?? 0) }; });
      if (milestones.some((milestone) => !Number.isInteger(milestone.offset_days))) throw new Error('Write each Milestone as "name | days after start".');
      await api(`/workspaces/${workspaceId}/project-templates`, { method: 'POST', body: JSON.stringify({ name: projectDraft.name, description: projectDraft.description, milestones, task_templates: projectDraft.tasks }) });
      setProjectDraft({ name: '', description: '', milestones: '', tasks: [] });
      setMessage('Project template saved.');
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save the template.'); }
  }

  async function remove(kind: 'task' | 'project', id: string) {
    setError(''); setMessage('');
    try { await api(`/workspaces/${workspaceId}/${kind}-templates/${id}`, { method: 'DELETE' }); if (choice.endsWith(id)) setChoice(''); await reload(); setMessage('Template deleted.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete the template.'); }
  }

  const empty = loaded && taskTemplates.length === 0 && projectTemplates.length === 0;
  return <div className="overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="shortcut-dialog templates-dialog" role="dialog" aria-modal="true" aria-label="Templates">
      <h2>Templates</h2>
      <p className="muted">Create a Task or a Project from a template. Everything it makes is one group: one Undo removes it. Templates never grant access.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {missing.length > 0 && <ul aria-label="Missing from the template">{missing.map((item) => <li key={`${item.kind}:${item.key}:${item.reason}`}>{describeMissing(item)}</li>)}</ul>}
      {message && <p role="status">{message}</p>}
      {created && !undone && <button type="button" disabled={busy} onClick={() => void undoCreated()}>Undo creation</button>}
      {!loaded ? <p className="muted">Loading templates…</p> : empty ? <p className="muted">No templates yet.{isAdmin ? ' Add one below.' : ' A Workspace Admin can add them.'}</p> : <form onSubmit={(event) => void create(event)} aria-label="Create from a template">
        <label>Template<select ref={firstField} value={choice} onChange={(event) => { setChoice(event.target.value); setVariables({}); setMissing([]); }}>
          <option value="">Choose a template…</option>
          {taskTemplates.length > 0 && <optgroup label="Task templates">{taskTemplates.map((item) => <option key={item.id} value={`task:${item.id}`}>{item.name}</option>)}</optgroup>}
          {projectTemplates.length > 0 && <optgroup label="Project templates">{projectTemplates.map((item) => <option key={item.id} value={`project:${item.id}`}>{item.name}</option>)}</optgroup>}
        </select></label>
        {selectedTask && <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
        {selectedProject && <>
          <label>Project name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} required /></label>
          <label>Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="restricted">Restricted (only you)</option><option value="workspace">Workspace</option></select></label>
          {selectedProject.milestones.length > 0 && <label>Start date<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label>}
        </>}
        {needed.map((name) => <label key={name}>{name}<input value={variables[name] ?? ''} onChange={(event) => setVariables((current) => ({ ...current, [name]: event.target.value }))} required /></label>)}
        <button type="submit" disabled={busy || (!selectedTask && !selectedProject)}>Create from template</button>
      </form>}
      {created?.milestones_pending && created.milestones_pending.length > 0 && <p className="muted">Milestones planned: {created.milestones_pending.map((item) => `${item.name} ${item.target_date}`).join(', ')}</p>}
      {isAdmin && <details className="capture"><summary>Manage templates</summary>
        <form onSubmit={(event) => void saveTaskTemplate(event)} aria-label="New Task template">
          <h3>New Task template</h3>
          <label>Template name<input value={taskDraft.name} onChange={(event) => setTaskDraft({ ...taskDraft, name: event.target.value })} required /></label>
          <label>Title pattern<input value={taskDraft.title} placeholder="Release {{version}}" onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} required /></label>
          <label>Description<textarea value={taskDraft.description} onChange={(event) => setTaskDraft({ ...taskDraft, description: event.target.value })} /></label>
          <label>Default Status<select value={taskDraft.status} onChange={(event) => setTaskDraft({ ...taskDraft, status: event.target.value })}><option value="">Backlog</option>{statuses.map((status) => <option key={status.key} value={status.key}>{status.name}</option>)}</select></label>
          <label>Checklist (one item per line)<textarea value={taskDraft.checklist} onChange={(event) => setTaskDraft({ ...taskDraft, checklist: event.target.value })} /></label>
          <label>Subtasks (one title per line)<textarea value={taskDraft.subtasks} onChange={(event) => setTaskDraft({ ...taskDraft, subtasks: event.target.value })} /></label>
          <button type="submit">Save Task template</button>
        </form>
        <form onSubmit={(event) => void saveProjectTemplate(event)} aria-label="New Project template">
          <h3>New Project template</h3>
          <label>Template name<input value={projectDraft.name} onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} required /></label>
          <label>Description<textarea value={projectDraft.description} onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })} /></label>
          <label>Milestones (name | days after start, one per line)<textarea value={projectDraft.milestones} onChange={(event) => setProjectDraft({ ...projectDraft, milestones: event.target.value })} /></label>
          <label>Task templates<select multiple value={projectDraft.tasks} onChange={(event) => setProjectDraft({ ...projectDraft, tasks: Array.from(event.target.selectedOptions, (option) => option.value) })}>{taskTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button type="submit">Save Project template</button>
        </form>
        <h3>Library</h3>
        <ul>{taskTemplates.map((item) => <li key={item.id}>{item.name} (Task) <button type="button" className="secondary" aria-label={`Delete Task template ${item.name}`} onClick={() => void remove('task', item.id)}>Delete</button></li>)}{projectTemplates.map((item) => <li key={item.id}>{item.name} (Project) <button type="button" className="secondary" aria-label={`Delete Project template ${item.name}`} onClick={() => void remove('project', item.id)}>Delete</button></li>)}</ul>
      </details>}
      <div className="palette-footer"><button type="button" className="secondary" onClick={onClose}>Close · Esc</button></div>
    </section>
  </div>;
}
