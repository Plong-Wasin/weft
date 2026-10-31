import { api } from './api';
import type { App } from './app-state';
import { SmartListBuilder } from './smart-builder';
import React from 'react';
import { Dialog } from './ui/primitives';
import { AssigneePicker, AttributeEditor, OptionPicker, StatusPicker } from './task-cells';
import { DateInput } from './ui/date-input';
import { t, useLocale } from './i18n';

export function NewTaskDialog({ app }: { app: App }) {
  useLocale();
  const { aiAvailability, projects, selectedProject, newTaskDraft: draft, setNewTaskDraft: setDraft } = app;
  const manualLists = app.taskLists.filter((list) => list.kind === 'manual');
  const projectAttributes = app.attributes.filter((attribute) => attribute.project_ids?.includes(selectedProject));
  const parents = app.tasks.filter((item) => item.project_id === selectedProject && app.taskDepth(item) < 4).map((item) => ({ value: item.id, label: `#${item.number} ${item.title}` }));
  const defaultStatus = app.statuses.find((status) => status.is_default) ?? app.statuses.find((status) => status.category === 'not_started') ?? app.statuses[0];
  return <Dialog wide label={t('dlg.newTask')} onClose={() => app.setNewTaskOpen(false)}>
    <form className="stack" onSubmit={app.createTask}>
      <label className="field" htmlFor="task-title">{t('dlg.taskTitle')}<input id="task-title" data-autofocus placeholder={t('dlg.taskTitlePlaceholder')} value={app.title} onChange={(event) => app.setTitle(event.target.value)} required /></label>
      <label className="field">{t('dlg.project')}<select aria-label="Project" value={selectedProject} onChange={(event) => { app.setSelectedProject(event.target.value); setDraft({ ...draft, parent: '', attrs: {} }); }} required><option value="" disabled>{t('dlg.selectProject')}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <div className="dialog-props">
        <div className="prop"><span className="prop-label">{t('detail.status')}</span><StatusPicker statuses={app.statuses} value={draft.status || defaultStatus?.key || ''} label={t('dlg.status')} className="prop-button secondary" onChange={(key) => setDraft({ ...draft, status: key })} /></div>
        <div className="prop"><span className="prop-label">{t('detail.assignee')}</span><AssigneePicker showNames className="prop-button secondary" value={draft.assignees} members={app.members} teams={app.teams} label={t('dlg.assignees')} onChange={(next) => setDraft({ ...draft, assignees: next })} /></div>
        <div className="prop"><span className="prop-label">{t('detail.dueDate')}</span><DateInput label={t('dlg.due')} value={draft.due} onChange={(next) => setDraft({ ...draft, due: next })} /></div>
        <div className="prop"><span className="prop-label">{t('detail.lists')}</span><OptionPicker multiple className="prop-button secondary" label={t('dlg.lists')} placeholder={manualLists.length ? t('detail.noLists') : t('detail.noManualLists')} disabled={manualLists.length === 0} options={manualLists.map((list) => ({ value: list.id, label: list.name }))} value={draft.lists} onChange={(next) => setDraft({ ...draft, lists: next as string[] })} /></div>
        <div className="prop"><span className="prop-label">{t('detail.parent')}</span><OptionPicker allowClear className="prop-button secondary" label={t('dlg.parent')} placeholder={t('detail.noParent')} options={parents} value={draft.parent || null} onChange={(next) => setDraft({ ...draft, parent: (next as string | null) ?? '' })} /></div>
        {projectAttributes.map((attribute) => <div className="prop" key={attribute.id}><span className="prop-label">{attribute.name}</span><AttributeEditor live className="prop-button secondary" attribute={attribute} members={app.members} label={attribute.name} value={draft.attrs[attribute.id]} onChange={(next) => setDraft({ ...draft, attrs: { ...draft.attrs, [attribute.id]: next } })} /></div>)}
      </div>
      <p id="ai-availability" className="muted ai-availability" role="status">{aiAvailability.status === 'ready' ? t('ai.ready', { provider: aiAvailability.connection.provider }) : aiAvailability.status === 'unavailable' ? t('ai.unavailable', { reason: aiAvailability.reason }) : t('ai.checking')}</p>
      <div className="actions end">
        <button type="button" className="secondary" disabled={aiAvailability.status !== 'ready'} aria-describedby="ai-availability" onClick={() => { app.setNewTaskOpen(false); app.openGenerate(app.title.trim()); }}>{t('dlg.generateWithAi')}</button>
        <button disabled={!selectedProject}>{t('dlg.createTask')}</button>
      </div>
    </form>
  </Dialog>;
}

