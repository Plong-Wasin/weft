import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Workspace = { id: string; name: string; role: string };
type Skill = { id: string; name: string; description: string; body?: string; enabled: boolean; version: number };
type Project = { id: string; name: string; visibility: string };
type Vault = { id: string; workspace_id: string; name: string; visibility: string; role: string };
type ReaderNote = { path: string; format: 'markdown' | 'source'; html?: string; source?: string; properties?: Record<string, string>; aliases?: string[]; tags?: string[]; links?: { target: string; embed: boolean; resolution: { status: string; path?: string; candidate?: string } }[] };
type Member = { id: string; email: string; role: string };
type ChecklistItem = { id: string; title: string; checked: boolean; position: number; version: number };
type TaskRelation = { task_id: string; number: number; title: string; kind: string };
type Task = { id: string; number: number; workspace_id: string; project_id: string; parent_task_id: string | null; title: string; description: string; status: string; priority: string; start_date: string | null; due_date: string | null; attributes: Record<string, unknown>; watchers: string[]; assignees: Assignee[]; subtasks: { id: string; number: number; title: string }[]; checklist: ChecklistItem[]; relations: TaskRelation[]; version: number; archived_at: string | null };
type Team = { id: string; name: string };
type Assignee = { type: 'user' | 'team'; id: string; name: string };
type TeamGrant = { team_id: string; name: string; role: string };
type MovePreview = { destination_visibility: string; subtasks_affected: number; relations_affected: number; destination_members: { user_id: string; role: string }[] };
type Status = { id: string; key: string; name: string; category: string; color: string; position: number; archived: boolean };
type Attribute = { id: string; name: string; type: string; project_ids: string[]; options: { id: string; key: string; name: string }[]; archived: boolean };
type TaskAttribute = { id: string; name: string; type: string; value: unknown };
type Comment = { id: string; body: string; author_id: string; edited: boolean };
type SearchResult = { task_id: string; task_number: number; title: string; snippet: string };
type TaskList = { id: string; name: string; kind: 'manual' | 'smart'; query: { filters: { field: string; op: string; value: unknown }[]; logic: 'and' | 'or'; sort?: unknown[]; group?: string | null; columns?: string[] } };

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

function isTextEntryTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (['POST', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase()) && !navigator.onLine) {
    throw new Error('Weft is offline and read-only. Reconnect to make changes.');
  }
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (['POST', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) headers.set('x-csrf-token', csrf());
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  } catch (reason) {
    if (['POST', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) {
      throw new Error('Weft could not reach the server. Writes are unavailable offline; reconnect and try again.');
    }
    throw reason;
  }
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw Object.assign(new Error(body?.error ?? `Request failed (${response.status})`), { status: response.status, body });
  return body as T;
}

