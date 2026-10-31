import React from 'react';
import { defaultFocusPrompt, loadAiAvailability, runGeneration, runStateLabel, type AiAvailability, type AiCapability, type AiFocusTask, type GenerationContext, type RunNotes } from './generate';
import { calendarCommands, useCalendar } from './calendar';
import { applyRegeneratedRow, mergeItems, rejectItem, rowName, itemName, untickBrokenLinks } from './proposal-review';
import { scheduleCommands, useScheduleAdmin } from './schedules';
import { timelineCommands, useTimeline, type TimelineTask } from './timeline';
import { api, clearClientCaches, csrf, isTextEntryTarget, COMMAND_PREFIX, MAX_ATTACHMENT_BYTES, MAX_COMMENT_ATTACHMENTS, MAX_TASK_ATTACHMENT_BYTES } from './api';
import type { Assignee, TaskSort, ViewSettings, Workspace, Skill, Project, Vault, ReaderNote, Member, ChecklistItem, TaskRelation, Task, Team, TeamGrant, MovePreview, Status, Attribute, TaskAttribute, Comment, MentionSuggestion, InboxEntry, WatchPreferences, TimelineItem, ReferenceSuggestion, Backlink, SearchResult, KnowledgeResult, TaskList, ProposalItem, Proposal } from './types';
import { t } from './i18n';
import { applySort, treeOrder, sortQuery, DEFAULT_COLUMNS, COLUMN_ALIASES } from './task-order';

const CORE_KEYS = ['title', 'description', 'status', 'priority', 'start_date', 'due_date'] as const;

/** True when the draft differs from the saved Task in a field the autosave writes (including Attribute values). */
export function taskIsDirty(task: Task, draft: Task, attributes: TaskAttribute[], attributeDraft: Record<string, unknown>) {
  if (CORE_KEYS.some((key) => (draft[key] ?? null) !== (task[key] ?? null))) return true;
  if (JSON.stringify(draft.assignees.map(({ type, id }) => `${type}:${id}`).sort()) !== JSON.stringify(task.assignees.map(({ type, id }) => `${type}:${id}`).sort())) return true;
  return attributes.some((attribute) => {
    const raw = attributeDraft[attribute.id] ?? null;
    const next = attribute.type === 'number' && raw !== null && raw !== '' ? Number(raw) : raw;
    return JSON.stringify(next) !== JSON.stringify(attribute.value ?? null);
  });
}

const WINDOW = 40;
export const ROW_HEIGHT = 44;
export const HEADER_HEIGHT = 34;
export const ROW_WINDOW = WINDOW;