const ATTRIBUTE_TYPES = ['text', 'number', 'date', 'single_select', 'multi_select', 'user'] as const;

/** Creates a custom Attribute from a column header menu: any type, for every Project, shown as a column at once. */
export function NewAttributeDialog({ app }: { app: App }) {
  useLocale();
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<(typeof ATTRIBUTE_TYPES)[number]>('text');
  const [optionsText, setOptionsText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const selectType = type === 'single_select' || type === 'multi_select';
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!app.workspace || busy) return;
    setBusy(true);
    try {
      const options = optionsText.split(',').map((item) => item.trim()).filter(Boolean);
      const created = await api<{ id: string }>(`/workspaces/${app.workspace.id}/attributes`, { method: 'POST', body: JSON.stringify({ name: name.trim(), value_type: type, project_ids: app.projects.map((project) => project.id), ...(selectType ? { options } : {}) }) });
      await app.refresh(app.workspace.id);
      app.changeColumns([...app.effectiveColumns.filter((column) => column !== `attribute:${created.id}`), `attribute:${created.id}`]);
      app.announce(t('attr.created', { name: name.trim() }));
      app.setAttributeDialogOpen(false);
    } catch (reason) { app.setError(reason instanceof Error ? reason.message : t('attr.failed')); setBusy(false); }
  }
  return <Dialog label={t('table.newAttribute')} onClose={() => app.setAttributeDialogOpen(false)}>
    <form className="stack" onSubmit={submit}>
      <label className="field">{t('attr.name')}<input data-autofocus aria-label={t('attr.name')} value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></label>
      <label className="field">{t('attr.type')}<select aria-label={t('attr.type')} value={type} onChange={(event) => setType(event.target.value as typeof type)}>{ATTRIBUTE_TYPES.map((value) => <option key={value} value={value}>{t(`attr.type.${value}`)}</option>)}</select></label>
      {selectType && <label className="field">{t('attr.options')}<input aria-label={t('attr.options')} value={optionsText} onChange={(event) => setOptionsText(event.target.value)} required /></label>}
      <p className="muted">{t('attr.hint')}</p>
      <div className="actions end"><button type="button" className="secondary" onClick={() => app.setAttributeDialogOpen(false)}>{t('common.cancel')}</button><button disabled={busy}>{t('attr.create')}</button></div>
    </form>
  </Dialog>;
}

