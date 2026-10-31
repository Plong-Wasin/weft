import React from 'react';
import { api } from './api';
import { MyConnectionsScreen, SchedulesScreen, type ScheduleAdmin } from './schedules';
import { Icon } from './ui/icons';
import { StatusSettings } from './settings-statuses';
import { formatDate, formatDateTime, t, useLocale } from './i18n';
import type { Attribute, McpToken, Project, Session, Status, Workspace, AiUsage } from './types';

export function SettingsScreen({ workspace, projects, projectsReady, onSignOut, onRefresh, scheduleAdmin, initialSection, onOpenProposal, selectedProject }: { selectedProject: string; onOpenProposal?: (proposalId: string) => void; workspace: Workspace; projects: Project[]; projectsReady: boolean; onSignOut: () => void; onRefresh: () => Promise<void>; scheduleAdmin: ScheduleAdmin; initialSection?: 'ai-schedules' | 'my-ai' }) {
  useLocale();
  const [section, setSection] = React.useState<'sessions' | 'statuses' | 'attributes' | 'tokens' | 'team-ai' | 'ai-usage' | 'ai-schedules' | 'my-ai' | 'data'>(initialSection ?? 'sessions');
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
  const [type, setType] = React.useState('text');
  const [selectedProjects, setSelectedProjects] = React.useState<string[]>([]);
  const [optionsText, setOptionsText] = React.useState('');
  const [attributeArchivePreview, setAttributeArchivePreview] = React.useState<{ id: string; affected_views: number } | null>(null);
  const [addingOptionTo, setAddingOptionTo] = React.useState<string | null>(null);
  const [newOptionName, setNewOptionName] = React.useState('');
  const admin = workspace.role === 'owner' || workspace.role === 'admin';
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [importJson, setImportJson] = React.useState('[\n  { "project_id": "", "title": "" }\n]');
  const [importPreview, setImportPreview] = React.useState<{ preview_id: string; results: { index: number; status: string; reason?: string }[] } | null>(null);
  const [importMessage, setImportMessage] = React.useState('');
  // Settings is a destination, not a dismissal: focus lands here once, never back on the More trigger.
  React.useEffect(() => { headingRef.current?.focus(); }, []);

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

  return <section className="settings-screen" aria-label={t('screen.settings')}><h2 ref={headingRef} tabIndex={-1} className="sr-only">{t('screen.settings')}</h2>
    <nav className="settings-nav" aria-label="Settings sections">
      {(['sessions', 'statuses', 'attributes'] as const).map((item) => <button type="button" key={item} className={section === item ? '' : 'secondary'} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>{item === 'sessions' ? t('settings.sessions') : item === 'statuses' ? t('settings.statuses') : t('settings.attributes')}</button>)}
      <button type="button" className={section === 'tokens' ? '' : 'secondary'} aria-current={section === 'tokens' ? 'page' : undefined} onClick={() => setSection('tokens')}>{t('settings.aiTokens')}</button>
      <button type="button" className={section === 'team-ai' ? '' : 'secondary'} aria-current={section === 'team-ai' ? 'page' : undefined} onClick={() => setSection('team-ai')}>{t('settings.teamAi')}</button>
      {admin && <button type="button" className={section === 'ai-usage' ? '' : 'secondary'} aria-current={section === 'ai-usage' ? 'page' : undefined} onClick={() => setSection('ai-usage')}>{t('settings.aiUsage')}</button>}
      {!admin && scheduleAdmin.ownConnections.length > 0 && <button type="button" className={section === 'my-ai' ? '' : 'secondary'} aria-current={section === 'my-ai' ? 'page' : undefined} onClick={() => setSection('my-ai')}>{t('settings.myAi')}</button>}
      {admin && <button type="button" className={section === 'ai-schedules' ? '' : 'secondary'} aria-current={section === 'ai-schedules' ? 'page' : undefined} onClick={() => setSection('ai-schedules')}>{t('settings.aiSchedules')}</button>}
      {admin && <button type="button" className={section === 'data' ? '' : 'secondary'} aria-current={section === 'data' ? 'page' : undefined} onClick={() => setSection('data')}>{t('settings.data')}</button>}
    </nav>
    {message && <p role="status" className="settings-message">{message}</p>}
    {section === 'data' && admin && <section aria-label={t('settings.data')}><h3>{t('settings.data')}</h3>
      <details className="capture" aria-label="Import Tasks from JSON" open><summary>Import Tasks from JSON</summary><p className="muted">{t('settings.importHelp')}</p><label className="field">JSON Tasks<textarea aria-label="JSON Tasks" rows={8} value={importJson} onChange={(event) => setImportJson(event.target.value)} /></label><div className="actions"><button type="button" disabled={!selectedProject} onClick={async () => { try { const parsed = JSON.parse(importJson); const items = (Array.isArray(parsed) ? parsed : parsed.items).map((item: Record<string, unknown>) => ({ ...item, project_id: item.project_id || selectedProject })); const preview = await api<{ preview_id: string; results: { index: number; status: string; reason?: string }[] }>(`/workspaces/${workspace.id}/tasks/import`, { method: 'POST', body: JSON.stringify({ items }) }); setImportPreview(preview); setImportMessage('Dry run complete. No Tasks have been created.'); } catch (reason) { setImportMessage(reason instanceof Error ? reason.message : 'Could not preview import.'); } }}>{importPreview ? 'Refresh dry run' : 'Dry run'}</button></div>{importPreview && <><ul aria-label="Import results" className="plain-list">{importPreview.results.map((result) => <li key={result.index}>Item {result.index + 1}: {result.status}{result.reason ? ` · ${result.reason}` : ''}</li>)}</ul><div className="actions"><button type="button" onClick={async () => { try { await api(`/workspaces/${workspace.id}/tasks/import/${importPreview.preview_id}/apply`, { method: 'POST', body: '{}' }); setImportMessage('Import applied as one undoable Operation.'); setImportPreview(null); await onRefresh(); } catch (reason) { setImportMessage(reason instanceof Error ? reason.message : 'Could not apply import.'); } }}>Apply import</button></div></>}{importMessage && <p role="status">{importMessage}</p>}</details>
      <div className="actions"><button type="button" className="secondary" onClick={async () => { try { const data = await api<unknown>(`/workspaces/${workspace.id}/export`, { method: 'POST' }); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${workspace.name}-export.json`; link.click(); URL.revokeObjectURL(url); } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not export Workspace.'); } }}><Icon name="download" small />{t('settings.exportWorkspace')}</button></div>
    </section>}
    {section === 'sessions' && <section aria-label="Active sessions"><h3>Active sessions</h3><p className="muted">Revoke a session to sign that device out.</p>{sessions.length === 0 ? <p>No active sessions.</p> : <ul className="settings-list">{sessions.map((session) => <li key={session.id}><span><strong>{session.current ? 'This device' : 'Signed-in device'}</strong><small>Signed in {formatDateTime(session.created_at)} · expires {formatDate(session.expires_at)}</small></span><button type="button" className="danger" onClick={async () => { if (session.current) { onSignOut(); return; } try { await api(`/auth/sessions/${session.id}`, { method: 'DELETE' }); await load(); setMessage('Session revoked.'); } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not revoke session.'); } }}>Revoke</button></li>)}</ul>}<button type="button" className="danger" onClick={onSignOut}>Sign out</button></section>}
    {section === 'team-ai' && <section aria-label="Team AI"><h3>Use team AI</h3>{!teamAi ? <p role="status">Loading Team AI…</p> : !teamAi.connection ? <p>{teamAi.message ?? 'No shared AI connection is set up. Ask a Workspace admin.'}</p> : <p>{teamAi.connection.state === 'ready' ? `Ready: members can generate without signing in to the provider. ${teamAi.run_notice ?? ''}` : `Shared AI is not ready: ${teamAi.connection.state_reason}`} Your runs only read Projects you can already open, and your sessions stay private to you.</p>}</section>}
    {section === 'my-ai' && !admin && <MyConnectionsScreen admin={scheduleAdmin} />}
    {section === 'ai-schedules' && admin && <SchedulesScreen api={api} workspaceId={workspace.id} projects={projects} projectsReady={projectsReady} admin={scheduleAdmin} onOpenProposal={onOpenProposal} />}
    {section === 'ai-usage' && admin && <section aria-label="AI usage"><h3>AI usage · last {aiUsage?.period_days ?? 30} days</h3><p className="muted">Usage is attributed to members and contains no prompt or Task content. Provider-reported usage stays unknown when the provider does not report it.</p>{!aiUsage ? <p role="status">Loading AI usage…</p> : <><div className="settings-fields"><p><strong>{aiUsage.totals.runs}</strong><small>Runs</small></p><p><strong>{aiUsage.totals.limited_runs}</strong><small>Limited or failed</small></p><p><strong>{aiUsage.totals.unknown ? 'Unknown' : `${aiUsage.totals.total_tokens.toLocaleString()} tokens`}</strong><small>Provider-reported usage</small></p><p><strong>{aiUsage.totals.unknown ? 'Unknown' : `$${aiUsage.totals.cost_usd.toFixed(4)}`}</strong><small>Reported API cost</small></p></div><h4>Connection limits</h4><ul className="settings-list">{aiUsage.policies.map((policy) => <li key={policy.connection_id}><span><strong>{policy.provider} · {policy.billing_mode}</strong><small>{policy.global_concurrency} concurrent runs globally · {policy.per_user_concurrency} per member · {policy.daily_run_budget} runs per member daily{policy.daily_token_budget ? ` · ${policy.daily_token_budget.toLocaleString()} tokens per member daily` : ''}</small></span></li>)}</ul><h4>Usage by member</h4>{aiUsage.users.length === 0 ? <p>No AI runs in this period.</p> : <ul className="settings-list">{aiUsage.users.map((user) => <li key={user.user_id}><span><strong>{user.email}</strong><small>{user.runs} runs · {user.limited_runs} limited or failed · {user.usage.unknown ? 'Provider usage unknown' : `${user.usage.total_tokens.toLocaleString()} reported tokens`}{!user.usage.unknown && ` · $${user.usage.cost_usd.toFixed(4)}`}</small></span></li>)}</ul>}</>}</section>}
    {section === 'statuses' && <StatusSettings workspace={workspace} admin={admin} statuses={statuses} setMessage={setMessage} reload={async () => { await load(); await onRefresh(); }} />}
    {section === 'tokens' && <section aria-label="AI tokens"><h3>AI tokens</h3><p className="muted">Connect your own Claude or Codex client at <code>{window.location.origin}/api/v1/mcp</code>. A token can read and propose only what you can; a person must still approve every Proposal here.</p>
      <form className="settings-create" onSubmit={createMcpToken}><label>Token name<input aria-label="New token name" value={tokenName} onChange={(event) => setTokenName(event.target.value)} required maxLength={100} /></label>
        <fieldset><legend>Capabilities</legend>{[['read', 'Read tasks and notes'], ['generate', 'Propose new tasks'], ['split', 'Propose splits'], ['link', 'Propose links']].map(([value, label]) => <label className="check-option" key={value}><input type="checkbox" checked={tokenCapabilities.includes(value)} onChange={(event) => setTokenCapabilities((current) => event.target.checked ? [...current, value] : current.filter((item) => item !== value))} />{label}</label>)}</fieldset>
        <button disabled={tokenCapabilities.length === 0}>Create token</button></form>
      {newSecret && <div role="group" aria-label="New token secret"><p>Copy this token now. It is shown only once.</p><code>{newSecret}</code> <button type="button" className="secondary" onClick={() => setNewSecret('')}>Done</button></div>}
      {mcpTokens.length === 0 ? <p>No tokens.</p> : <ul className="settings-list">{mcpTokens.map((token) => <li key={token.id} className={token.revoked_at ? 'archived-row' : ''}><span><strong>{token.name}</strong><small>{token.capabilities.join(', ')} · created {formatDate(token.created_at)}{token.last_used_at ? ` · last used ${formatDateTime(token.last_used_at)}` : ' · never used'}{token.revoked_at ? ' · revoked' : ''}</small></span>{!token.revoked_at && <button type="button" className="danger" aria-label={`Revoke token ${token.name}`} onClick={() => void revokeMcpToken(token)}>Revoke</button>}</li>)}</ul>}
    </section>}
    {section === 'attributes' && <section aria-label="Attributes"><h3>Attributes</h3>{!admin && <p className="muted">Read-only · Workspace admins manage Attributes.</p>}{admin && <form className="settings-create" onSubmit={createAttribute}><label>Attribute name<input aria-label="New Attribute name" value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Type<select aria-label="New Attribute type" value={type} onChange={(event) => setType(event.target.value)}>{[['text','Text'],['number','Number'],['date','Date'],['user','User'],['single_select','Single select'],['multi_select','Multi select']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>{(type === 'single_select' || type === 'multi_select') && <label>Options, separated by commas<input aria-label="Attribute options" value={optionsText} onChange={(event) => setOptionsText(event.target.value)} required /></label>}<fieldset><legend>Projects</legend>{projects.map((project) => <label className="check-option" key={project.id}><input type="checkbox" checked={selectedProjects.includes(project.id)} onChange={(event) => setSelectedProjects((current) => event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id))} />{project.name}</label>)}</fieldset><button>Create Attribute</button></form>}
      <ul className="settings-list">{attributes.map((attribute) => <li key={attribute.id} className={attribute.archived ? 'archived-row' : ''}><div className="settings-fields"><label>Name<input aria-label={`Name for ${attribute.name}`} disabled={!admin || attribute.archived} defaultValue={attribute.name} onBlur={(event) => { if (event.target.value !== attribute.name) void updateAttribute(attribute, { name: event.target.value }); }} /></label><span>{attribute.type.replace('_', ' ')}</span><span>{attribute.project_ids.map((id) => projects.find((project) => project.id === id)?.name).filter(Boolean).join(', ') || 'No Projects'}</span></div>{attribute.options.map((option) => <div className="settings-option" key={option.id}><label>{option.name}<input aria-label={`Rename option ${option.name}`} disabled={!admin || attribute.archived} defaultValue={option.name} onBlur={(event) => { if (event.target.value !== option.name) void updateOption(attribute, option, { name: event.target.value }); }} /></label>{admin && !attribute.archived && <button type="button" className="secondary" onClick={() => void updateOption(attribute, option, { archived: true })}>Archive option</button>}</div>)}{addingOptionTo === attribute.id && <form className="settings-option" onSubmit={async (event) => { event.preventDefault(); try { await api(`/workspaces/${workspace.id}/attributes/${attribute.id}/options`, { method: 'POST', body: JSON.stringify({ name: newOptionName }) }); setAddingOptionTo(null); setNewOptionName(''); await load(); setMessage('Option added.'); } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not add option.'); } }}><label>New option<input aria-label="New option name" autoFocus value={newOptionName} onChange={(event) => setNewOptionName(event.target.value)} required /></label><button type="submit">Save option</button><button type="button" className="secondary" onClick={() => { setAddingOptionTo(null); setNewOptionName(''); }}>Cancel</button></form>}{attributeArchivePreview?.id === attribute.id && <div className="archive-preview" role="group" aria-label={`Archive preview for ${attribute.name}`}><p>This affects {attributeArchivePreview.affected_views} saved views.</p><button type="button" className="danger" onClick={() => { setAttributeArchivePreview(null); void updateAttribute(attribute, { archived: true }); }}>Confirm archive</button><button type="button" className="secondary" onClick={() => setAttributeArchivePreview(null)}>Cancel</button></div>}{admin && !attribute.archived && <div className="actions">{['single_select', 'multi_select'].includes(attribute.type) && <button type="button" className="secondary" onClick={() => setAddingOptionTo(attribute.id)}>Add option</button>}<button type="button" className="danger" onClick={() => void previewAttributeArchive(attribute)}>Archive Attribute</button></div>}</li>)}</ul>
    </section>}
  </section>;
}
