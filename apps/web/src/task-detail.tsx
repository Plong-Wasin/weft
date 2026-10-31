import React from 'react';
import { RecurrenceSection } from './recurrence';
import { MilestoneSelect } from './milestones';
import { defaultFocusPrompt } from './generate';
import { api } from './api';
import type { App } from './app-state';
import { Icon } from './ui/icons';
import { MenuButton, MenuItem } from './ui/primitives';
import { enumLabel, formatDateTime, t, useLocale } from './i18n';
import { priorityLabel } from './tasks-screen';
import type { Attribute, SearchResult, Task, WatchPreferences } from './types';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  const text = state === 'saving' ? t('detail.saving') : state === 'saved' ? t('detail.saved') : state === 'error' ? t('detail.notSaved') : '';
  return <span className={`save-indicator ${state}`} role="status" aria-live="polite">{state === 'saved' && <Icon name="check" small />}{text}</span>;
}

function AssigneePicker({ app, draft }: { app: App; draft: Task }) {
  const [open, setOpen] = React.useState(false);
  const wrap = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const selected = new Set(draft.assignees.map(({ type, id }) => `${type}:${id}`));
  function toggle(type: 'user' | 'team', id: string, name: string, on: boolean) {
    const rest = draft.assignees.filter((item) => !(item.type === type && item.id === id));
    app.setDraft({ ...draft, assignees: on ? [...rest, { type, id, name }] : rest });
  }
  const summary = draft.assignees.length ? draft.assignees.map((item) => item.type === 'team' ? `@${item.name}` : item.name.split('@')[0]).join(', ') : t('detail.unassigned');
  return <div className="prop assignee-prop" ref={wrap} onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <span className="prop-label" id="prop-assignee-label">{t('detail.assignee')}</span>
    <button ref={trigger} type="button" className="secondary prop-button" aria-haspopup="true" aria-expanded={open} aria-labelledby="prop-assignee-label prop-assignee-value" onClick={() => setOpen(!open)}><span id="prop-assignee-value" className="prop-value">{summary}</span><Icon name="chevron-down" small /></button>
    {open && <div className="menu left assignee-menu" role="group" aria-label={t('detail.assignees')}>
      {app.members.map((member) => <label key={member.id} className="check-option"><input type="checkbox" checked={selected.has(`user:${member.id}`)} onChange={(event) => toggle('user', member.id, member.email, event.target.checked)} />{member.email}</label>)}
      {app.teams.map((team) => <label key={team.id} className="check-option"><input type="checkbox" checked={selected.has(`team:${team.id}`)} onChange={(event) => toggle('team', team.id, team.name, event.target.checked)} />@{team.name}</label>)}
      <p className="menu-note">{t('detail.assignNoAccess')}</p>
    </div>}
  </div>;
}