export function NewListDialog({ app }: { app: App }) {
  useLocale();
  const { statuses, attributes, workspace } = app;
  return <Dialog wide label={t('dlg.newList')} onClose={() => app.setNewListOpen(false)}>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); void app.createList('manual'); }}>
      <label className="field" htmlFor="new-list-name">{t('dlg.listName')}<input id="new-list-name" data-autofocus placeholder={t('dlg.listNamePlaceholder')} value={app.newListName} onChange={(event) => app.setNewListName(event.target.value)} required /></label>
      <div className="form-grid">
        <label className="field">{t('dlg.statusFilter')}<select aria-label="Smart List Status filter" value={app.smartStatus} onChange={(event) => app.setSmartStatus(event.target.value)}><option value="">{t('dlg.anyStatus')}</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label>
        <label className="field">{t('dlg.dueFilter')}<select aria-label="Smart List due date filter" value={app.smartRelativeDate} onChange={(event) => app.setSmartRelativeDate(event.target.value)}><option value="">{t('dlg.anyDate')}</option><option value="today">{t('dlg.dueToday')}</option><option value="overdue">{t('dlg.overdue')}</option><option value="next_7_days">{t('dlg.dueIn7')}</option></select></label>
        <label className="field">{t('dlg.attrFilter')}<select aria-label="Smart List Attribute" value={app.smartAttribute} onChange={(event) => { app.setSmartAttribute(event.target.value); app.setSmartAttributeValue(''); }}><option value="">{t('dlg.noAttrFilter')}</option>{attributes.map((attribute) => <option key={attribute.id} value={attribute.id}>{attribute.name}</option>)}</select></label>
        {app.smartAttribute && <label className="field">{t('dlg.attrValue')}{attributes.find((attribute) => attribute.id === app.smartAttribute)?.options.length ? <select aria-label="Smart List Attribute value" value={app.smartAttributeValue} onChange={(event) => app.setSmartAttributeValue(event.target.value)}><option value="">{t('dlg.anyValue')}</option>{attributes.find((attribute) => attribute.id === app.smartAttribute)?.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select> : <input aria-label="Smart List Attribute value" value={app.smartAttributeValue} onChange={(event) => app.setSmartAttributeValue(event.target.value)} />}</label>}
      </div>
      <label className="check-option"><input type="checkbox" checked={app.smartAssignee} onChange={(event) => app.setSmartAssignee(event.target.checked)} />{t('dlg.assignedToMe')}</label>
      {app.smartAssignee && <label className="check-option"><input type="checkbox" checked={app.smartIncludeTeam} onChange={(event) => app.setSmartIncludeTeam(event.target.checked)} />{t('dlg.includeTeam')}</label>}
      <fieldset><legend>{t('dlg.visibleColumns')}</legend><div className="check-row">{['title', 'status', 'priority'].map((column) => <label className="check-option" key={column}><input type="checkbox" checked={app.smartColumns.includes(column)} onChange={(event) => app.setSmartColumns((items) => event.target.checked ? [...items, column] : items.filter((item) => item !== column))} />{t(`col.${column as 'status'}`)}</label>)}{attributes.map((attribute) => { const column = `attribute:${attribute.id}`; return <label className="check-option" key={column}><input type="checkbox" checked={app.smartColumns.includes(column)} onChange={(event) => app.setSmartColumns((items) => event.target.checked ? [...items, column] : items.filter((item) => item !== column))} />{attribute.name}</label>; })}</div></fieldset>
      <div className="form-grid">
        <label className="field">{t('dlg.combine')}<select aria-label="Smart List filter logic" value={app.smartLogic} onChange={(event) => app.setSmartLogic(event.target.value as 'and' | 'or')}><option value="and">{t('dlg.matchAll')}</option><option value="or">{t('dlg.matchAny')}</option></select></label>
        <label className="field">{t('dlg.sort')}<select aria-label="Smart List sort" value={app.smartSort} onChange={(event) => app.setSmartSort(event.target.value)}><option value="number">{t('dlg.sortNumber')}</option><option value="title">{t('col.task')}</option><option value="due_date">{t('col.due')}</option></select></label>
        <label className="field">{t('dlg.group')}<select aria-label="Smart List group" value={app.smartGroup} onChange={(event) => app.setSmartGroup(event.target.value)}><option value="">{t('dlg.noGroup')}</option><option value="status">{t('col.status')}</option><option value="priority">{t('col.priority')}</option></select></label>
      </div>
      <div className="actions end"><button type="submit" className="secondary">{t('dlg.createManual')}</button><button type="button" onClick={() => void app.createList('smart')}>{t('dlg.createSmart')}</button></div>
    </form>
    <SmartListBuilder api={api} workspaceId={workspace?.id ?? ''} statuses={statuses} projects={app.projects} onCreated={(created) => { app.setTaskLists((items) => [...items, created]); app.setListTasks([]); app.setActiveView('list'); app.setActiveTab('tasks'); app.setNewListOpen(false); void app.openList(created.id); }} />
  </Dialog>;
}

