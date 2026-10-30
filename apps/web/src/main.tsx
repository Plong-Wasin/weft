import React from 'react';
import { MilestonePanel, MilestoneSelect, PaletteMilestones, type TaskMilestone } from './milestones';

function sandboxedHtmlPreview(source: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'"><body>${source}</body>`;
}
import { createRoot } from 'react-dom/client';
import './style.css';
import { GenerateDialog, defaultFocusPrompt, loadAiAvailability, runGeneration, runStateLabel, type AiAvailability, type AiCapability, type AiFocusTask, type GenerationContext, type RunNotes } from './generate';
import { ProposalRowEditor, applyRegeneratedRow, approvalSummary, guessLines, mergeItems, rejectItem, rowName, sourceLabel, itemName, untickBrokenLinks } from './proposal-review';

type Workspace = { id: string; name: string; role: string };
type Skill = { id: string; name: string; description: string; body?: string; enabled: boolean; version: number };
type Project = { id: string; name: string; visibility: string };
type Vault = { id: string; workspace_id: string; name: string; visibility: string; role: string };
type ReaderNote = { path: string; format: 'markdown' | 'source' | 'html_page'; html?: string; source?: string; page_url?: string; title?: string; visible_text?: string; properties?: Record<string, string>; aliases?: string[]; tags?: string[]; links?: { target: string; embed: boolean; resolution: { status: string; path?: string; candidate?: string } }[] };
type Member = { id: string; email: string; role: string };
type ChecklistItem = { id: string; title: string; checked: boolean; position: number; version: number };
type TaskRelation = { task_id: string; number: number; title: string; kind: string };
type Task = { milestone_id?: string | null; milestone?: TaskMilestone | null; id: string; number: number; workspace_id: string; project_id: string; parent_task_id: string | null; title: string; description: string; description_html?: string; status: string; priority: string; start_date: string | null; due_date: string | null; attributes: Record<string, unknown>; watchers: string[]; assignees: Assignee[]; subtasks: { id: string; number: number; title: string }[]; checklist: ChecklistItem[]; relations: TaskRelation[]; similar_tasks?: { id: string; number: number; title: string; similarity: number }[]; similar_tasks_complete?: boolean; version: number; archived_at: string | null; created_from?: { task_id: string; task_number: number; comment_id: string } | null };
type Team = { id: string; name: string };
type Assignee = { type: 'user' | 'team'; id: string; name: string };
type TeamGrant = { team_id: string; name: string; role: string };
type MovePreview = { milestone_effect?: { clears: boolean; tasks_cleared: number; milestone: { name: string } | null }; destination_visibility: string; subtasks_affected: number; relations_affected: number; destination_members: { user_id: string; role: string }[] };
type Status = { id: string; key: string; name: string; category: string; color: string; position: number; archived: boolean };
type Attribute = { id: string; name: string; type: string; project_ids: string[]; options: { id: string; key: string; name: string }[]; archived: boolean };
type TaskAttribute = { id: string; name: string; type: string; value: unknown };
type CommentAttachment = { id: string; storage_key: string; file_name: string; content_type: string; size: number; download_url: string; preview_url: string | null };
type Comment = { id: string; body: string; html: string; author_id: string; edited: boolean; attachments?: CommentAttachment[]; reply_to?: string | null; quote?: { id: string; body: string } | null; reactions?: { emoji: string; count: number; reacted: boolean }[]; created_tasks?: { id: string; number: number; title: string }[] };
type MentionSuggestion = { id: string; label: string; mention: string };
type InboxEntry = { id: string; task: { id: string; number: number; title: string; status: string }; reason: string; reasons: string[]; operation_group_id: string | null; created_at: string; unread_count: number; read: boolean };
type WatchPreferences = { task_id: string; watching: boolean; events: string[]; muted: boolean };
type TimelineItem = { kind: string; id: string; body?: string; html?: string; attachments?: CommentAttachment[]; edited?: boolean; created_at: string; field?: string; before?: unknown; after?: unknown; reply_to?: string | null; quote?: { id: string; body: string } | null; reactions?: { emoji: string; count: number; reacted: boolean }[] };
type ReferenceSuggestion = { id: string; number: number; title: string; status: string };
type Backlink = { source_kind: string; task_number: number; task_title: string; comment_id: string | null; position: number; snippet?: string | null };
type SearchResult = { task_id: string; task_number: number; title: string; snippet: string };
type KnowledgeResult = { vault_id: string; vault_name: string; path: string; title: string; snippet?: string };
type TaskList = { id: string; name: string; kind: 'manual' | 'smart'; query: { filters: { field: string; op: string; value: unknown }[]; logic: 'and' | 'or'; sort?: unknown[]; group?: string | null; columns?: string[] } };
type ProposalItem = { id: string; kind: 'task' | 'relation' | 'note_edit' | 'file_add' | 'skill' | 'schema'; title?: string; name?: string; path?: string; reason: string; sources: string[]; selected: boolean; depends_on?: string[]; [key: string]: unknown };
type Proposal = { id: string; revision: number; status: string; items: ProposalItem[]; stale_items?: string[]; remaining_in_original?: string[]; assumptions?: string[]; open_questions?: string[]; provider?: string | null; ai_run_id?: string | null; scope?: { project_ids?: string[]; vault_ids?: string[] } };
type McpToken = { id: string; name: string; capabilities: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null };
type Session = { id: string; created_at: string; expires_at: string; current: boolean };
type AiUsage = {
  period_days: number;
  policies: { connection_id: string; provider: string; billing_mode: string; global_concurrency: number; per_user_concurrency: number; daily_run_budget: number; daily_token_budget: number }[];
  totals: { runs: number; limited_runs: number; input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number; unknown: boolean };
  users: { user_id: string; email: string; runs: number; limited_runs: number; usage: { input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number; unknown: boolean } }[];
};

const proposalGroups: { kind: ProposalItem['kind']; label: string }[] = [
  { kind: 'task', label: 'Tasks' },
  { kind: 'relation', label: 'Links' },
  { kind: 'note_edit', label: 'Knowledge' },
  { kind: 'file_add', label: 'Knowledge' },
  { kind: 'skill', label: 'Skills' },
  { kind: 'schema', label: 'Schema' },
];

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
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase()) && !navigator.onLine) {
    throw new Error('Weft is offline and read-only. Reconnect to make changes.');
  }
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) headers.set('x-csrf-token', csrf());
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
  if (response.status === 401) window.dispatchEvent(new Event('weft:unauthorized'));
  if (!response.ok) throw Object.assign(new Error(readableError(response.status, body)), { status: response.status, body });
  return body as T;
}

const MAX_COMMENT_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TASK_ATTACHMENT_BYTES = 64 * 1024 * 1024;

// Server error codes that reach a person as-is; any other code stays as the server sent it.
const errorMessages: Record<string, string> = {
  attachment_quota_exceeded: 'Attachment limit reached: a comment holds at most 10 files and a Task at most 64 MiB in total (across all its comments).',
  file_already_exists: 'A file with that name already exists in the Vault, so it was not added.',
  milestone_unavailable: 'That Milestone is not available: choose a Milestone of the Task\'s own Project.',
  detach_required: 'Choose what happens to the Tasks of this Milestone before archiving it.'
};

function readableError(status: number, body: { error?: string; detail?: string } | undefined) {
  const known = (body?.detail && errorMessages[body.detail]) || (body?.error && errorMessages[body.error]);
  if (known) return known;
  if (body?.error) return body.error;
  return status === 413 ? 'That upload is too large: each file can be at most 10 MiB.' : `Request failed (${status})`;
}

async function clearClientCaches() {
  if (!('caches' in window)) return;
  try {
    await Promise.all((await caches.keys()).filter((name) => !name.startsWith('weft-shell-')).map((name) => caches.delete(name)));
  } catch { /* Cache cleanup must not prevent sign-in or sign-out. */ }
}