export function useAppState() {
  const [workspace, setWorkspace] = React.useState<Workspace | null>(null);
  const [workspaceChoices, setWorkspaceChoices] = React.useState<Workspace[]>([]);
  const [needsWorkspaceChoice, setNeedsWorkspaceChoice] = React.useState(false);
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
  const [inboxEntries, setInboxEntries] = React.useState<InboxEntry[]>([]);
  const [watchPreferences, setWatchPreferences] = React.useState<WatchPreferences | null>(null);
  const [taskLists, setTaskLists] = React.useState<TaskList[]>([]);
  const [selectedListId, setSelectedListId] = React.useState('');
  const [viewMode, setViewMode] = React.useState<'table' | 'kanban' | 'calendar' | 'timeline'>('table');
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
  const [importJson, setImportJson] = React.useState('[\n  { "project_id": "", "title": "" }\n]');
  const [importPreview, setImportPreview] = React.useState<{ preview_id: string; results: { index: number; status: string; reason?: string }[] } | null>(null);
  const [importMessage, setImportMessage] = React.useState('');
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
  const [taskFromComment, setTaskFromComment] = React.useState<{ comment: Comment; title: string; description: string; project_id: string; request_id?: string } | null>(null);
  const [commentBody, setCommentBody] = React.useState('');
  const [commentFiles, setCommentFiles] = React.useState<File[]>([]);
  const commentDraft = React.useRef<{ requestId: string; savedId?: string; savedBody?: string; uploaded: Set<string> } | null>(null);
  const [referenceSuggestions, setReferenceSuggestions] = React.useState<ReferenceSuggestion[]>([]);
  const [mentionSuggestions, setMentionSuggestions] = React.useState<MentionSuggestion[]>([]);
  const [referenceSuggestionIndex, setReferenceSuggestionIndex] = React.useState(0);
  const [noteReferenceSuggestions, setNoteReferenceSuggestions] = React.useState<KnowledgeResult[]>([]);
  const [noteReferenceSuggestionIndex, setNoteReferenceSuggestionIndex] = React.useState(0);
  const [discussionFilter, setDiscussionFilter] = React.useState<'all' | 'discussion' | 'changes'>('all');
  const [replyToComment, setReplyToComment] = React.useState<string | null>(null);
  const [timelineItems, setTimelineItems] = React.useState<TimelineItem[]>([]);
  const [backlinks, setBacklinks] = React.useState<Backlink[]>([]);
  const commentInput = React.useRef<HTMLTextAreaElement>(null);
  const [editingComment, setEditingComment] = React.useState<string | null>(null);
  // A draft belongs to one posted comment: it is dropped when the Task, the edited comment or the reply
  // target changes, and when the box is cleared, so a different comment typed afterwards is posted as
  // a new one instead of overwriting the one already saved.
  React.useEffect(() => { commentDraft.current = null; }, [task?.id, editingComment, replyToComment]);
  React.useEffect(() => { if (!commentBody.trim()) commentDraft.current = null; }, [commentBody]);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([]);
  const [searchCount, setSearchCount] = React.useState<number | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = React.useState('');
  const [knowledgeResults, setKnowledgeResults] = React.useState<KnowledgeResult[]>([]);
  const [knowledgeCount, setKnowledgeCount] = React.useState<number | null>(null);
  const [knowledgeIndexing, setKnowledgeIndexing] = React.useState(false);
  const [knowledgeSearchError, setKnowledgeSearchError] = React.useState('');
  const [keyboardMode, setKeyboardMode] = React.useState<'browse' | 'edit' | 'outline'>('browse');
  const [focusedRowIndex, setFocusedRowIndex] = React.useState(0);
  const [selectedTaskIds, setSelectedTaskIds] = React.useState<string[]>([]);
  const [selectionAnchor, setSelectionAnchor] = React.useState<number | null>(null);
  const [editingTaskId, setEditingTaskId] = React.useState<string | null>(null);
  const [inlineTitle, setInlineTitle] = React.useState('');
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [milestoneEpoch, setMilestoneEpoch] = React.useState(0);
  const [savingMilestone, setSavingMilestone] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<'inbox' | 'tasks' | 'proposal' | 'blockers' | 'overview' | 'knowledge' | 'milestones' | 'settings'>('tasks');
  const [newTaskOpen, setNewTaskOpen] = React.useState(false);
  const [newListOpen, setNewListOpen] = React.useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = React.useState(false);
  const [teamsOpen, setTeamsOpen] = React.useState(false);
  const [projectFilter, setProjectFilter] = React.useState('');
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [taskMoreOpen, setTaskMoreOpen] = React.useState(false);
  const savingRef = React.useRef(false);
  const failedDraft = React.useRef('');
  const gPending = React.useRef(0);
  const [templatesOpen, setTemplatesOpen] = React.useState(false);
  const [exportNotice, setExportNotice] = React.useState('');
  const [proposal, setProposal] = React.useState<Proposal | null>(null);
  const [proposalStale, setProposalStale] = React.useState(false);
  const [proposalBusy, setProposalBusy] = React.useState(false);
  const [proposalApplying, setProposalApplying] = React.useState(false);
  const [proposalMessage, setProposalMessage] = React.useState('');
  const [proposalDetail, setProposalDetail] = React.useState<string | null>(null);
  const [aiAvailability, setAiAvailability] = React.useState<AiAvailability>({ status: 'loading' });
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [generateGoal, setGenerateGoal] = React.useState('');
  const [generateCapability, setGenerateCapability] = React.useState<AiCapability>('generate');
  const [generateFocus, setGenerateFocus] = React.useState<AiFocusTask | null>(null);
  const [generation, setGeneration] = React.useState<GenerationContext | null>(null);
  const [runNotes, setRunNotes] = React.useState<RunNotes | null>(null);
  const proposalRef = React.useRef<Proposal | null>(null);
  const focusReview = React.useRef(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [offline, setOffline] = React.useState(!navigator.onLine);
  const [realtimeConnected, setRealtimeConnected] = React.useState(false);
  const [liveTick, setLiveTick] = React.useState(0);
  const [settingsSection, setSettingsSection] = React.useState<{ section: 'ai-schedules'; nonce: number } | undefined>(undefined);
  const [paletteQuery, setPaletteQuery] = React.useState('');
  const [paletteSearchResults, setPaletteSearchResults] = React.useState<SearchResult[]>([]);
  const [paletteSearchError, setPaletteSearchError] = React.useState('');
  const [paletteNoteResults, setPaletteNoteResults] = React.useState<KnowledgeResult[]>([]);
  const [shortcutHelpOpen, setShortcutHelpOpen] = React.useState(false);
  const [virtualStart, setVirtualStart] = React.useState(0);
  const [sort, setSort] = React.useState<TaskSort | null>(null);
  const sortRef = React.useRef<TaskSort | null>(null);
  sortRef.current = sort;
  const [viewColumns, setViewColumns] = React.useState<string[] | null>(null);
  const [creatingRow, setCreatingRow] = React.useState(false);
  const [creatingInColumn, setCreatingInColumn] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const [detailTab, setDetailTab] = React.useState<'chat' | 'description'>('chat');
  const [attributeDialogOpen, setAttributeDialogOpen] = React.useState(false);
  const [newTaskDraft, setNewTaskDraft] = React.useState<{ status: string; assignees: Assignee[]; lists: string[]; parent: string; due: string; attrs: Record<string, unknown> }>({ status: '', assignees: [], lists: [], parent: '', due: '', attrs: {} });
  const pendingFocusId = React.useRef<string | null>(null);
  const clearLocalSession = React.useCallback(() => {
    localStorage.removeItem('weft-workspace-id');
    setWorkspace(null); setWorkspaceChoices([]); setNeedsWorkspaceChoice(false); setSignedIn(false); setActiveTab('tasks'); setMoreOpen(false); setTask(null); setDraft(null); setProposal(null); setProposalStale(false);
    setWatchPreferences(null); setInboxEntries([]);
    void clearClientCaches();
  }, []);
  const composing = React.useRef(false);
  const taskRef = React.useRef<Task | null>(null);
  // Comment lists are fetched from several places; only the newest request may write, so a slower older response never hides a comment or reaction a newer one already showed.
  const commentsSeq = React.useRef(0);
  const draftRef = React.useRef<Task | null>(null);
  const taskAttributesRef = React.useRef<TaskAttribute[]>([]);
  const attributeDraftRef = React.useRef<Record<string, unknown>>({});
  const focusReturn = React.useRef<HTMLElement | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const paletteInputRef = React.useRef<HTMLInputElement>(null);

  const taskAppendEpoch = React.useRef(0);
  const appendTask = React.useCallback((created: Task) => {
    taskAppendEpoch.current += 1;
    setTasks((items) => [...items, created]);
  }, []);
  // Overlapping refreshes finish in any order: only the newest one may write, so a slow older snapshot never replaces newer data.
  const [projectsLoadedFor, setProjectsLoadedFor] = React.useState('');
  const refreshSeq = React.useRef(0);
  const refresh = React.useCallback(async (workspaceId: string) => {
    const epochAtStart = taskAppendEpoch.current;
    const ticket = ++refreshSeq.current;
    const [projectResult, taskResult, memberResult, teamResult, myWorkResult, skillResult, statusResult, attributeResult, listResult, vaultResult, inboxResult] = await Promise.all([
      api<{ projects: Project[] }>(`/workspaces/${workspaceId}/projects`),
      api<{ tasks: Task[] }>(`/workspaces/${workspaceId}/tasks${sortQuery(sortRef.current)}`),
      api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`),
      api<{ teams: Team[] }>(`/workspaces/${workspaceId}/teams`),
      api<{ direct_tasks: Task[]; via_team_tasks: Task[] }>(`/workspaces/${workspaceId}/my-work`),
      api<{ skills: Skill[] }>(`/workspaces/${workspaceId}/skills`),
      api<{ statuses: Status[] }>(`/workspaces/${workspaceId}/statuses`),
      api<{ attributes: Attribute[] }>(`/workspaces/${workspaceId}/attributes`),
      api<{ lists: TaskList[] }>(`/workspaces/${workspaceId}/lists`),
      api<{ vaults: Vault[] }>(`/workspaces/${workspaceId}/vaults`),
      api<{ entries: InboxEntry[] }>(`/workspaces/${workspaceId}/inbox`),
    ]);
    if (ticket !== refreshSeq.current) return;
    setProjects(projectResult.projects);
    setProjectsLoadedFor(workspaceId);
    // A Task appended locally while this fetch was in flight is missing from its snapshot; applying it would drop that row.
    if (epochAtStart === taskAppendEpoch.current) setTasks(taskResult.tasks);
    else void refresh(workspaceId).catch(() => undefined);
    setInboxEntries(inboxResult.entries);
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

  // `reloadOf` marks a background reload of the open Task: its result is dropped when that Task was closed or replaced
  // while the fetches were in flight, so a stale reload never reopens a Task over a Proposal review or another Task.
  const loadTask = React.useCallback(async (workspaceId: string, number: number, reloadOf?: string) => {
    const loaded = await api<Task>(`/workspaces/${workspaceId}/tasks/${number}`);
    const watch = await api<WatchPreferences>(`/tasks/${loaded.id}/watch`);
    const values = await api<{ attributes: TaskAttribute[] }>(`/tasks/${loaded.id}/attributes`);
    const commentsTicket = ++commentsSeq.current;
    const discussion = await api<{ comments: Comment[] }>(`/tasks/${loaded.id}/comments`);
    const backlinkResult = await api<{ references: Backlink[] }>(`/tasks/${loaded.id}/references`);
    if (reloadOf !== undefined && taskRef.current?.id !== reloadOf) return;
    setWatchPreferences(watch);
    if (commentsTicket === commentsSeq.current) setComments(discussion.comments);
    setBacklinks(backlinkResult.references);
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
      if (commentsTicket === commentsSeq.current) setComments(discussion.comments);
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
    proposalRef.current = proposal;
    if (focusReview.current && proposal && activeTab === 'proposal') {
      const first = document.querySelector<HTMLElement>('.proposal-screen input[type="checkbox"]');
      if (first) { first.focus(); focusReview.current = false; }
    }
  });

  React.useEffect(() => {
    if (!task) { setTimelineItems([]); return; }
    let active = true;
    void Promise.all([
      api<{ items: TimelineItem[] }>(`/tasks/${task.id}/activity?filter=${discussionFilter}`),
      // The activity feed names a change; History carries the old and new value, so the chat can show what changed.
      api<{ operations: { id: string; before: unknown; after: unknown }[] }>(`/tasks/${task.id}/history`).catch(() => ({ operations: [] })),
    ]).then(([result, historyResult]) => {
      if (!active) return;
      const values = new Map(historyResult.operations.map((operation) => [operation.id, operation]));
      setTimelineItems(result.items.map((item) => item.kind === 'change' && values.has(item.id) ? { ...item, before: values.get(item.id)?.before, after: values.get(item.id)?.after } : item));
    }).catch(() => { if (active) setTimelineItems([]); });
    return () => { active = false; };
  }, [task?.id, task?.version, discussionFilter, comments]);

  React.useEffect(() => {
    if (!workspace) { setAiAvailability({ status: 'loading' }); return; }
    let active = true;
    void loadAiAvailability(api, workspace.id).then((value) => { if (active) setAiAvailability(value); });
    return () => { active = false; };
  }, [workspace?.id]);

  React.useEffect(() => {
    window.addEventListener('weft:unauthorized', clearLocalSession);
    return () => window.removeEventListener('weft:unauthorized', clearLocalSession);
  }, [clearLocalSession]);

  React.useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/service-worker.js');
    const pathTask = location.pathname.match(/^\/w\/([^/]+)\/tasks\/(\d+)$/);
    void api<{ user_id: string; workspaces: Workspace[] }>('/auth/me').then(async (me) => {
      if (me.workspaces.length === 0) return;
      setSignedIn(true); setWorkspaceChoices(me.workspaces);
      const remembered = localStorage.getItem('weft-workspace-id');
      const found = me.workspaces.find((item) => item.id === remembered) ?? (me.workspaces.length === 1 ? me.workspaces[0] : null);
      if (!found) { setNeedsWorkspaceChoice(true); return; }
      setWorkspace(found); setNeedsWorkspaceChoice(false);
      await refresh(found.id);
      if (pathTask && pathTask[1] === found.id) await loadTask(pathTask[1], Number(pathTask[2]));
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

  React.useLayoutEffect(() => {
    // Layout effect: a deferred focus would land after the user (or a test) already moved focus inside the palette.
    if (paletteOpen) paletteInputRef.current?.focus();
  }, [paletteOpen]);

  React.useEffect(() => {
    const query = paletteQuery.trim();
    if (!paletteOpen || !workspace || query.length < 2) {
      setPaletteNoteResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api<{ results: KnowledgeResult[] }>(`/workspaces/${workspace.id}/knowledge/names?q=${encodeURIComponent(query)}`)
        .then((result) => { if (active) setPaletteNoteResults(result.results); })
        .catch(() => { if (active) setPaletteNoteResults([]); });
    }, 120);
    return () => { active = false; window.clearTimeout(timer); };
  }, [paletteOpen, paletteQuery, workspace]);

  React.useEffect(() => {
    const query = paletteQuery.trim();
    if (!paletteOpen || !workspace || query.length === 0 || COMMAND_PREFIX.test(query)) {
      setPaletteSearchResults([]);
      setPaletteSearchError('');
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api<{ results: SearchResult[] }>(`/workspaces/${workspace.id}/search?q=${encodeURIComponent(query)}&limit=8`)
        .then((result) => { if (active) { setPaletteSearchResults(result.results); setPaletteSearchError(''); } })
        .catch((reason) => { if (active) { setPaletteSearchResults([]); setPaletteSearchError(reason instanceof Error ? reason.message : 'Could not search tasks and comments.'); } });
    }, 120);
    return () => { active = false; window.clearTimeout(timer); };
  }, [paletteOpen, paletteQuery, workspace]);

  React.useEffect(() => {
    const updateOnlineState = () => setOffline(!navigator.onLine);
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    return () => {
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
    };
  }, []);

  React.useEffect(() => {
    if (!workspace || !signedIn || !('EventSource' in window)) { setRealtimeConnected(false); return; }
    let active = true;
    let cursor = 0;
    let source: EventSource | null = null;
    const connect = () => void api<{ cursor: number }>(`/workspaces/${workspace.id}/realtime/snapshot`).then((snapshot) => {
      if (!active) return;
      cursor = snapshot.cursor;
      source = new EventSource(`/api/v1/workspaces/${workspace.id}/realtime/events?after=${cursor}`, { withCredentials: true });
      source.onopen = () => {
        setRealtimeConnected(true);
        setMilestoneEpoch((value) => value + 1);
        setLiveTick((tick) => tick + 1);
        void refresh(workspace.id).catch(() => setRealtimeConnected(false));
        const open = taskRef.current;
        if (open) void loadTask(workspace.id, open.number, open.id).catch(() => {
          if (taskRef.current?.id !== open.id) return;
          setTask(null); setDraft(null); setComments([]); setTaskAttributes([]); setTasks((items) => items.filter((item) => item.id !== taskRef.current?.id));
        });
      };
      source.onerror = () => setRealtimeConnected(false);
      // Events are hints to reconcile against the server, never patches to append: a replayed or
      // duplicate event id is ignored, and one refresh covers a burst.
      let lastEventId = 0;
      let pending = false;
      const reconcile = () => {
        if (pending) return;
        pending = true;
        window.setTimeout(() => {
          pending = false;
          if (!active) return;
          setMilestoneEpoch((value) => value + 1);
          setLiveTick((tick) => tick + 1);
          void refresh(workspace.id).catch(() => setRealtimeConnected(false));
          const open = taskRef.current;
          if (open) void loadTask(workspace.id, open.number, open.id).catch(() => {
            const hidden = taskRef.current?.id;
            if (hidden !== open.id) return;
            setTask(null); setDraft(null); setComments([]); setTaskAttributes([]);
            if (hidden) setTasks((items) => items.filter((item) => item.id !== hidden));
          });
        }, 50);
      };
      source.addEventListener('change', (event) => {
        const id = Number((event as MessageEvent<string> & { lastEventId: string }).lastEventId) || 0;
        if (id && id <= lastEventId) return;
        if (id) lastEventId = id;
        setRealtimeConnected(true);
        reconcile();
      });
      source.addEventListener('scope_granted', reconcile);
      // The cursor is older than the server's retention: drop the stream and start from a snapshot.
      source.addEventListener('snapshot_required', () => { source?.close(); connect(); });
      source.addEventListener('scope_revoked', (event) => {
        const scope = JSON.parse((event as MessageEvent<string>).data || '{}') as { workspace?: boolean; project_ids?: string[] };
        if (scope.workspace) {
          source?.close(); setRealtimeConnected(false); setTasks([]); setComments([]); setTask(null); setDraft(null); setTaskAttributes([]); setWorkspace(null); setWorkspaceChoices([]); setSignedIn(false);
          void clearClientCaches();
          return;
        }
        const lost = new Set(scope.project_ids ?? []);
        setTasks((items) => items.filter((item) => !lost.has(item.project_id)));
        if (taskRef.current && lost.has(taskRef.current.project_id)) { setTask(null); setDraft(null); setComments([]); setTaskAttributes([]); }
        void clearClientCaches();
        reconcile();
      });
    }).catch(() => setRealtimeConnected(false));
    connect();
    return () => { active = false; source?.close(); setRealtimeConnected(false); };
  }, [workspace?.id, signedIn, refresh, loadTask]);

  React.useEffect(() => { taskRef.current = task; draftRef.current = draft; taskAttributesRef.current = taskAttributes; attributeDraftRef.current = attributeDraft; });

  // The Project whose view settings (visible columns, sort) this table keeps: the filtered Project, else the first one.
  const viewProjectId = projectFilter || projects[0]?.id || '';
  const lastSortKey = React.useRef('manual:asc');
  React.useEffect(() => {
    if (!workspace || !viewProjectId) return;
    let active = true;
    void api<ViewSettings>(`/projects/${viewProjectId}/view-settings`).then((result) => {
      if (!active) return;
      if (!result.stored) { setViewColumns(null); setSort(null); return; }
      setViewColumns(result.settings.columns);
      setSort(result.settings.sort && result.settings.sort !== 'manual' ? { key: result.settings.sort, direction: result.settings.direction } : null);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [workspace?.id, viewProjectId]);
  React.useEffect(() => {
    const key = `${sort?.key ?? 'manual'}:${sort?.direction ?? 'asc'}`;
    if (key === lastSortKey.current) return;
    lastSortKey.current = key;
    if (workspace) void refresh(workspace.id).catch(() => undefined);
  }, [sort]);
  React.useEffect(() => { setDetailTab('chat'); }, [task?.id]);
  React.useEffect(() => {
    const id = pendingFocusId.current;
    if (!id) return;
    const index = viewTasks.findIndex((item) => item.id === id);
    if (index < 0) return;
    pendingFocusId.current = null;
    setFocusedRowIndex(index); setSelectedTaskIds([id]); setSelectionAnchor(index);
    setVirtualStart((start) => index < start || index >= start + WINDOW ? Math.max(0, index - 3) : start);
  });

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
      if ((event.ctrlKey || event.metaKey) && key === 'p' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
        return;
      }
      if (event.key === 'Escape') {
        // Dialogs built on <Dialog> close themselves; only the legacy overlays and the Task panel are handled here.
        if (paletteOpen || moreOpen || shortcutHelpOpen || newTaskOpen || newListOpen || projectDialogOpen || teamsOpen) return;
        if (templatesOpen) { event.preventDefault(); setTemplatesOpen(false); restoreFocus(); return; }
        if (editingTaskId) { event.preventDefault(); setEditingTaskId(null); setKeyboardMode('browse'); requestAnimationFrame(() => gridRef.current?.focus()); return; }
        if (task && !fullPage && !generateOpen) {
          event.preventDefault();
          void flushAndClose();
          return;
        }
      }
      if (event.key === 'Tab' && templatesOpen) {
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
        const overlay = paletteOpen || moreOpen || shortcutHelpOpen || newTaskOpen || newListOpen || projectDialogOpen || teamsOpen || templatesOpen || generateOpen;
        if (!overlay && gPending.current > Date.now()) {
          gPending.current = 0;
          const target = ({ i: 'inbox', t: 'tasks', m: 'my-work', p: 'proposal', k: 'knowledge', b: 'blockers', o: 'overview', l: 'milestones', s: 'settings' } as Record<string, string>)[key];
          if (target) { event.preventDefault(); goTo(target as Parameters<typeof goTo>[0]); return; }
        }
        if (!overlay && key === 'g') { gPending.current = Date.now() + 1200; return; }
        if (!overlay && event.key === '?') { event.preventDefault(); openShortcutHelp(); return; }
        if (!overlay && key === 'c' && activeTab === 'tasks' && !showSkills) { event.preventDefault(); openNewTask(); return; }
        if (key === 'b') setKeyboardMode('browse');
        if (key === 'e') setKeyboardMode('edit');
        if (key === 'o') setKeyboardMode('outline');
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === '?') {
        const overlay = paletteOpen || moreOpen || shortcutHelpOpen || newTaskOpen || newListOpen || projectDialogOpen || teamsOpen || templatesOpen || generateOpen;
        if (!overlay) { event.preventDefault(); openShortcutHelp(); }
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
  }, [paletteOpen, templatesOpen, shortcutHelpOpen, moreOpen, newTaskOpen, newListOpen, projectDialogOpen, teamsOpen, generateOpen, editingTaskId, task, draft, fullPage, statuses, tasks, selectedTaskIds, focusedRowIndex, workspace, activeTab, showSkills]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try {
      await api('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email, password }) });
      const me = await api<{ user_id: string; workspaces: Workspace[] }>('/auth/me');
      await clearClientCaches();
      if (!me.workspaces.length) throw new Error('No Workspace is available for this account.');
      setWorkspaceChoices(me.workspaces); setSignedIn(true);
      const remembered = localStorage.getItem('weft-workspace-id');
      const found = me.workspaces.find((item) => item.id === remembered) ?? (me.workspaces.length === 1 ? me.workspaces[0] : null);
      if (!found) { setWorkspace(null); setNeedsWorkspaceChoice(true); return; }
      setWorkspace(found); setNeedsWorkspaceChoice(false); await refresh(found.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign-in failed.'); }
  }

  async function chooseWorkspace(found: Workspace) {
    localStorage.setItem('weft-workspace-id', found.id);
    setWorkspace(found); setNeedsWorkspaceChoice(false); setActiveTab('tasks'); setShowSkills(false);
    setTask(null); setDraft(null); setSelectedTaskIds([]); setSelectedListId(''); setActiveView('all');
    try { await refresh(found.id); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not open Workspace.'); }
  }

  async function signOut() {
    try { await api('/auth/sign-out', { method: 'POST', body: '{}' }); }
    catch (reason) { if ((reason as { status?: number }).status !== 401) { setError(reason instanceof Error ? reason.message : 'Could not sign out.'); return; } }
    clearLocalSession();
  }

  async function createProject(event: React.FormEvent) {
    event.preventDefault(); if (!workspace) return;
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem('project-name') as HTMLInputElement;
    try { const project = await api<Project>(`/workspaces/${workspace.id}/projects`, { method: 'POST', body: JSON.stringify({ name: input.value.trim(), visibility: 'workspace' }) }); setProjects((items) => [...items, project]); setSelectedProject(project.id); input.value = ''; setProjectDialogOpen(false); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create Project.'); }
  }

  async function createMockProposal() {
    if (!workspace) return;
    const project = projects.find((item) => item.id === selectedProject) ?? projects[0];
    if (!project) { setProposalMessage('Choose a Project before creating a Proposal.'); return; }
    let availableVaults = vaults;
    try {
      availableVaults = (await api<{ vaults: Vault[] }>(`/workspaces/${workspace.id}/vaults`)).vaults;
      setVaults(availableVaults);
    } catch { /* The current screen can still create a Proposal without a Knowledge item. */ }
    const rootId = 'task-parent';
    const childId = 'task-dependent';
    const items: ProposalItem[] = [
      { id: rootId, kind: 'task', project_id: project.id, title: 'Prepare the launch checklist', description: 'Created from the mock provider.', reason: 'Capture the work in one place.', sources: ['Mock provider'], selected: true },
      { id: childId, kind: 'task', project_id: project.id, title: 'Review the checklist', description: '', reason: 'Review the parent task.', sources: ['Mock provider'], selected: true, depends_on: [rootId] },
      { id: 'link-existing', kind: 'relation', relation: 'related', source_task_id: rootId, target_task_id: childId, reason: 'Connect related work.', sources: ['Mock provider'], selected: true, depends_on: [rootId, childId] },
    ];
    const vault = availableVaults[0];
    if (vault) items.push({ id: 'knowledge-note', kind: 'note_edit', vault_id: vault.id, path: 'Proposal review.md', content: '# Review notes\n\nPrepared for approval.', reason: 'Review the proposed note; Vault apply is not enabled yet.', sources: ['Mock provider'], selected: false });
    const skill = skills.find((item) => item.enabled);
    if (skill && ['owner', 'admin'].includes(workspace.role)) items.push({ id: 'workspace-skill', kind: 'skill', skill_id: skill.id, expected_version: skill.version, body: `${skill.body ?? ''}\n\nUse the reviewed Proposal checklist.`, reason: 'Clarify the Workspace guidance.', sources: ['Mock provider'], selected: true });
    if (['owner', 'admin'].includes(workspace.role)) items.push({ id: 'review-schema', kind: 'schema', name: 'Review outcome', value_type: 'text', reason: 'Capture proposal outcomes consistently.', sources: ['Mock provider'], selected: true });
    setProposalBusy(true); setProposalMessage('');
    try {
      const created = await api<Proposal>(`/workspaces/${workspace.id}/proposals/mock`, { method: 'POST', body: JSON.stringify({ scope: { project_ids: [project.id], ...(vault ? { vault_ids: [vault.id] } : {}) }, items }) });
      setProposal(created); setProposalStale(false); setProposalDetail(null);
      setProposalMessage('Mock Proposal is ready for review.');
    } catch (reason) { setProposalMessage(reason instanceof Error ? reason.message : 'Could not create the mock Proposal.'); }
    finally { setProposalBusy(false); }
  }

  async function toggleProposalItem(item: ProposalItem, selected: boolean) {
    if (!workspace || !proposal) return;
    const before = new Map(proposal.items.map((candidate) => [candidate.id, candidate.selected]));
    setProposalBusy(true); setProposalMessage('');
    try {
      const updated = await api<Proposal>(`/workspaces/${workspace.id}/proposals/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ expected_revision: proposal.revision, items: selected ? proposal.items : untickBrokenLinks(proposal.items, item.id), toggle: { item_id: item.id, selected } }) });
      setProposal(updated);
      const changed = updated.items.filter((candidate) => candidate.id !== item.id && before.get(candidate.id) !== candidate.selected);
      const removed = changed.filter((candidate) => !candidate.selected).map((candidate) => rowName(candidate, updated.items));
      const restored = changed.filter((candidate) => candidate.selected).map((candidate) => rowName(candidate, updated.items));
      const notes = [removed.length ? `Dependent item removed: ${removed.join(', ')}.` : '', restored.length ? `Prerequisite restored: ${restored.join(', ')}.` : ''].filter(Boolean);
      if (notes.length) setProposalMessage(notes.join(' '));
    } catch (reason) { setProposalMessage(reason instanceof Error ? reason.message : 'Could not update the Proposal selection.'); }
    finally { setProposalBusy(false); }
  }

  /** Saves an edited copy of the draft plan. A stale revision reloads the latest plan instead of overwriting it. */
  async function savePlan(change: (items: ProposalItem[]) => ProposalItem[], success: string): Promise<boolean> {
    const current = proposalRef.current;
    if (!workspace || !current) return false;
    setProposalBusy(true); setProposalMessage('');
    try {
      const updated = await api<Proposal>(`/workspaces/${workspace.id}/proposals/${current.id}`, { method: 'PATCH', body: JSON.stringify({ expected_revision: current.revision, items: change(current.items) }) });
      setProposal(updated);
      if (success) setProposalMessage(success);
      return true;
    } catch (reason) {
      const failure = reason as { status?: number; body?: { detail?: string } };
      if (failure.status === 409) {
        try { setProposal(await api<Proposal>(`/workspaces/${workspace.id}/proposals/${current.id}`)); } catch { /* keep the plan on screen */ }
        setProposalMessage('This plan changed elsewhere, so your last edit was not saved. Review the latest version and try again.');
      } else setProposalMessage(failure.body?.detail ? `Could not save: ${failure.body.detail}.` : reason instanceof Error ? reason.message : 'Could not save the plan.');
      return false;
    } finally { setProposalBusy(false); }
  }

  function editProposalItem(id: string, patch: Record<string, unknown>) {
    void savePlan((items) => items.map((item) => (item.id === id ? { ...item, ...patch, edited: true } : item)), 'Edit saved.');
  }

  function rejectProposalItem(id: string) {
    const current = proposalRef.current;
    if (!current) return;
    const outcome = rejectItem<ProposalItem>(current.items, id);
    const names = outcome.removed.map((item) => itemName(item));
    void savePlan(() => outcome.items, `Rejected: ${names.join(', ')}.${names.length > 1 ? ' Rows that needed it went with it.' : ''}`);
  }

  function mergeProposalItems(fromId: string, intoId: string) {
    const current = proposalRef.current;
    const from = current?.items.find((item) => item.id === fromId);
    const into = current?.items.find((item) => item.id === intoId);
    if (!from || !into) return;
    void savePlan((items) => mergeItems<ProposalItem>(items, fromId, intoId).map((item) => (item.id === intoId ? { ...item, selected: item.selected || from.selected } : item)), `Merged ${itemName(from)} into ${itemName(into)}.`);
  }

  function openGenerate(goal = '', capability: AiCapability = 'generate', focus: AiFocusTask | null = null) {
    if (aiAvailability.status !== 'ready') return;
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : gridRef.current;
    setGenerateGoal(goal);
    setGenerateCapability(capability);
    setGenerateFocus(focus);
    setGenerateOpen(true);
  }

  /** Suggest split and Suggest links work on one Task and share Generate's scope, preview and connection rules. */
  function openSuggest(capability: 'split' | 'link', target: AiFocusTask | undefined, extra = '') {
    if (!target) return;
    // The review replaces the Task panel, so an unsaved edit must be saved or dropped first.
    const edited = task && draft && taskIsDirty(task, draft, taskAttributes, attributeDraft);
    if (edited) {
      void saveTask().then((saved) => { if (saved) openGenerate(extra || defaultFocusPrompt(capability, target), capability, target); else setError(t('err.saveBeforeAi')); });
      return;
    }
    openGenerate(extra || defaultFocusPrompt(capability, target), capability, target);
  }

  function closeGenerate() {
    setGenerateOpen(false);
    restoreFocus();
  }

  async function openProposalById(proposalId: string) {
    if (!workspace) return;
    try {
      const opened = await api<Proposal>(`/workspaces/${workspace.id}/proposals/${proposalId}`);
      setProposal(opened); setProposalStale(false); setProposalDetail(null);
      setGeneration(null); setRunNotes(null);
      setShowSkills(false); setActiveTab('proposal');
      focusReview.current = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open the Proposal.');
    }
  }

  async function finishGeneration(proposalId: string, context: GenerationContext) {
    if (!workspace) return;
    try {
      const created = await api<Proposal>(`/workspaces/${workspace.id}/proposals/${proposalId}`);
      setProposal(created); setProposalStale(false); setProposalDetail(null);
      setGeneration(context); setRunNotes(context.notes);
      setProposalMessage('Plan ready. Review it, then approve once.');
      setShowSkills(false); setActiveTab('proposal'); setGenerateOpen(false);
      if (task) { history.pushState({}, '', '/'); setTask(null); setDraft(null); setTaskAttributes([]); setFullPage(false); }
      focusReview.current = true;
    } catch (reason) {
      setGenerateOpen(false);
      setError(reason instanceof Error ? reason.message : 'Could not open the generated plan.');
    }
  }

  async function regenerateRow(rowId: string, instruction: string, replaceEdited: boolean) {
    const current = proposalRef.current;
    const connectionId = generation?.connectionId ?? (aiAvailability.status === 'ready' ? aiAvailability.connection.id : null);
    const row = current?.items.find((item) => item.id === rowId);
    if (!workspace || !current || !row || !connectionId) { setProposalMessage('Regenerating needs a ready AI connection.'); return; }
    const scope = generation?.scope ?? { projects: current.scope?.project_ids ?? [], tasks: [], vaults: current.scope?.vault_ids ?? [] };
    const others = replaceEdited ? current.items.filter((item) => item.kind === 'task' && item.id !== rowId && item.edited === true) : [];
    const prompt = [
      'Regenerate draft Tasks in an existing plan.',
      `Propose ${others.length + 1} replacement ${others.length ? 'Tasks, in this order' : 'Task'}.`,
      generation?.goal ? `Overall goal: ${generation.goal}` : '',
      `1. Replace this draft: ${itemName(row)}${row.description ? ` (${String(row.description)})` : ''}`,
      ...others.map((item, index) => `${index + 2}. Replace this draft: ${itemName(item)}`),
      instruction.trim() ? `Change requested: ${instruction.trim()}` : '',
    ].filter(Boolean).join('\n');
    setProposalBusy(true); setProposalMessage('Regenerating…');
    try {
      const { proposalId } = await runGeneration(api, { workspaceId: workspace.id, connectionId, scope, prompt }, { onRun: (run) => setProposalMessage(`Regenerating: ${runStateLabel(run.state)}`), isStopped: () => false });
      const drafts = await api<Proposal>(`/workspaces/${workspace.id}/proposals/${proposalId}`);
      setProposalBusy(false);
      await savePlan((items) => applyRegeneratedRow<ProposalItem>(items, rowId, drafts.items, replaceEdited), replaceEdited ? 'Row regenerated; manual edits on the other rows were replaced as you chose.' : 'Row regenerated. Your manual edits on other rows were kept.');
    } catch (reason) {
      setProposalMessage(reason instanceof Error ? reason.message : 'Could not regenerate this row.');
    } finally { setProposalBusy(false); }
  }

  async function refreshProposal() {
    if (!workspace || !proposal) return;
    setProposalBusy(true); setProposalMessage('Checking Proposal versions…');
    try {
      const result = await api<{ valid: boolean; error?: string }>(`/workspaces/${workspace.id}/proposals/${proposal.id}/validate`, { method: 'POST', body: '{}' });
      setProposalStale(!result.valid);
      setProposalMessage(result.valid ? 'Proposal is up to date.' : `Stale item: ${result.error ?? 'refresh or remove it before approving.'}`);
    } catch (reason) {
      const body = (reason as { body?: { error?: string; detail?: string } }).body;
      const detail = body?.detail ?? body?.error;
      const explanation = detail === 'stale base version'
        ? 'a Skill changed since this Proposal was created; refresh or remove it before approving.'
        : detail ?? (reason instanceof Error ? reason.message : 'refresh or remove the stale item before approving.');
      setProposalStale(true);
      setProposalMessage(`Stale item: ${explanation}`);
    } finally { setProposalBusy(false); }
  }

  async function removeStaleProposalItems() {
    if (!workspace || !proposal) return;
    const staleSkillItems = await Promise.all(proposal.items.filter((item) => item.kind === 'skill' && typeof item.skill_id === 'string').map(async (item) => {
      try {
        const current = await api<Skill & { body: string }>(`/workspaces/${workspace.id}/skills/${item.skill_id}`);
        return current.version !== item.expected_version ? item.id : null;
      } catch { return item.id; }
    }));
    const staleIds = new Set(staleSkillItems.filter((id): id is string => id !== null));
    if (staleIds.size === 0) { setProposalMessage('No stale Skills to remove.'); return; }
    const items = proposal.items.filter((item) => !staleIds.has(item.id));
    setProposalBusy(true);
    try {
      const updated = await api<Proposal>(`/workspaces/${workspace.id}/proposals/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ expected_revision: proposal.revision, items }) });
      setProposal(updated); setProposalStale(false); setProposalMessage('Stale items removed. Review the remaining Proposal before approving.');
    } catch (reason) { setProposalMessage(reason instanceof Error ? reason.message : 'Could not remove stale items.'); }
    finally { setProposalBusy(false); }
  }

  async function refreshStaleProposalItems() {
    if (!workspace || !proposal) return;
    const staleSkills = proposal.items.filter((item) => item.kind === 'skill' && typeof item.skill_id === 'string');
    if (!staleSkills.length) { setProposalMessage('Remove stale items that cannot be refreshed.'); return; }
    setProposalBusy(true);
    try {
      const fetched = await Promise.all(staleSkills.map(async (item) => {
        const current = await api<Skill & { body: string }>(`/workspaces/${workspace.id}/skills/${item.skill_id}`);
        return current.version === item.expected_version ? null : { ...item, expected_version: current.version, current_body: current.body, body: current.body };
      }));
      const refreshed = fetched.filter((item) => item !== null);
      if (refreshed.length === 0) { setProposalMessage('No stale Skills to refresh.'); return; }
      const refreshedById = new Map(refreshed.map((item) => [item.id, item]));
      const items = proposal.items.map((item) => refreshedById.get(item.id) ?? item);
      const updated = await api<Proposal>(`/workspaces/${workspace.id}/proposals/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ expected_revision: proposal.revision, items }) });
      const validation = await api<{ valid: boolean }>(`/workspaces/${workspace.id}/proposals/${proposal.id}/validate`, { method: 'POST', body: '{}' });
      setProposal({ ...updated, items: updated.items.map((item) => refreshedById.get(item.id) ?? item) });
      setProposalStale(!validation.valid);
      setProposalDetail(refreshed[0].id);
      setProposalMessage(validation.valid ? 'Stale Skill refreshed to its current content. Review the Proposal before approving.' : 'Proposal still has stale items; remove them before approving.');
    } catch (reason) { setProposalStale(true); setProposalMessage(reason instanceof Error ? reason.message : 'Could not refresh stale items.'); }
    finally { setProposalBusy(false); }
  }

  /** Brings stale items up to the current Task versions after the member has looked at them. */
  async function refreshStaleItems() {
    if (!workspace || !proposal) return;
    setProposalBusy(true); setProposalMessage('');
    try {
      const updated = await api<Proposal>(`/workspaces/${workspace.id}/proposals/${proposal.id}/refresh`, { method: 'POST', body: JSON.stringify({ expected_revision: proposal.revision, item_ids: proposal.stale_items }) });
      setProposal(updated);
      setProposalMessage('Stale items now use the current Task versions. Check them once more, then approve.');
    } catch (reason) { setProposalMessage(reason instanceof Error ? reason.message : 'Could not refresh the stale items.'); }
    finally { setProposalBusy(false); }
  }

  function removeStaleItems() {
    const current = proposalRef.current;
    if (!current) return;
    let items = current.items;
    for (const id of current.stale_items ?? []) items = rejectItem<ProposalItem>(items, id).items;
    void savePlan(() => items, 'Stale items removed. Review the rest of the plan before approving.');
  }

  async function approveProposal() {
    if (!workspace || !proposal || proposalStale || (proposal.stale_items?.length ?? 0) > 0) return;
    setProposalBusy(true); setProposalApplying(true); setProposalMessage('');
    try {
      await api(`/workspaces/${workspace.id}/proposals/${proposal.id}/approve`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ revision: proposal.revision }) });
      setProposal({ ...proposal, status: 'applied' });
      setProposalMessage('Proposal approved. You can undo this change.');
      await refresh(workspace.id);
    } catch (reason) {
      const failure = reason as { status?: number; body?: { error?: string } };
      if (failure.status === 409) {
        try {
          const latest = await api<Proposal>(`/workspaces/${workspace.id}/proposals/${proposal.id}`);
          setProposal(latest);
        } catch { /* Keep the reviewed Proposal visible when a refetch is unavailable. */ }
        if (failure.body?.error === 'proposal_stale') { setProposalMessage('A Task changed after this plan was drafted. Refresh the stale items or remove them before approving.'); return; }
        setProposalStale(true);
        setProposalMessage(failure.body?.error === 'proposal_revision_changed'
          ? 'This Proposal changed while you were reviewing it. Refresh its versions before approving.'
          : 'This Proposal is out of date. Refresh its versions before approving.');
      } else setProposalMessage(reason instanceof Error ? reason.message : 'Could not approve the Proposal.');
    }
    finally { setProposalBusy(false); setProposalApplying(false); }
  }

  async function undoProposal() {
    if (!workspace || !proposal) return;
    setProposalBusy(true);
    try {
      await api(`/workspaces/${workspace.id}/proposals/${proposal.id}/undo`, { method: 'POST', body: '{}' });
      setProposal({ ...proposal, status: 'undone' }); setProposalMessage('Proposal changes undone.'); await refresh(workspace.id);
    } catch (reason) { setProposalMessage(reason instanceof Error ? reason.message : 'Could not undo the Proposal.'); }
    finally { setProposalBusy(false); }
  }

  /** Status key a new Task should start in when the open Smart List pins exactly one Status. */
  function listStatusKey() {
    const selectedList = taskLists.find((item) => item.id === selectedListId);
    const unambiguousStatus = selectedList?.kind === 'smart' && selectedList.query.logic !== 'or' && selectedList.query.filters.filter((filter) => filter.field === 'status' && filter.op === 'eq').length === 1
      ? selectedList.query.filters.find((filter) => filter.field === 'status' && filter.op === 'eq')?.value
      : undefined;
    return typeof unambiguousStatus === 'string' ? statuses.find((status) => status.id === unambiguousStatus)?.key ?? unambiguousStatus : undefined;
  }

  async function writeAttributeValues(created: Task, values: Record<string, unknown>) {
    const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0));
    if (entries.length === 0) return created;
    const body = entries.map(([attribute_id, value]) => ({ attribute_id, value: attributes.find((item) => item.id === attribute_id)?.type === 'number' ? Number(value) : value, expected_version: created.version }));
    const saved = await api<{ version: number }>(`/tasks/${created.id}/attributes`, { method: 'PATCH', body: JSON.stringify({ values: body }) });
    return { ...created, version: saved.version, attributes: { ...created.attributes, ...Object.fromEntries(body.map((item) => [item.attribute_id, item.value])) } };
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !selectedProject || !title.trim()) return;
    try {
      const draftValues = newTaskDraft;
      const statusKey = draftValues.status || listStatusKey();
      let created = await api<Task>(`/workspaces/${workspace.id}/tasks`, { method: 'POST', body: JSON.stringify({ project_id: selectedProject, title: title.trim(), status: statusKey, assignees: draftValues.assignees.length ? draftValues.assignees.map(({ type, id }) => ({ type, id })) : undefined, due_date: draftValues.due || undefined, parent_task_id: draftValues.parent || undefined }) });
      created = await writeAttributeValues(created, draftValues.attrs).catch(() => created);
      setTitle(''); setNewTaskOpen(false); appendTask(created); openPanel(created);
      for (const listId of draftValues.lists) {
        await api(`/lists/${listId}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: created.id, request_id: crypto.randomUUID() }) });
        if (listId === selectedListId) setListTasks((items) => [...items, created]);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create task.'); }
  }

  /** Creates a Task straight from the table or a board column; the Task stays closed so the next one can be typed at once. */
  async function createInlineTask(input: { title: string; status?: string; assignees?: Assignee[]; due?: string; attrs?: Record<string, unknown> }): Promise<boolean> {
    const project = projectFilter || selectedProject || projects[0]?.id;
    if (!workspace || !project || !input.title.trim()) return false;
    try {
      let created = await api<Task>(`/workspaces/${workspace.id}/tasks`, { method: 'POST', body: JSON.stringify({ project_id: project, title: input.title.trim(), status: input.status ?? listStatusKey(), assignees: input.assignees?.length ? input.assignees.map(({ type, id }) => ({ type, id })) : undefined, due_date: input.due || undefined }) });
      if (input.attrs) created = await writeAttributeValues(created, input.attrs).catch(() => created);
      appendTask(created);
      const selectedList = taskLists.find((item) => item.id === selectedListId);
      if (activeView === 'list' && selectedList?.kind === 'manual') { await api(`/lists/${selectedList.id}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: created.id, request_id: crypto.randomUUID() }) }); setListTasks((items) => [...items, created]); }
      announce(t('announce.created', { n: created.number, title: created.title }));
      setError('');
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create task.'); return false; }
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
      setListTasks([]); setActiveView('list'); setActiveTab('tasks'); setNewListOpen(false);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create List.'); }
  }

  async function changeListMembership(task: Task, add: boolean) {
    if (!selectedListId || !workspace) return;
    try {
      if (add) await api(`/lists/${selectedListId}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: task.id, request_id: crypto.randomUUID() }) });
      else await api(`/lists/${selectedListId}/tasks/${task.id}`, { method: 'DELETE' });
      const result = await api<{ id: string; tasks: Task[]; total: number }>(`/workspaces/${workspace.id}/lists/${selectedListId}`);
      setTasks((items) => items.map((item) => result.tasks.find((viewTask) => viewTask.id === item.id) ?? item));
      if (selectedListId) { setListTasks(result.tasks); setListTotal(result.total); }
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update List membership.'); }
  }

  /** The heading a Task sits under when the List is grouped by `field`. */
  function groupLabel(item: Task, field: string): string {
    const none = 'No value';
    if (field === 'milestone') return item.milestone?.name ?? 'No Milestone';
    if (field === 'milestone_state') return item.milestone?.state ?? 'No Milestone';
    if (field === 'status') return statuses.find((status) => status.key === item.status)?.name ?? item.status;
    if (field === 'priority') return item.priority || none;
    if (field.startsWith('attribute:')) { const value = item.attributes?.[field.slice(10)]; return value === undefined || value === null || value === '' ? none : String(value); }
    const value = (item as unknown as Record<string, unknown>)[field];
    return value === undefined || value === null || value === '' ? none : String(value);
  }
  const [listTasks, setListTasks] = React.useState<Task[]>([]);
  // Tasks the server holds for the open List; a Smart List page can show fewer than this.
  const [listTotal, setListTotal] = React.useState(0);
  async function openList(id: string) {
    setSelectedListId(id);
    if (!workspace || !id) { setListTasks([]); setListTotal(0); return; }
    try { const result = await api<{ tasks: Task[]; total: number }>(`/workspaces/${workspace.id}/lists/${id}`); setListTasks(result.tasks); setListTotal(result.total); setError(''); }
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

  function updateCommentBody(value: string, caret: number) {
    setCommentBody(value);
    const noteFragment = value.slice(0, caret).match(/(?:^|\s)\[\[([^\]]*)$/);
    if (noteFragment && workspace) {
      setReferenceSuggestions([]);
      setMentionSuggestions([]);
      setNoteReferenceSuggestionIndex(0);
      void api<{ results: KnowledgeResult[] }>(`/workspaces/${workspace.id}/knowledge/names?q=${encodeURIComponent(noteFragment[1].trim())}`)
        .then((result) => setNoteReferenceSuggestions(result.results))
        .catch(() => setNoteReferenceSuggestions([]));
      return;
    }
    setNoteReferenceSuggestions([]);
    const fragment = value.slice(0, caret).match(/(?:^|[\s(])#([^\s#]*)$/);
    const mention = value.slice(0, caret).match(/(?:^|[\s(])@([a-zA-Z0-9_.-]*)$/);
    if (mention && workspace) {
      setReferenceSuggestions([]);
      void api<{ results: MentionSuggestion[] }>(`/workspaces/${workspace.id}/mention-suggestions?q=${encodeURIComponent(mention[1])}&task_id=${task?.id ?? ''}`).then((result) => setMentionSuggestions(result.results)).catch(() => setMentionSuggestions([]));
      return;
    }
    setMentionSuggestions([]);
    if (!fragment || !workspace) { setReferenceSuggestions([]); return; }
    setReferenceSuggestionIndex(0);
    void api<{ results: ReferenceSuggestion[] }>(`/workspaces/${workspace.id}/task-reference-suggestions?q=${encodeURIComponent(fragment[1])}`)
      .then((result) => setReferenceSuggestions(result.results))
      .catch(() => setReferenceSuggestions([]));
  }

  function commentKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (noteReferenceSuggestions.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setNoteReferenceSuggestionIndex((index) => (index + 1) % noteReferenceSuggestions.length); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setNoteReferenceSuggestionIndex((index) => (index + noteReferenceSuggestions.length - 1) % noteReferenceSuggestions.length); }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); insertNoteReference(noteReferenceSuggestions[noteReferenceSuggestionIndex]); }
      else if (event.key === 'Escape') setNoteReferenceSuggestions([]);
      return;
    }
    const list = mentionSuggestions.length ? mentionSuggestions : referenceSuggestions;
    if (!list.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setReferenceSuggestionIndex((index) => (index + 1) % list.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setReferenceSuggestionIndex((index) => (index + list.length - 1) % list.length); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (mentionSuggestions.length) insertMention(mentionSuggestions[referenceSuggestionIndex]); else insertReference(referenceSuggestions[referenceSuggestionIndex]); }
    else if (event.key === 'Escape') { setReferenceSuggestions([]); setMentionSuggestions([]); }
  }

  function insertReference(suggestion: ReferenceSuggestion) {
    const input = commentInput.current;
    if (!input) return;
    const caret = input.selectionStart;
    const before = commentBody.slice(0, caret);
    const fragment = before.match(/(?:^|[\s(])#([^\s#]*)$/);
    if (!fragment) return;
    const start = caret - fragment[0].length + fragment[0].lastIndexOf('#');
    const value = `${commentBody.slice(0, start)}#${suggestion.number} ${commentBody.slice(caret)}`;
    setCommentBody(value);
    setReferenceSuggestions([]);
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + String(suggestion.number).length + 2, start + String(suggestion.number).length + 2); });
  }

  function insertNoteReference(suggestion: KnowledgeResult) {
    const input = commentInput.current;
    if (!input) return;
    const caret = input.selectionStart;
    const before = commentBody.slice(0, caret);
    const fragment = before.match(/(?:^|\s)\[\[([^\]]*)$/);
    if (!fragment) return;
    const start = caret - fragment[0].length + fragment[0].lastIndexOf('[[');
    const value = `${commentBody.slice(0, start)}[[${suggestion.vault_name}/${suggestion.path}]]${commentBody.slice(caret)}`;
    setCommentBody(value);
    setNoteReferenceSuggestions([]);
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + suggestion.vault_name.length + suggestion.path.length + 5, start + suggestion.vault_name.length + suggestion.path.length + 5); });
  }

  function insertMention(suggestion: MentionSuggestion) {
    const input = commentInput.current;
    if (!input) return;
    const caret = input.selectionStart;
    const before = commentBody.slice(0, caret);
    const fragment = before.match(/(?:^|[\s(])@([a-zA-Z0-9_.-]*)$/);
    if (!fragment) return;
    const start = caret - fragment[0].length + fragment[0].lastIndexOf('@');
    const value = `${commentBody.slice(0, start)}${suggestion.mention} ${commentBody.slice(caret)}`;
    setCommentBody(value); setMentionSuggestions([]);
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + suggestion.mention.length + 1, start + suggestion.mention.length + 1); });
  }

  // The server's rules: 10 files per comment, 10 MiB per file, 64 MiB per Task. The client can only count
  // what this Task already holds in the comments it has loaded; the server has the last word.
  function attachmentProblem(files: File[]) {
    if (files.length > MAX_COMMENT_ATTACHMENTS) return 'A comment can have at most 10 attachments.';
    if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) return 'Each attachment must be 10 MiB or smaller.';
    const uploaded = commentDraft.current?.uploaded;
    const held = comments.reduce((total, comment) => total + (comment.attachments ?? []).reduce((sum, attachment) => sum + attachment.size, 0), 0);
    const pending = files.filter((file) => !uploaded?.has(`${file.name}:${file.size}:${file.lastModified}`)).reduce((total, file) => total + file.size, 0);
    if (held + pending > MAX_TASK_ATTACHMENT_BYTES) return 'This Task\'s attachments would pass 64 MiB in total (the limit is per Task, not per comment).';
    return '';
  }

  async function saveComment(event: React.FormEvent) {
    event.preventDefault(); if (!task || !commentBody.trim()) return;
    const problem = attachmentProblem(commentFiles);
    if (problem) { setError(problem); return; }
    // The comment is saved before its files are uploaded. A failed upload keeps this draft, so the retry
    // reuses the saved comment (and its request id) instead of posting a second one.
    const draft = (commentDraft.current ??= { requestId: crypto.randomUUID(), uploaded: new Set<string>() });
    try {
      if (editingComment) {
        draft.savedId = editingComment;
        await api<Comment>(`/tasks/${task.id}/comments/${editingComment}`, { method: 'PATCH', body: JSON.stringify({ body: commentBody }) });
      } else if (!draft.savedId) {
        draft.savedId = (await api<Comment>(`/tasks/${task.id}/comments`, { method: 'POST', body: JSON.stringify({ request_id: draft.requestId, body: commentBody, reply_to: replyToComment }) })).id;
        draft.savedBody = commentBody;
      } else if (draft.savedBody !== commentBody) {
        await api<Comment>(`/tasks/${task.id}/comments/${draft.savedId}`, { method: 'PATCH', body: JSON.stringify({ body: commentBody }) });
        draft.savedBody = commentBody;
      }
      for (const file of commentFiles) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (draft.uploaded.has(key)) continue;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const content_hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        try {
          await api(`/tasks/${task.id}/comments/${draft.savedId}/attachments`, { method: 'POST', body: JSON.stringify({ file_name: file.name, content_type: file.type || 'application/octet-stream', content_hex }) });
        } catch (reason) {
          throw new Error(`Could not attach ${file.name}: ${reason instanceof Error ? reason.message : 'upload failed.'}`);
        }
        draft.uploaded.add(key);
      }
      commentDraft.current = null;
      setCommentBody(''); setCommentFiles([]); setEditingComment(null); setReplyToComment(null); setError('');
      await refreshComments(task.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not save comment.';
      // Once the comment itself is saved, only its files failed: say so, so nobody posts it again.
      setError(draft.savedId && !editingComment ? `Your comment was saved, but not all files were attached. ${message}` : message);
      if (draft.savedId) await refreshComments(task.id).catch(() => undefined);
    }
  }

  async function refreshComments(taskId: string) {
    const ticket = ++commentsSeq.current;
    const result = await api<{ comments: Comment[] }>(`/tasks/${taskId}/comments`);
    if (ticket === commentsSeq.current) setComments(result.comments);
  }

  async function toggleReaction(comment: Pick<Comment, 'id' | 'reactions'>, emoji: string) {
    if (!task) return;
    const reacted = comment.reactions?.some((reaction) => reaction.emoji === emoji && reaction.reacted);
    try {
      await api(`/tasks/${task.id}/comments/${comment.id}/reactions${reacted ? `?emoji=${encodeURIComponent(emoji)}` : ''}`, reacted ? { method: 'DELETE' } : { method: 'POST', body: JSON.stringify({ emoji }) });
      await refreshComments(task.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update reaction.'); }
  }

  async function deleteComment(id: string) {
    if (!task) return;
    try { await api(`/tasks/${task.id}/comments/${id}`, { method: 'DELETE' }); setComments((items) => items.filter((item) => item.id !== id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete comment.'); }
  }

  async function createTaskFromComment(event: React.FormEvent) {
    event.preventDefault();
    if (!task || !taskFromComment) return;
    try {
      const created = await api<Task>(`/tasks/${task.id}/comments/${taskFromComment.comment.id}/create-task`, {
        method: 'POST',
        body: JSON.stringify({ project_id: taskFromComment.project_id, title: taskFromComment.title, description: taskFromComment.description, request_id: taskFromComment.request_id ?? crypto.randomUUID() }),
      });
      setTaskFromComment(null);
      await refresh(workspace!.id);
      openPanel(created);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create a Task from this comment.'); }
  }

  function restoreFocus() {
    requestAnimationFrame(() => focusReturn.current?.focus());
  }

  function openShortcutHelp(keepReturn = false) {
    if (!keepReturn) focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShortcutHelpOpen(true);
  }

  /** Moves to a top-level destination. `my-work` is the Tasks screen with the My work view. */
  function goTo(target: 'inbox' | 'tasks' | 'my-work' | 'proposal' | 'blockers' | 'overview' | 'knowledge' | 'milestones' | 'settings' | 'all' | 'skills') {
    setMoreOpen(false);
    if (target !== 'skills') setShowSkills(false);
    if (task) { history.pushState({}, '', '/'); setTask(null); setDraft(null); setTaskAttributes([]); setFullPage(false); }
    if (target === 'skills') { setSelectedSkill(null); setEditingSkill(false); setShowSkills(true); return; }
    if (target === 'my-work') { setActiveTab('tasks'); void showMyWork(); return; }
    if (target === 'all') { setActiveTab('tasks'); setActiveView('all'); setProjectFilter(''); return; }
    if (target === 'knowledge') { void showKnowledge(); return; }
    if (target === 'tasks') { setActiveTab('tasks'); return; }
    setActiveTab(target);
  }

  function openNewTask() {
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : gridRef.current;
    const list = taskLists.find((item) => item.id === selectedListId);
    setNewTaskDraft({ status: '', assignees: [], lists: activeView === 'list' && list?.kind === 'manual' ? [list.id] : [], parent: '', due: '', attrs: {} });
    if (projectFilter) setSelectedProject(projectFilter);
    setNewTaskOpen(true);
  }

  /** Saves any pending edit, then closes the Task panel. A failed save keeps the panel open with its error. */
  async function flushAndClose() {
    if (!task || !draft) { closeTaskPanel(); return; }
    const pending = taskIsDirty(task, draft, taskAttributes, attributeDraft);
    if (pending && !conflict) { const ok = await saveTask(); if (!ok) return; }
    else if (pending && conflict) { setError(t('err.unsaved')); return; }
    closeTaskPanel();
  }

  function openMenu() {
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMoreOpen(true);
  }

  function closeMenu() { setMoreOpen(false); }

  function openTemplates(keepReturn = false) {
    if (!keepReturn) focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTemplatesOpen(true);
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

  /** Screen-reader announcement (aria-live region in the app root). */
  function announce(text: string) {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(text));
  }

  const replaceTask = (updated: Task) => {
    const swap = (items: Task[]) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item);
    setTasks(swap); setListTasks(swap); setWorkTasks(swap); setViaTeamTasks(swap); setTeamQueue(swap);
    setTask((current) => current?.id === updated.id ? { ...current, ...updated } : current);
  };

  /** PATCH one Task with the given fields and put the answer into every list that holds it. */
  async function patchTask(value: Task, body: Record<string, unknown>, fallback: string): Promise<Task | null> {
    if (!workspace) return null;
    try {
      const updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${value.number}`, { method: 'PATCH', body: JSON.stringify({ expected_version: value.version, ...body }) });
      replaceTask(updated);
      setDraft((current) => current?.id === updated.id && !taskIsDirty(taskRef.current ?? updated, current, taskAttributesRef.current, attributeDraftRef.current) ? { ...current, ...updated } : current);
      if (value.recurrence) void refresh(workspace.id);
      return updated;
    } catch (reason) { reportWriteError(reason, fallback); return null; }
  }

  const updateTaskAssignees = (value: Task, next: Assignee[]) => patchTask(value, { assignees: next.map(({ type, id }) => ({ type, id })) }, 'Could not change Assignees.').then((updated) => { if (updated) announce(t('announce.assigned', { n: value.number })); });
  const updateTaskPriority = (value: Task, priority: string) => patchTask(value, { priority }, 'Could not change priority.');
  const updateTaskDate = (value: Task, field: 'due_date' | 'start_date', date: string) => patchTask(value, { [field]: date || null }, 'Could not change the date.');

  type Move = { status?: string; before?: string; after?: string; toEnd?: boolean };
  /** A reorder or board drop: optimistic, atomic on the server, rolled back with an announcement on any error. */
  async function moveTask(item: Task, move: Move, label: string) {
    if (!workspace) return;
    const snapshot = { tasks, listTasks };
    const place = (items: Task[]) => {
      const rest = items.filter((candidate) => candidate.id !== item.id);
      const moved = { ...(items.find((candidate) => candidate.id === item.id) ?? item), ...(move.status ? { status: move.status } : {}) };
      const anchor = move.before ?? move.after;
      const index = anchor ? rest.findIndex((candidate) => candidate.id === anchor) : -1;
      if (move.toEnd) return [...rest, moved];
      if (index < 0) return items.map((candidate) => candidate.id === item.id ? moved : candidate);
      rest.splice(move.before ? index : index + 1, 0, moved);
      return rest;
    };
    setTasks(place); setListTasks(place);
    pendingFocusId.current = item.id;
    announce(label);
    try {
      const result = await api<{ task: Task }>(`/workspaces/${workspace.id}/tasks/${item.number}/move`, { method: 'POST', body: JSON.stringify({ command_id: crypto.randomUUID(), expected_version: move.status && move.status !== item.status ? item.version : undefined, status: move.status, before_task_id: move.before, after_task_id: move.after, to_end: move.toEnd || undefined }) });
      replaceTask(result.task);
      if (result.task.recurrence) void refresh(workspace.id);
    } catch (reason) {
      setTasks(snapshot.tasks); setListTasks(snapshot.listTasks);
      const message = reason instanceof Error ? reason.message : 'Could not move the Task.';
      announce(t('announce.moveFailed', { n: item.number, reason: message }));
      reportWriteError(reason, 'Could not move the Task.');
    }
  }

  const isSibling = (a: Task, b: Task) => a.project_id === b.project_id && (a.parent_task_id ?? null) === (b.parent_task_id ?? null) && a.id !== b.id;
  /** The sibling a drop should anchor to: the first sibling at or after `index`, else the last one before it. */
  function anchorAt(item: Task, ordered: Task[], index: number): Move {
    for (let i = index; i < ordered.length; i += 1) if (isSibling(item, ordered[i])) return { before: ordered[i].id };
    for (let i = Math.min(index, ordered.length) - 1; i >= 0; i -= 1) if (isSibling(item, ordered[i])) return { after: ordered[i].id };
    return {};
  }

  /** Keyboard path (Alt+ArrowUp/ArrowDown) and drop target resolution for table rows. */
  function reorderRow(item: Task, targetId: string | null, position: 'before' | 'after') {
    if (sort) { announce(t('announce.manualOnly')); return; }
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    let anchor: Task | undefined = targetId ? byId.get(targetId) : undefined;
    const original = anchor;
    while (anchor && !isSibling(item, anchor)) anchor = anchor.parent_task_id ? byId.get(anchor.parent_task_id) : undefined;
    if (!anchor || (original && original.id === item.id)) { announce(t('announce.siblingsOnly')); return; }
    const where = anchor.id === original?.id ? position : 'after';
    void moveTask(item, where === 'before' ? { before: anchor.id } : { after: anchor.id }, t(where === 'before' ? 'announce.movedBefore' : 'announce.movedAfter', { n: item.number, other: anchor.number }));
  }
  function stepRow(item: Task, delta: -1 | 1, scope?: Task[]) {
    if (sort) { announce(t('announce.manualOnly')); return; }
    const siblings = (scope ?? tasks).filter((candidate) => isSibling(item, candidate) || candidate.id === item.id);
    const index = siblings.findIndex((candidate) => candidate.id === item.id);
    const other = siblings[index + delta];
    if (!other) { announce(t(delta < 0 ? 'announce.atTop' : 'announce.atBottom', { n: item.number })); return; }
    void moveTask(item, delta < 0 ? { before: other.id } : { after: other.id }, t(delta < 0 ? 'announce.movedBefore' : 'announce.movedAfter', { n: item.number, other: other.number }));
  }

  /** Board drop: a Status (column) plus the neighbour in that column. */
  function dropOnBoard(item: Task, status: string, targetId: string | null, position: 'before' | 'after') {
    const column = viewTasks.filter((candidate) => candidate.status === status && candidate.id !== item.id);
    let index = column.length;
    if (targetId) { const at = column.findIndex((candidate) => candidate.id === targetId); if (at >= 0) index = position === 'before' ? at : at + 1; }
    const anchor = sort ? {} : anchorAt(item, column, index);
    const changesStatus = item.status !== status;
    if (!changesStatus && !anchor.before && !anchor.after) return;
    const name = statuses.find((candidate) => candidate.key === status)?.name ?? status;
    void moveTask(item, { ...(changesStatus ? { status } : {}), ...anchor }, changesStatus ? t('announce.movedToStatus', { n: item.number, status: name }) : t('announce.reordered', { n: item.number }));
  }

  /** Tab on a title makes the Task a subtask of the sibling above; Shift+Tab lifts it one level. */
  async function indentTask(item: Task, outdent: boolean) {
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    let parent: string | null;
    if (outdent) {
      if (!item.parent_task_id) { announce(t('announce.topLevel', { n: item.number })); return; }
      parent = byId.get(item.parent_task_id)?.parent_task_id ?? null;
    } else {
      const siblings = viewTasks.filter((candidate) => isSibling(item, candidate) || candidate.id === item.id);
      const above = siblings[siblings.findIndex((candidate) => candidate.id === item.id) - 1];
      if (!above) { announce(t('announce.noIndent', { n: item.number })); return; }
      if (taskDepth(above) >= 3) { announce(t('announce.tooDeep', { n: item.number })); return; }
      parent = above.id;
    }
    const updated = await patchTask(item, { parent_task_id: parent }, 'Could not change the parent Task.');
    if (!updated) return;
    announce(parent ? t('announce.indented', { n: item.number, parent: byId.get(parent)?.number ?? '' }) : t('announce.outdented', { n: item.number }));
    pendingFocusId.current = item.id;
    if (workspace) void loadTask(workspace.id, updated.number, updated.id).catch(() => undefined);
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[aria-label="Edit title for #${item.number}"]`)?.focus()));
  }

  async function setViewSettings(columns: string[], nextSort: TaskSort | null) {
    if (!viewProjectId) return;
    try { await api(`/projects/${viewProjectId}/view-settings`, { method: 'PUT', body: JSON.stringify({ columns, sort: nextSort?.key ?? 'manual', direction: nextSort?.direction ?? 'asc' }) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save the view.'); }
  }
  function changeSort(next: TaskSort | null) {
    setSort(next);
    void setViewSettings(effectiveColumns, next);
  }
  function changeColumns(next: string[]) {
    setViewColumns(next);
    void setViewSettings(next, sort);
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
      if (value.recurrence) void refresh(workspace.id);
    } catch (reason) { reportWriteError(reason, 'Could not update Status.'); }
  }

  async function updateTaskMilestone(value: Task, milestone: string | null) {
    if (!workspace || (value.milestone_id ?? null) === milestone) return;
    setSavingMilestone(value.id);
    try {
      const updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${value.number}`, { method: 'PATCH', body: JSON.stringify({ expected_version: value.version, milestone_id: milestone }) });
      setTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setListTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setTask((current) => current?.id === updated.id ? updated : current);
      setDraft((current) => current?.id === updated.id ? { ...current, milestone_id: updated.milestone_id, milestone: updated.milestone, version: updated.version } : current);
      setMilestoneEpoch((count) => count + 1);
    } catch (reason) { reportWriteError(reason, 'Could not change the Milestone.'); }
    finally { setSavingMilestone(null); }
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
      if (task) await loadTask(workspace.id, task.number, task.id);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : `Could not ${redo ? 'redo' : 'undo'} the last change.`); }
  }

  async function exportView() {
    if (!workspace) return;
    setError(''); setExportNotice('');
    // A saved List is exported by its id; every other view exports the Tasks it shows, and the server re-checks access for each one.
    const body = activeView === 'list' && selectedListId ? { list_id: selectedListId } : { task_ids: viewTasks.map((item) => item.id) };
    try {
      const response = await fetch(`/api/v1/workspaces/${workspace.id}/tasks/export.csv`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Export failed (${response.status}).`);
      const blob = await response.blob();
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = 'weft-tasks.csv';
      document.body.appendChild(link); link.click(); link.remove();
      // Revoking right after click() can cancel the download before the browser has read the blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setExportNotice(response.headers.get('x-weft-export-notice') ?? 'CSV export is not a backup.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not export this view.'); }
  }

  async function runPaletteCommand() {
    const query = paletteQuery.trim();
    if (/^templates?\b/i.test(query)) {
      closePalette(false);
      setTemplatesOpen(true);
      return;
    }
    const calendarMatch = calendarCommands(query, calendar, (item) => { closePalette(false); openPanel(item as Task); }, async () => { await runHistoryAction(false); })[0];
    if (calendarMatch) { closePalette(false); await calendarMatch.run(); return; }
    const timelineMatch = timelineCommands(query, timeline, (item) => { closePalette(false); openPanel(item as Task); })[0];
    if (timelineMatch) { closePalette(false); await timelineMatch.run(); return; }
    if (/^export(?:\s+csv)?$/i.test(query)) { closePalette(); await exportView(); return; }
    const suggest = query.match(/^(?:suggest\s+)?(split|links?)(?:\s+(.+))?$/i);
    if (suggest) {
      if (aiAvailability.status !== 'ready') return;
      const target = task ?? viewTasks[focusedRowIndex];
      if (!target) return;
      closePalette(false);
      openSuggest(suggest[1].toLowerCase() === 'split' ? 'split' : 'link', target, suggest[2]?.trim());
      return;
    }
    const planMilestones = query.match(/^plan(?:\s+milestones?)?(?:\s+(.+))?$/i);
    if (planMilestones) {
      if (aiAvailability.status !== 'ready') return;
      closePalette(false);
      openGenerate(planMilestones[1]?.trim() ?? '', 'plan');
      return;
    }
    const generate = query.match(/^(?:generate|ai)(?:\s+(.+))?$/i);
    if (generate) {
      if (aiAvailability.status !== 'ready') return;
      closePalette(false);
      openGenerate(generate[1]?.trim() ?? '');
      return;
    }
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
        appendTask(created);
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
        // Close first: the palette must not still be open (and toggle shut on the next Ctrl+K) while the write is in flight.
        closePalette();
        await updateTaskStatus(target, nextStatus.key);
      }
      return;
    }
    const milestoneCommand = query.match(/^milestone(?:\s+(.*))?$/i);
    if (milestoneCommand) {
      const target = task ?? viewTasks[focusedRowIndex];
      const wanted = (milestoneCommand[1] ?? '').trim().toLowerCase();
      if (!target) return;
      const clearing = ['none', 'clear', '-'].includes(wanted);
      try {
        const choices = clearing ? [] : (await api<{ milestones: { id: string; name: string; archived: boolean }[] }>(`/projects/${target.project_id}/milestones`)).milestones.filter((item) => !item.archived && item.name.toLowerCase().includes(wanted));
        const choice = choices.find((item) => item.name.toLowerCase() === wanted) ?? choices[0];
        if (clearing || choice) { closePalette(); await updateTaskMilestone(target, choice?.id ?? null); }
      } catch (reason) { reportWriteError(reason, 'Could not change the Milestone.'); }
      return;
    }
    const columnCommand = query.match(/^column\s+move\s+(.+?)\s+(left|right)$/i);
    if (columnCommand) {
      const status = statuses.find((item) => item.name.toLowerCase() === columnCommand[1].toLowerCase() || item.key.toLowerCase() === columnCommand[1].toLowerCase());
      if (status) { closePalette(); await moveKanbanColumn(status.id, columnCommand[2].toLowerCase() === 'right' ? 1 : -1); }
      return;
    }
    const noteMatch = paletteNoteResults[0];
    if (noteMatch) {
      closePalette(false);
      await openKnowledgeResult(noteMatch);
      return;
    }
    let match = paletteSearchResults[0];
    if (workspace) {
      try {
        const latest = await api<{ results: SearchResult[] }>(`/workspaces/${workspace.id}/search?q=${encodeURIComponent(query)}&limit=8`);
        match = latest.results[0];
        setPaletteSearchResults(latest.results);
        setPaletteSearchError('');
      } catch (reason) {
        setPaletteSearchError(reason instanceof Error ? reason.message : 'Could not search tasks and comments.');
        return;
      }
    }
    if (match) {
      closePalette(false);
      openPanel(match);
    }
  }

  function openPanel(value: Task | SearchResult, full = false) {
    if (!workspace) return;
    const number = 'number' in value ? value.number : value.task_number;
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : gridRef.current;
    history.pushState({}, '', `/w/${workspace.id}/tasks/${number}`);
    setFullPage(full);
    void loadTask(workspace.id, number).catch((reason) => setError(reason instanceof Error ? reason.message : 'Task is unavailable.'));
  }

  /** Saves the open Task. Property and text edits autosave; moving to another Project only happens with `move`. */
  async function saveTask(options: { move?: boolean } = {}): Promise<boolean> {
    if (!workspace || !draft || !task || savingRef.current) return false;
    const sent = draft;
    const sentAttributes = attributeDraft;
    const moving = Boolean(options.move) && moveTarget !== task.project_id;
    savingRef.current = true; setSaveState('saving');
    try {
      let updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${sent.number}`, { method: 'PATCH', body: JSON.stringify({ expected_version: task.version, title: sent.title, description: sent.description, status: sent.status, priority: sent.priority, start_date: sent.start_date, due_date: sent.due_date, assignees: sent.assignees.map(({ type, id }) => ({ type, id })), project_id: moving ? moveTarget : undefined, confirm_move: moving ? true : undefined }) });
      setTask(updated); setTasks((items) => items.map((item) => item.number === updated.number ? updated : item));
      const changes = taskAttributes.map((attribute) => {
        const draftValue = sentAttributes[attribute.id] ?? null;
        const value = attribute.type === 'number' && draftValue !== null && draftValue !== '' ? Number(draftValue) : draftValue;
        return { ...attribute, nextValue: value };
      }).filter((attribute) => JSON.stringify(attribute.value) !== JSON.stringify(attribute.nextValue));
      if (changes.length > 0) {
        const saved = await api<{ version: number }>(`/tasks/${updated.id}/attributes`, { method: 'PATCH', body: JSON.stringify({ values: changes.map((attribute) => ({ attribute_id: attribute.id, value: attribute.nextValue, expected_version: updated.version })) }) });
        updated = { ...updated, version: saved.version, attributes: { ...updated.attributes, ...Object.fromEntries(changes.map((attribute) => [attribute.id, attribute.nextValue])) } };
        setTaskAttributes((items) => items.map((attribute) => ({ ...attribute, value: changes.find((change) => change.id === attribute.id)?.nextValue ?? attribute.value })));
      }
      // Edits typed while this save was in flight stay in the draft; everything else adopts the saved Task.
      const typed = <K extends keyof Task>(current: Task, key: K) => JSON.stringify(current[key]) === JSON.stringify(sent[key]) ? updated[key] : current[key];
      setTask(updated);
      setDraft((current) => current && current.id === updated.id ? { ...updated, title: typed(current, 'title'), description: typed(current, 'description'), status: typed(current, 'status'), priority: typed(current, 'priority'), start_date: typed(current, 'start_date'), due_date: typed(current, 'due_date'), assignees: typed(current, 'assignees') } : updated);
      setConflict(null); setPreview(null); setTasks((items) => items.map((item) => item.number === updated.number ? updated : item));
      setSaveState('saved'); failedDraft.current = '';
      if (updated.recurrence) void refresh(workspace.id);
      return true;
    } catch (reason) {
      const failure = reason as Error & { status?: number; body?: { current?: Task } };
      setError(failure.message);
      setSaveState('error');
      failedDraft.current = JSON.stringify([sent, sentAttributes]);
      if (failure.status === 409) setConflict(failure.body?.current ?? null);
      return false;
    } finally { savingRef.current = false; }
  }

  React.useEffect(() => { setSaveState('idle'); failedDraft.current = ''; setTaskMoreOpen(false); }, [task?.id]);
  // Autosave: a changed draft is written shortly after the last edit; a failed or conflicting write waits for a new edit.
  React.useEffect(() => {
    if (!task || !draft || conflict || !taskIsDirty(task, draft, taskAttributes, attributeDraft)) return;
    if (failedDraft.current === JSON.stringify([draft, attributeDraft])) return;
    const timer = window.setTimeout(() => { void saveTask(); }, 500);
    return () => window.clearTimeout(timer);
  }, [draft, attributeDraft, task, conflict, taskAttributes]);

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
    try { const copied = await api<Task>(`/workspaces/${workspace.id}/tasks/${task.number}/duplicate`, { method: 'POST', body: '{}' }); appendTask(copied); openPanel(copied); }
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
      setSubtaskTitle(''); appendTask(created); await loadTask(workspace.id, task.number, task.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create subtask.'); }
  }

  async function createChecklistItem(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !task || !checklistTitle.trim()) return;
    try {
      await api(`/tasks/${task.id}/checklist`, { method: 'POST', body: JSON.stringify({ title: checklistTitle.trim() }) });
      setChecklistTitle(''); await loadTask(workspace.id, task.number, task.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not add checklist item.'); }
  }

  async function toggleChecklist(item: ChecklistItem) {
    if (!workspace || !task) return;
    try {
      await api(`/tasks/${task.id}/checklist/${item.id}`, { method: 'PATCH', body: JSON.stringify({ expected_version: item.version, checked: !item.checked }) });
      await loadTask(workspace.id, task.number, task.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update checklist item.'); }
  }

  async function addRelation(event: React.FormEvent) {
    event.preventDefault(); if (!task || !relationTarget) return;
    try {
      await api(`/tasks/${task.id}/relations`, { method: 'POST', body: JSON.stringify({ target_task_id: relationTarget, kind: relationKind }) });
      if (workspace) await loadTask(workspace.id, task.number, task.id);
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
      await loadTask(workspace.id, task.number, task.id);
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
      const [result, indexStatus] = await Promise.all([
        api<{ vaults: Vault[] }>(`/workspaces/${workspace.id}/vaults`),
        api<{ indexing: boolean }>(`/workspaces/${workspace.id}/knowledge/search-status`),
      ]);
      setVaults(result.vaults);
      setKnowledgeIndexing(indexStatus.indexing);
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

  async function searchKnowledge(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace || !knowledgeQuery.trim()) return;
    setKnowledgeSearchError('');
    try {
      const result = await api<{ results: KnowledgeResult[]; count: number; indexing: boolean }>(
        `/workspaces/${workspace.id}/knowledge/search?q=${encodeURIComponent(knowledgeQuery.trim())}`,
      );
      setKnowledgeResults(result.results);
      setKnowledgeCount(result.count);
      setKnowledgeIndexing(result.indexing);
    } catch (reason) {
      setKnowledgeSearchError(reason instanceof Error ? reason.message : 'Could not search Knowledge.');
    }
  }

  async function openKnowledgeResult(result: KnowledgeResult) {
    setShowSkills(false);
    setActiveTab('knowledge');
    setSelectedVaultId(result.vault_id);
    setReaderNote(null);
    setVaultError('');
    try {
      const contents = await api<{ files: string[] }>(`/vaults/${result.vault_id}/contents`);
      setVaultFiles(contents.files);
      await openVaultNote(result.vault_id, result.path);
    } catch (reason) {
      setVaultError(reason instanceof Error ? reason.message : 'Could not open this note.');
    }
  }

  async function reindexVault(vaultId: string) {
    try {
      await api(`/vaults/${vaultId}/search-index`, { method: 'POST', body: '{}' });
      setKnowledgeIndexing(true);
    } catch (reason) {
      setKnowledgeSearchError(reason instanceof Error ? reason.message : 'Could not reindex this Vault.');
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

  const baseTasks = activeView === 'my-work' ? [...workTasks, ...viaTeamTasks] : activeView === 'team-queue' ? teamQueue : activeView === 'list' ? listTasks : tasks;
  const filteredTasks = projectFilter ? baseTasks.filter((item) => item.project_id === projectFilter) : baseTasks;
  // The Workspace list is sorted by the server; other sources (My work, Lists) are sorted here the same way.
  const sortedTasks = sort && activeView !== 'all' ? applySort(filteredTasks, sort, statuses) : filteredTasks;
  const viewTasks = React.useMemo(() => treeOrder(sortedTasks), [sortedTasks]);
  const calendar = useCalendar({
    workspaceId: workspace?.id,
    api,
    tasks: viewTasks,
    onUpdated: (updated) => {
      const replace = (items: Task[]) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item);
      setTasks(replace); setWorkTasks(replace); setViaTeamTasks(replace); setTeamQueue(replace); setListTasks(replace);
      setTask((current) => current && current.id === updated.id ? { ...current, ...updated } : current);
    },
    onError: setError,
    showView: () => { setShowSkills(false); setActiveTab('tasks'); setViewMode('calendar'); },
  });
  const timeline = useTimeline({
    workspaceId: workspace?.id,
    api,
    tasks: viewTasks as TimelineTask[],
    projects,
    active: viewMode === 'timeline',
    liveTick,
    onUpdated: (updated) => {
      const replace = (items: Task[]) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item);
      setTasks(replace); setWorkTasks(replace); setViaTeamTasks(replace); setTeamQueue(replace); setListTasks(replace);
      setTask((current) => current && current.id === updated.id ? { ...current, ...updated } : current);
    },
    onRefresh: async () => { if (workspace) await refresh(workspace.id); },
    onUndo: () => runHistoryAction(false),
    onError: setError,
    showView: () => { setShowSkills(false); setActiveTab('tasks'); setViewMode('timeline'); },
  });
  const scheduleAdmin = useScheduleAdmin(api, workspace?.id, workspace?.role === 'owner' || workspace?.role === 'admin', setError);
  const schedulePaletteCommands = paletteOpen ? scheduleCommands(paletteQuery, scheduleAdmin, () => { closePalette(false); setShowSkills(false); setSettingsSection({ section: 'ai-schedules', nonce: Date.now() }); setActiveTab('settings'); }, workspace?.role === 'owner' || workspace?.role === 'admin') : [];
  const timelinePaletteCommands = paletteOpen ? timelineCommands(paletteQuery, timeline, (item) => { closePalette(false); openPanel(item as Task); }) : [];
  const calendarPaletteCommands = paletteOpen ? calendarCommands(paletteQuery, calendar, (item) => { closePalette(false); openPanel(item as Task); }, async () => { await runHistoryAction(false); }) : [];
  const taskUrl = (value: Task) => `/w/${value.workspace_id}/tasks/${value.number}`;
  const defaultColumns = [...DEFAULT_COLUMNS, ...attributes.map((attribute) => `attribute:${attribute.id}`)];
  const effectiveColumns = activeView === 'list' ? taskLists.find((list) => list.id === selectedListId)?.query.columns ?? ['title', 'status', 'priority'] : viewColumns ?? defaultColumns;
  const selectedColumns = effectiveColumns;
  const showColumn = (column: string) => column === 'title' || effectiveColumns.includes(column) || effectiveColumns.includes(COLUMN_ALIASES[column] ?? '');
  const selectedTasks = tasks.filter((item) => selectedTaskIds.includes(item.id));
  const staleItemIds = proposal?.stale_items ?? [];
  const proposalBlocked = proposalStale || staleItemIds.length > 0;
  const bulkAttributes = attributes.filter((attribute) => attribute.type === 'single_select' && selectedTasks.length > 1 && selectedTasks.every((item) => attribute.project_ids?.includes(item.project_id)));
  const milestoneTarget = task ?? viewTasks[focusedRowIndex];
  const paletteMilestoneQuery = paletteQuery.trim().match(/^milestone(?:\s+(.*))?$/i);
  const paletteResults = paletteSearchResults;
  const virtualEnd = Math.min(viewTasks.length, virtualStart + WINDOW);
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
    // The scroll container owns the window: moving the scroll position moves the rendered rows (see onScroll in the table).
    const scroller = gridRef.current?.closest<HTMLElement>('.table-scroll');
    if (scroller && viewTasks[next]) {
      const top = next * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT + HEADER_HEIGHT;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
    }
  }
  async function createOutlineChild(parent: Task) {
    if (!workspace) return;
    try {
      const child = await api<Task>(`/workspaces/${workspace.id}/tasks`, { method: 'POST', body: JSON.stringify({ project_id: parent.project_id, parent_task_id: parent.id, title: 'New subtask' }) });
      appendTask(child);
      pendingFocusId.current = child.id;
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
      if (event.key === 'Tab' && edited) { event.preventDefault(); event.stopPropagation(); void indentTask(edited, event.shiftKey); }
      return;
    }
    const focusedTask = viewTasks[focusedRowIndex];
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && focusedTask) {
      event.preventDefault();
      stepRow(focusedTask, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && focusedTask) {
      event.preventDefault();
      openPanel(focusedTask, event.shiftKey);
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
  return {
    workspace,
    setWorkspace,
    workspaceChoices,
    setWorkspaceChoices,
    needsWorkspaceChoice,
    setNeedsWorkspaceChoice,
    projects,
    setProjects,
    vaults,
    setVaults,
    selectedVaultId,
    setSelectedVaultId,
    vaultFiles,
    setVaultFiles,
    readerNote,
    setReaderNote,
    readerBacklinks,
    setReaderBacklinks,
    readerHistory,
    setReaderHistory,
    readerError,
    setReaderError,
    vaultError,
    setVaultError,
    members,
    setMembers,
    teams,
    setTeams,
    skills,
    setSkills,
    selectedSkill,
    setSelectedSkill,
    skillDraft,
    setSkillDraft,
    editingSkill,
    setEditingSkill,
    showSkills,
    setShowSkills,
    tasks,
    setTasks,
    inboxEntries,
    setInboxEntries,
    watchPreferences,
    setWatchPreferences,
    taskLists,
    setTaskLists,
    selectedListId,
    setSelectedListId,
    viewMode,
    setViewMode,
    newListName,
    setNewListName,
    smartStatus,
    setSmartStatus,
    smartRelativeDate,
    setSmartRelativeDate,
    smartAttribute,
    setSmartAttribute,
    smartAttributeValue,
    setSmartAttributeValue,
    smartAssignee,
    setSmartAssignee,
    smartIncludeTeam,
    setSmartIncludeTeam,
    smartLogic,
    setSmartLogic,
    smartSort,
    setSmartSort,
    smartGroup,
    setSmartGroup,
    smartColumns,
    setSmartColumns,
    statuses,
    setStatuses,
    attributes,
    setAttributes,
    taskAttributes,
    setTaskAttributes,
    attributeDraft,
    setAttributeDraft,
    tableAttributeDrafts,
    setTableAttributeDrafts,
    workTasks,
    setWorkTasks,
    viaTeamTasks,
    setViaTeamTasks,
    teamQueue,
    setTeamQueue,
    activeView,
    setActiveView,
    selectedTeam,
    setSelectedTeam,
    teamName,
    setTeamName,
    teamMembers,
    setTeamMembers,
    teamMemberDrafts,
    setTeamMemberDrafts,
    teamGrants,
    setTeamGrants,
    grantTeam,
    setGrantTeam,
    grantRole,
    setGrantRole,
    selectedProject,
    setSelectedProject,
    title,
    setTitle,
    importJson,
    setImportJson,
    importPreview,
    setImportPreview,
    importMessage,
    setImportMessage,
    task,
    setTask,
    draft,
    setDraft,
    error,
    setError,
    conflict,
    setConflict,
    moveTarget,
    setMoveTarget,
    preview,
    setPreview,
    fullPage,
    setFullPage,
    signedIn,
    setSignedIn,
    email,
    setEmail,
    password,
    setPassword,
    subtaskTitle,
    setSubtaskTitle,
    checklistTitle,
    setChecklistTitle,
    relationTarget,
    setRelationTarget,
    relationKind,
    setRelationKind,
    comments,
    setComments,
    taskFromComment,
    setTaskFromComment,
    commentBody,
    setCommentBody,
    commentFiles,
    setCommentFiles,
    referenceSuggestions,
    setReferenceSuggestions,
    mentionSuggestions,
    setMentionSuggestions,
    referenceSuggestionIndex,
    setReferenceSuggestionIndex,
    noteReferenceSuggestions,
    setNoteReferenceSuggestions,
    noteReferenceSuggestionIndex,
    setNoteReferenceSuggestionIndex,
    discussionFilter,
    setDiscussionFilter,
    replyToComment,
    setReplyToComment,
    timelineItems,
    setTimelineItems,
    backlinks,
    setBacklinks,
    editingComment,
    setEditingComment,
    searchQuery,
    setSearchQuery,
    searchResults,
    setSearchResults,
    searchCount,
    setSearchCount,
    knowledgeQuery,
    setKnowledgeQuery,
    knowledgeResults,
    setKnowledgeResults,
    knowledgeCount,
    setKnowledgeCount,
    knowledgeIndexing,
    setKnowledgeIndexing,
    knowledgeSearchError,
    setKnowledgeSearchError,
    keyboardMode,
    setKeyboardMode,
    focusedRowIndex,
    setFocusedRowIndex,
    selectedTaskIds,
    setSelectedTaskIds,
    selectionAnchor,
    setSelectionAnchor,
    editingTaskId,
    setEditingTaskId,
    inlineTitle,
    setInlineTitle,
    paletteOpen,
    setPaletteOpen,
    milestoneEpoch,
    setMilestoneEpoch,
    savingMilestone,
    setSavingMilestone,
    activeTab,
    setActiveTab,
    newTaskOpen,
    setNewTaskOpen,
    newListOpen,
    setNewListOpen,
    projectDialogOpen,
    setProjectDialogOpen,
    teamsOpen,
    setTeamsOpen,
    projectFilter,
    setProjectFilter,
    saveState,
    setSaveState,
    taskMoreOpen,
    setTaskMoreOpen,
    templatesOpen,
    setTemplatesOpen,
    exportNotice,
    setExportNotice,
    proposal,
    setProposal,
    proposalStale,
    setProposalStale,
    proposalBusy,
    setProposalBusy,
    proposalApplying,
    setProposalApplying,
    proposalMessage,
    setProposalMessage,
    proposalDetail,
    setProposalDetail,
    aiAvailability,
    setAiAvailability,
    generateOpen,
    setGenerateOpen,
    generateGoal,
    setGenerateGoal,
    generateCapability,
    setGenerateCapability,
    generateFocus,
    setGenerateFocus,
    generation,
    setGeneration,
    runNotes,
    setRunNotes,
    moreOpen,
    setMoreOpen,
    offline,
    setOffline,
    realtimeConnected,
    setRealtimeConnected,
    liveTick,
    setLiveTick,
    settingsSection,
    setSettingsSection,
    paletteQuery,
    setPaletteQuery,
    paletteSearchResults,
    setPaletteSearchResults,
    paletteSearchError,
    setPaletteSearchError,
    paletteNoteResults,
    setPaletteNoteResults,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    virtualStart,
    setVirtualStart,
    projectsLoadedFor,
    setProjectsLoadedFor,
    listTasks,
    setListTasks,
    listTotal,
    setListTotal,
    commentDraft,
    commentInput,
    savingRef,
    failedDraft,
    gPending,
    proposalRef,
    focusReview,
    clearLocalSession,
    composing,
    taskRef,
    commentsSeq,
    draftRef,
    taskAttributesRef,
    attributeDraftRef,
    focusReturn,
    gridRef,
    paletteInputRef,
    taskAppendEpoch,
    appendTask,
    refreshSeq,
    refresh,
    loadTask,
    baseTasks,
    viewTasks,
    calendar,
    timeline,
    scheduleAdmin,
    schedulePaletteCommands,
    timelinePaletteCommands,
    calendarPaletteCommands,
    taskUrl,
    selectedColumns,
    showColumn,
    selectedTasks,
    staleItemIds,
    proposalBlocked,
    bulkAttributes,
    milestoneTarget,
    paletteMilestoneQuery,
    paletteResults,
    virtualEnd,
    visibleTasks,
    signIn,
    chooseWorkspace,
    signOut,
    createProject,
    createMockProposal,
    toggleProposalItem,
    savePlan,
    editProposalItem,
    rejectProposalItem,
    mergeProposalItems,
    openGenerate,
    openSuggest,
    closeGenerate,
    openProposalById,
    finishGeneration,
    regenerateRow,
    refreshProposal,
    removeStaleProposalItems,
    refreshStaleProposalItems,
    refreshStaleItems,
    removeStaleItems,
    approveProposal,
    undoProposal,
    createTask,
    createList,
    changeListMembership,
    groupLabel,
    openList,
    moveKanbanColumn,
    searchTasks,
    updateCommentBody,
    insertReference,
    insertNoteReference,
    insertMention,
    attachmentProblem,
    saveComment,
    refreshComments,
    toggleReaction,
    deleteComment,
    createTaskFromComment,
    restoreFocus,
    openShortcutHelp,
    commentKeyDown,
    openMenu,
    closeMenu,
    openTemplates,
    goTo,
    openNewTask,
    flushAndClose,
    openPalette,
    closePalette,
    closeTaskPanel,
    reportWriteError,
    saveInlineTitle,
    updateTaskStatus,
    updateTaskMilestone,
    updateTaskAttribute,
    bulkSetStatus,
    bulkSetAttribute,
    runHistoryAction,
    exportView,
    runPaletteCommand,
    openPanel,
    saveTask,
    previewMove,
    archive,
    duplicate,
    taskDepth,
    createSubtask,
    createChecklistItem,
    toggleChecklist,
    addRelation,
    removeRelation,
    takeTask,
    refreshTeams,
    createTeam,
    renameTeam,
    deleteTeam,
    loadTeamMembers,
    changeTeamMember,
    showMyWork,
    showKnowledge,
    openVaultContents,
    openVaultNote,
    searchKnowledge,
    openKnowledgeResult,
    reindexVault,
    followReaderLink,
    showTeamQueue,
    addProjectTeamGrant,
    removeProjectTeamGrant,
    saveSkill,
    openSkill,
    archiveSkill,
    focusRow,
    createOutlineChild,
    handleGridKeyDown,
    sort, changeSort, viewColumns, changeColumns, effectiveColumns, defaultColumns, viewProjectId,
    creatingRow, setCreatingRow, creatingInColumn, setCreatingInColumn,
    announcement, announce, detailTab, setDetailTab, attributeDialogOpen, setAttributeDialogOpen,
    newTaskDraft, setNewTaskDraft, pendingFocusId,
    createInlineTask, writeAttributeValues, patchTask, replaceTask, updateTaskAssignees, updateTaskPriority, updateTaskDate,
    moveTask, reorderRow, stepRow, dropOnBoard, indentTask, isSibling,
  };
}

export type App = ReturnType<typeof useAppState>;