function App() {
  const [workspace, setWorkspace] = React.useState<Workspace | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [vaults, setVaults] = React.useState<Vault[]>([]);
  const [selectedVaultId, setSelectedVaultId] = React.useState('');
  const [vaultFiles, setVaultFiles] = React.useState<string[]>([]);
  const [readerNote, setReaderNote] = React.useState<ReaderNote | null>(null);
  const [readerBacklinks, setReaderBacklinks] = React.useState<{ path: string; title: string }[]>([]);
  const [readerHistory, setReaderHistory] = React.useState<{ id: string; author: string; time: string; message: string }[]>([]);
  const [readerError, setReaderError] = React.useState('');
  const [vaultError, setVaultError] = React.useState('');
  const [members, setMembers] = React.useState<Member[]>([]);
  const [teams, setTeams] = React.useState<Team[]>([]);
  const [skills, setSkills] = React.useState<Skill[]>([]);
  const [selectedSkill, setSelectedSkill] = React.useState<Skill | null>(null);
  const [skillDraft, setSkillDraft] = React.useState({ name: '', description: '', body: '' });
  const [editingSkill, setEditingSkill] = React.useState(false);
  const [showSkills, setShowSkills] = React.useState(false);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [taskLists, setTaskLists] = React.useState<TaskList[]>([]);
  const [selectedListId, setSelectedListId] = React.useState('');
  const [viewMode, setViewMode] = React.useState<'table' | 'kanban'>('table');
  const [newListName, setNewListName] = React.useState('');
  const [smartStatus, setSmartStatus] = React.useState('');
  const [smartRelativeDate, setSmartRelativeDate] = React.useState('');
  const [smartAttribute, setSmartAttribute] = React.useState('');
  const [smartAttributeValue, setSmartAttributeValue] = React.useState('');
  const [smartAssignee, setSmartAssignee] = React.useState(false);
  const [smartIncludeTeam, setSmartIncludeTeam] = React.useState(false);
  const [smartLogic, setSmartLogic] = React.useState<'and' | 'or'>('and');
  const [smartSort, setSmartSort] = React.useState('number');
  const [smartGroup, setSmartGroup] = React.useState('');
  const [smartColumns, setSmartColumns] = React.useState(['title', 'status', 'priority']);
  const [statuses, setStatuses] = React.useState<Status[]>([]);
  const [attributes, setAttributes] = React.useState<Attribute[]>([]);
  const [taskAttributes, setTaskAttributes] = React.useState<TaskAttribute[]>([]);
  const [attributeDraft, setAttributeDraft] = React.useState<Record<string, unknown>>({});
  const [tableAttributeDrafts, setTableAttributeDrafts] = React.useState<Record<string, string>>({});
  const [workTasks, setWorkTasks] = React.useState<Task[]>([]);
  const [viaTeamTasks, setViaTeamTasks] = React.useState<Task[]>([]);
  const [teamQueue, setTeamQueue] = React.useState<Task[]>([]);
  const [activeView, setActiveView] = React.useState<'all' | 'my-work' | 'team-queue' | 'list'>('all');
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
  const [comments, setComments] = React.useState<Comment[]>([]);
  const [commentBody, setCommentBody] = React.useState('');
  const [editingComment, setEditingComment] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([]);
  const [searchCount, setSearchCount] = React.useState<number | null>(null);
  const [keyboardMode, setKeyboardMode] = React.useState<'browse' | 'edit' | 'outline'>('browse');
  const [focusedRowIndex, setFocusedRowIndex] = React.useState(0);
  const [selectedTaskIds, setSelectedTaskIds] = React.useState<string[]>([]);
  const [selectionAnchor, setSelectionAnchor] = React.useState<number | null>(null);
  const [editingTaskId, setEditingTaskId] = React.useState<string | null>(null);
  const [inlineTitle, setInlineTitle] = React.useState('');
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'inbox' | 'my-work' | 'proposal' | 'knowledge' | 'more'>('inbox');
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [offline, setOffline] = React.useState(!navigator.onLine);
  const [paletteQuery, setPaletteQuery] = React.useState('');
  const [shortcutHelpOpen, setShortcutHelpOpen] = React.useState(false);
  const [virtualStart, setVirtualStart] = React.useState(0);
  const composing = React.useRef(false);
  const taskRef = React.useRef<Task | null>(null);
  const draftRef = React.useRef<Task | null>(null);
  const taskAttributesRef = React.useRef<TaskAttribute[]>([]);
  const attributeDraftRef = React.useRef<Record<string, unknown>>({});
  const focusReturn = React.useRef<HTMLElement | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const paletteInputRef = React.useRef<HTMLInputElement>(null);

  const refresh = React.useCallback(async (workspaceId: string) => {
    const [projectResult, taskResult, memberResult, teamResult, myWorkResult, skillResult, statusResult, attributeResult, listResult, vaultResult] = await Promise.all([
      api<{ projects: Project[] }>(`/workspaces/${workspaceId}/projects`),
      api<{ tasks: Task[] }>(`/workspaces/${workspaceId}/tasks`),
      api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`),
      api<{ teams: Team[] }>(`/workspaces/${workspaceId}/teams`),
      api<{ direct_tasks: Task[]; via_team_tasks: Task[] }>(`/workspaces/${workspaceId}/my-work`),
      api<{ skills: Skill[] }>(`/workspaces/${workspaceId}/skills`),
      api<{ statuses: Status[] }>(`/workspaces/${workspaceId}/statuses`),
      api<{ attributes: Attribute[] }>(`/workspaces/${workspaceId}/attributes`),
      api<{ lists: TaskList[] }>(`/workspaces/${workspaceId}/lists`),
      api<{ vaults: Vault[] }>(`/workspaces/${workspaceId}/vaults`),
    ]);
    setProjects(projectResult.projects);
    setTasks(taskResult.tasks);
    setTaskLists(listResult.lists);
    setVaults(vaultResult.vaults);
    setMembers(memberResult.members);
    setTeams(teamResult.teams);
    setSkills(skillResult.skills);
    setStatuses(statusResult.statuses.filter((status) => !status.archived));
    setAttributes(attributeResult.attributes.filter((attribute) => !attribute.archived));
    setWorkTasks(myWorkResult.direct_tasks);
    setViaTeamTasks(myWorkResult.via_team_tasks);
    setSelectedProject((current) => current || projectResult.projects[0]?.id || '');
  }, []);

  const loadTask = React.useCallback(async (workspaceId: string, number: number) => {
    const loaded = await api<Task>(`/workspaces/${workspaceId}/tasks/${number}`);
    const values = await api<{ attributes: TaskAttribute[] }>(`/tasks/${loaded.id}/attributes`);
    const discussion = await api<{ comments: Comment[] }>(`/tasks/${loaded.id}/comments`);
    setComments(discussion.comments);
    const base = taskRef.current;
    const attributesDirty = taskAttributesRef.current.some((attribute) => JSON.stringify(attributeDraftRef.current[attribute.id] ?? null) !== JSON.stringify(attribute.value ?? null));
    const dirty = base?.id === loaded.id && draftRef.current !== null && (JSON.stringify(draftRef.current) !== JSON.stringify(base) || attributesDirty);
    const sections = { subtasks: loaded.subtasks, checklist: loaded.checklist, relations: loaded.relations };
    setTasks((items) => items.map((item) => item.id === loaded.id ? loaded : item));
    setListTasks((items) => items.map((item) => item.id === loaded.id ? loaded : item));
    if (dirty && base) {
      // Keep unsaved edits. Someone else changing the fields we edit must still surface as a
      // conflict, so the baseline version only advances when those fields are unchanged.
      const coreKeys = ['title', 'description', 'status', 'priority', 'start_date', 'due_date'] as const;
      const othersEdited = coreKeys.some((key) => base[key] !== loaded[key]) || JSON.stringify(base.assignees) !== JSON.stringify(loaded.assignees);
      setTask(othersEdited ? { ...base, ...sections } : loaded);
      setDraft((current) => current ? { ...current, ...sections, ...(othersEdited ? {} : { version: loaded.version }) } : loaded);
      setComments(discussion.comments);
      setConflict(othersEdited ? loaded : null);
      void api<{ teams: TeamGrant[] }>(`/projects/${loaded.project_id}/teams`).then((result) => setTeamGrants(result.teams)).catch(() => setTeamGrants([]));
      return;
    }
    setTask(loaded);
    setDraft(loaded);
    setTaskAttributes(values.attributes);
    setAttributeDraft(Object.fromEntries(values.attributes.map((attribute) => [attribute.id, attribute.value])));
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

  React.useEffect(() => {
    if (paletteOpen) requestAnimationFrame(() => paletteInputRef.current?.focus());
  }, [paletteOpen]);

  React.useEffect(() => {
    if (moreOpen) requestAnimationFrame(() => document.querySelector<HTMLElement>('.more-sheet button')?.focus());
  }, [moreOpen]);

  React.useEffect(() => {
    const updateOnlineState = () => setOffline(!navigator.onLine);
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    return () => {
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
    };
  }, []);

  React.useEffect(() => { taskRef.current = task; draftRef.current = draft; taskAttributesRef.current = taskAttributes; attributeDraftRef.current = attributeDraft; });

  React.useEffect(() => {
    const startComposition = () => { composing.current = true; };
    const endComposition = () => { composing.current = false; };
    const keydown = (event: KeyboardEvent) => {
      const composingNow = composing.current || event.isComposing || event.keyCode === 229;
      if (composingNow) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'k') {
        event.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
        return;
      }
      if (event.key === 'Escape') {
        if (paletteOpen) { event.preventDefault(); closePalette(); return; }
        if (moreOpen) { event.preventDefault(); setMoreOpen(false); setActiveTab('inbox'); restoreFocus(); return; }
        if (shortcutHelpOpen) { event.preventDefault(); setShortcutHelpOpen(false); restoreFocus(); return; }
        if (editingTaskId) { event.preventDefault(); setEditingTaskId(null); setKeyboardMode('browse'); requestAnimationFrame(() => gridRef.current?.focus()); return; }
        if (task && !fullPage) {
          event.preventDefault();
          if (draft && JSON.stringify(draft) !== JSON.stringify(task)) { setError('Unsaved changes. Save them, or use Close to discard.'); return; }
          closeTaskPanel();
          return;
        }
      }
      if (event.key === 'Tab' && (paletteOpen || moreOpen || shortcutHelpOpen)) {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
        const controls = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')) : [];
        if (controls.length) {
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
        }
      }
      if (isTextEntryTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        void runHistoryAction(event.shiftKey);
      } else if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault();
        void runHistoryAction(true);
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        if (key === 'b') setKeyboardMode('browse');
        if (key === 'e') setKeyboardMode('edit');
        if (key === 'o') setKeyboardMode('outline');
      }
    };
    window.addEventListener('compositionstart', startComposition, true);
    window.addEventListener('compositionend', endComposition, true);
    window.addEventListener('blur', endComposition);
    document.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('compositionstart', startComposition, true);
      window.removeEventListener('compositionend', endComposition, true);
      window.removeEventListener('blur', endComposition);
      document.removeEventListener('keydown', keydown);
    };
  }, [paletteOpen, shortcutHelpOpen, moreOpen, editingTaskId, task, draft, fullPage, statuses, tasks, selectedTaskIds, focusedRowIndex, workspace]);

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
      const selectedList = taskLists.find((item) => item.id === selectedListId);
      const unambiguousStatus = selectedList?.kind === 'smart' && selectedList.query.logic !== 'or' && selectedList.query.filters.filter((filter) => filter.field === 'status' && filter.op === 'eq').length === 1
        ? selectedList.query.filters.find((filter) => filter.field === 'status' && filter.op === 'eq')?.value
        : undefined;
      const statusKey = typeof unambiguousStatus === 'string' ? statuses.find((status) => status.id === unambiguousStatus)?.key ?? unambiguousStatus : undefined;
      const created = await api<Task>(`/workspaces/${workspace.id}/tasks`, { method: 'POST', body: JSON.stringify({ project_id: selectedProject, title: title.trim(), status: statusKey }) });
      setTitle(''); setTasks((items) => [...items, created]); openPanel(created);
      if (selectedList?.kind === 'manual') { await api(`/lists/${selectedList.id}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: created.id, request_id: crypto.randomUUID() }) }); setListTasks((items) => [...items, created]); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create task.'); }
  }

  async function createList(kind: 'manual' | 'smart') {
    if (!workspace || !newListName.trim()) return;
    const filters = [
      ...(smartStatus ? [{ field: 'status', op: 'eq', value: smartStatus }] : []),
      ...(smartRelativeDate ? [{ field: 'due_date', op: 'relative', value: smartRelativeDate }] : []),
      ...(smartAttribute && smartAttributeValue ? [{ field: `attribute:${smartAttribute}`, op: 'eq', value: smartAttributeValue }] : []),
      ...(smartAssignee ? [{ field: smartIncludeTeam ? 'assignee_including_team' : 'assignee', op: 'eq', value: 'me' }] : []),
    ];
    const columns = smartColumns.includes('title') ? smartColumns : ['title', ...smartColumns];
    const query = kind === 'smart' ? { filters, logic: smartLogic, sort: [{ field: smartSort, direction: 'asc' }], group: smartGroup || null, columns } : undefined;
    try {
      const created = await api<TaskList>(`/workspaces/${workspace.id}/lists`, { method: 'POST', body: JSON.stringify({ name: newListName.trim(), kind, query }) });
      setTaskLists((items) => [...items, created]); setSelectedListId(created.id); setNewListName('');
      setListTasks([]); setActiveView('list');
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create List.'); }
  }

  async function changeListMembership(task: Task, add: boolean) {
    if (!selectedListId || !workspace) return;
    try {
      if (add) await api(`/lists/${selectedListId}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: task.id, request_id: crypto.randomUUID() }) });
      else await api(`/lists/${selectedListId}/tasks/${task.id}`, { method: 'DELETE' });
      const result = await api<{ id: string; tasks: Task[] }>(`/workspaces/${workspace.id}/lists/${selectedListId}`);
      setTasks((items) => items.map((item) => result.tasks.find((viewTask) => viewTask.id === item.id) ?? item));
      if (selectedListId) setListTasks(result.tasks);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update List membership.'); }
  }

  const [listTasks, setListTasks] = React.useState<Task[]>([]);
  async function openList(id: string) {
    setSelectedListId(id);
    if (!workspace || !id) { setListTasks([]); return; }
    try { const result = await api<{ tasks: Task[] }>(`/workspaces/${workspace.id}/lists/${id}`); setListTasks(result.tasks); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not open List.'); }
  }

  async function moveKanbanColumn(statusId: string, delta: number) {
    if (!workspace || !['owner', 'admin'].includes(workspace.role)) return;
    const ordered = [...statuses].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((status) => status.id === statusId);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= ordered.length) return;
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    try {
      await api(`/workspaces/${workspace.id}/statuses/reorder`, { method: 'POST', body: JSON.stringify({ status_ids: ordered.map((status) => status.id) }) });
      const result = await api<{ statuses: Status[] }>(`/workspaces/${workspace.id}/statuses`);
      setStatuses(result.statuses.filter((status) => !status.archived)); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not move the Status column.'); }
  }

  async function searchTasks(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || searchQuery.trim().length < 1) return;
    try { const result = await api<{ results: SearchResult[]; count: number }>(`/workspaces/${workspace.id}/search?q=${encodeURIComponent(searchQuery.trim())}`); setSearchResults(result.results); setSearchCount(result.count); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not search tasks.'); }
  }

  async function saveComment(event: React.FormEvent) {
    event.preventDefault(); if (!task || !commentBody.trim()) return;
    try {
      if (editingComment) await api<Comment>(`/tasks/${task.id}/comments/${editingComment}`, { method: 'PATCH', body: JSON.stringify({ body: commentBody }) });
      else await api<Comment>(`/tasks/${task.id}/comments`, { method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID(), body: commentBody }) });
      setCommentBody(''); setEditingComment(null); setComments((await api<{ comments: Comment[] }>(`/tasks/${task.id}/comments`)).comments);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save comment.'); }
  }

  async function deleteComment(id: string) {
    if (!task) return;
    try { await api(`/tasks/${task.id}/comments/${id}`, { method: 'DELETE' }); setComments((items) => items.filter((item) => item.id !== id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete comment.'); }
  }

  function restoreFocus() {
    requestAnimationFrame(() => focusReturn.current?.focus());
  }

  function openPalette() {
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : gridRef.current;
    setPaletteQuery('');
    setPaletteOpen(true);
  }

  function closePalette(restore = true) {
    setPaletteOpen(false);
    setPaletteQuery('');
    if (restore) restoreFocus();
  }

  function closeTaskPanel() {
    if (!workspace) return;
    history.pushState({}, '', '/');
    setTask(null);
    setDraft(null);
    setTaskAttributes([]);
    setFullPage(false);
    restoreFocus();
  }

  function reportWriteError(reason: unknown, fallback: string) {
    setError(reason instanceof Error ? reason.message : fallback);
    // A stale version is the usual cause of a 409: reload so the next attempt uses the current one.
    if ((reason as { status?: number }).status === 409 && workspace) void refresh(workspace.id);
  }

  async function saveInlineTitle(value: Task) {
    if (!workspace || !inlineTitle.trim()) return;
    try {
      const updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${value.number}`, { method: 'PATCH', body: JSON.stringify({ expected_version: value.version, title: inlineTitle.trim() }) });
      setTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setEditingTaskId(null);
      setKeyboardMode('browse');
      requestAnimationFrame(() => gridRef.current?.focus());
    } catch (reason) { reportWriteError(reason, 'Could not save task title.'); }
  }

  async function updateTaskStatus(value: Task, status: string) {
    if (!workspace || value.status === status) return;
    try {
      const updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${value.number}`, { method: 'PATCH', body: JSON.stringify({ expected_version: value.version, status }) });
      setTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setListTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setTask((current) => current?.id === updated.id ? updated : current);
    } catch (reason) { reportWriteError(reason, 'Could not update Status.'); }
  }

  async function updateTaskAttribute(value: Task, attribute: Attribute, next: unknown) {
    const normalized = attribute.type === 'number' && next !== null && next !== '' ? Number(next) : next;
    if (JSON.stringify(value.attributes[attribute.id] ?? null) === JSON.stringify(normalized ?? null)) return;
    try {
      const result = await api<{ version: number }>(`/tasks/${value.id}/attributes`, { method: 'PATCH', body: JSON.stringify({ values: [{ attribute_id: attribute.id, value: normalized ?? null, expected_version: value.version }] }) });
      setTasks((items) => items.map((item) => item.id === value.id ? { ...item, version: result.version, attributes: { ...item.attributes, [attribute.id]: normalized ?? null } } : item));
      setTask((current) => current?.id === value.id ? { ...current, version: result.version, attributes: { ...current.attributes, [attribute.id]: normalized ?? null } } : current);
    } catch (reason) { reportWriteError(reason, `Could not update ${attribute.name}.`); }
  }

  async function bulkSetStatus(status: string) {
    if (!workspace) return;
    const selected = tasks.filter((item) => selectedTaskIds.includes(item.id));
    if (selected.length === 0) return;
    try {
      await api(`/workspaces/${workspace.id}/tasks/bulk`, { method: 'POST', body: JSON.stringify({ items: selected.map((item) => ({ task_id: item.id, expected_version: item.version, status })) }) });
      await refresh(workspace.id);
      setError('');
    } catch (reason) { reportWriteError(reason, 'Could not update selected tasks.'); }
  }

  async function bulkSetAttribute(attribute: Attribute, value: string) {
    if (!workspace || !value) return;
    const selected = tasks.filter((item) => selectedTaskIds.includes(item.id));
    if (selected.length === 0) return;
    try {
      await api(`/workspaces/${workspace.id}/tasks/bulk-attributes`, { method: 'POST', body: JSON.stringify({ items: selected.map((item) => ({ task_id: item.id, expected_version: item.version })), attribute_id: attribute.id, value }) });
      await refresh(workspace.id);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : `Could not update ${attribute.name} on selected tasks.`); }
  }

  async function runHistoryAction(redo: boolean) {
    if (!workspace) return;
    try {
      await api(`/workspaces/${workspace.id}/history/${redo ? 'redo' : 'undo'}`, { method: 'POST', body: '{}' });
      await refresh(workspace.id);
      if (task) await loadTask(workspace.id, task.number);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : `Could not ${redo ? 'redo' : 'undo'} the last change.`); }
  }

  async function runPaletteCommand() {
    const query = paletteQuery.trim();
    const create = query.match(/^create(?:\s+(.+))?$/i);
    const projectId = selectedProject || tasks[focusedRowIndex]?.project_id;
    if (create && workspace && projectId) {
      const name = create[1]?.trim() || 'New task';
      try {
        const list = taskLists.find((item) => item.id === selectedListId);
        const filter = list?.kind === 'smart' && list.query.logic === 'and' && list.query.filters.filter((item) => item.field === 'status' && item.op === 'eq').length === 1 ? list.query.filters.find((item) => item.field === 'status' && item.op === 'eq') : undefined;
        const status = typeof filter?.value === 'string' ? statuses.find((item) => item.id === filter.value)?.key ?? filter.value : undefined;
        const created = await api<Task>(`/workspaces/${workspace.id}/tasks`, { method: 'POST', body: JSON.stringify({ project_id: projectId, title: name, status }) });
        if (list?.kind === 'manual') { await api(`/lists/${list.id}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: created.id, request_id: crypto.randomUUID() }) }); setListTasks((items) => [...items, created]); }
        setTasks((items) => [...items, created]);
        closePalette(false);
        openPanel(created);
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create task.'); }
      return;
    }
      const statusCommand = query.match(/^status\s+(.+)$/i);
    if (statusCommand) {
      const nextStatus = statuses.find((status) => status.key.toLowerCase() === statusCommand[1].toLowerCase() || status.name.toLowerCase() === statusCommand[1].toLowerCase());
      const target = viewTasks[focusedRowIndex];
      if (nextStatus && target) {
        await updateTaskStatus(target, nextStatus.key);
        closePalette();
      }
      return;
    }
    const columnCommand = query.match(/^column\s+move\s+(.+?)\s+(left|right)$/i);
    if (columnCommand) {
      const status = statuses.find((item) => item.name.toLowerCase() === columnCommand[1].toLowerCase() || item.key.toLowerCase() === columnCommand[1].toLowerCase());
      if (status) { await moveKanbanColumn(status.id, columnCommand[2].toLowerCase() === 'right' ? 1 : -1); closePalette(); }
      return;
    }
    const match = paletteResults[0];
    if (match) {
      closePalette(false);
      openPanel(match);
    }
  }

  function openPanel(value: Task) {
    if (!workspace) return;
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : gridRef.current;
    history.pushState({}, '', `/w/${workspace.id}/tasks/${value.number}`);
    setFullPage(false);
    void loadTask(workspace.id, value.number).catch((reason) => setError(reason instanceof Error ? reason.message : 'Task is unavailable.'));
  }

  async function saveTask(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !draft) return;
    try {
      let updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${draft.number}`, { method: 'PATCH', body: JSON.stringify({ expected_version: task?.version, title: draft.title, description: draft.description, status: draft.status, priority: draft.priority, start_date: draft.start_date, due_date: draft.due_date, assignees: draft.assignees.map(({ type, id }) => ({ type, id })), project_id: moveTarget !== task?.project_id ? moveTarget : undefined, confirm_move: moveTarget !== task?.project_id ? true : undefined }) });
      setTask(updated); setTasks((items) => items.map((item) => item.number === updated.number ? updated : item));
      const changes = taskAttributes.map((attribute) => {
        const draftValue = attributeDraft[attribute.id] ?? null;
        const value = attribute.type === 'number' && draftValue !== null && draftValue !== '' ? Number(draftValue) : draftValue;
        return { ...attribute, nextValue: value };
      }).filter((attribute) => JSON.stringify(attribute.value) !== JSON.stringify(attribute.nextValue));
      if (changes.length > 0) {
        const saved = await api<{ version: number }>(`/tasks/${updated.id}/attributes`, { method: 'PATCH', body: JSON.stringify({ values: changes.map((attribute) => ({ attribute_id: attribute.id, value: attribute.nextValue, expected_version: updated.version })) }) });
        updated = { ...updated, version: saved.version, attributes: { ...updated.attributes, ...Object.fromEntries(changes.map((attribute) => [attribute.id, attribute.nextValue])) } };
        setTaskAttributes((items) => items.map((attribute) => ({ ...attribute, value: changes.find((change) => change.id === attribute.id)?.nextValue ?? attribute.value })));
      }
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
      if (restore) { setTask(updated); setDraft(updated); await refresh(workspace.id); }
      else {
        const remaining = tasks.filter((item) => item.id !== task.id);
        setTasks(remaining);
        setSelectedTaskIds((items) => items.filter((id) => id !== task.id));
        setFocusedRowIndex((index) => Math.max(0, Math.min(index, remaining.length - 1)));
        await refresh(workspace.id);
        closeTaskPanel();
      }
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

  async function showKnowledge() {
    setShowSkills(false);
    setActiveTab('knowledge');
    if (!workspace) return;
    try {
      const result = await api<{ vaults: Vault[] }>(`/workspaces/${workspace.id}/vaults`);
      setVaults(result.vaults);
      setVaultError('');
    } catch (reason) {
      setVaultError(reason instanceof Error ? reason.message : 'Could not list Vaults.');
    }
  }

  async function openVaultContents(vault: Vault) {
    setSelectedVaultId(vault.id);
    setVaultFiles([]);
    setReaderNote(null);
    setReaderBacklinks([]);
    setReaderHistory([]);
    setVaultError('');
    try {
      const result = await api<{ files: string[] }>(`/vaults/${vault.id}/contents`);
      setVaultFiles(result.files);
      const firstNote = result.files.find((file) => file.toLowerCase().endsWith('.md') || file.toLowerCase().endsWith('.html'));
      if (firstNote) await openVaultNote(vault.id, firstNote);
    } catch (reason) {
      setVaultError(reason instanceof Error ? reason.message : 'Could not read this Vault.');
    }
  }

  async function openVaultNote(vaultId: string, path: string, fragment = '') {
    setReaderError('');
    setReaderNote(null);
    setReaderBacklinks([]);
    setReaderHistory([]);
    const encodedPath = encodeURIComponent(path);
    try {
      const note = await api<ReaderNote>(`/vaults/${vaultId}/notes?path=${encodedPath}`);
      setReaderNote(note);
      if (note.format === 'markdown') {
        const [backlinks, history] = await Promise.all([
          api<{ backlinks: { path: string; title: string }[] }>(`/vaults/${vaultId}/backlinks?path=${encodedPath}`),
          api<{ commits: { id: string; author: string; time: string; message: string }[] }>(`/vaults/${vaultId}/history?path=${encodedPath}`),
        ]);
        setReaderBacklinks(backlinks.backlinks);
        setReaderHistory(history.commits);
      }
      if (fragment) {
        const id = decodeURIComponent(fragment.slice(1));
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView()));
      }
    } catch (reason) {
      setReaderError(reason instanceof Error ? reason.message : 'Could not open this note.');
    }
  }

  function followReaderLink(event: React.MouseEvent<HTMLElement>) {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor || !selectedVaultId || anchor.pathname !== `/api/v1/vaults/${selectedVaultId}/notes`) return;
    event.preventDefault();
    const path = new URLSearchParams(anchor.search).get('path');
    if (!path) return;
    void openVaultNote(selectedVaultId, path, anchor.hash);
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
  const viewTasks = activeView === 'my-work' ? [...workTasks, ...viaTeamTasks] : activeView === 'team-queue' ? teamQueue : activeView === 'list' ? listTasks : tasks;
  const selectedColumns = activeView === 'list' ? taskLists.find((list) => list.id === selectedListId)?.query.columns ?? ['title', 'status', 'priority'] : ['title', 'status', 'priority', ...attributes.map((attribute) => `attribute:${attribute.id}`)];
  const showColumn = (column: string) => activeView !== 'list' || selectedColumns.includes(column);
  const selectedTasks = tasks.filter((item) => selectedTaskIds.includes(item.id));
  const bulkAttributes = attributes.filter((attribute) => attribute.type === 'single_select' && selectedTasks.length > 1 && selectedTasks.every((item) => attribute.project_ids?.includes(item.project_id)));
  const paletteResults = tasks.filter((item) => `${item.number} ${item.title} ${item.description}`.toLocaleLowerCase().includes(paletteQuery.trim().toLocaleLowerCase()));
  const virtualEnd = Math.min(viewTasks.length, virtualStart + 30);
  const visibleTasks = viewTasks.slice(virtualStart, virtualEnd);
  function focusRow(index: number, extend = false) {
    const next = Math.max(0, Math.min(index, viewTasks.length - 1));
    setFocusedRowIndex(next);
    if (extend && viewTasks[next]) {
      const anchor = selectionAnchor ?? focusedRowIndex;
      const first = Math.min(anchor, next);
      const last = Math.max(anchor, next);
      setSelectedTaskIds(viewTasks.slice(first, last + 1).map((item) => item.id));
      setSelectionAnchor(anchor);
    } else if (viewTasks[next]) {
      setSelectedTaskIds([viewTasks[next].id]);
      setSelectionAnchor(next);
    }
    if (next < virtualStart) setVirtualStart(next);
    else if (next >= virtualStart + 30) setVirtualStart(next - 29);
    if (viewTasks[next]) requestAnimationFrame(() => document.getElementById(`task-row-${viewTasks[next].id}`)?.scrollIntoView({ block: 'nearest' }));
  }
  async function createOutlineChild(parent: Task) {
    if (!workspace) return;
    try {
      const child = await api<Task>(`/workspaces/${workspace.id}/tasks`, { method: 'POST', body: JSON.stringify({ project_id: parent.project_id, parent_task_id: parent.id, title: 'New subtask' }) });
      setTasks((items) => [...items, child]);
      const childIndex = tasks.length;
      setFocusedRowIndex(childIndex);
      setSelectedTaskIds([child.id]);
      setSelectionAnchor(childIndex);
      setVirtualStart(Math.max(0, childIndex - 29));
      setKeyboardMode('edit');
      setEditingTaskId(child.id);
      setInlineTitle(child.title);
      requestAnimationFrame(() => document.getElementById(`task-row-${child.id}`)?.scrollIntoView({ block: 'nearest' }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create subtask.'); }
  }
  function handleGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (editingTaskId) {
      const edited = tasks.find((item) => item.id === editingTaskId);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditingTaskId(null); setKeyboardMode('browse'); requestAnimationFrame(() => gridRef.current?.focus()); }
      if (event.key === 'Enter' && edited) { event.preventDefault(); event.stopPropagation(); void saveInlineTitle(edited); }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(focusedRowIndex + (event.key === 'ArrowDown' ? 1 : -1), event.shiftKey);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusRow(event.key === 'Home' ? 0 : viewTasks.length - 1);
    } else if ((event.key === 'Enter' || event.key === 'F2') && viewTasks[focusedRowIndex]) {
      event.preventDefault();
      setEditingTaskId(viewTasks[focusedRowIndex].id);
      setInlineTitle(viewTasks[focusedRowIndex].title);
      setKeyboardMode('edit');
    } else if (event.key === ' ' && (event.ctrlKey || event.metaKey) && viewTasks[focusedRowIndex]) {
      event.preventDefault();
      const id = viewTasks[focusedRowIndex].id;
      setSelectedTaskIds((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
      setSelectionAnchor(focusedRowIndex);
    } else if (event.key === 'Tab' && keyboardMode === 'outline' && viewTasks[focusedRowIndex]) {
      event.preventDefault();
      void createOutlineChild(viewTasks[focusedRowIndex]);
    }
  }
  const statusSelect = (value: Task, label: string) => <select aria-label={label} value={value.status} onChange={(event) => void updateTaskStatus(value, event.target.value)}>{statuses.map((status) => <option key={status.id} value={status.key}>{status.name}</option>)}</select>;
  const attributeSelect = (value: Task, attribute: Attribute, label: string) => <select aria-label={label} value={String(value.attributes[attribute.id] ?? '')} onChange={(event) => void updateTaskAttribute(value, attribute, event.target.value || null)}><option value="">—</option>{attribute.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select>;
  const attributeEditor = (value: Task, attribute: Attribute) => {
    const label = `${attribute.name} for #${value.number}`;
    const current = value.attributes[attribute.id];
    if (attribute.type === 'single_select') return attributeSelect(value, attribute, label);
    if (attribute.type === 'multi_select') return <select multiple aria-label={label} value={Array.isArray(current) ? current.map(String) : []} onChange={(event) => void updateTaskAttribute(value, attribute, Array.from(event.target.selectedOptions, (option) => option.value))}>{attribute.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select>;
    if (attribute.type === 'user') return <select aria-label={label} value={String(current ?? '')} onChange={(event) => void updateTaskAttribute(value, attribute, event.target.value || null)}><option value="">—</option>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select>;
    const draftKey = `${value.id}:${attribute.id}`;
    const inputType = attribute.type === 'number' || attribute.type === 'date' ? attribute.type : 'text';
    return <input aria-label={label} type={inputType} value={tableAttributeDrafts[draftKey] ?? String(current ?? '')} onChange={(event) => setTableAttributeDrafts((items) => ({ ...items, [draftKey]: event.target.value }))} onBlur={(event) => { if (draftKey in tableAttributeDrafts) { void updateTaskAttribute(value, attribute, event.target.value || null); setTableAttributeDrafts((items) => { const next = { ...items }; delete next[draftKey]; return next; }); } }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
  };
  return <main className="shell app-shell" data-keyboard-mode={keyboardMode}>
    <header><div><p className="eyebrow">WEFT · {workspace?.name.toUpperCase()}</p><h1>{showSkills ? 'Workspace Skills' : activeTab === 'knowledge' ? 'Knowledge' : activeTab === 'proposal' ? 'Proposal' : activeTab === 'my-work' ? 'My work' : 'Tasks'}</h1></div><div className="actions"><button type="button" className="secondary palette-trigger" aria-label="Open command palette" onClick={openPalette}><span aria-hidden="true">⌕</span><span className="desktop-label">Search · ⌘K</span></button><button type="button" className="secondary" aria-label="Keyboard shortcuts" onClick={() => { focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setShortcutHelpOpen(true); }}>Shortcuts</button><span className="count">{tasks.length} tasks</span>{['owner','admin'].includes(workspace?.role ?? '') && <button type="button" className="secondary" onClick={async () => { try { const data = await api<unknown>(`/workspaces/${workspace!.id}/export`); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${workspace!.name}-export.json`; link.click(); URL.revokeObjectURL(url); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not export Workspace.'); } }}>Export JSON</button>}</div></header>
    <nav className="primary-tabs" aria-label="Primary">
      <button type="button" aria-current={activeTab === 'inbox' ? 'page' : undefined} className={activeTab === 'inbox' ? 'selected' : 'secondary'} onClick={() => { setShowSkills(false); setActiveTab('inbox'); setActiveView('all'); }}>Inbox</button>
      <button type="button" aria-current={activeTab === 'my-work' ? 'page' : undefined} className={activeTab === 'my-work' ? 'selected' : 'secondary'} onClick={() => { setShowSkills(false); setActiveTab('my-work'); void showMyWork(); }}>My work</button>
      <button type="button" aria-current={activeTab === 'proposal' ? 'page' : undefined} className={activeTab === 'proposal' ? 'selected' : 'secondary'} onClick={() => { setShowSkills(false); setActiveTab('proposal'); }}>Proposal</button>
      <button type="button" aria-current={activeTab === 'knowledge' ? 'page' : undefined} className={activeTab === 'knowledge' ? 'selected' : 'secondary'} onClick={() => void showKnowledge()}>Knowledge</button>
      <button type="button" aria-current={activeTab === 'more' ? 'page' : undefined} className={activeTab === 'more' ? 'selected' : 'secondary'} aria-expanded={moreOpen} onClick={() => { focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setActiveTab('more'); setMoreOpen(true); }}>More</button>
    </nav>
    {offline && <p className="offline-banner" role="status">Offline mode · previously opened pages remain available; writing is disabled.</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {!showSkills && activeTab === 'proposal' && !task && <section className="task-list app-section" aria-label="Proposal"><h2>Proposal</h2><p className="muted">Proposal review will be available here when its review screen is added.</p></section>}
    {!showSkills && activeTab === 'knowledge' && !task && <section className="task-list app-section knowledge-view" aria-label="Knowledge"><div className="knowledge-vaults"><h2>Knowledge</h2>{vaultError && !selectedVaultId && <p className="notice" role="alert">{vaultError}</p>}{vaults.length === 0 ? <p className="muted">No Vaults are available to read.</p> : <ul>{vaults.map((vault) => <li key={vault.id}><button type="button" aria-label={`Open Vault ${vault.name}`} aria-pressed={selectedVaultId === vault.id} className={selectedVaultId === vault.id ? 'selected' : 'secondary'} onClick={() => void openVaultContents(vault)}><strong>{vault.name}</strong><span className="muted">{vault.visibility}</span></button></li>)}</ul>}</div><div className="knowledge-content">{selectedVaultId ? <><h2>{vaults.find((vault) => vault.id === selectedVaultId)?.name ?? 'Vault contents'}</h2>{vaultError && <p className="notice" role="alert">{vaultError}</p>}<div className="knowledge-reader-layout"><nav aria-label="Vault notes"><ul>{vaultFiles.map((file) => <li key={file}><button type="button" className="link-button" aria-current={readerNote?.path === file ? 'page' : undefined} onClick={() => void openVaultNote(selectedVaultId, file)}>{file}</button></li>)}</ul></nav><div className="knowledge-reader">{readerError && <p className="notice" role="alert">{readerError}</p>}{readerNote ? <><h3>{readerNote.path}</h3>{readerNote.format === 'source' ? <pre className="knowledge-source">{readerNote.source}</pre> : <><div className="knowledge-properties">{Object.entries(readerNote.properties ?? {}).map(([key, value]) => <p key={key}><strong>{key}:</strong> {value}</p>)}{(readerNote.tags ?? []).length > 0 && <p><strong>Tags:</strong> {(readerNote.tags ?? []).map((tag) => `#${tag}`).join(' ')}</p>}</div><article className="knowledge-markdown" onClick={followReaderLink} dangerouslySetInnerHTML={{ __html: readerNote.html ?? '' }} /><section aria-label="Note links"><h4>Links</h4><ul>{(readerNote.links ?? []).map((link, index) => <li key={`${link.target}-${index}`}>{link.target}: {link.resolution.status}{link.resolution.path ? ` · ${link.resolution.path}` : ''}</li>)}</ul></section><section aria-label="Backlinks"><h4>Backlinks</h4>{readerBacklinks.length ? <ul>{readerBacklinks.map((backlink) => <li key={backlink.path}><button type="button" className="link-button" onClick={() => void openVaultNote(selectedVaultId, backlink.path)}>{backlink.title}</button></li>)}</ul> : <p className="muted">No backlinks.</p>}</section><section aria-label="Note history"><h4>History</h4>{readerHistory.length ? <ol>{readerHistory.map((commit) => <li key={commit.id}><strong>{commit.message}</strong><span className="muted"> {commit.author} · {new Date(commit.time).toLocaleString()}</span></li>)}</ol> : <p className="muted">No history yet.</p>}</section></>}</> : vaultFiles.length === 0 ? <p className="muted">No files in this Vault yet.</p> : <p className="muted">Choose a note to read.</p>}</div></div></> : <p className="knowledge-reader-placeholder" aria-label="Note reader">Choose a Vault to read its notes.</p>}</div></section>}
    {!showSkills && moreOpen && <div className="overlay-backdrop sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setMoreOpen(false); setActiveTab('inbox'); restoreFocus(); } }}><section className="more-sheet" role="dialog" aria-modal="true" aria-label="More"><h2>More</h2><button type="button" onClick={() => { setMoreOpen(false); setActiveTab('inbox'); setShowSkills(true); setSelectedSkill(null); setEditingSkill(false); }}>Skills</button><button type="button" className="secondary" onClick={() => { setMoreOpen(false); setActiveTab('inbox'); setShortcutHelpOpen(true); }}>Keyboard shortcuts</button><button type="button" className="secondary" onClick={() => { setMoreOpen(false); setActiveTab('inbox'); restoreFocus(); }}>Close</button></section></div>}
    {showSkills && <section className="skill-browser" aria-label="Workspace Skills"><aside><h2>Skills</h2><ul>{skills.map((skill) => <li key={skill.id}><button type="button" className="link-button" onClick={() => openSkill(skill)}><strong>{skill.name}{!skill.enabled && ' · Disabled'}</strong><span className="muted">{skill.description}</span></button></li>)}</ul>{['owner','admin'].includes(workspace?.role ?? '') && <button type="button" onClick={() => { setSelectedSkill(null); setSkillDraft({ name: '', description: '', body: '' }); setEditingSkill(true); }}>Create Skill</button>}</aside>
      <div className="skill-content">{editingSkill ? <form className="task-form" onSubmit={saveSkill}><h2>{selectedSkill ? 'Edit Skill' : 'New Skill'}</h2><p className="notice">Everyone in this Workspace, including Viewers, and the AI can read enabled Skills. Never include passwords, tokens, or other secrets.</p><label>Name<input value={skillDraft.name} onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })} required /></label><label>Short description<input value={skillDraft.description} onChange={(event) => setSkillDraft({ ...skillDraft, description: event.target.value })} required maxLength={300} /></label><label>Markdown body<textarea rows={16} value={skillDraft.body} onChange={(event) => setSkillDraft({ ...skillDraft, body: event.target.value })} /></label><div className="actions"><button>Save Skill</button><button type="button" className="secondary" onClick={() => setEditingSkill(false)}>Cancel</button></div></form> : selectedSkill ? <article><h2>{selectedSkill.name}{!selectedSkill.enabled && ' · Disabled'}</h2><p className="muted">{selectedSkill.description}</p><div className="skill-markdown">{renderSkillBody(selectedSkill.body ?? '', workspace!.id)}</div>{['owner','admin'].includes(workspace?.role ?? '') && <div className="actions"><button type="button" onClick={() => { setSkillDraft({ name: selectedSkill.name, description: selectedSkill.description, body: selectedSkill.body ?? '' }); setEditingSkill(true); }}>Edit</button><button type="button" className="secondary" onClick={() => void api<Skill>(`/workspaces/${workspace!.id}/skills/${selectedSkill.id}`, { method: 'PATCH', body: JSON.stringify({ expected_version: selectedSkill.version, enabled: !selectedSkill.enabled }) }).then((saved) => { setSelectedSkill({ ...selectedSkill, ...saved }); setSkills((items) => items.map((item) => item.id === saved.id ? saved : item)); }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not update Skill.'))}>{selectedSkill.enabled ? 'Disable' : 'Enable'}</button>{selectedSkill.enabled && <button type="button" className="danger" onClick={() => void archiveSkill()}>Archive</button>}</div>}</article> : <p className="muted">Choose a Skill to read it.</p>}</div>
    </section>}
    {!showSkills && activeTab !== 'proposal' && activeTab !== 'knowledge' && !task && <>
      <nav className="view-nav" aria-label="Task views"><button className={activeView === 'all' ? 'selected' : 'secondary'} onClick={() => setActiveView('all')}>All tasks</button><button className={activeView === 'my-work' ? 'selected' : 'secondary'} onClick={() => void showMyWork()}>My work</button><label>Team queue<select aria-label="Team queue" value={selectedTeam} onChange={(event) => void showTeamQueue(event.target.value)}><option value="">Choose a Team</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label>List<select aria-label="Saved List" value={selectedListId} onChange={(event) => { void openList(event.target.value); if (event.target.value) setActiveView('list'); else setActiveView('all'); }}><option value="">Choose a List</option>{taskLists.map((list) => <option key={list.id} value={list.id}>{list.name} · {list.kind === 'smart' ? 'Smart' : 'Manual'}</option>)}</select></label><button type="button" className={activeView === 'list' ? 'selected' : 'secondary'} disabled={!selectedListId} onClick={() => { if (selectedListId) { setActiveView('list'); void openList(selectedListId); } }}>Open List</button><button type="button" className="secondary" onClick={() => setViewMode('table')}>Table</button><button type="button" className="secondary" onClick={() => setViewMode('kanban')}>Kanban</button></nav>
      <form className="capture" onSubmit={(event) => { event.preventDefault(); void createList('manual'); }}><label className="sr-only" htmlFor="new-list-name">New List name</label><input id="new-list-name" placeholder="New manual List…" value={newListName} onChange={(event) => setNewListName(event.target.value)} required /><button>Create manual List</button><label>Status filter<select aria-label="Smart List Status filter" value={smartStatus} onChange={(event) => setSmartStatus(event.target.value)}><option value="">Any Status</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label><label>Due date<select aria-label="Smart List due date filter" value={smartRelativeDate} onChange={(event) => setSmartRelativeDate(event.target.value)}><option value="">Any date</option><option value="today">Due today</option><option value="overdue">Overdue</option><option value="next_7_days">Due in 7 days</option></select></label><label>Attribute filter<select aria-label="Smart List Attribute" value={smartAttribute} onChange={(event) => { setSmartAttribute(event.target.value); setSmartAttributeValue(''); }}><option value="">No Attribute filter</option>{attributes.map((attribute) => <option key={attribute.id} value={attribute.id}>{attribute.name}</option>)}</select></label>{smartAttribute && <label>Attribute value{attributes.find((attribute) => attribute.id === smartAttribute)?.options.length ? <select aria-label="Smart List Attribute value" value={smartAttributeValue} onChange={(event) => setSmartAttributeValue(event.target.value)}><option value="">Any value</option>{attributes.find((attribute) => attribute.id === smartAttribute)?.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select> : <input aria-label="Smart List Attribute value" value={smartAttributeValue} onChange={(event) => setSmartAttributeValue(event.target.value)} />}</label>}<label><input type="checkbox" checked={smartAssignee} onChange={(event) => setSmartAssignee(event.target.checked)} />Assigned directly to me</label>{smartAssignee && <label><input type="checkbox" checked={smartIncludeTeam} onChange={(event) => setSmartIncludeTeam(event.target.checked)} />Include via Team</label>}<fieldset><legend>Visible columns</legend>{['title','status','priority'].map((column) => <label key={column}><input type="checkbox" checked={smartColumns.includes(column)} onChange={(event) => setSmartColumns((items) => event.target.checked ? [...items, column] : items.filter((item) => item !== column))} />{column}</label>)}{attributes.map((attribute) => { const column = `attribute:${attribute.id}`; return <label key={column}><input type="checkbox" checked={smartColumns.includes(column)} onChange={(event) => setSmartColumns((items) => event.target.checked ? [...items, column] : items.filter((item) => item !== column))} />{attribute.name}</label>; })}</fieldset><label>Combine filters<select aria-label="Smart List filter logic" value={smartLogic} onChange={(event) => setSmartLogic(event.target.value as 'and' | 'or')}><option value="and">Match all (AND)</option><option value="or">Match any (OR)</option></select></label><label>Sort<select aria-label="Smart List sort" value={smartSort} onChange={(event) => setSmartSort(event.target.value)}><option value="number">Task number</option><option value="title">Title</option><option value="due_date">Due date</option></select></label><label>Group<select aria-label="Smart List group" value={smartGroup} onChange={(event) => setSmartGroup(event.target.value)}><option value="">No group</option><option value="status">Status</option><option value="priority">Priority</option></select></label><button type="button" onClick={() => void createList('smart')}>Create Smart List</button></form>
      <form className="capture" onSubmit={createTask}><label className="sr-only" htmlFor="task-title">Task title</label><input id="task-title" placeholder="Add a task…" value={title} onChange={(e) => setTitle(e.target.value)} required /><select aria-label="Project" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)} required><option value="" disabled>Select a Project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button disabled={!selectedProject}>Create task</button></form>
      <form className="capture" role="search" onSubmit={searchTasks}><label className="sr-only" htmlFor="task-search">Search tasks and comments</label><input id="task-search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search tasks and comments…" minLength={1} maxLength={100} /><button type="submit">Search</button></form>{searchCount !== null && <section className="task-list" aria-label="Search results"><h2>{searchCount} search results</h2><ul>{searchResults.map((result) => <li key={result.task_id}><a href={`/w/${workspace!.id}/tasks/${result.task_number}`} onClick={(event) => { event.preventDefault(); const found = tasks.find((item) => item.id === result.task_id); if (found) openPanel(found); else void loadTask(workspace!.id, result.task_number); }}><span className="number">#{result.task_number}</span><strong>{result.title}</strong><span className="muted">{result.snippet}</span></a></li>)}</ul></section>}
      <section className="task-list" aria-label="Tasks">
        <div className="table-heading"><div><h2>{activeView === 'my-work' ? 'My work' : activeView === 'team-queue' ? `${teams.find((team) => team.id === selectedTeam)?.name ?? 'Team'} queue` : activeView === 'list' ? taskLists.find((list) => list.id === selectedListId)?.name ?? 'List' : 'Task Table'}</h2><p className="muted">Browse mode · Enter or F2 edits a title · Shift+Arrow selects a range</p></div><div className="mode-controls" aria-label="Keyboard mode"><button type="button" className={keyboardMode === 'browse' ? 'selected' : 'secondary'} aria-label="Browse mode" aria-pressed={keyboardMode === 'browse'} onClick={() => setKeyboardMode('browse')}>Browse</button><button type="button" className={keyboardMode === 'edit' ? 'selected' : 'secondary'} aria-label="Edit mode" aria-pressed={keyboardMode === 'edit'} onClick={() => setKeyboardMode('edit')}>Edit</button><button type="button" className={keyboardMode === 'outline' ? 'selected' : 'secondary'} aria-label="Outline mode" aria-pressed={keyboardMode === 'outline'} onClick={() => setKeyboardMode('outline')}>Outline</button></div></div>
        {selectedTaskIds.length > 1 && <div className="bulk-actions" aria-label="Bulk actions"><span>{selectedTaskIds.length} selected</span><label>Set status<select aria-label="Set status" defaultValue="" onChange={(event) => { if (event.target.value) void bulkSetStatus(event.target.value); }}><option value="" disabled>Choose a Status</option>{statuses.map((status) => <option key={status.id} value={status.key}>{status.name}</option>)}</select></label>{bulkAttributes.map((attribute) => <label key={attribute.id}>Set {attribute.name}<select aria-label={`Set ${attribute.name}`} defaultValue="" onChange={(event) => { if (event.target.value) void bulkSetAttribute(attribute, event.target.value); }}><option value="" disabled>Choose a value</option>{attribute.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select></label>)}<button type="button" className="secondary" onClick={() => setSelectedTaskIds([])}>Clear selection</button></div>}
        {activeView === 'list' && selectedListId && taskLists.find((list) => list.id === selectedListId)?.kind === 'manual' && <div className="bulk-actions"><button type="button" disabled={!viewTasks[focusedRowIndex]} onClick={() => { const item = viewTasks[focusedRowIndex]; if (item) void changeListMembership(item, false); }}>Remove selected task from List</button><button type="button" disabled={!tasks[focusedRowIndex]} onClick={() => { const item = tasks[focusedRowIndex]; if (item) void changeListMembership(item, true); }}>Add selected task to List</button></div>}
        {viewTasks.length === 0 ? <p className="muted">No tasks in this view.</p> : viewMode === 'kanban' ? <div className="kanban-board" aria-label="Kanban board grouped by Status">{statuses.map((status, columnIndex) => <section key={status.id} className="kanban-column" aria-label={`${status.name} column`}><div className="kanban-heading"><h3>{status.name} <span className="count">{viewTasks.filter((item) => item.status === status.key).length}</span></h3>{['owner','admin'].includes(workspace?.role ?? '') && <span className="kanban-column-controls"><button type="button" className="secondary" aria-label={`Move ${status.name} column left`} disabled={columnIndex === 0} onClick={() => void moveKanbanColumn(status.id, -1)}>←</button><button type="button" className="secondary" aria-label={`Move ${status.name} column right`} disabled={columnIndex === statuses.length - 1} onClick={() => void moveKanbanColumn(status.id, 1)}>→</button></span>}</div>{viewTasks.filter((item) => item.status === status.key).map((item) => <button type="button" key={item.id} className="kanban-card" aria-label={`Task #${item.number}, ${item.title}, ${status.name}`} onClick={() => openPanel(item)} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = statuses[columnIndex + (event.key === 'ArrowRight' ? 1 : -1)]; if (next) void updateTaskStatus(item, next.key); } }}><span className="number">#{item.number}</span><strong>{item.title}</strong><span className="muted">{item.priority}</span></button>)}</section>)}</div> : <div className="table-scroll" onScroll={(event) => { const next = Math.floor(event.currentTarget.scrollTop / 58); if (Math.abs(next - virtualStart) > 3) setVirtualStart(Math.min(next, Math.max(0, viewTasks.length - 30))); }}><div role="grid" aria-label="Tasks" aria-rowcount={viewTasks.length + 1} aria-activedescendant={`task-row-${viewTasks[focusedRowIndex]?.id ?? ''}`} tabIndex={0} ref={gridRef} onKeyDown={handleGridKeyDown}>
          <div role="row" className="table-row table-header">{showColumn('title') && <span role="columnheader">Task</span>}{showColumn('status') && <span role="columnheader">Status</span>}{showColumn('priority') && <span role="columnheader">Priority</span>}{attributes.filter((attribute) => selectedColumns.includes(`attribute:${attribute.id}`) && viewTasks.some((item) => attribute.project_ids?.includes(item.project_id))).map((attribute) => <span role="columnheader" key={attribute.id}>{attribute.name}</span>)}</div>
          {virtualStart > 0 && <div aria-hidden="true" style={{ height: virtualStart * 58 }} />}
          {visibleTasks.map((item, offset) => {
            const index = virtualStart + offset;
            const depth = taskDepth(item);
            const editable = editingTaskId === item.id;
            return <div role="row" id={`task-row-${item.id}`} aria-selected={selectedTaskIds.includes(item.id)} aria-label={`#${item.number} ${item.title}`} key={item.id} className={`table-row ${selectedTaskIds.includes(item.id) ? 'row-selected' : ''} ${index === focusedRowIndex ? 'row-focused' : ''}`} onClick={(event) => { if (event.target instanceof HTMLElement && event.target.closest('select,input,button')) return; focusRow(index); }}>
              {showColumn('title') && <div role="gridcell" className="table-task" style={{ paddingLeft: `${16 + depth * 24}px` }}><span className="number">#{item.number}</span>{editable ? <input aria-label={`Edit title for #${item.number}`} autoFocus value={inlineTitle} onChange={(event) => setInlineTitle(event.target.value)} onBlur={() => { if (!inlineTitle.trim()) setInlineTitle(item.title); }} /> : <button type="button" className="table-task-title" onClick={() => { focusRow(index); openPanel(item); }}><strong>{item.title}</strong></button>}</div>}
              {showColumn('status') && <div role="gridcell" onClick={() => focusRow(index)}>{statusSelect(item, `Status for #${item.number}`)}</div>}
              {showColumn('priority') && <div role="gridcell">{item.priority}</div>}
              {attributes.filter((attribute) => selectedColumns.includes(`attribute:${attribute.id}`) && attribute.project_ids?.includes(item.project_id)).map((attribute) => <div role="gridcell" key={attribute.id}>{attributeEditor(item, attribute)}</div>)}
            </div>;
          })}
          {virtualEnd < viewTasks.length && <div aria-hidden="true" style={{ height: (viewTasks.length - virtualEnd) * 58 }} />}
        </div></div>}
      </section>
      {(workspace?.role === 'owner' || workspace?.role === 'admin') && <section className="team-admin" aria-label="Team management"><h2>Teams</h2><form className="capture" onSubmit={createTeam}><label className="sr-only" htmlFor="team-name">New Team name</label><input id="team-name" value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="New Team name" required /><button>Create Team</button></form>{teams.length === 0 ? <p className="muted">No Teams yet.</p> : teams.map((team) => <details key={team.id} onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) void loadTeamMembers(team); }}><summary>{team.name}</summary><div className="team-actions"><button className="secondary" onClick={() => void renameTeam(team)}>Rename</button><button className="danger" onClick={() => void deleteTeam(team)}>Delete Team</button></div><form className="capture" onSubmit={(event) => { event.preventDefault(); const memberId = teamMemberDrafts[team.id]; if (memberId) void changeTeamMember(team, memberId, true); }}><label>Add member<select aria-label={`Add member to ${team.name}`} value={teamMemberDrafts[team.id] ?? ''} onChange={(event) => setTeamMemberDrafts((drafts) => ({ ...drafts, [team.id]: event.target.value }))}><option value="">Choose a Workspace member</option>{members.filter((member) => !teamMembers[team.id]?.some((item) => item.id === member.id)).map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select></label><button disabled={!teamMemberDrafts[team.id]}>Add</button></form><ul>{(teamMembers[team.id] ?? []).map((member) => <li key={member.id}><span>{member.email}</span><button className="link-button" onClick={() => void changeTeamMember(team, member.id, false)}>Remove</button></li>)}</ul></details>)}</section>}
    </>}
    {!showSkills && task && draft && <section className={`task-detail ${fullPage ? 'full-page' : 'side-panel'}`} aria-label={`Task #${task.number}`}><div className="detail-top"><span className="number">#{task.number}</span><div><a href={taskUrl(task)} onClick={(event) => { event.preventDefault(); history.pushState({}, '', taskUrl(task)); setFullPage(true); }}>Open full page</a>{fullPage ? <button className="link-button" onClick={closeTaskPanel}>Back to list</button> : <button type="button" className="link-button" onClick={closeTaskPanel}>Close task</button>}</div></div>
      <form onSubmit={saveTask} className="task-form"><label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label><label>Description <span className="muted">Markdown</span><textarea rows={6} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label><div className="form-grid"><label>Status<select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{statuses.map((status) => <option key={status.id} value={status.key}>{status.name}</option>)}</select></label><label>Priority<select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>{['low','normal','high','urgent'].map((p) => <option key={p}>{p}</option>)}</select></label>{taskAttributes.map((attribute) => <label key={attribute.id}>{attribute.name}{attribute.type === 'single_select' || attribute.type === 'multi_select' ? <select aria-label={attribute.name} multiple={attribute.type === 'multi_select'} value={attribute.type === 'multi_select' ? (Array.isArray(attributeDraft[attribute.id]) ? attributeDraft[attribute.id] as string[] : []) : String(attributeDraft[attribute.id] ?? '')} onChange={(event) => setAttributeDraft((current) => ({ ...current, [attribute.id]: attribute.type === 'multi_select' ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value || null }))}>{attribute.type === 'single_select' && <option value="">—</option>}{attributes.find((item) => item.id === attribute.id)?.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select> : attribute.type === 'user' ? <select aria-label={attribute.name} value={String(attributeDraft[attribute.id] ?? '')} onChange={(event) => setAttributeDraft((current) => ({ ...current, [attribute.id]: event.target.value || null }))}><option value="">—</option>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select> : <input aria-label={attribute.name} type={attribute.type === 'number' || attribute.type === 'date' ? attribute.type : 'text'} value={String(attributeDraft[attribute.id] ?? '')} onChange={(event) => setAttributeDraft((current) => ({ ...current, [attribute.id]: event.target.value || null }))} />}</label>)}<label>Start date<input type="date" value={draft.start_date ?? ''} onChange={(e) => setDraft({ ...draft, start_date: e.target.value || null })} /></label><label>Due date<input type="date" value={draft.due_date ?? ''} onChange={(e) => setDraft({ ...draft, due_date: e.target.value || null })} /></label></div><label>Watchers<select multiple size={Math.min(Math.max(members.length, 2), 5)} value={draft.watchers} onChange={(e) => setDraft({ ...draft, watchers: Array.from(e.target.selectedOptions, (option) => option.value) })}>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select><span className="muted">Use Ctrl or Command to select multiple people.</span></label><label>Assignees<select multiple size={Math.min(Math.max(members.length + teams.length, 2), 6)} value={draft.assignees.map(({ type, id }) => `${type}:${id}`)} onChange={(e) => setDraft({ ...draft, assignees: Array.from(e.target.selectedOptions, (option) => { const [type, id] = option.value.split(':'); return { type: type as 'user' | 'team', id, name: option.textContent ?? '' }; }) })}>{members.map((member) => <option key={`user:${member.id}`} value={`user:${member.id}`}>{member.email}</option>)}{teams.map((team) => <option key={`team:${team.id}`} value={`team:${team.id}`}>@{team.name}</option>)}</select><span className="muted">Assignees do not receive access from assignment.</span></label><label>Move to Project<select value={moveTarget} onChange={(e) => { setMoveTarget(e.target.value); setPreview(null); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.visibility}</option>)}</select></label>{moveTarget !== task.project_id && <div className="move-preview"><button type="button" className="secondary" onClick={previewMove}>Preview move effects</button>{preview && <div role="status"><strong>Review before confirming</strong><p>Destination is {preview.destination_visibility}; {preview.subtasks_affected} subtasks and {preview.relations_affected} relations are affected.</p><p>Destination members: {preview.destination_members.length}. Save task to confirm this move.</p></div>}</div>}
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
      <section className="task-structure" aria-label="Comments"><h2>Comments</h2>{comments.map((comment) => <article key={comment.id} className="comment"><p>{comment.body}{comment.edited && <span className="muted"> · edited</span>}</p><div className="actions"><button type="button" className="secondary" onClick={() => { setEditingComment(comment.id); setCommentBody(comment.body); }}>Edit</button><button type="button" className="danger" onClick={() => void deleteComment(comment.id)}>Delete</button></div></article>)}<form className="inline-form" onSubmit={saveComment}><label className="sr-only" htmlFor="comment-body">Markdown comment</label><textarea id="comment-body" rows={4} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Write a Markdown comment…" required /><button type="submit">{editingComment ? 'Save edit' : 'Comment'}</button>{editingComment && <button type="button" className="secondary" onClick={() => { setEditingComment(null); setCommentBody(''); }}>Cancel</button>}</form></section>
      <p className="muted">Stable URL: <code>{taskUrl(task)}</code> · version {task.version}</p>
    </section>}
    {!showSkills && paletteOpen && <div className="overlay-backdrop palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closePalette(); }}><section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><label className="sr-only" htmlFor="command-search">Search tasks and commands</label><input id="command-search" ref={paletteInputRef} role="searchbox" aria-label="Search tasks and commands" placeholder="Search tasks or type a command…" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void runPaletteCommand(); } }} /><p className="muted">Search tasks by title or number. Commands: create &lt;title&gt;, status &lt;name&gt;.</p><div className="palette-results" role="listbox" aria-label="Palette results">
      {paletteQuery.trim().match(/^create(?:\s+.+)?$/i) && <button type="button" role="option" onClick={() => void runPaletteCommand()}><strong>Create task</strong><span className="muted">{paletteQuery.trim().replace(/^create\s*/i, '') || 'New task'}</span></button>}
      {paletteQuery.trim().match(/^status\s+.+$/i) && statuses.filter((status) => `${status.key} ${status.name}`.toLowerCase().includes(paletteQuery.trim().replace(/^status\s+/i, '').toLowerCase())).map((status) => <button type="button" role="option" key={status.id} onClick={() => void runPaletteCommand()}><strong>Set status to {status.name}</strong><span className="muted">Task #{viewTasks[focusedRowIndex]?.number ?? '—'}</span></button>)}
      {paletteQuery.trim().match(/^column\s+move\s+.+\s+(left|right)$/i) && <button type="button" role="option" onClick={() => void runPaletteCommand()}><strong>{paletteQuery.trim()}</strong><span className="muted">Reorder a Kanban Status column</span></button>}
      {paletteResults.map((item) => <button type="button" role="option" key={item.id} onClick={() => { closePalette(false); openPanel(item); }}><span className="number">#{item.number}</span><strong>{item.title}</strong><span className="muted">{statuses.find((status) => status.key === item.status)?.name ?? item.status}</span></button>)}
      {paletteResults.length === 0 && !paletteQuery.trim().match(/^(?:create|status)\b/i) && <p className="muted">No matching tasks.</p>}
      </div><div className="palette-footer"><button type="button" className="secondary" onClick={() => closePalette()}>Close · Esc</button></div></section></div>}
    {!showSkills && shortcutHelpOpen && <div className="overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShortcutHelpOpen(false); restoreFocus(); } }}><section className="shortcut-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><h2>Keyboard shortcuts</h2><dl><dt>Enter or F2</dt><dd>Edit the selected task title</dd><dt>Escape</dt><dd>Cancel an edit or close an overlay</dd><dt>Shift + Arrow</dt><dd>Select a range of tasks</dd><dt>Tab</dt><dd>Move between controls; create a subtask only in Outline mode</dd><dt>Ctrl/⌘ + K</dt><dd>Open task search and commands</dd><dt>Ctrl/⌘ + Z</dt><dd>Undo the last change</dd><dt>Ctrl/⌘ + Shift + Z</dt><dd>Redo the last change</dd><dt>B, E, O</dt><dd>Switch between Browse, Edit and Outline modes</dd><dt>Thai IME</dt><dd>Single-letter shortcuts pause while text is composing</dd></dl><button type="button" onClick={() => { setShortcutHelpOpen(false); restoreFocus(); }}>Close shortcuts</button></section></div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