export function ProjectDialog({ app }: { app: App }) {
  useLocale();
  return <Dialog label={t('dlg.newProject')} onClose={() => app.setProjectDialogOpen(false)}>
    <form className="stack" onSubmit={app.createProject}>
      <label className="field" htmlFor="project-name">{t('dlg.projectName')}<input id="project-name" name="project-name" data-autofocus placeholder={t('dlg.projectNamePlaceholder')} required /></label>
      <div className="actions end"><button type="submit">{t('dlg.createProject')}</button></div>
    </form>
  </Dialog>;
}

export function TeamsDialog({ app }: { app: App }) {
  useLocale();
  const { teams, members, teamMembers, teamMemberDrafts } = app;
  return <Dialog wide label={t('dlg.teams')} onClose={() => app.setTeamsOpen(false)}>
    <form className="inline-form" onSubmit={app.createTeam}><label className="sr-only" htmlFor="team-name">{t('dlg.teamName')}</label><input id="team-name" data-autofocus value={app.teamName} onChange={(event) => app.setTeamName(event.target.value)} placeholder={t('dlg.teamName')} required /><button>{t('dlg.createTeam')}</button></form>
    {teams.length === 0 ? <p className="muted">{t('dlg.noTeams')}</p> : teams.map((team) => <details key={team.id} className="team-row" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) void app.loadTeamMembers(team); }}><summary>{team.name}</summary>
      <div className="actions team-actions"><button type="button" className="secondary" onClick={() => void app.renameTeam(team)}>{t('common.rename')}</button><button type="button" className="danger" onClick={() => void app.deleteTeam(team)}>{t('dlg.deleteTeam')}</button></div>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const memberId = teamMemberDrafts[team.id]; if (memberId) void app.changeTeamMember(team, memberId, true); }}><label className="field">{t('dlg.addMember')}<select aria-label={`Add member to ${team.name}`} value={teamMemberDrafts[team.id] ?? ''} onChange={(event) => app.setTeamMemberDrafts((drafts) => ({ ...drafts, [team.id]: event.target.value }))}><option value="">{t('dlg.chooseMember')}</option>{members.filter((member) => !teamMembers[team.id]?.some((item) => item.id === member.id)).map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select></label><button disabled={!teamMemberDrafts[team.id]}>{t('dlg.add')}</button></form>
      <ul className="plain-list">{(teamMembers[team.id] ?? []).map((member) => <li key={member.id}><span>{member.email}</span><button type="button" className="link-button" onClick={() => void app.changeTeamMember(team, member.id, false)}>{t('common.remove')}</button></li>)}</ul>
    </details>)}
  </Dialog>;
}

export function ShortcutHelpDialog({ app }: { app: App }) {
  useLocale();
  const rows: [string[], string][] = [
    [['Ctrl/⌘', 'K'], t('sc.palette')], [['g', 'i'], t('sc.goInbox')], [['g', 't'], t('sc.goTasks')], [['g', 'm'], t('sc.goMyWork')], [['g', 'p'], t('sc.goProposals')], [['g', 'k'], t('sc.goKnowledge')],
    [['Enter', 'F2'], t('sc.edit')], [['Esc'], t('sc.escape')], [['Shift', '↑ ↓'], t('sc.range')], [['Ctrl/⌘', 'Space'], t('sc.toggle')], [['Tab'], t('sc.tab')],
    [['Ctrl/⌘', 'Z'], t('sc.undo')], [['Ctrl/⌘', 'Shift', 'Z'], t('sc.redo')], [['b', 'e', 'o'], t('sc.modes')], [['?'], t('sc.help')],
  ];
  return <Dialog label={t('menu.shortcuts')} returnFocus={app.focusReturn} onClose={() => app.setShortcutHelpOpen(false)}>
    <dl className="shortcut-list">{rows.map(([keys, text]) => <div key={text} className="shortcut-row"><dt>{keys.map((key, index) => <span key={key}>{index > 0 && ' '}<kbd>{key}</kbd></span>)}</dt><dd>{text}</dd></div>)}<div className="shortcut-row"><dt>{t('sc.imeKey')}</dt><dd>{t('sc.ime')}</dd></div></dl>
  </Dialog>;
}