function SettingsScreen({ workspace, projects, onSignOut, onRefresh }: { workspace: Workspace; projects: Project[]; onSignOut: () => void; onRefresh: () => Promise<void> }) {
  const [section, setSection] = React.useState<'sessions' | 'statuses' | 'attributes' | 'tokens' | 'team-ai' | 'ai-usage'>('sessions');
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [statuses, setStatuses] = React.useState<Status[]>([]);
  const [attributes, setAttributes] = React.useState<Attribute[]>([]);
  const [aiUsage, setAiUsage] = React.useState<AiUsage | null>(null);
  const [teamAi, setTeamAi] = React.useState<{ connection: { provider: string; billing_mode: string; state: string; state_reason: string } | null; source: string; run_notice?: string; message?: string } | null>(null);
  const [mcpTokens, setMcpTokens] = React.useState<McpToken[]>([]);
  const [tokenName, setTokenName] = React.useState('');
  const [tokenCapabilities, setTokenCapabilities] = React.useState<string[]>(['read']);
  const [newSecret, setNewSecret] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [name, setName] = React.useState('');
  const [category, setCategory] = React.useState('not_started');
  const [color, setColor] = React.useState('#64748b');
  const [type, setType] = React.useState('text');
  const [selectedProjects, setSelectedProjects] = React.useState<string[]>([]);
  const [optionsText, setOptionsText] = React.useState('');
  const [archivePreview, setArchivePreview] = React.useState<{ id: string; affected_tasks: number; affected_views: number } | null>(null);
  const [attributeArchivePreview, setAttributeArchivePreview] = React.useState<{ id: string; affected_views: number } | null>(null);
  const [addingOptionTo, setAddingOptionTo] = React.useState<string | null>(null);
  const [newOptionName, setNewOptionName] = React.useState('');
  const admin = workspace.role === 'owner' || workspace.role === 'admin';

  const load = React.useCallback(async () => {
    const [sessionResult, statusResult, attributeResult, tokenResult] = await Promise.all([
      api<{ sessions: Session[] }>('/auth/sessions'),
      api<{ statuses: Status[] }>(`/workspaces/${workspace.id}/statuses`),
      api<{ attributes: Attribute[] }>(`/workspaces/${workspace.id}/attributes`),
      api<{ tokens: McpToken[] }>(`/workspaces/${workspace.id}/mcp-tokens`),
    ]);
    setMcpTokens(tokenResult.tokens);
    setSessions(sessionResult.sessions);
    setStatuses(statusResult.statuses);
    setAttributes(attributeResult.attributes);
  }, [workspace.id]);
  React.useEffect(() => { void load().catch((reason) => setMessage(reason instanceof Error ? reason.message : 'Could not load Settings.')); }, [load]);
  React.useEffect(() => {
    if (section !== 'team-ai') return;
    void api<NonNullable<typeof teamAi>>(`/ai/defaults?workspace_id=${workspace.id}`).then(setTeamAi).catch((reason) => setMessage(reason instanceof Error ? reason.message : 'Could not load Team AI.'));
  }, [section, workspace.id]);
  React.useEffect(() => {
    if (section !== 'ai-usage' || !admin) return;
    void api<AiUsage>(`/ai/usage?workspace_id=${workspace.id}`).then(setAiUsage).catch((reason) => setMessage(reason instanceof Error ? reason.message : 'Could not load AI usage.'));
  }, [section, admin, workspace.id]);

  async function createMcpToken(event: React.FormEvent) {
    event.preventDefault();
    try {
      const created = await api<McpToken & { token: string }>(`/workspaces/${workspace.id}/mcp-tokens`, { method: 'POST', body: JSON.stringify({ name: tokenName, capabilities: tokenCapabilities }) });
      setNewSecret(created.token); setTokenName(''); await load(); setMessage('Token created. Copy it now; it is shown only once.');
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not create token.'); }
  }
  async function revokeMcpToken(token: McpToken) {
    try { await api(`/workspaces/${workspace.id}/mcp-tokens/${token.id}`, { method: 'DELETE' }); await load(); setMessage('Token revoked.'); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not revoke token.'); }
  }
  async function saveStatus(status: Status, patch: Partial<Status>) {
    try {
      await api(`/workspaces/${workspace.id}/statuses/${status.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await load(); await onRefresh(); setMessage('Status saved.');
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not save Status.'); }
  }
  async function createStatus(event: React.FormEvent) {
    event.preventDefault();
    try { await api(`/workspaces/${workspace.id}/statuses`, { method: 'POST', body: JSON.stringify({ name, category, color }) }); setName(''); await load(); await onRefresh(); setMessage('Status created.'); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not create Status.'); }
  }
  async function moveStatus(status: Status, delta: number) {
    const active = statuses.filter((item) => !item.archived).sort((a, b) => a.position - b.position);
    const from = active.findIndex((item) => item.id === status.id); const to = from + delta;
    if (to < 0 || to >= active.length) return;
    [active[from], active[to]] = [active[to], active[from]];
    try { await api(`/workspaces/${workspace.id}/statuses/reorder`, { method: 'POST', body: JSON.stringify({ status_ids: active.map((item) => item.id) }) }); await load(); await onRefresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not reorder Statuses.'); }
  }
  async function previewStatus(status: Status) {
    try { const preview = await api<{ affected_tasks: number; affected_views: number }>(`/workspaces/${workspace.id}/statuses/${status.id}/archive-preview`); setArchivePreview({ id: status.id, ...preview }); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not preview archive effects.'); }
  }
  async function archiveStatus(status: Status, replacement: string) {
    try { await api(`/workspaces/${workspace.id}/statuses/${status.id}/archive`, { method: 'POST', body: JSON.stringify({ replacement_id: replacement || null }) }); setArchivePreview(null); await load(); await onRefresh(); setMessage('Status archived.'); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not archive Status.'); }
  }
  async function createAttribute(event: React.FormEvent) {
    event.preventDefault();
    const options = optionsText.split(',').map((item) => item.trim()).filter(Boolean);
    try {
      await api(`/workspaces/${workspace.id}/attributes`, { method: 'POST', body: JSON.stringify({ name, value_type: type, project_ids: selectedProjects, ...(type === 'single_select' || type === 'multi_select' ? { options } : {}) }) });
      setName(''); setOptionsText(''); setSelectedProjects([]); await load(); await onRefresh(); setMessage('Attribute created.');
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not create Attribute.'); }
  }
  async function updateAttribute(attribute: Attribute, patch: Record<string, unknown>) {
    try { await api(`/workspaces/${workspace.id}/attributes/${attribute.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); await load(); await onRefresh(); setMessage('Attribute saved.'); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not update Attribute.'); }
  }
  async function previewAttributeArchive(attribute: Attribute) {
    try { const preview = await api<{ affected_views: number }>(`/workspaces/${workspace.id}/attributes/${attribute.id}/archive-preview`); setAttributeArchivePreview({ id: attribute.id, ...preview }); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not preview Attribute archive effects.'); }
  }
  async function updateOption(attribute: Attribute, option: Attribute['options'][number], patch: Record<string, unknown>) {
    try { await api(`/workspaces/${workspace.id}/attributes/${attribute.id}/options/${option.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); await load(); await onRefresh(); setMessage('Option saved.'); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not update option.'); }
  }

  return <section className="settings-screen" aria-label="Settings"><h2>Settings</h2>
    <nav className="settings-nav" aria-label="Settings sections">
      {(['sessions', 'statuses', 'attributes'] as const).map((item) => <button type="button" key={item} className={section === item ? '' : 'secondary'} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>{item === 'sessions' ? 'Sessions' : item === 'statuses' ? 'Statuses' : 'Attributes'}</button>)}
      <button type="button" className={section === 'tokens' ? '' : 'secondary'} aria-current={section === 'tokens' ? 'page' : undefined} onClick={() => setSection('tokens')}>AI tokens</button>
      <button type="button" className={section === 'team-ai' ? '' : 'secondary'} aria-current={section === 'team-ai' ? 'page' : undefined} onClick={() => setSection('team-ai')}>Team AI</button>
      {admin && <button type="button" className={section === 'ai-usage' ? '' : 'secondary'} aria-current={section === 'ai-usage' ? 'page' : undefined} onClick={() => setSection('ai-usage')}>AI usage</button>}
    </nav>
    {message && <p role="status" className="settings-message">{message}</p>}
    {section === 'sessions' && <section aria-label="Active sessions"><h3>Active sessions</h3><p className="muted">Revoke a session to sign that device out.</p>{sessions.length === 0 ? <p>No active sessions.</p> : <ul className="settings-list">{sessions.map((session) => <li key={session.id}><span><strong>{session.current ? 'This device' : 'Signed-in device'}</strong><small>Signed in {new Date(session.created_at).toLocaleString()} · expires {new Date(session.expires_at).toLocaleDateString()}</small></span><button type="button" className="danger" onClick={async () => { if (session.current) { onSignOut(); return; } try { await api(`/auth/sessions/${session.id}`, { method: 'DELETE' }); await load(); setMessage('Session revoked.'); } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not revoke session.'); } }}>Revoke</button></li>)}</ul>}<button type="button" className="danger" onClick={onSignOut}>Sign out</button></section>}
    {section === 'team-ai' && <section aria-label="Team AI"><h3>Use team AI</h3>{!teamAi ? <p role="status">Loading Team AI…</p> : !teamAi.connection ? <p>{teamAi.message ?? 'No shared AI connection is set up. Ask a Workspace admin.'}</p> : <p>{teamAi.connection.state === 'ready' ? `Ready: members can generate without signing in to the provider. ${teamAi.run_notice ?? ''}` : `Shared AI is not ready: ${teamAi.connection.state_reason}`} Your runs only read Projects you can already open, and your sessions stay private to you.</p>}</section>}
    {section === 'ai-usage' && admin && <section aria-label="AI usage"><h3>AI usage · last {aiUsage?.period_days ?? 30} days</h3><p className="muted">Usage is attributed to members and contains no prompt or Task content. Provider-reported usage stays unknown when the provider does not report it.</p>{!aiUsage ? <p role="status">Loading AI usage…</p> : <><div className="settings-fields"><p><strong>{aiUsage.totals.runs}</strong><small>Runs</small></p><p><strong>{aiUsage.totals.limited_runs}</strong><small>Limited or failed</small></p><p><strong>{aiUsage.totals.unknown ? 'Unknown' : `${aiUsage.totals.total_tokens.toLocaleString()} tokens`}</strong><small>Provider-reported usage</small></p><p><strong>{aiUsage.totals.unknown ? 'Unknown' : `$${aiUsage.totals.cost_usd.toFixed(4)}`}</strong><small>Reported API cost</small></p></div><h4>Connection limits</h4><ul className="settings-list">{aiUsage.policies.map((policy) => <li key={policy.connection_id}><span><strong>{policy.provider} · {policy.billing_mode}</strong><small>{policy.global_concurrency} concurrent runs globally · {policy.per_user_concurrency} per member · {policy.daily_run_budget} runs per member daily{policy.daily_token_budget ? ` · ${policy.daily_token_budget.toLocaleString()} tokens per member daily` : ''}</small></span></li>)}</ul><h4>Usage by member</h4>{aiUsage.users.length === 0 ? <p>No AI runs in this period.</p> : <ul className="settings-list">{aiUsage.users.map((user) => <li key={user.user_id}><span><strong>{user.email}</strong><small>{user.runs} runs · {user.limited_runs} limited or failed · {user.usage.unknown ? 'Provider usage unknown' : `${user.usage.total_tokens.toLocaleString()} reported tokens`}{!user.usage.unknown && ` · $${user.usage.cost_usd.toFixed(4)}`}</small></span></li>)}</ul>}</>}</section>}
    {section === 'statuses' && <section aria-label="Statuses"><h3>Statuses</h3>{!admin && <p className="muted">Read-only · Workspace admins manage Statuses.</p>}{admin && <form className="settings-create" onSubmit={createStatus}><label>Status name<input aria-label="New Status name" value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Category<select aria-label="New Status category" value={category} onChange={(event) => setCategory(event.target.value)}><option value="not_started">Not started</option><option value="active">Active</option><option value="completed">Completed</option><option value="canceled">Canceled</option></select></label><label>Color<input aria-label="New Status color" type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label><button>Create Status</button></form>}
      <ul className="settings-list">{[...statuses].sort((a, b) => a.position - b.position).map((status) => <li key={status.id} className={status.archived ? 'archived-row' : ''}><div className="settings-fields"><label>Name<input aria-label={`Name for ${status.name}`} disabled={!admin || status.archived} defaultValue={status.name} onBlur={(event) => { if (event.target.value !== status.name) void saveStatus(status, { name: event.target.value }); }} /></label><label>Category<select aria-label={`Category for ${status.name}`} disabled={!admin || status.archived} value={status.category} onChange={(event) => void saveStatus(status, { category: event.target.value })}><option value="not_started">Not started</option><option value="active">Active</option><option value="completed">Completed</option><option value="canceled">Canceled</option></select></label><label>Color<input aria-label={`Color for ${status.name}`} disabled={!admin || status.archived} type="color" value={status.color} onChange={(event) => void saveStatus(status, { color: event.target.value })} /></label></div>{admin && !status.archived && <div className="actions"><button type="button" className="secondary" aria-label={`Move ${status.name} up`} onClick={() => void moveStatus(status, -1)}>Move up</button><button type="button" className="secondary" aria-label={`Move ${status.name} down`} onClick={() => void moveStatus(status, 1)}>Move down</button><button type="button" className="danger" onClick={() => void previewStatus(status)}>Archive</button></div>}{archivePreview?.id === status.id && <div className="archive-preview" role="group" aria-label={`Archive preview for ${status.name}`}><p>This affects {archivePreview.affected_tasks} tasks and {archivePreview.affected_views} views.</p><label>Replacement Status<select aria-label="Replacement Status" defaultValue=""><option value="">Choose replacement</option>{statuses.filter((item) => !item.archived && item.id !== status.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" disabled={statuses.filter((item) => !item.archived && item.id !== status.id).length === 0} onClick={(event) => { const replacement = event.currentTarget.parentElement?.querySelector('select')?.value ?? ''; if (replacement) void archiveStatus(status, replacement); }}>Confirm archive</button><button type="button" className="secondary" onClick={() => setArchivePreview(null)}>Cancel</button></div>}</li>)}</ul>
    </section>}
    {section === 'tokens' && <section aria-label="AI tokens"><h3>AI tokens</h3><p className="muted">Connect your own Claude or Codex client at <code>{window.location.origin}/api/v1/mcp</code>. A token can read and propose only what you can; a person must still approve every Proposal here.</p>
      <form className="settings-create" onSubmit={createMcpToken}><label>Token name<input aria-label="New token name" value={tokenName} onChange={(event) => setTokenName(event.target.value)} required maxLength={100} /></label>
        <fieldset><legend>Capabilities</legend>{[['read', 'Read tasks and notes'], ['generate', 'Propose new tasks'], ['split', 'Propose splits'], ['link', 'Propose links']].map(([value, label]) => <label className="check-option" key={value}><input type="checkbox" checked={tokenCapabilities.includes(value)} onChange={(event) => setTokenCapabilities((current) => event.target.checked ? [...current, value] : current.filter((item) => item !== value))} />{label}</label>)}</fieldset>
        <button disabled={tokenCapabilities.length === 0}>Create token</button></form>
      {newSecret && <div role="group" aria-label="New token secret"><p>Copy this token now. It is shown only once.</p><code>{newSecret}</code> <button type="button" className="secondary" onClick={() => setNewSecret('')}>Done</button></div>}
      {mcpTokens.length === 0 ? <p>No tokens.</p> : <ul className="settings-list">{mcpTokens.map((token) => <li key={token.id} className={token.revoked_at ? 'archived-row' : ''}><span><strong>{token.name}</strong><small>{token.capabilities.join(', ')} · created {new Date(token.created_at).toLocaleDateString()}{token.last_used_at ? ` · last used ${new Date(token.last_used_at).toLocaleString()}` : ' · never used'}{token.revoked_at ? ' · revoked' : ''}</small></span>{!token.revoked_at && <button type="button" className="danger" aria-label={`Revoke token ${token.name}`} onClick={() => void revokeMcpToken(token)}>Revoke</button>}</li>)}</ul>}
    </section>}
    {section === 'attributes' && <section aria-label="Attributes"><h3>Attributes</h3>{!admin && <p className="muted">Read-only · Workspace admins manage Attributes.</p>}{admin && <form className="settings-create" onSubmit={createAttribute}><label>Attribute name<input aria-label="New Attribute name" value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Type<select aria-label="New Attribute type" value={type} onChange={(event) => setType(event.target.value)}>{[['text','Text'],['number','Number'],['date','Date'],['user','User'],['single_select','Single select'],['multi_select','Multi select']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>{(type === 'single_select' || type === 'multi_select') && <label>Options, separated by commas<input aria-label="Attribute options" value={optionsText} onChange={(event) => setOptionsText(event.target.value)} required /></label>}<fieldset><legend>Projects</legend>{projects.map((project) => <label className="check-option" key={project.id}><input type="checkbox" checked={selectedProjects.includes(project.id)} onChange={(event) => setSelectedProjects((current) => event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id))} />{project.name}</label>)}</fieldset><button>Create Attribute</button></form>}
      <ul className="settings-list">{attributes.map((attribute) => <li key={attribute.id} className={attribute.archived ? 'archived-row' : ''}><div className="settings-fields"><label>Name<input aria-label={`Name for ${attribute.name}`} disabled={!admin || attribute.archived} defaultValue={attribute.name} onBlur={(event) => { if (event.target.value !== attribute.name) void updateAttribute(attribute, { name: event.target.value }); }} /></label><span>{attribute.type.replace('_', ' ')}</span><span>{attribute.project_ids.map((id) => projects.find((project) => project.id === id)?.name).filter(Boolean).join(', ') || 'No Projects'}</span></div>{attribute.options.map((option) => <div className="settings-option" key={option.id}><label>{option.name}<input aria-label={`Rename option ${option.name}`} disabled={!admin || attribute.archived} defaultValue={option.name} onBlur={(event) => { if (event.target.value !== option.name) void updateOption(attribute, option, { name: event.target.value }); }} /></label>{admin && !attribute.archived && <button type="button" className="secondary" onClick={() => void updateOption(attribute, option, { archived: true })}>Archive option</button>}</div>)}{addingOptionTo === attribute.id && <form className="settings-option" onSubmit={async (event) => { event.preventDefault(); try { await api(`/workspaces/${workspace.id}/attributes/${attribute.id}/options`, { method: 'POST', body: JSON.stringify({ name: newOptionName }) }); setAddingOptionTo(null); setNewOptionName(''); await load(); setMessage('Option added.'); } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not add option.'); } }}><label>New option<input aria-label="New option name" autoFocus value={newOptionName} onChange={(event) => setNewOptionName(event.target.value)} required /></label><button type="submit">Save option</button><button type="button" className="secondary" onClick={() => { setAddingOptionTo(null); setNewOptionName(''); }}>Cancel</button></form>}{attributeArchivePreview?.id === attribute.id && <div className="archive-preview" role="group" aria-label={`Archive preview for ${attribute.name}`}><p>This affects {attributeArchivePreview.affected_views} saved views.</p><button type="button" className="danger" onClick={() => { setAttributeArchivePreview(null); void updateAttribute(attribute, { archived: true }); }}>Confirm archive</button><button type="button" className="secondary" onClick={() => setAttributeArchivePreview(null)}>Cancel</button></div>}{admin && !attribute.archived && <div className="actions">{['single_select', 'multi_select'].includes(attribute.type) && <button type="button" className="secondary" onClick={() => setAddingOptionTo(attribute.id)}>Add option</button>}<button type="button" className="danger" onClick={() => void previewAttributeArchive(attribute)}>Archive Attribute</button></div>}</li>)}</ul>
    </section>}
  </section>;
}

function App() {
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
  const [activeTab, setActiveTab] = React.useState<'inbox' | 'my-work' | 'proposal' | 'knowledge' | 'more' | 'settings'>('inbox');
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
  const [paletteQuery, setPaletteQuery] = React.useState('');
  const [paletteSearchResults, setPaletteSearchResults] = React.useState<SearchResult[]>([]);
  const [paletteSearchError, setPaletteSearchError] = React.useState('');
  const [paletteNoteResults, setPaletteNoteResults] = React.useState<KnowledgeResult[]>([]);
  const [shortcutHelpOpen, setShortcutHelpOpen] = React.useState(false);
  const [virtualStart, setVirtualStart] = React.useState(0);
  const clearLocalSession = React.useCallback(() => {
    localStorage.removeItem('weft-workspace-id');
    setWorkspace(null); setWorkspaceChoices([]); setNeedsWorkspaceChoice(false); setSignedIn(false); setActiveTab('inbox'); setMoreOpen(false); setTask(null); setDraft(null); setProposal(null); setProposalStale(false);
    setWatchPreferences(null); setInboxEntries([]);
    void clearClientCaches();
  }, []);
  const composing = React.useRef(false);
  const taskRef = React.useRef<Task | null>(null);
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
  const refresh = React.useCallback(async (workspaceId: string) => {
    const epochAtStart = taskAppendEpoch.current;
    const [projectResult, taskResult, memberResult, teamResult, myWorkResult, skillResult, statusResult, attributeResult, listResult, vaultResult, inboxResult] = await Promise.all([
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
      api<{ entries: InboxEntry[] }>(`/workspaces/${workspaceId}/inbox`),
    ]);
    setProjects(projectResult.projects);
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
    const discussion = await api<{ comments: Comment[] }>(`/tasks/${loaded.id}/comments`);
    const backlinkResult = await api<{ references: Backlink[] }>(`/tasks/${loaded.id}/references`);
    if (reloadOf !== undefined && taskRef.current?.id !== reloadOf) return;
    setWatchPreferences(watch);
    setComments(discussion.comments);
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
    proposalRef.current = proposal;
    if (focusReview.current && proposal && activeTab === 'proposal') {
      const first = document.querySelector<HTMLElement>('.proposal-screen input[type="checkbox"]');
      if (first) { first.focus(); focusReview.current = false; }
    }
  });

  React.useEffect(() => {
    if (!task) { setTimelineItems([]); return; }
    let active = true;
    void api<{ items: TimelineItem[] }>(`/tasks/${task.id}/activity?filter=${discussionFilter}`).then((result) => { if (active) setTimelineItems(result.items); }).catch(() => { if (active) setTimelineItems([]); });
    return () => { active = false; };
  }, [task?.id, discussionFilter, comments]);

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

  React.useEffect(() => {
    if (paletteOpen) requestAnimationFrame(() => paletteInputRef.current?.focus());
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
    if (!paletteOpen || !workspace || query.length === 0 || /^(?:create|status|milestone|generate|ai|split|links?|suggest|column)\b/i.test(query)) {
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
    setWorkspace(found); setNeedsWorkspaceChoice(false); setActiveTab('inbox'); setShowSkills(false);
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
    try { const project = await api<Project>(`/workspaces/${workspace.id}/projects`, { method: 'POST', body: JSON.stringify({ name: input.value.trim(), visibility: 'workspace' }) }); setProjects((items) => [...items, project]); setSelectedProject(project.id); input.value = ''; setError(''); }
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
    const edited = task && draft && (['title', 'description', 'status', 'priority', 'start_date', 'due_date'] as const).some((field) => (draft[field] ?? null) !== (task[field] ?? null));
    if (edited) { setError('Save or discard your edits to this task before asking for AI suggestions.'); return; }
    openGenerate(extra || defaultFocusPrompt(capability, target), capability, target);
  }

  function closeGenerate() {
    setGenerateOpen(false);
    restoreFocus();
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

  async function createTask(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !selectedProject || !title.trim()) return;
    try {
      const selectedList = taskLists.find((item) => item.id === selectedListId);
      const unambiguousStatus = selectedList?.kind === 'smart' && selectedList.query.logic !== 'or' && selectedList.query.filters.filter((filter) => filter.field === 'status' && filter.op === 'eq').length === 1
        ? selectedList.query.filters.find((filter) => filter.field === 'status' && filter.op === 'eq')?.value
        : undefined;
      const statusKey = typeof unambiguousStatus === 'string' ? statuses.find((status) => status.id === unambiguousStatus)?.key ?? unambiguousStatus : undefined;
      const created = await api<Task>(`/workspaces/${workspace.id}/tasks`, { method: 'POST', body: JSON.stringify({ project_id: selectedProject, title: title.trim(), status: statusKey }) });
      setTitle(''); appendTask(created); openPanel(created);
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
      setComments((await api<{ comments: Comment[] }>(`/tasks/${task.id}/comments`)).comments);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not save comment.';
      // Once the comment itself is saved, only its files failed: say so, so nobody posts it again.
      setError(draft.savedId && !editingComment ? `Your comment was saved, but not all files were attached. ${message}` : message);
      if (draft.savedId) setComments((await api<{ comments: Comment[] }>(`/tasks/${task.id}/comments`).catch(() => ({ comments }))).comments);
    }
  }

  async function toggleReaction(comment: Pick<Comment, 'id' | 'reactions'>, emoji: string) {
    if (!task) return;
    const reacted = comment.reactions?.some((reaction) => reaction.emoji === emoji && reaction.reacted);
    try {
      await api(`/tasks/${task.id}/comments/${comment.id}/reactions${reacted ? `?emoji=${encodeURIComponent(emoji)}` : ''}`, reacted ? { method: 'DELETE' } : { method: 'POST', body: JSON.stringify({ emoji }) });
      setComments((await api<{ comments: Comment[] }>(`/tasks/${task.id}/comments`)).comments);
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

  async function updateTaskMilestone(value: Task, milestone: string | null) {
    if (!workspace || (value.milestone_id ?? null) === milestone) return;
    try {
      const updated = await api<Task>(`/workspaces/${workspace.id}/tasks/${value.number}`, { method: 'PATCH', body: JSON.stringify({ expected_version: value.version, milestone_id: milestone }) });
      setTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setListTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setTask((current) => current?.id === updated.id ? updated : current);
      setDraft((current) => current?.id === updated.id ? { ...current, milestone_id: updated.milestone_id, milestone: updated.milestone, version: updated.version } : current);
      setMilestoneEpoch((count) => count + 1);
    } catch (reason) { reportWriteError(reason, 'Could not change the Milestone.'); }
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
    const suggest = query.match(/^(?:suggest\s+)?(split|links?)(?:\s+(.+))?$/i);
    if (suggest) {
      if (aiAvailability.status !== 'ready') return;
      const target = task ?? viewTasks[focusedRowIndex];
      if (!target) return;
      closePalette(false);
      openSuggest(suggest[1].toLowerCase() === 'split' ? 'split' : 'link', target, suggest[2]?.trim());
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
        await updateTaskStatus(target, nextStatus.key);
        closePalette();
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
        if (clearing || choice) { await updateTaskMilestone(target, choice?.id ?? null); closePalette(); }
      } catch (reason) { reportWriteError(reason, 'Could not change the Milestone.'); }
      return;
    }
    const columnCommand = query.match(/^column\s+move\s+(.+?)\s+(left|right)$/i);
    if (columnCommand) {
      const status = statuses.find((item) => item.name.toLowerCase() === columnCommand[1].toLowerCase() || item.key.toLowerCase() === columnCommand[1].toLowerCase());
      if (status) { await moveKanbanColumn(status.id, columnCommand[2].toLowerCase() === 'right' ? 1 : -1); closePalette(); }
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

  function openPanel(value: Task | SearchResult) {
    if (!workspace) return;
    const number = 'number' in value ? value.number : value.task_number;
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : gridRef.current;
    history.pushState({}, '', `/w/${workspace.id}/tasks/${number}`);
    setFullPage(false);
    void loadTask(workspace.id, number).catch((reason) => setError(reason instanceof Error ? reason.message : 'Task is unavailable.'));
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
      setSubtaskTitle(''); appendTask(created); await loadTask(workspace.id, task.number);
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

  if (!signedIn) return <main className="shell"><p className="eyebrow">WEFT · WORKSPACE</p><h1>Work moves forward, together.</h1><p className="intro">Sign in to open your Workspace tasks.</p><form className="signin" onSubmit={signIn}><label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label><button>Sign in</button>{error && <p role="alert">{error}</p>}</form></main>;
  if (needsWorkspaceChoice || !workspace) return <main className="shell workspace-picker"><p className="eyebrow">WEFT · WORKSPACE</p><h1>Choose a Workspace</h1><p className="intro">Select where you want to work. Your choice is remembered on this device.</p><ul>{workspaceChoices.map((item) => <li key={item.id}><button type="button" onClick={() => void chooseWorkspace(item)}>{item.name}<span>{item.role}</span></button></li>)}</ul><button type="button" className="secondary" onClick={() => void signOut()}>Sign out</button></main>;

  const taskUrl = (value: Task) => `/w/${value.workspace_id}/tasks/${value.number}`;
  const viewTasks = activeView === 'my-work' ? [...workTasks, ...viaTeamTasks] : activeView === 'team-queue' ? teamQueue : activeView === 'list' ? listTasks : tasks;
  const selectedColumns = activeView === 'list' ? taskLists.find((list) => list.id === selectedListId)?.query.columns ?? ['title', 'status', 'priority'] : ['title', 'status', 'priority', ...attributes.map((attribute) => `attribute:${attribute.id}`)];
  const showColumn = (column: string) => activeView !== 'list' || selectedColumns.includes(column);
  const selectedTasks = tasks.filter((item) => selectedTaskIds.includes(item.id));
  const staleItemIds = proposal?.stale_items ?? [];
  const proposalBlocked = proposalStale || staleItemIds.length > 0;
  const bulkAttributes = attributes.filter((attribute) => attribute.type === 'single_select' && selectedTasks.length > 1 && selectedTasks.every((item) => attribute.project_ids?.includes(item.project_id)));
  const milestoneTarget = task ?? viewTasks[focusedRowIndex];
  const paletteMilestoneQuery = paletteQuery.trim().match(/^milestone(?:\s+(.*))?$/i);
  const paletteResults = paletteSearchResults;
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
      appendTask(child);
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
    <header><div><p className="eyebrow">WEFT · {workspace?.name.toUpperCase()}</p><h1>{showSkills ? 'Workspace Skills' : activeTab === 'knowledge' ? 'Knowledge' : activeTab === 'proposal' ? 'Proposal' : activeTab === 'my-work' ? 'My work' : activeTab === 'settings' ? 'Settings' : 'Tasks'}</h1></div><div className="actions">{workspaceChoices.length > 1 && <label className="workspace-switch">Workspace<select aria-label="Workspace" value={workspace.id} onChange={(event) => { const selected = workspaceChoices.find((item) => item.id === event.target.value); if (selected) void chooseWorkspace(selected); }}>{workspaceChoices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<button type="button" className="secondary palette-trigger" aria-label="Open command palette" onClick={openPalette}><span aria-hidden="true">⌕</span><span className="desktop-label">Search · ⌘K</span></button><button type="button" className="secondary" aria-label="Keyboard shortcuts" onClick={() => { focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setShortcutHelpOpen(true); }}>Shortcuts</button><span className="count">{tasks.length} tasks</span>{['owner','admin'].includes(workspace?.role ?? '') && <button type="button" className="secondary" onClick={async () => { try { const data = await api<unknown>(`/workspaces/${workspace!.id}/export`, { method: 'POST' }); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${workspace!.name}-export.json`; link.click(); URL.revokeObjectURL(url); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not export Workspace.'); } }}>Export JSON</button>}<button type="button" className="secondary desktop-signout" onClick={() => void signOut()}>Sign out</button></div></header>
    <nav className="primary-tabs" aria-label="Primary">
      <button type="button" aria-current={activeTab === 'inbox' ? 'page' : undefined} className={activeTab === 'inbox' ? 'selected' : 'secondary'} onClick={() => { setShowSkills(false); setActiveTab('inbox'); setActiveView('all'); }}>Inbox</button>
      <button type="button" aria-current={activeTab === 'my-work' ? 'page' : undefined} className={activeTab === 'my-work' ? 'selected' : 'secondary'} onClick={() => { setShowSkills(false); setActiveTab('my-work'); void showMyWork(); }}>My work</button>
      <button type="button" aria-current={activeTab === 'proposal' ? 'page' : undefined} className={activeTab === 'proposal' ? 'selected' : 'secondary'} onClick={() => { setShowSkills(false); setActiveTab('proposal'); }}>Proposal</button>
      <button type="button" aria-current={activeTab === 'knowledge' ? 'page' : undefined} className={activeTab === 'knowledge' ? 'selected' : 'secondary'} onClick={() => void showKnowledge()}>Knowledge</button>
      <button type="button" aria-current={activeTab === 'more' ? 'page' : undefined} className={activeTab === 'more' ? 'selected' : 'secondary'} aria-expanded={moreOpen} onClick={() => { focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setActiveTab('more'); setMoreOpen(true); }}>More</button>
    </nav>
    {offline && <p className="offline-banner" role="status">Offline mode · the app shell and static assets remain available; Knowledge and other data need a connection.</p>}
    {!offline && signedIn && !realtimeConnected && <p className="offline-banner" role="status">Live updates are reconnecting. Writes still require a server response and will not be queued offline.</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {!showSkills && activeTab === 'settings' && !task && <SettingsScreen workspace={workspace} projects={projects} onSignOut={() => void signOut()} onRefresh={() => refresh(workspace.id)} />}
    {!showSkills && activeTab === 'inbox' && !task && <section className="task-list inbox-screen" aria-label="Inbox">
      <div className="table-heading"><div><h2>Inbox</h2><p className="muted">Assignments, mentions, replies and updates you chose to follow.</p></div><button type="button" className="secondary" onClick={() => void refresh(workspace.id)}>Refresh</button></div>
      {inboxEntries.length === 0 ? <p className="muted">Your Inbox is clear.</p> : <ul className="inbox-list">{inboxEntries.map((entry) => <li key={entry.id} className={entry.read ? 'inbox-read' : 'inbox-unread'}>
        <div><strong>{entry.task.title}</strong> <span className="number">#{entry.task.number}</span><p>{entry.reasons.join(', ')} · {entry.task.status}{entry.unread_count ? ` · ${entry.unread_count} unread` : ' · read'}</p></div>
        <div className="actions"><button type="button" onClick={() => { const item = tasks.find((candidate) => candidate.id === entry.task.id); if (item) openPanel(item); else void loadTask(workspace.id, entry.task.number); }}>Open Task #{entry.task.number}</button>
          {!entry.read && <button type="button" className="secondary" onClick={async () => { try { await api(`/inbox/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ read: true }) }); setInboxEntries((items) => items.map((item) => item.id === entry.id ? { ...item, read: true, unread_count: 0 } : item)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not mark Inbox entry read.'); } }}>Mark read</button>}
          <button type="button" className="secondary" onClick={async () => { try { await api(`/inbox/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ dismissed: true }) }); setInboxEntries((items) => items.filter((item) => item.id !== entry.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not dismiss Inbox entry.'); } }}>Dismiss</button>
          <button type="button" className="secondary" onClick={async () => { try { await api(`/tasks/${entry.task.id}/watch`, { method: 'PUT', body: JSON.stringify({ events: [], muted: true }) }); setInboxEntries((items) => items.filter((item) => item.task.id !== entry.task.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not mute Task notifications.'); } }}>Mute Task</button>
        </div>
      </li>)}</ul>}
    </section>}
    {!showSkills && activeTab === 'proposal' && !task && <section className="proposal-screen" aria-label="Proposal review">
      {!proposal ? <div className="proposal-empty"><h2>Review a Proposal</h2><p className="muted">A Proposal groups prepared changes into one review. Nothing is applied until you approve it.</p><button type="button" disabled={proposalBusy} onClick={() => void createMockProposal()}>{proposalBusy ? 'Preparing…' : 'Create mock Proposal'}</button></div> : <>
        <div className="proposal-heading"><div><p className="eyebrow">{proposal.status === 'applied' ? 'APPROVED' : proposal.status === 'undone' ? 'UNDONE' : proposal.status === 'needs_attention' ? 'NEEDS ATTENTION' : 'READY FOR REVIEW'}</p>{proposal.status === 'needs_attention' && <p role="alert" className="proposal-warning">This Apply did not finish. The Vault was left as it is; ask a Vault manager to follow the recovery steps.</p>}<h2>Proposal checklist</h2><p className="muted">Review each change, then approve the selected items together.</p></div><button type="button" className="secondary" disabled={proposalBusy || !['pending', 'ready'].includes(proposal.status)} onClick={() => void refreshProposal()}>Check versions</button></div>
        {proposal.provider && <p className="muted">Prepared with {proposal.provider}.</p>}
        {proposal.ai_run_id && runNotes && <section className="proposal-run-notes" aria-label="AI run notes"><h3>AI run</h3><p>{runNotes.summary}</p><p className="muted">Sources read: {runNotes.read.length ? runNotes.read.map((source) => sourceLabel(source)).join(', ') : 'none beyond your request'}.</p>{runNotes.unread.length > 0 && <p role="note" className="proposal-warning">Not read by the AI: {runNotes.unread.map((source) => source.label).join(', ')}.</p>}{runNotes.truncated && <p role="note" className="proposal-warning">Some sources were too large and were cut short. The plan may miss details.</p>}</section>}
        {!!proposal.assumptions?.length && <section aria-label="Proposal assumptions"><h3>Assumptions</h3><ul>{proposal.assumptions.map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}</ul></section>}
        {!!proposal.remaining_in_original?.length && <section aria-label="Stays in the original Task"><h3>Stays in the original Task</h3><ul>{proposal.remaining_in_original.map((part, index) => <li key={`${index}-${part}`}>{part}</li>)}</ul></section>}
        {!!proposal.open_questions?.length && <section aria-label="Open questions"><h3>Open questions</h3><ul>{proposal.open_questions.map((question, index) => <li key={`${index}-${question}`}>{question}</li>)}</ul></section>}
        {staleItemIds.length > 0 && <div className="proposal-stale" role="alert"><strong>Some items are stale.</strong><p>A Task changed after this plan was drafted: {staleItemIds.map((id) => { const found = proposal.items.find((item) => item.id === id); return found ? rowName(found, proposal.items) : id; }).join('; ')}. Refresh them to the current Task, or remove them, before approving.</p><div className="actions"><button type="button" className="secondary" disabled={proposalBusy} onClick={() => void refreshStaleItems()}>Refresh stale items</button><button type="button" className="secondary" disabled={proposalBusy} onClick={() => removeStaleItems()}>Remove stale items</button></div></div>}
        {proposalStale && staleItemIds.length === 0 && <div className="proposal-stale" role="alert"><strong>This Proposal has stale items.</strong><p>Refresh their current versions or remove stale Skills before approving.</p><div className="actions"><button type="button" className="secondary" disabled={proposalBusy} onClick={() => void refreshStaleProposalItems()}>Refresh stale Skills</button><button type="button" className="secondary" disabled={proposalBusy} onClick={() => void removeStaleProposalItems()}>Remove stale Skills</button></div></div>}
        {proposalGroups.filter((group, index, all) => all.findIndex((candidate) => candidate.label === group.label) === index).map((group) => {
          const kinds = proposalGroups.filter((candidate) => candidate.label === group.label).map((candidate) => candidate.kind);
          const groupItems = proposal.items.filter((item) => kinds.includes(item.kind));
          if (groupItems.length === 0) return null;
          return <section className="proposal-group" key={group.label} aria-label={`${group.label} proposal items`}><div className="proposal-group-heading"><h3>{group.label}</h3><span>{groupItems.filter((item) => item.selected).length} of {groupItems.length} kept</span></div><ul>{groupItems.map((item) => {
            const parent = item.depends_on?.map((id) => proposal.items.find((candidate) => candidate.id === id)).find((candidate) => candidate?.kind === 'task');
            const reviewOnly = item.kind === 'note_edit' || item.kind === 'file_add';
            const shownName = proposal.ai_run_id ? rowName(item, proposal.items) : (item.title ?? item.name ?? item.path ?? item.id);
            const label = item.id === 'task-dependent' ? 'Add dependent task' : `${item.selected ? 'Keep' : 'Add'} ${shownName}`;
            return <li key={item.id} className={`proposal-item ${parent ? 'proposal-child' : ''} ${item.selected ? '' : 'proposal-unkept'} ${staleItemIds.includes(item.id) ? 'proposal-item-stale' : ''}`}>
              <label><input type="checkbox" aria-label={label} checked={item.selected} disabled={proposalBusy || !['pending', 'ready'].includes(proposal.status) || reviewOnly} onChange={(event) => void toggleProposalItem(item, event.target.checked)} /><span className="proposal-item-copy"><strong>{proposal.ai_run_id && item.kind === 'relation' ? shownName : (item.title ?? item.name ?? item.path ?? (item.kind === 'relation' ? 'Task link' : 'Knowledge file'))}</strong><span className="muted">{item.reason}</span>{staleItemIds.includes(item.id) && <span className="proposal-stale-badge">Stale: a Task it depends on changed after the run started</span>}{proposal.ai_run_id && guessLines(item).length > 0 && <span className="proposal-guess-badge">Guessed: {guessLines(item).map((line) => line.replace(/^Guessed /, '')).join('; ')}</span>}{proposal.ai_run_id && item.kind === 'task' && typeof item.status === 'string' && item.status && <span className="muted">Status: {statuses.find((status) => status.key === item.status)?.name ?? item.status}</span>}{reviewOnly && <span className="muted">Review only; Vault apply is deferred.</span>}</span></label>
              <button type="button" className="link-button proposal-detail-toggle" aria-expanded={proposalDetail === item.id} onClick={() => setProposalDetail(proposalDetail === item.id ? null : item.id)}>{proposalDetail === item.id ? 'Hide details' : 'Show details'}</button>
              {proposalDetail === item.id && proposal.ai_run_id && <ProposalRowEditor item={item} all={proposal.items} statuses={statuses} busy={proposalBusy || !['pending', 'ready'].includes(proposal.status)} canRegenerate={aiAvailability.status === 'ready' || generation !== null} onEdit={editProposalItem} onReject={rejectProposalItem} onMerge={mergeProposalItems} onRegenerate={(id, instruction, replace) => void regenerateRow(id, instruction, replace)} />}
              {proposalDetail === item.id && !proposal.ai_run_id && <div className="proposal-diff"><strong>{item.kind.replace('_', ' ')}</strong>{typeof item.current_body === 'string' && <><p>Current Skill</p><p>{item.current_body}</p><p>Proposed Skill</p></>}{(item.kind === 'file_add' || item.kind === 'note_edit') && typeof item.path === 'string' && item.path.toLowerCase().endsWith('.html') ? <><p role="note">This page contains scripts.</p><iframe title={`Sandboxed preview of ${item.path}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={sandboxedHtmlPreview(String(item.preview ?? item.content ?? ''))} /></> : <p>{item.description as string ?? item.content as string ?? item.body as string ?? item.reason}</p>}{item.path && <p>Vault path: {item.path}</p>}</div>}
            </li>;
          })}</ul></section>;
        })}
        {proposalMessage && <p className={`${proposalStale ? 'proposal-message notice' : 'proposal-message'} ${proposal.status === 'applied' ? 'proposal-toast' : ''}`} role="status">{proposalMessage}{proposal.status === 'applied' && <button type="button" className="link-button" disabled={proposalBusy} onClick={() => void undoProposal()}>Undo</button>}</p>}
        <div className="proposal-approve-bar"><div><strong>{proposal.items.filter((item) => item.selected).length} items kept</strong>{proposal.ai_run_id && (() => { const summary = approvalSummary(proposal.items, proposal.scope, projects, vaults); return <span aria-label="Approval summary">Creates {summary.created}, updates {summary.updated}, links {summary.linked}. Access: {summary.scope.join(', ') || 'none'}.</span>; })()}<span className="muted">{proposalBlocked ? 'Resolve stale items to approve.' : 'One approval applies the selected changes.'}</span></div><button type="button" disabled={proposalBusy || proposalBlocked || !['pending', 'ready'].includes(proposal.status) || !proposal.items.some((item) => item.selected)} onClick={() => void approveProposal()}>{proposalBusy ? 'Applying…' : 'Approve'}</button></div>
      </>}
      {proposalApplying && <div className="overlay-backdrop proposal-lock-backdrop"><section className="proposal-lock-sheet" role="dialog" aria-modal="true" aria-label="Applying Proposal"><h2>Applying Proposal</h2><p>We’re briefly locking this Proposal while its selected changes are applied together.</p></section></div>}
    </section>}
    {!showSkills && activeTab === 'knowledge' && !task && <section className="task-list app-section knowledge-view" aria-label="Knowledge"><div className="knowledge-vaults"><h2>Knowledge</h2>
      <form className="capture" role="search" onSubmit={searchKnowledge}><label className="sr-only" htmlFor="knowledge-search">Search Knowledge notes</label><input type="search" id="knowledge-search" value={knowledgeQuery} onChange={(event) => setKnowledgeQuery(event.target.value)} placeholder="Search notes…" maxLength={100} /><button type="submit">Search notes</button></form>
      {knowledgeSearchError && <p role="alert" className="notice">{knowledgeSearchError}</p>}{knowledgeIndexing && <p className="notice" role="status">Content is not yet searchable while the Vault index is being rebuilt.</p>}
      {knowledgeCount !== null && <section aria-label="Knowledge search results"><h3>{knowledgeCount} note results</h3><ul>{knowledgeResults.map((result) => <li key={`${result.vault_id}:${result.path}`}><button type="button" className="link-button" onClick={() => void openKnowledgeResult(result)}><strong>{result.title}</strong><span className="muted">{result.vault_name} · {result.path}</span><span>{result.snippet}</span></button></li>)}</ul></section>}
      {vaultError && !selectedVaultId && <p className="notice" role="alert">{vaultError}</p>}{vaults.length === 0 ? <p className="muted">No Vaults are available to read.</p> : <ul>{vaults.map((vault) => <li key={vault.id}><button type="button" aria-label={`Open Vault ${vault.name}`} aria-pressed={selectedVaultId === vault.id} className={selectedVaultId === vault.id ? 'selected' : 'secondary'} onClick={() => void openVaultContents(vault)}><strong>{vault.name}</strong><span className="muted">{vault.visibility}</span></button>{vault.role === 'manager' && <button type="button" className="link-button" onClick={() => void reindexVault(vault.id)}>Reindex</button>}</li>)}</ul>}</div><div className="knowledge-content">{selectedVaultId ? <><h2>{vaults.find((vault) => vault.id === selectedVaultId)?.name ?? 'Vault contents'}</h2>{vaultError && <p className="notice" role="alert">{vaultError}</p>}<div className="knowledge-reader-layout"><nav aria-label="Vault notes"><ul>{vaultFiles.map((file) => <li key={file}><button type="button" className="link-button" aria-current={readerNote?.path === file ? 'page' : undefined} onClick={() => void openVaultNote(selectedVaultId, file)}>{file}</button></li>)}</ul></nav><div className="knowledge-reader">{readerError && <p className="notice" role="alert">{readerError}</p>}{readerNote ? <><h3>{readerNote.path}</h3>{readerNote.format === 'source' ? <pre className="knowledge-source">{readerNote.source}</pre> : readerNote.format === 'html_page' ? <><p role="note">This page contains scripts.</p><iframe className="knowledge-html-page" title={readerNote.title || readerNote.path} sandbox="allow-scripts" referrerPolicy="no-referrer" src={readerNote.page_url} /></> : <><div className="knowledge-properties">{Object.entries(readerNote.properties ?? {}).map(([key, value]) => <p key={key}><strong>{key}:</strong> {value}</p>)}{(readerNote.tags ?? []).length > 0 && <p><strong>Tags:</strong> {(readerNote.tags ?? []).map((tag) => `#${tag}`).join(' ')}</p>}</div><article className="knowledge-markdown" onClick={followReaderLink} dangerouslySetInnerHTML={{ __html: readerNote.html ?? '' }} /><section aria-label="Note links"><h4>Links</h4><ul>{(readerNote.links ?? []).map((link, index) => <li key={`${link.target}-${index}`}>{link.target}: {link.resolution.status}{link.resolution.path ? ` · ${link.resolution.path}` : ''}</li>)}</ul></section><section aria-label="Backlinks"><h4>Backlinks</h4>{readerBacklinks.length ? <ul>{readerBacklinks.map((backlink) => <li key={backlink.path}><button type="button" className="link-button" onClick={() => void openVaultNote(selectedVaultId, backlink.path)}>{backlink.title}</button></li>)}</ul> : <p className="muted">No backlinks.</p>}</section><section aria-label="Note history"><h4>History</h4>{readerHistory.length ? <ol>{readerHistory.map((commit) => <li key={commit.id}><strong>{commit.message}</strong><span className="muted"> {commit.author} · {new Date(commit.time).toLocaleString()}</span></li>)}</ol> : <p className="muted">No history yet.</p>}</section></>}</> : vaultFiles.length === 0 ? <p className="muted">No files in this Vault yet.</p> : <p className="muted">Choose a note to read.</p>}</div></div></> : <p className="knowledge-reader-placeholder" aria-label="Note reader">Choose a Vault to read its notes.</p>}</div></section>}
    {!showSkills && moreOpen && <div className="overlay-backdrop sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setMoreOpen(false); setActiveTab('inbox'); restoreFocus(); } }}><section className="more-sheet" role="dialog" aria-modal="true" aria-label="More"><h2>More</h2><button type="button" onClick={() => { setMoreOpen(false); setActiveTab('inbox'); setShowSkills(true); setSelectedSkill(null); setEditingSkill(false); }}>Skills</button><button type="button" className="secondary" onClick={() => { setMoreOpen(false); setActiveTab('settings'); restoreFocus(); }}>Settings</button><button type="button" className="secondary" onClick={() => { setMoreOpen(false); setActiveTab('inbox'); setShortcutHelpOpen(true); }}>Keyboard shortcuts</button><button type="button" className="danger" onClick={() => void signOut()}>Sign out</button><button type="button" className="secondary" onClick={() => { setMoreOpen(false); setActiveTab('inbox'); restoreFocus(); }}>Close</button></section></div>}
    {showSkills && <section className="skill-browser" aria-label="Workspace Skills"><aside><h2>Skills</h2><ul>{skills.map((skill) => <li key={skill.id}><button type="button" className="link-button" onClick={() => openSkill(skill)}><strong>{skill.name}{!skill.enabled && ' · Disabled'}</strong><span className="muted">{skill.description}</span></button></li>)}</ul>{['owner','admin'].includes(workspace?.role ?? '') && <button type="button" onClick={() => { setSelectedSkill(null); setSkillDraft({ name: '', description: '', body: '' }); setEditingSkill(true); }}>Create Skill</button>}</aside>
      <div className="skill-content">{editingSkill ? <form className="task-form" onSubmit={saveSkill}><h2>{selectedSkill ? 'Edit Skill' : 'New Skill'}</h2><p className="notice">Everyone in this Workspace, including Viewers, and the AI can read enabled Skills. Never include passwords, tokens, or other secrets.</p><label>Name<input value={skillDraft.name} onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })} required /></label><label>Short description<input value={skillDraft.description} onChange={(event) => setSkillDraft({ ...skillDraft, description: event.target.value })} required maxLength={300} /></label><label>Markdown body<textarea rows={16} value={skillDraft.body} onChange={(event) => setSkillDraft({ ...skillDraft, body: event.target.value })} /></label><div className="actions"><button>Save Skill</button><button type="button" className="secondary" onClick={() => setEditingSkill(false)}>Cancel</button></div></form> : selectedSkill ? <article><h2>{selectedSkill.name}{!selectedSkill.enabled && ' · Disabled'}</h2><p className="muted">{selectedSkill.description}</p><div className="skill-markdown">{renderSkillBody(selectedSkill.body ?? '', workspace!.id)}</div>{['owner','admin'].includes(workspace?.role ?? '') && <div className="actions"><button type="button" onClick={() => { setSkillDraft({ name: selectedSkill.name, description: selectedSkill.description, body: selectedSkill.body ?? '' }); setEditingSkill(true); }}>Edit</button><button type="button" className="secondary" onClick={() => void api<Skill>(`/workspaces/${workspace!.id}/skills/${selectedSkill.id}`, { method: 'PATCH', body: JSON.stringify({ expected_version: selectedSkill.version, enabled: !selectedSkill.enabled }) }).then((saved) => { setSelectedSkill({ ...selectedSkill, ...saved }); setSkills((items) => items.map((item) => item.id === saved.id ? saved : item)); }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not update Skill.'))}>{selectedSkill.enabled ? 'Disable' : 'Enable'}</button>{selectedSkill.enabled && <button type="button" className="danger" onClick={() => void archiveSkill()}>Archive</button>}</div>}</article> : <p className="muted">Choose a Skill to read it.</p>}</div>
    </section>}
    {!showSkills && activeTab !== 'inbox' && activeTab !== 'proposal' && activeTab !== 'knowledge' && activeTab !== 'settings' && !task && <>
      <nav className="view-nav" aria-label="Task views"><button className={activeView === 'all' ? 'selected' : 'secondary'} onClick={() => setActiveView('all')}>All tasks</button><button className={activeView === 'my-work' ? 'selected' : 'secondary'} onClick={() => void showMyWork()}>My work</button><label>Team queue<select aria-label="Team queue" value={selectedTeam} onChange={(event) => void showTeamQueue(event.target.value)}><option value="">Choose a Team</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label>List<select aria-label="Saved List" value={selectedListId} onChange={(event) => { void openList(event.target.value); if (event.target.value) setActiveView('list'); else setActiveView('all'); }}><option value="">Choose a List</option>{taskLists.map((list) => <option key={list.id} value={list.id}>{list.name} · {list.kind === 'smart' ? 'Smart' : 'Manual'}</option>)}</select></label><button type="button" className={activeView === 'list' ? 'selected' : 'secondary'} disabled={!selectedListId} onClick={() => { if (selectedListId) { setActiveView('list'); void openList(selectedListId); } }}>Open List</button><button type="button" className="secondary" onClick={() => setViewMode('table')}>Table</button><button type="button" className="secondary" onClick={() => setViewMode('kanban')}>Kanban</button></nav>
      <form className="capture" onSubmit={(event) => { event.preventDefault(); void createList('manual'); }}><label className="sr-only" htmlFor="new-list-name">New List name</label><input id="new-list-name" placeholder="New manual List…" value={newListName} onChange={(event) => setNewListName(event.target.value)} required /><button>Create manual List</button><label>Status filter<select aria-label="Smart List Status filter" value={smartStatus} onChange={(event) => setSmartStatus(event.target.value)}><option value="">Any Status</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label><label>Due date<select aria-label="Smart List due date filter" value={smartRelativeDate} onChange={(event) => setSmartRelativeDate(event.target.value)}><option value="">Any date</option><option value="today">Due today</option><option value="overdue">Overdue</option><option value="next_7_days">Due in 7 days</option></select></label><label>Attribute filter<select aria-label="Smart List Attribute" value={smartAttribute} onChange={(event) => { setSmartAttribute(event.target.value); setSmartAttributeValue(''); }}><option value="">No Attribute filter</option>{attributes.map((attribute) => <option key={attribute.id} value={attribute.id}>{attribute.name}</option>)}</select></label>{smartAttribute && <label>Attribute value{attributes.find((attribute) => attribute.id === smartAttribute)?.options.length ? <select aria-label="Smart List Attribute value" value={smartAttributeValue} onChange={(event) => setSmartAttributeValue(event.target.value)}><option value="">Any value</option>{attributes.find((attribute) => attribute.id === smartAttribute)?.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select> : <input aria-label="Smart List Attribute value" value={smartAttributeValue} onChange={(event) => setSmartAttributeValue(event.target.value)} />}</label>}<label><input type="checkbox" checked={smartAssignee} onChange={(event) => setSmartAssignee(event.target.checked)} />Assigned directly to me</label>{smartAssignee && <label><input type="checkbox" checked={smartIncludeTeam} onChange={(event) => setSmartIncludeTeam(event.target.checked)} />Include via Team</label>}<fieldset><legend>Visible columns</legend>{['title','status','priority'].map((column) => <label key={column}><input type="checkbox" checked={smartColumns.includes(column)} onChange={(event) => setSmartColumns((items) => event.target.checked ? [...items, column] : items.filter((item) => item !== column))} />{column}</label>)}{attributes.map((attribute) => { const column = `attribute:${attribute.id}`; return <label key={column}><input type="checkbox" checked={smartColumns.includes(column)} onChange={(event) => setSmartColumns((items) => event.target.checked ? [...items, column] : items.filter((item) => item !== column))} />{attribute.name}</label>; })}</fieldset><label>Combine filters<select aria-label="Smart List filter logic" value={smartLogic} onChange={(event) => setSmartLogic(event.target.value as 'and' | 'or')}><option value="and">Match all (AND)</option><option value="or">Match any (OR)</option></select></label><label>Sort<select aria-label="Smart List sort" value={smartSort} onChange={(event) => setSmartSort(event.target.value)}><option value="number">Task number</option><option value="title">Title</option><option value="due_date">Due date</option></select></label><label>Group<select aria-label="Smart List group" value={smartGroup} onChange={(event) => setSmartGroup(event.target.value)}><option value="">No group</option><option value="status">Status</option><option value="priority">Priority</option></select></label><button type="button" onClick={() => void createList('smart')}>Create Smart List</button></form>
      {['owner','admin'].includes(workspace?.role ?? '') && <form className="capture project-create" onSubmit={createProject}><label className="sr-only" htmlFor="project-name">New Project name</label><input id="project-name" name="project-name" placeholder="New Project name" required /><button type="submit">Create Project</button></form>}
      <form className="capture" onSubmit={createTask}><label className="sr-only" htmlFor="task-title">Task title</label><input id="task-title" placeholder="Add a task…" value={title} onChange={(e) => setTitle(e.target.value)} required /><select aria-label="Project" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)} required><option value="" disabled>Select a Project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button disabled={!selectedProject}>Create task</button><button type="button" className="secondary" disabled={aiAvailability.status !== 'ready'} aria-describedby="ai-availability" onClick={() => openGenerate(title.trim())}>Generate with AI</button></form>
      {['owner','admin'].includes(workspace?.role ?? '') && <details className="capture" aria-label="Import Tasks from JSON"><summary>Import Tasks from JSON</summary><p>Paste an array of Task objects. Missing project_id values use the selected Project.</p><label>JSON Tasks<textarea aria-label="JSON Tasks" rows={8} value={importJson} onChange={(event) => setImportJson(event.target.value)} /></label><button type="button" disabled={!selectedProject} onClick={async () => { try { const parsed = JSON.parse(importJson); const items = (Array.isArray(parsed) ? parsed : parsed.items).map((item: Record<string, unknown>) => ({ ...item, project_id: item.project_id || selectedProject })); const preview = await api<{ preview_id: string; results: { index: number; status: string; reason?: string }[] }>(`/workspaces/${workspace!.id}/tasks/import`, { method: 'POST', body: JSON.stringify({ items }) }); setImportPreview(preview); setImportMessage('Dry run complete. No Tasks have been created.'); } catch (reason) { setImportMessage(reason instanceof Error ? reason.message : 'Could not preview import.'); } }}>{importPreview ? 'Refresh dry run' : 'Dry run'}</button>{importPreview && <><ul aria-label="Import results">{importPreview.results.map((result) => <li key={result.index}>Item {result.index + 1}: {result.status}{result.reason ? ` · ${result.reason}` : ''}</li>)}</ul><button type="button" onClick={async () => { try { await api(`/workspaces/${workspace!.id}/tasks/import/${importPreview.preview_id}/apply`, { method: 'POST', body: '{}' }); setImportMessage('Import applied as one undoable Operation.'); setImportPreview(null); await refresh(workspace!.id); } catch (reason) { setImportMessage(reason instanceof Error ? reason.message : 'Could not apply import.'); } }}>Apply import</button></>}{importMessage && <p role="status">{importMessage}</p>}</details>}
      <p id="ai-availability" className="muted ai-availability" role="status">{aiAvailability.status === 'ready' ? `AI planning is ready (${aiAvailability.connection.provider}). It only proposes; you approve.` : aiAvailability.status === 'unavailable' ? `Generate with AI is unavailable: ${aiAvailability.reason} Everything else works as usual.` : 'Checking AI availability…'}</p>
      <form className="capture" role="search" onSubmit={searchTasks}><label className="sr-only" htmlFor="task-search">Search tasks and comments</label><input id="task-search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search tasks and comments…" minLength={1} maxLength={100} /><button type="submit">Search</button></form>{searchCount !== null && <section className="task-list" aria-label="Search results"><h2>{searchCount} search results</h2><ul>{searchResults.map((result) => <li key={result.task_id}><a href={`/w/${workspace!.id}/tasks/${result.task_number}`} onClick={(event) => { event.preventDefault(); const found = tasks.find((item) => item.id === result.task_id); if (found) openPanel(found); else void loadTask(workspace!.id, result.task_number); }}><span className="number">#{result.task_number}</span><strong>{result.title}</strong><span className="muted">{result.snippet}</span></a></li>)}</ul></section>}
      <section className="task-list" aria-label="Tasks">
        <div className="table-heading"><div><h2>{activeView === 'my-work' ? 'My work' : activeView === 'team-queue' ? `${teams.find((team) => team.id === selectedTeam)?.name ?? 'Team'} queue` : activeView === 'list' ? taskLists.find((list) => list.id === selectedListId)?.name ?? 'List' : 'Task Table'}</h2><p className="muted">Browse mode · Enter or F2 edits a title · Shift+Arrow selects a range</p></div><div className="mode-controls" aria-label="Keyboard mode"><button type="button" className={keyboardMode === 'browse' ? 'selected' : 'secondary'} aria-label="Browse mode" aria-pressed={keyboardMode === 'browse'} onClick={() => setKeyboardMode('browse')}>Browse</button><button type="button" className={keyboardMode === 'edit' ? 'selected' : 'secondary'} aria-label="Edit mode" aria-pressed={keyboardMode === 'edit'} onClick={() => setKeyboardMode('edit')}>Edit</button><button type="button" className={keyboardMode === 'outline' ? 'selected' : 'secondary'} aria-label="Outline mode" aria-pressed={keyboardMode === 'outline'} onClick={() => setKeyboardMode('outline')}>Outline</button></div></div>
        {selectedTaskIds.length > 1 && <div className="bulk-actions" aria-label="Bulk actions"><span>{selectedTaskIds.length} selected</span><label>Set status<select aria-label="Set status" defaultValue="" onChange={(event) => { if (event.target.value) void bulkSetStatus(event.target.value); }}><option value="" disabled>Choose a Status</option>{statuses.map((status) => <option key={status.id} value={status.key}>{status.name}</option>)}</select></label>{bulkAttributes.map((attribute) => <label key={attribute.id}>Set {attribute.name}<select aria-label={`Set ${attribute.name}`} defaultValue="" onChange={(event) => { if (event.target.value) void bulkSetAttribute(attribute, event.target.value); }}><option value="" disabled>Choose a value</option>{attribute.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select></label>)}<button type="button" className="secondary" onClick={() => setSelectedTaskIds([])}>Clear selection</button></div>}
        {activeView === 'list' && selectedListId && taskLists.find((list) => list.id === selectedListId)?.kind === 'manual' && <div className="bulk-actions"><button type="button" disabled={!viewTasks[focusedRowIndex]} onClick={() => { const item = viewTasks[focusedRowIndex]; if (item) void changeListMembership(item, false); }}>Remove selected task from List</button><button type="button" disabled={!tasks[focusedRowIndex]} onClick={() => { const item = tasks[focusedRowIndex]; if (item) void changeListMembership(item, true); }}>Add selected task to List</button></div>}
        {viewTasks.length === 0 ? <p className="muted">No tasks in this view.</p> : viewMode === 'kanban' ? <div className="kanban-board" aria-label="Kanban board grouped by Status">{statuses.map((status, columnIndex) => <section key={status.id} className="kanban-column" aria-label={`${status.name} column`}><div className="kanban-heading"><h3>{status.name} <span className="count">{viewTasks.filter((item) => item.status === status.key).length}</span></h3>{['owner','admin'].includes(workspace?.role ?? '') && <span className="kanban-column-controls"><button type="button" className="secondary" aria-label={`Move ${status.name} column left`} disabled={columnIndex === 0} onClick={() => void moveKanbanColumn(status.id, -1)}>←</button><button type="button" className="secondary" aria-label={`Move ${status.name} column right`} disabled={columnIndex === statuses.length - 1} onClick={() => void moveKanbanColumn(status.id, 1)}>→</button></span>}</div>{viewTasks.filter((item) => item.status === status.key).map((item) => <button type="button" key={item.id} className="kanban-card" aria-label={`Task #${item.number}, ${item.title}, ${status.name}`} onClick={() => openPanel(item)} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = statuses[columnIndex + (event.key === 'ArrowRight' ? 1 : -1)]; if (next) void updateTaskStatus(item, next.key); } }}><span className="number">#{item.number}</span><strong>{item.title}</strong><span className="muted">{item.priority}</span></button>)}</section>)}</div> : <div className="table-scroll" onScroll={(event) => { const next = Math.floor(event.currentTarget.scrollTop / 58); if (Math.abs(next - virtualStart) > 3) setVirtualStart(Math.min(next, Math.max(0, viewTasks.length - 30))); }}><div role="grid" aria-label="Tasks" aria-rowcount={viewTasks.length + 1} aria-activedescendant={`task-row-${viewTasks[focusedRowIndex]?.id ?? ''}`} tabIndex={0} ref={gridRef} onKeyDown={handleGridKeyDown}>
          <div role="row" className="table-row table-header">{showColumn('title') && <span role="columnheader">Task</span>}{showColumn('status') && <span role="columnheader">Status</span>}{showColumn('priority') && <span role="columnheader">Priority</span>}{attributes.filter((attribute) => selectedColumns.includes(`attribute:${attribute.id}`) && viewTasks.some((item) => attribute.project_ids?.includes(item.project_id))).map((attribute) => <span role="columnheader" key={attribute.id}>{attribute.name}</span>)}{showColumn('milestone') && <span role="columnheader">Milestone</span>}</div>
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
              {showColumn('milestone') && <div role="gridcell" onClick={() => focusRow(index)}><MilestoneSelect api={api} project={item.project_id} epoch={milestoneEpoch} value={item.milestone} label={`Milestone for #${item.number}`} onChange={(milestone) => void updateTaskMilestone(item, milestone)} /></div>}
            </div>;
          })}
          {virtualEnd < viewTasks.length && <div aria-hidden="true" style={{ height: (viewTasks.length - virtualEnd) * 58 }} />}
        </div></div>}
      </section>
      {(() => { const milestoneProject = projects.find((item) => item.id === selectedProject); return milestoneProject ? <MilestonePanel api={api} project={milestoneProject.id} projectName={milestoneProject.name} epoch={milestoneEpoch} onChanged={() => { setMilestoneEpoch((value) => value + 1); if (workspace) void refresh(workspace.id); }} /> : null; })()}
      {(workspace?.role === 'owner' || workspace?.role === 'admin') && <section className="team-admin" aria-label="Team management"><h2>Teams</h2><form className="capture" onSubmit={createTeam}><label className="sr-only" htmlFor="team-name">New Team name</label><input id="team-name" value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="New Team name" required /><button>Create Team</button></form>{teams.length === 0 ? <p className="muted">No Teams yet.</p> : teams.map((team) => <details key={team.id} onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) void loadTeamMembers(team); }}><summary>{team.name}</summary><div className="team-actions"><button className="secondary" onClick={() => void renameTeam(team)}>Rename</button><button className="danger" onClick={() => void deleteTeam(team)}>Delete Team</button></div><form className="capture" onSubmit={(event) => { event.preventDefault(); const memberId = teamMemberDrafts[team.id]; if (memberId) void changeTeamMember(team, memberId, true); }}><label>Add member<select aria-label={`Add member to ${team.name}`} value={teamMemberDrafts[team.id] ?? ''} onChange={(event) => setTeamMemberDrafts((drafts) => ({ ...drafts, [team.id]: event.target.value }))}><option value="">Choose a Workspace member</option>{members.filter((member) => !teamMembers[team.id]?.some((item) => item.id === member.id)).map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select></label><button disabled={!teamMemberDrafts[team.id]}>Add</button></form><ul>{(teamMembers[team.id] ?? []).map((member) => <li key={member.id}><span>{member.email}</span><button className="link-button" onClick={() => void changeTeamMember(team, member.id, false)}>Remove</button></li>)}</ul></details>)}</section>}
    </>}
    {!showSkills && task && draft && <section className={`task-detail ${fullPage ? 'full-page' : 'side-panel'}`} aria-label={`Task #${task.number}`}><div className="detail-top"><span className="number">#{task.number}</span><div><a href={taskUrl(task)} onClick={(event) => { event.preventDefault(); history.pushState({}, '', taskUrl(task)); setFullPage(true); }}>Open full page</a>{fullPage ? <button className="link-button" onClick={closeTaskPanel}>Back to list</button> : <button type="button" className="link-button" onClick={closeTaskPanel}>Close task</button>}</div></div>
      <div className="task-ai-actions" role="group" aria-label="AI suggestions"><button type="button" className="secondary" disabled={aiAvailability.status !== 'ready'} onClick={() => openGenerate(defaultFocusPrompt('summarize', task), 'summarize', task)}>Summarize discussion</button><button type="button" className="secondary" disabled={aiAvailability.status !== 'ready'} onClick={() => openGenerate(defaultFocusPrompt('review', task), 'review', task)}>Review task quality</button><button type="button" className="secondary" disabled={aiAvailability.status !== 'ready'} onClick={() => openSuggest('split', task)}>Suggest split</button><button type="button" className="secondary" disabled={aiAvailability.status !== 'ready'} onClick={() => openSuggest('link', task)}>Suggest links</button>{aiAvailability.status === 'unavailable' && <span className="muted" role="note">AI suggestions are unavailable: {aiAvailability.reason}</span>}</div>
      <section className="task-structure" aria-label="Likely duplicates"><h2>Likely duplicates</h2>{task.similar_tasks?.length ? <ul>{task.similar_tasks.map((candidate) => <li key={candidate.id}><a href={`/w/${task.workspace_id}/tasks/${candidate.number}`}>#{candidate.number} {candidate.title}</a> · {Math.round(candidate.similarity * 100)}% similar <button type="button" className="link-button" disabled={aiAvailability.status !== 'ready'} onClick={() => openGenerate(`Propose a Duplicate relation from task #${task.number} “${task.title}” to task #${candidate.number} “${candidate.title}”. Only create the relation Proposal; do not merge or close either task.`, 'link', task)}>Propose Duplicate relation</button></li>)}</ul> : <p className="muted">No likely duplicates found.</p>}<p className="muted" role="note">Only Tasks you can open are compared.{task.similar_tasks_complete === false && ' More candidates exist than are shown, so this list may be incomplete.'}</p></section>
      <form onSubmit={saveTask} className="task-form"><label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label><label>Description <span className="muted">Markdown</span><textarea rows={6} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>{task.description_html && <article className="task-description-markdown" aria-label="Rendered description" dangerouslySetInnerHTML={{ __html: task.description_html }} />}<div className="form-grid"><label>Status<select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{statuses.map((status) => <option key={status.id} value={status.key}>{status.name}</option>)}</select></label><label>Priority<select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>{['low','normal','high','urgent'].map((p) => <option key={p}>{p}</option>)}</select></label><label>Milestone<MilestoneSelect api={api} project={task.project_id} epoch={milestoneEpoch} value={task.milestone} label="Milestone" onChange={(milestone) => void updateTaskMilestone(task, milestone)} /></label>{taskAttributes.map((attribute) => <label key={attribute.id}>{attribute.name}{attribute.type === 'single_select' || attribute.type === 'multi_select' ? <select aria-label={attribute.name} multiple={attribute.type === 'multi_select'} value={attribute.type === 'multi_select' ? (Array.isArray(attributeDraft[attribute.id]) ? attributeDraft[attribute.id] as string[] : []) : String(attributeDraft[attribute.id] ?? '')} onChange={(event) => setAttributeDraft((current) => ({ ...current, [attribute.id]: attribute.type === 'multi_select' ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value || null }))}>{attribute.type === 'single_select' && <option value="">—</option>}{attributes.find((item) => item.id === attribute.id)?.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select> : attribute.type === 'user' ? <select aria-label={attribute.name} value={String(attributeDraft[attribute.id] ?? '')} onChange={(event) => setAttributeDraft((current) => ({ ...current, [attribute.id]: event.target.value || null }))}><option value="">—</option>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select> : <input aria-label={attribute.name} type={attribute.type === 'number' || attribute.type === 'date' ? attribute.type : 'text'} value={String(attributeDraft[attribute.id] ?? '')} onChange={(event) => setAttributeDraft((current) => ({ ...current, [attribute.id]: event.target.value || null }))} />}</label>)}<label>Start date<input type="date" value={draft.start_date ?? ''} onChange={(e) => setDraft({ ...draft, start_date: e.target.value || null })} /></label><label>Due date<input type="date" value={draft.due_date ?? ''} onChange={(e) => setDraft({ ...draft, due_date: e.target.value || null })} /></label></div><section aria-label="Task notifications"><h3>Task notifications</h3>{watchPreferences && <><label className="check-option"><input type="checkbox" checked={watchPreferences.watching} onChange={(event) => setWatchPreferences({ ...watchPreferences, watching: event.target.checked })} />Watch this Task</label><fieldset disabled={!watchPreferences.watching}><legend>Send me</legend>{[['updated','Task changes'],['assignment','Assignee changes'],['comment','New comments'],['reply','Replies'],['mention','Mentions']].map(([value,label]) => <label className="check-option" key={value}><input type="checkbox" checked={watchPreferences.events.includes(value)} onChange={(event) => setWatchPreferences({ ...watchPreferences, events: event.target.checked ? [...watchPreferences.events, value] : watchPreferences.events.filter((item) => item !== value) })} />{label}</label>)}</fieldset><label className="check-option"><input type="checkbox" checked={watchPreferences.muted} disabled={!watchPreferences.watching} onChange={(event) => setWatchPreferences({ ...watchPreferences, muted: event.target.checked })} />Mute this Task</label><button type="button" className="secondary" onClick={async () => { try { const saved = await api<WatchPreferences>(`/tasks/${task.id}/watch`, { method: 'PUT', body: JSON.stringify(watchPreferences) }); setWatchPreferences(saved); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save notification preferences.'); } }}>Save notification preferences</button></>}</section><label>Watchers<select multiple size={Math.min(Math.max(members.length, 2), 5)} value={draft.watchers} onChange={(e) => setDraft({ ...draft, watchers: Array.from(e.target.selectedOptions, (option) => option.value) })}>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select><span className="muted">Use Ctrl or Command to select multiple people.</span></label><label>Assignees<select multiple size={Math.min(Math.max(members.length + teams.length, 2), 6)} value={draft.assignees.map(({ type, id }) => `${type}:${id}`)} onChange={(e) => setDraft({ ...draft, assignees: Array.from(e.target.selectedOptions, (option) => { const [type, id] = option.value.split(':'); return { type: type as 'user' | 'team', id, name: option.textContent ?? '' }; }) })}>{members.map((member) => <option key={`user:${member.id}`} value={`user:${member.id}`}>{member.email}</option>)}{teams.map((team) => <option key={`team:${team.id}`} value={`team:${team.id}`}>@{team.name}</option>)}</select><span className="muted">Assignees do not receive access from assignment.</span></label><label>Move to Project<select value={moveTarget} onChange={(e) => { setMoveTarget(e.target.value); setPreview(null); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.visibility}</option>)}</select></label>{moveTarget !== task.project_id && <div className="move-preview"><button type="button" className="secondary" onClick={previewMove}>Preview move effects</button>{preview && <div role="status"><strong>Review before confirming</strong><p>Destination is {preview.destination_visibility}; {preview.subtasks_affected} subtasks and {preview.relations_affected} relations are affected.</p>{preview.milestone_effect?.clears && <p>{preview.milestone_effect.milestone ? `The Milestone “${preview.milestone_effect.milestone.name}” is cleared` : 'Milestones are cleared'}; {preview.milestone_effect.tasks_cleared} {preview.milestone_effect.tasks_cleared === 1 ? 'Task loses' : 'Tasks lose'} a Milestone.</p>}<p>Destination members: {preview.destination_members.length}. Save task to confirm this move.</p></div>}</div>}
      <section className="team-grants" aria-label="Project Team access"><h3>Project Team access</h3><div className="capture"><label>Team<select value={grantTeam} onChange={(event) => setGrantTeam(event.target.value)}><option value="">Choose a Team</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label>Access<select value={grantRole} onChange={(event) => setGrantRole(event.target.value)}><option value="viewer">Viewer</option><option value="contributor">Contributor</option><option value="manager">Manager</option></select></label><button type="button" disabled={!grantTeam} onClick={() => void addProjectTeamGrant()}>Grant access</button></div><ul>{teamGrants.map((grant) => <li key={grant.team_id}><span>{grant.name} · {grant.role}</span><button type="button" className="link-button" onClick={() => void removeProjectTeamGrant(grant.team_id)}>Remove</button></li>)}</ul></section>
      {conflict && <div className="conflict" role="alert"><strong>This task changed on the server.</strong><p>Your draft is still in the editor. Current title: “{conflict.title}” (version {conflict.version}). Copy your draft or reload before saving again.</p><button type="button" className="secondary" onClick={() => { setDraft(conflict); setTask(conflict); setConflict(null); }}>Load current version</button></div>}
      <div className="actions"><button type="submit" disabled={moveTarget !== task.project_id && !preview}>Save changes</button><button type="button" className="secondary" onClick={() => void takeTask()}>Take</button><button type="button" className="secondary" onClick={duplicate}>Duplicate</button>{task.archived_at ? <button type="button" className="secondary" onClick={() => void archive(true)}>Restore</button> : <button type="button" className="danger" onClick={() => void archive()}>Archive</button>}</div></form>
      {task.created_from && <p className="muted">Created from a comment on <a href={`/w/${task.workspace_id}/tasks/${task.created_from.task_number}`}>#{task.created_from.task_number}</a></p>}
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
      <section className="task-structure" aria-label="Referenced from"><h2>Referenced from</h2>{backlinks.length ? <ul>{backlinks.map((reference, index) => <li key={`${reference.comment_id ?? reference.source_kind}-${index}`}><a href={`/w/${task.workspace_id}/tasks/${reference.task_number}`}>#{reference.task_number} {reference.task_title}</a>{reference.comment_id ? ` · comment at position ${reference.position}` : ` · description at position ${reference.position}`}{reference.snippet && <p className="muted">{reference.snippet}</p>}</li>)}</ul> : <p className="muted">No references yet.</p>}</section>
      <section className="task-structure" aria-label="Comments"><h2>Discussion and changes</h2>
        <div role="group" aria-label="Timeline filter" className="actions">{(['all', 'discussion', 'changes'] as const).map((filter) => <button key={filter} type="button" className={discussionFilter === filter ? '' : 'secondary'} aria-pressed={discussionFilter === filter} onClick={() => setDiscussionFilter(filter)}>{filter === 'all' ? 'All' : filter === 'discussion' ? 'Discussion' : 'Changes'}</button>)}</div>
        {timelineItems.map((item) => item.kind === 'comment' ? <article key={item.id} className="comment" data-comment-id={item.id}>{item.quote && <blockquote className="quoted-comment">{item.quote.body}</blockquote>}<div dangerouslySetInnerHTML={{ __html: item.html ?? '' }} />{Boolean(item.attachments?.length) && <ul aria-label="Comment attachments">{item.attachments?.map((attachment) => <li key={attachment.id}><a href={attachment.download_url} download={attachment.file_name}>{attachment.file_name} ({Math.ceil(attachment.size / 1024)} KiB)</a>{attachment.preview_url && attachment.content_type.startsWith('image/') && <img className="comment-attachment-preview" src={attachment.preview_url} alt={`Preview: ${attachment.file_name}`} />}{attachment.preview_url && attachment.content_type === 'application/pdf' && <a href={attachment.preview_url} target="_blank" rel="noreferrer">Preview PDF: {attachment.file_name}</a>}</li>)}</ul>}{item.edited && <span className="muted"> · Edited</span>}{comments.find((comment) => comment.id === item.id)?.created_tasks?.map((created) => <p key={created.id}><a href={`/w/${task.workspace_id}/tasks/${created.number}`} onClick={(event) => { event.preventDefault(); openPanel({ task_id: created.id, task_number: created.number, title: created.title } as SearchResult); }}>Created Task: #{created.number} {created.title}</a></p>)}<div className="actions"><button type="button" className="secondary" onClick={() => setReplyToComment(item.id)}>Reply</button><button type="button" className="secondary" aria-label={`React to comment ${item.id} with thumbs up`} onClick={() => void toggleReaction(item, '👍')}>👍 {item.reactions?.find((reaction) => reaction.emoji === '👍')?.count ?? 0}</button><button type="button" className="secondary" onClick={() => { setEditingComment(item.id); setCommentBody(item.body ?? ''); }}>Edit</button><button type="button" className="secondary" onClick={() => { const comment = comments.find((entry) => entry.id === item.id); if (comment && task) setTaskFromComment({ comment, title: comment.body.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 255) || 'New task', description: comment.body, project_id: task.project_id, request_id: crypto.randomUUID() }); }}>Create Task</button><button type="button" className="danger" onClick={() => void deleteComment(item.id)}>Delete</button></div>{taskFromComment?.comment.id === item.id && <form className="capture" aria-label="Create Task from comment" onSubmit={createTaskFromComment}><label>Title<input autoFocus value={taskFromComment.title} onChange={(event) => setTaskFromComment({ ...taskFromComment, title: event.target.value })} required /></label><label>Description<textarea rows={5} value={taskFromComment.description} onChange={(event) => setTaskFromComment({ ...taskFromComment, description: event.target.value })} /></label><label>Project<select value={taskFromComment.project_id} onChange={(event) => setTaskFromComment({ ...taskFromComment, project_id: event.target.value })}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button type="submit">Save Task</button><button type="button" className="secondary" onClick={() => setTaskFromComment(null)}>Cancel</button></form>}</article> : item.kind === 'change' ? <article key={item.id} className="timeline-change"><strong>Changed {item.field}</strong><span className="muted"> · {new Date(item.created_at).toLocaleString()}</span></article> : <article key={item.id} className="comment"><span className="muted">Deleted comment</span></article>)}
        {replyToComment && <p className="muted">Replying to a comment <button type="button" className="link-button" onClick={() => setReplyToComment(null)}>Cancel reply</button></p>}
        <form className="inline-form" onSubmit={saveComment}><label className="sr-only" htmlFor="comment-body">Markdown comment</label><textarea id="comment-body" ref={commentInput} rows={4} value={commentBody} onChange={(event) => updateCommentBody(event.target.value, event.target.selectionStart)} onKeyDown={(event) => { if (noteReferenceSuggestions.length) { if (event.key === 'ArrowDown') { event.preventDefault(); setNoteReferenceSuggestionIndex((index) => (index + 1) % noteReferenceSuggestions.length); } else if (event.key === 'ArrowUp') { event.preventDefault(); setNoteReferenceSuggestionIndex((index) => (index + noteReferenceSuggestions.length - 1) % noteReferenceSuggestions.length); } else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); insertNoteReference(noteReferenceSuggestions[noteReferenceSuggestionIndex]); } else if (event.key === 'Escape') setNoteReferenceSuggestions([]); return; } const list = mentionSuggestions.length ? mentionSuggestions : referenceSuggestions; if (!list.length) return; if (event.key === 'ArrowDown') { event.preventDefault(); setReferenceSuggestionIndex((index) => (index + 1) % list.length); } else if (event.key === 'ArrowUp') { event.preventDefault(); setReferenceSuggestionIndex((index) => (index + list.length - 1) % list.length); } else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (mentionSuggestions.length) insertMention(mentionSuggestions[referenceSuggestionIndex]); else insertReference(referenceSuggestions[referenceSuggestionIndex]); } else if (event.key === 'Escape') { setReferenceSuggestions([]); setMentionSuggestions([]); } }} placeholder="Write a Markdown comment…" required /><label htmlFor="comment-attachments">Attach files to comment</label><input id="comment-attachments" type="file" multiple onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); setCommentFiles(files); setError(attachmentProblem(files)); }} />{commentFiles.length > 0 && <p className="muted">{commentFiles.map((file) => `${file.name} (${Math.ceil(file.size / 1024)} KiB)`).join(', ')}</p>}{noteReferenceSuggestions.length > 0 && <ul role="listbox" aria-label="Note references">{noteReferenceSuggestions.map((suggestion, index) => <li key={`${suggestion.vault_id}:${suggestion.path}`}><button type="button" role="option" aria-selected={index === noteReferenceSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => insertNoteReference(suggestion)}>{suggestion.title} · {suggestion.vault_name} · {suggestion.path}</button></li>)}</ul>}{mentionSuggestions.length > 0 && <ul role="listbox" aria-label="People to mention">{mentionSuggestions.map((suggestion, index) => <li key={suggestion.id}><button type="button" role="option" aria-selected={index === referenceSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(suggestion)}>{suggestion.label}</button></li>)}</ul>}{referenceSuggestions.length > 0 && <ul role="listbox" aria-label="Task references">{referenceSuggestions.map((suggestion, index) => <li key={suggestion.id}><button type="button" role="option" aria-selected={index === referenceSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => insertReference(suggestion)}>#{suggestion.number} {suggestion.title} · {suggestion.status}</button></li>)}</ul>}<button type="submit">{editingComment ? 'Save edit' : replyToComment ? 'Reply' : 'Comment'}</button>{editingComment && <button type="button" className="secondary" onClick={() => { setEditingComment(null); setCommentBody(''); }}>Cancel</button>}</form>
      </section>
      <p className="muted">Stable URL: <code>{taskUrl(task)}</code> · version {task.version}</p>
    </section>}
    {!showSkills && generateOpen && workspace && aiAvailability.status === 'ready' && <GenerateDialog capability={generateCapability} focusTask={generateFocus} api={api} workspaceId={workspace.id} connection={aiAvailability.connection} projects={projects} vaults={vaults} selectedTaskIds={generateFocus ? [generateFocus.id] : selectedTaskIds} defaultProjectId={generateFocus?.project_id ?? selectedProject} initialGoal={generateGoal} onClose={closeGenerate} onDone={(id, context) => void finishGeneration(id, context)} />}
    {!showSkills && paletteOpen && <div className="overlay-backdrop palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closePalette(); }}><section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><label className="sr-only" htmlFor="command-search">Search tasks and commands</label><input id="command-search" ref={paletteInputRef} role="searchbox" aria-label="Search tasks and commands" placeholder="Search tasks, notes, or commands…" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void runPaletteCommand(); } }} /><p className="muted">Search tasks and comments, or jump to notes by name. Commands: create &lt;title&gt;, generate &lt;goal&gt;, split, links, status &lt;name&gt;.</p><div className="palette-results" role="listbox" aria-label="Palette results">
      {paletteQuery.trim().match(/^(?:suggest\s+)?(?:split|links?)(?:\s+.+)?$/i) && (aiAvailability.status !== 'ready'
        ? <p role="option" aria-selected="false" aria-disabled="true" className="muted">Suggest split and Suggest links are unavailable: {aiAvailability.status === 'unavailable' ? aiAvailability.reason : 'checking…'}</p>
        : !(task ?? viewTasks[focusedRowIndex])
          ? <p role="option" aria-selected="false" aria-disabled="true" className="muted">Open or focus a task first.</p>
          : <button type="button" role="option" onClick={() => void runPaletteCommand()}><strong>{/split/i.test(paletteQuery) ? 'Suggest split' : 'Suggest links'}</strong><span className="muted">Task #{(task ?? viewTasks[focusedRowIndex]).number} {(task ?? viewTasks[focusedRowIndex]).title}</span></button>)}
      {paletteQuery.trim().match(/^(?:generate|ai)(?:\s+.+)?$/i) && (aiAvailability.status === 'ready'
        ? <button type="button" role="option" onClick={() => void runPaletteCommand()}><strong>Generate with AI</strong><span className="muted">{paletteQuery.trim().replace(/^(?:generate|ai)\s*/i, '') || 'Describe a goal next'}</span></button>
        : <p role="option" aria-selected="false" aria-disabled="true" className="muted">Generate with AI is unavailable: {aiAvailability.status === 'unavailable' ? aiAvailability.reason : 'checking…'}</p>)}
      {paletteQuery.trim().match(/^create(?:\s+.+)?$/i) && <button type="button" role="option" onClick={() => void runPaletteCommand()}><strong>Create task</strong><span className="muted">{paletteQuery.trim().replace(/^create\s*/i, '') || 'New task'}</span></button>}
      {paletteQuery.trim().match(/^status\s+.+$/i) && statuses.filter((status) => `${status.key} ${status.name}`.toLowerCase().includes(paletteQuery.trim().replace(/^status\s+/i, '').toLowerCase())).map((status) => <button type="button" role="option" key={status.id} onClick={() => void runPaletteCommand()}><strong>Set status to {status.name}</strong><span className="muted">Task #{viewTasks[focusedRowIndex]?.number ?? '—'}</span></button>)}
      {paletteMilestoneQuery && milestoneTarget && <PaletteMilestones api={api} project={milestoneTarget.project_id} epoch={milestoneEpoch} filter={paletteMilestoneQuery[1] ?? ''} taskNumber={milestoneTarget.number} onPick={(milestone) => { void updateTaskMilestone(milestoneTarget, milestone); closePalette(); }} />}
      {paletteQuery.trim().match(/^column\s+move\s+.+\s+(left|right)$/i) && <button type="button" role="option" onClick={() => void runPaletteCommand()}><strong>{paletteQuery.trim()}</strong><span className="muted">Reorder a Kanban Status column</span></button>}
      {paletteSearchError && <p role="alert" className="muted">{paletteSearchError}</p>}
      {paletteResults.map((item) => <button type="button" role="option" key={item.task_id} onClick={() => { closePalette(false); openPanel(item); }}><span className="number">#{item.task_number}</span><strong>{item.title}</strong><span className="muted">{item.snippet}</span></button>)}
      {paletteNoteResults.map((item) => <button type="button" role="option" key={`${item.vault_id}:${item.path}`} onClick={() => { closePalette(false); void openKnowledgeResult(item); }}><strong>{item.title}</strong><span className="muted">{item.vault_name} · {item.path}</span></button>)}
      {paletteResults.length === 0 && paletteNoteResults.length === 0 && !paletteSearchError && !paletteQuery.trim().match(/^(?:create|status|milestone|generate|ai|split|links?|suggest)\b/i) && <p className="muted">No matching tasks, comments, or note names.</p>}
      </div><div className="palette-footer"><button type="button" className="secondary" onClick={() => closePalette()}>Close · Esc</button></div></section></div>}
    {!showSkills && shortcutHelpOpen && <div className="overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShortcutHelpOpen(false); restoreFocus(); } }}><section className="shortcut-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><h2>Keyboard shortcuts</h2><dl><dt>Enter or F2</dt><dd>Edit the selected task title</dd><dt>Escape</dt><dd>Cancel an edit or close an overlay</dd><dt>Shift + Arrow</dt><dd>Select a range of tasks</dd><dt>Tab</dt><dd>Move between controls; create a subtask only in Outline mode</dd><dt>Ctrl/⌘ + K</dt><dd>Open task search and commands</dd><dt>Ctrl/⌘ + Z</dt><dd>Undo the last change</dd><dt>Ctrl/⌘ + Shift + Z</dt><dd>Redo the last change</dd><dt>B, E, O</dt><dd>Switch between Browse, Edit and Outline modes</dd><dt>Thai IME</dt><dd>Single-letter shortcuts pause while text is composing</dd></dl><button type="button" onClick={() => { setShortcutHelpOpen(false); restoreFocus(); }}>Close shortcuts</button></section></div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