function AttributeField({ app, attribute }: { app: App; attribute: { id: string; name: string; type: string } }) {
  const { attributeDraft, setAttributeDraft, attributes, members } = app;
  return <label className="prop"><span className="prop-label">{attribute.name}</span>{attribute.type === 'single_select' || attribute.type === 'multi_select'
    ? <select aria-label={attribute.name} multiple={attribute.type === 'multi_select'} value={attribute.type === 'multi_select' ? (Array.isArray(attributeDraft[attribute.id]) ? attributeDraft[attribute.id] as string[] : []) : String(attributeDraft[attribute.id] ?? '')} onChange={(event) => setAttributeDraft((current) => ({ ...current, [attribute.id]: attribute.type === 'multi_select' ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value || null }))}>{attribute.type === 'single_select' && <option value="">—</option>}{attributes.find((item: Attribute) => item.id === attribute.id)?.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select>
    : attribute.type === 'user'
      ? <select aria-label={attribute.name} value={String(attributeDraft[attribute.id] ?? '')} onChange={(event) => setAttributeDraft((current) => ({ ...current, [attribute.id]: event.target.value || null }))}><option value="">—</option>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select>
      : <input aria-label={attribute.name} type={attribute.type === 'number' || attribute.type === 'date' ? attribute.type : 'text'} value={String(attributeDraft[attribute.id] ?? '')} onChange={(event) => setAttributeDraft((current) => ({ ...current, [attribute.id]: event.target.value || null }))} />}</label>;
}

function NotificationPrefs({ app, task, prefs }: { app: App; task: Task; prefs: WatchPreferences }) {
  const set = app.setWatchPreferences;
  return <section aria-label={t('detail.notifications')} className="more-block"><h3>{t('detail.notifications')}</h3>
    <label className="check-option"><input type="checkbox" checked={prefs.watching} onChange={(event) => set({ ...prefs, watching: event.target.checked })} />{t('detail.watch')}</label>
    <fieldset disabled={!prefs.watching}><legend>{t('detail.sendMe')}</legend>{([['updated', 'detail.ev.updated'], ['assignment', 'detail.ev.assignment'], ['comment', 'detail.ev.comment'], ['reply', 'detail.ev.reply'], ['mention', 'detail.ev.mention']] as const).map(([value, key]) => <label className="check-option" key={value}><input type="checkbox" checked={prefs.events.includes(value)} onChange={(event) => set({ ...prefs, events: event.target.checked ? [...prefs.events, value] : prefs.events.filter((item) => item !== value) })} />{t(key)}</label>)}</fieldset>
    <label className="check-option"><input type="checkbox" checked={prefs.muted} disabled={!prefs.watching} onChange={(event) => set({ ...prefs, muted: event.target.checked })} />{t('detail.mute')}</label>
    <div><button type="button" className="secondary" onClick={async () => { try { set(await api<WatchPreferences>(`/tasks/${task.id}/watch`, { method: 'PUT', body: JSON.stringify(prefs) })); } catch (reason) { app.setError(reason instanceof Error ? reason.message : t('err.saveNotifications')); } }}>{t('detail.saveNotifications')}</button></div>
  </section>;
}

export function TaskDetail({ app }: { app: App }) {
  useLocale();
  const { task, draft, workspace, fullPage, statuses, projects, teams, aiAvailability, taskAttributes } = app;
  if (!task || !draft || !workspace) return null;
  const ai = aiAvailability.status === 'ready';
  const wsId = task.workspace_id;
  const taskLink = (number: number) => `/w/${wsId}/tasks/${number}`;
  const preview = app.preview;
  const moving = app.moveTarget !== task.project_id;

  return <section className={`task-detail ${fullPage ? 'full-page' : 'side-panel'}`} aria-label={`Task #${task.number}`}>
    <div className="detail-bar">
      <span className="number detail-number">#{task.number}</span>
      <SaveIndicator state={app.saveState} />
      <div className="detail-bar-actions">
        <a className="detail-link" href={app.taskUrl(task)} onClick={(event) => { event.preventDefault(); history.pushState({}, '', app.taskUrl(task)); app.setFullPage(true); }}><Icon name="expand" small /><span>{t('detail.openFullPage')}</span></a>
        <MenuButton label={t('detail.askAi')} icon="sparkles" className="secondary btn-sm">
          <p className="menu-note ai-mode"><strong>{t('ai.modeApprove')}</strong> {t('ai.modeApproveHint')}</p>
          {aiAvailability.status === 'unavailable' && <p className="menu-note" role="note">{t('ai.suggestionsUnavailable', { reason: aiAvailability.reason })}</p>}
          <div className="menu-sep" />
          <MenuItem icon="comment" disabled={!ai} onSelect={() => app.openGenerate(defaultFocusPrompt('summarize', task), 'summarize', task)}>{t('ai.summarize')}</MenuItem>
          <MenuItem icon="check" disabled={!ai} onSelect={() => app.openGenerate(defaultFocusPrompt('review', task), 'review', task)}>{t('ai.review')}</MenuItem>
          <MenuItem icon="kanban" disabled={!ai} onSelect={() => app.openSuggest('split', task)}>{t('ai.split')}</MenuItem>
          <MenuItem icon="link" disabled={!ai} onSelect={() => app.openSuggest('link', task)}>{t('ai.links')}</MenuItem>
        </MenuButton>
        <button type="button" className={`ghost btn-sm ${app.taskMoreOpen ? 'selected' : ''}`} aria-expanded={app.taskMoreOpen} aria-controls="task-more" onClick={() => app.setTaskMoreOpen(!app.taskMoreOpen)}><Icon name="more" small />{t('detail.more')}</button>
        {fullPage ? <button type="button" className="secondary btn-sm" onClick={app.closeTaskPanel}><Icon name="arrow-left" small />{t('detail.backToList')}</button> : <button type="button" className="ghost btn-sm" onClick={() => void app.flushAndClose()}><Icon name="x" small />{t('detail.close')}</button>}
      </div>
    </div>

    <div className="detail-scroll">
      {app.conflict && <div className="conflict" role="alert"><strong>{t('detail.conflictTitle')}</strong><p>{t('detail.conflictBody', { title: app.conflict.title, version: app.conflict.version })}</p><button type="button" className="secondary" onClick={() => { app.setDraft(app.conflict); app.setTask(app.conflict); app.setConflict(null); }}>{t('detail.loadCurrent')}</button></div>}

      <input className="title-input" aria-label={t('detail.title')} value={draft.title} onChange={(event) => app.setDraft({ ...draft, title: event.target.value })} />

      <div className="prop-bar" role="group" aria-label={t('detail.properties')}>
        <label className="prop"><span className="prop-label">{t('detail.status')}</span><select aria-label={t('detail.status')} value={draft.status} onChange={(event) => app.setDraft({ ...draft, status: event.target.value })}>{statuses.map((status) => <option key={status.id} value={status.key}>{status.name}</option>)}</select></label>
        <AssigneePicker app={app} draft={draft} />
        <label className="prop"><span className="prop-label">{t('detail.priority')}</span><select aria-label={t('detail.priority')} value={draft.priority} onChange={(event) => app.setDraft({ ...draft, priority: event.target.value })}>{PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}</select></label>
        <label className="prop"><span className="prop-label">{t('detail.dueDate')}</span><input type="date" aria-label={t('detail.dueDate')} value={draft.due_date ?? ''} onChange={(event) => app.setDraft({ ...draft, due_date: event.target.value || null })} /></label>
        <label className="prop"><span className="prop-label">{t('detail.milestone')}</span><MilestoneSelect api={api} project={task.project_id} epoch={app.milestoneEpoch} value={task.milestone} label="Milestone" disabled={app.savingMilestone === task.id} onChange={(milestone) => void app.updateTaskMilestone(task, milestone)} /></label>
        <label className="prop"><span className="prop-label">{t('detail.startDate')}</span><input type="date" aria-label={t('detail.startDate')} value={draft.start_date ?? ''} onChange={(event) => app.setDraft({ ...draft, start_date: event.target.value || null })} /></label>
        {taskAttributes.map((attribute) => <AttributeField key={attribute.id} app={app} attribute={attribute} />)}
      </div>

      {app.taskMoreOpen && <section id="task-more" className="more-panel" aria-label={t('detail.more')}>
        {app.watchPreferences && <NotificationPrefs app={app} task={task} prefs={app.watchPreferences} />}
        <section className="team-grants more-block" aria-label={t('detail.teamAccess')}><h3>{t('detail.teamAccess')}</h3>
          <div className="inline-fields"><label className="field">{t('detail.team')}<select value={app.grantTeam} onChange={(event) => app.setGrantTeam(event.target.value)}><option value="">{t('detail.chooseTeam')}</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label className="field">{t('detail.access')}<select value={app.grantRole} onChange={(event) => app.setGrantRole(event.target.value)}><option value="viewer">{t('role.viewer')}</option><option value="contributor">{t('role.contributor')}</option><option value="manager">{t('role.manager')}</option></select></label><button type="button" disabled={!app.grantTeam} onClick={() => void app.addProjectTeamGrant()}>{t('detail.grantAccess')}</button></div>
          <ul className="plain-list">{app.teamGrants.map((grant) => <li key={grant.team_id}><span>{grant.name} · {enumLabel('role', grant.role)}</span><button type="button" className="link-button" onClick={() => void app.removeProjectTeamGrant(grant.team_id)}>{t('common.remove')}</button></li>)}</ul>
        </section>
        {!task.archived_at && <RecurrenceSection api={api} task={task} onError={app.reportWriteError} onChange={(updated) => { const next = updated as Task; app.setTasks((items) => items.map((item) => item.id === next.id ? next : item)); app.setListTasks((items) => items.map((item) => item.id === next.id ? next : item)); app.setTask((current) => current?.id === next.id ? next : current); app.setDraft((current) => current?.id === next.id ? { ...current, recurrence: next.recurrence, start_date: next.start_date, due_date: next.due_date, version: next.version } : current); }} />}
        <section className="more-block" aria-label={t('detail.moveTitle')}><h3>{t('detail.moveTitle')}</h3>
          <label className="field">{t('detail.moveTo')}<select value={app.moveTarget} onChange={(event) => { app.setMoveTarget(event.target.value); app.setPreview(null); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {enumLabel('visibility', project.visibility)}</option>)}</select></label>
          {moving && <div className="move-preview"><button type="button" className="secondary" onClick={() => void app.previewMove()}>{t('detail.previewMove')}</button>{preview && <div role="status"><strong>{t('detail.reviewBefore')}</strong><p>{t('detail.moveEffects', { visibility: preview.destination_visibility, subtasks: preview.subtasks_affected, relations: preview.relations_affected })}</p>{preview.milestone_effect?.clears && <p>{preview.milestone_effect.milestone ? t('detail.milestoneCleared', { name: preview.milestone_effect.milestone.name, n: preview.milestone_effect.tasks_cleared }) : t('detail.milestonesCleared', { n: preview.milestone_effect.tasks_cleared })}</p>}<p>{t('detail.destMembers', { n: preview.destination_members.length })}</p><button type="button" onClick={() => void app.saveTask({ move: true })}>{t('detail.confirmMove')}</button></div>}</div>}
        </section>
        <div className="actions more-actions"><button type="button" className="secondary" onClick={() => void app.takeTask()}>{t('detail.take')}</button><button type="button" className="secondary" onClick={() => void app.duplicate()}><Icon name="copy" small />{t('detail.duplicate')}</button>{task.archived_at ? <button type="button" className="secondary" onClick={() => void app.archive(true)}>{t('detail.restore')}</button> : <button type="button" className="danger" onClick={() => void app.archive()}><Icon name="archive" small />{t('detail.archive')}</button>}</div>
      </section>}

      <section className="detail-section" aria-label={t('detail.description')}>
        <h2>{t('detail.description')} <span className="muted section-note">Markdown</span></h2>
        <textarea aria-label="Description" rows={5} value={draft.description} placeholder={t('detail.descriptionPlaceholder')} onChange={(event) => app.setDraft({ ...draft, description: event.target.value })} />
        {task.description_html && draft.description === task.description && <article className="task-description-markdown" aria-label={t('detail.renderedDescription')} dangerouslySetInnerHTML={{ __html: task.description_html }} />}
        {task.created_from && <p className="muted">{t('detail.createdFrom')} <a href={taskLink(task.created_from.task_number)}>#{task.created_from.task_number}</a></p>}
      </section>

      <section className="detail-section" aria-label="Subtasks and checklist">
        <h2>{t('detail.subtasks')}</h2>
        {task.subtasks.length > 0 && <ul className="plain-list">{task.subtasks.map((child) => <li key={child.id}><a href={taskLink(child.number)} onClick={(event) => { event.preventDefault(); const found = app.tasks.find((item) => item.id === child.id); if (found) app.openPanel(found); }}>{`#${child.number} ${child.title}`}</a></li>)}</ul>}
        {app.taskDepth(task) < 4 ? <form className="inline-form" onSubmit={app.createSubtask}><label className="sr-only" htmlFor="subtask-title">{t('detail.subtaskTitle')}</label><input id="subtask-title" value={app.subtaskTitle} onChange={(event) => app.setSubtaskTitle(event.target.value)} placeholder={t('detail.addSubtaskPlaceholder')} required /><button type="submit" className="secondary">{t('detail.addSubtask')}</button></form> : <p className="muted">{t('detail.subtaskLimit')}</p>}
        <section aria-label="Checklist" className="checklist-block">
          <h3>{t('detail.checklist')}</h3>
          {task.checklist.length > 0 && <ul className="plain-list">{task.checklist.map((item) => <li key={item.id}><label className="check-option checklist-item"><input type="checkbox" checked={item.checked} onChange={() => void app.toggleChecklist(item)} /><span>{item.title}</span></label></li>)}</ul>}
          <form className="inline-form" onSubmit={app.createChecklistItem}><label className="sr-only" htmlFor="checklist-title">{t('detail.checklistItem')}</label><input id="checklist-title" value={app.checklistTitle} onChange={(event) => app.setChecklistTitle(event.target.value)} placeholder={t('detail.addChecklistPlaceholder')} required /><button type="submit" className="secondary">{t('detail.addItem')}</button></form>
        </section>
      </section>

      <section className="detail-section" aria-label={t('detail.references')}>
        <h2>{t('detail.references')}</h2>
        <section aria-label="Relations" className="sub-section">
          <h3>{t('detail.relations')}</h3>
          {task.relations.length > 0 && <ul className="plain-list">{task.relations.map((relation) => <li key={`${relation.kind}-${relation.task_id}`}><span>{enumLabel('relation', relation.kind)}</span> · <a href={taskLink(relation.number)}>{`#${relation.number} ${relation.title}`}</a> <button type="button" className="link-button" aria-label={`Remove ${relation.kind} relation to task ${relation.number}`} onClick={() => void app.removeRelation(relation)}>{t('common.remove')}</button></li>)}</ul>}
          <form className="inline-form relation-form" onSubmit={app.addRelation}><label className="sr-only" htmlFor="relation-kind">{t('detail.relationType')}</label><select id="relation-kind" value={app.relationKind} onChange={(event) => app.setRelationKind(event.target.value)}><option value="blocks">{t('relation.blocksOpt')}</option><option value="related">{t('relation.relatedOpt')}</option><option value="duplicate">{t('relation.duplicateOpt')}</option></select><label className="sr-only" htmlFor="relation-target">{t('detail.relatedTask')}</label><select id="relation-target" value={app.relationTarget} onChange={(event) => app.setRelationTarget(event.target.value)}><option value="">{t('detail.chooseTask')}</option>{app.tasks.filter((item) => item.id !== task.id).map((item) => <option key={item.id} value={item.id}>#{item.number} {item.title}</option>)}</select><button type="submit" className="secondary" disabled={!app.relationTarget}>{t('detail.addRelation')}</button></form>
        </section>
        <section aria-label="Referenced from" className="sub-section"><h3>{t('detail.referencedFrom')}</h3>{app.backlinks.length ? <ul className="plain-list">{app.backlinks.map((reference, index) => <li key={`${reference.comment_id ?? reference.source_kind}-${index}`}><a href={taskLink(reference.task_number)}>#{reference.task_number} {reference.task_title}</a>{reference.comment_id ? ` · ${t('detail.inComment', { n: reference.position })}` : ` · ${t('detail.inDescription', { n: reference.position })}`}{reference.snippet && <p className="muted">{reference.snippet}</p>}</li>)}</ul> : <p className="muted">{t('detail.noReferences')}</p>}</section>
        <section aria-label="Likely duplicates" className="sub-section"><h3>{t('detail.duplicates')}</h3>{task.similar_tasks?.length ? <ul className="plain-list">{task.similar_tasks.map((candidate) => <li key={candidate.id}><a href={taskLink(candidate.number)}>#{candidate.number} {candidate.title}</a> · {t('detail.similar', { n: Math.round(candidate.similarity * 100) })} <button type="button" className="link-button" disabled={!ai} onClick={() => app.openGenerate(`Propose a Duplicate relation from task #${task.number} “${task.title}” to task #${candidate.number} “${candidate.title}”. Only create the relation Proposal; do not merge or close either task.`, 'link', task)}>{t('detail.proposeDuplicate')}</button></li>)}</ul> : <p className="muted">{t('detail.noDuplicates')}</p>}<p className="muted" role="note">{t('detail.duplicatesNote')}{task.similar_tasks_complete === false && ` ${t('detail.duplicatesIncomplete')}`}</p></section>
      </section>

      <section className="detail-section" aria-label="Comments">
        <h2>{t('detail.discussion')}</h2>
        <div role="group" aria-label={t('detail.timelineFilter')} className="segmented">{(['all', 'discussion', 'changes'] as const).map((filter) => <button key={filter} type="button" aria-pressed={app.discussionFilter === filter} onClick={() => app.setDiscussionFilter(filter)}>{t(`detail.filter.${filter}`)}</button>)}</div>
        <div className="timeline-feed">
        {app.timelineItems.map((item) => item.kind === 'comment' ? <article key={item.id} className="comment" data-comment-id={item.id}>
          {item.quote && <blockquote className="quoted-comment">{item.quote.body}</blockquote>}
          <div className="comment-body" dangerouslySetInnerHTML={{ __html: item.html ?? '' }} />
          {Boolean(item.attachments?.length) && <ul aria-label={t('detail.attachments')} className="plain-list">{item.attachments?.map((attachment) => <li key={attachment.id}><a href={attachment.download_url} download={attachment.file_name}>{attachment.file_name} ({Math.ceil(attachment.size / 1024)} KiB)</a>{attachment.preview_url && attachment.content_type.startsWith('image/') && <img className="comment-attachment-preview" src={attachment.preview_url} alt={`Preview: ${attachment.file_name}`} />}{attachment.preview_url && attachment.content_type === 'application/pdf' && <a href={attachment.preview_url} target="_blank" rel="noreferrer">Preview PDF: {attachment.file_name}</a>}</li>)}</ul>}
          {item.edited && <span className="muted"> · {t('detail.edited')}</span>}
          {app.comments.find((comment) => comment.id === item.id)?.created_tasks?.map((created) => <p key={created.id}><a href={taskLink(created.number)} onClick={(event) => { event.preventDefault(); app.openPanel({ task_id: created.id, task_number: created.number, title: created.title } as SearchResult); }}>Created Task: #{created.number} {created.title}</a></p>)}
          <div className="actions comment-actions">
            <button type="button" className="ghost btn-sm" onClick={() => app.setReplyToComment(item.id)}>{t('detail.reply')}</button>
            <button type="button" className="ghost btn-sm" aria-label={`React to comment ${item.id} with thumbs up`} onClick={() => void app.toggleReaction(item, '👍')}>👍 {item.reactions?.find((reaction) => reaction.emoji === '👍')?.count ?? 0}</button>
            <button type="button" className="ghost btn-sm" onClick={() => { app.setEditingComment(item.id); app.setCommentBody(item.body ?? ''); }}>{t('common.edit')}</button>
            <button type="button" className="ghost btn-sm" onClick={() => { const comment = app.comments.find((entry) => entry.id === item.id); if (comment) app.setTaskFromComment({ comment, title: comment.body.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 255) || t('detail.newTaskTitle'), description: comment.body, project_id: task.project_id, request_id: crypto.randomUUID() }); }}>{t('detail.createTask')}</button>
            <button type="button" className="ghost btn-sm danger-text" onClick={() => void app.deleteComment(item.id)}>{t('common.delete')}</button>
          </div>
          {app.taskFromComment?.comment.id === item.id && <form className="comment-task-form" aria-label="Create Task from comment" onSubmit={app.createTaskFromComment}>
            <label className="field">{t('detail.title')}<input autoFocus value={app.taskFromComment.title} onChange={(event) => app.setTaskFromComment({ ...app.taskFromComment!, title: event.target.value })} required /></label>
            <label className="field">{t('detail.description')}<textarea rows={5} value={app.taskFromComment.description} onChange={(event) => app.setTaskFromComment({ ...app.taskFromComment!, description: event.target.value })} /></label>
            <label className="field">{t('detail.project')}<select value={app.taskFromComment.project_id} onChange={(event) => app.setTaskFromComment({ ...app.taskFromComment!, project_id: event.target.value })}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <div className="actions"><button type="submit">{t('detail.saveTask')}</button><button type="button" className="secondary" onClick={() => app.setTaskFromComment(null)}>{t('common.cancel')}</button></div>
          </form>}
        </article> : item.kind === 'change' ? <article key={item.id} className="timeline-change"><strong>{t('detail.changed', { field: fieldLabel(item.field) })}</strong><span className="muted"> · {formatDateTime(item.created_at)}</span></article> : <article key={item.id} className="comment"><span className="muted">{t('detail.deletedComment')}</span></article>)}
        </div>
        {app.replyToComment && <p className="muted">{t('detail.replyingTo')} <button type="button" className="link-button" onClick={() => app.setReplyToComment(null)}>{t('detail.cancelReply')}</button></p>}
        <form className="composer" onSubmit={app.saveComment}>
          <label className="sr-only" htmlFor="comment-body">Markdown comment</label>
          <textarea id="comment-body" ref={app.commentInput} rows={4} value={app.commentBody} onChange={(event) => app.updateCommentBody(event.target.value, event.target.selectionStart)} onKeyDown={app.commentKeyDown} placeholder={t('detail.commentPlaceholder')} required />
          {app.noteReferenceSuggestions.length > 0 && <ul role="listbox" aria-label="Note references" className="suggest-list">{app.noteReferenceSuggestions.map((suggestion, index) => <li key={`${suggestion.vault_id}:${suggestion.path}`}><button type="button" role="option" aria-selected={index === app.noteReferenceSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => app.insertNoteReference(suggestion)}>{suggestion.title} · {suggestion.vault_name} · {suggestion.path}</button></li>)}</ul>}
          {app.mentionSuggestions.length > 0 && <ul role="listbox" aria-label="People to mention" className="suggest-list">{app.mentionSuggestions.map((suggestion, index) => <li key={suggestion.id}><button type="button" role="option" aria-selected={index === app.referenceSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => app.insertMention(suggestion)}>{suggestion.label}</button></li>)}</ul>}
          {app.referenceSuggestions.length > 0 && <ul role="listbox" aria-label="Task references" className="suggest-list">{app.referenceSuggestions.map((suggestion, index) => <li key={suggestion.id}><button type="button" role="option" aria-selected={index === app.referenceSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => app.insertReference(suggestion)}>#{suggestion.number} {suggestion.title} · {suggestion.status}</button></li>)}</ul>}
          <div className="composer-row">
            <label className="attach" htmlFor="comment-attachments"><Icon name="upload" small />{t('detail.attach')}</label>
            <input id="comment-attachments" type="file" multiple aria-label="Attach files to comment" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); app.setCommentFiles(files); app.setError(app.attachmentProblem(files)); }} />
            <span className="grow" />
            {app.editingComment && <button type="button" className="secondary" onClick={() => { app.setEditingComment(null); app.setCommentBody(''); }}>{t('common.cancel')}</button>}
            <button type="submit">{app.editingComment ? t('detail.saveEdit') : app.replyToComment ? t('detail.reply') : t('detail.comment')}</button>
          </div>
          {app.commentFiles.length > 0 && <p className="muted">{app.commentFiles.map((file) => `${file.name} (${Math.ceil(file.size / 1024)} KiB)`).join(', ')}</p>}
        </form>
      </section>
      <p className="muted detail-foot">{t('detail.stableUrl')} <code>{app.taskUrl(task)}</code> · {t('detail.version')} {task.version}</p>
    </div>
  </section>;
}

function fieldLabel(field: string | undefined) {
  if (!field) return '';
  return enumLabel('field', field);
}
