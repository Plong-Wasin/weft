import React from 'react';
import { RecurrenceSection } from './recurrence';
import { MilestoneSelect } from './milestones';
import { defaultFocusPrompt } from './generate';
import { api } from './api';
import type { App } from './app-state';
import { Icon } from './ui/icons';
import { MenuButton, MenuItem } from './ui/primitives';
import { AssigneePicker, AttributeEditor, OptionPicker, StatusPicker, priorityOptions } from './task-cells';
import { StatusIcon } from './ui/status-icon';
import { DateInput } from './ui/date-input';
import { displayName } from './ui/avatar';
import { enumLabel, formatDate, formatDateTime, t, useLocale } from './i18n';
import { useDragSort, DragGhost, dropClass } from './ui/drag';
import type { SearchResult, Task, TimelineItem, WatchPreferences } from './types';

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  const text = state === 'saving' ? t('detail.saving') : state === 'saved' ? t('detail.saved') : state === 'error' ? t('detail.notSaved') : '';
  return <span className={`save-indicator ${state}`} role="status" aria-live="polite">{state === 'saved' && <Icon name="check" small />}{text}</span>;
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
  const slash = useSlashCommands(app);
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
        <div className="prop"><span className="prop-label">{t('detail.status')}</span><StatusPicker statuses={statuses} value={draft.status} label={t('detail.status')} className="prop-button secondary" onChange={(key) => app.setDraft({ ...draft, status: key })} /></div>
        <div className="prop assignee-prop"><span className="prop-label">{t('detail.assignee')}</span><AssigneePicker showNames className="prop-button secondary" value={draft.assignees} members={app.members} teams={app.teams} label={t('detail.assignees')} onChange={(next) => app.setDraft({ ...draft, assignees: next })} /></div>
        <div className="prop"><span className="prop-label">{t('detail.priority')}</span><OptionPicker className="prop-button secondary" label={t('detail.priority')} options={priorityOptions()} value={draft.priority} onChange={(next) => app.setDraft({ ...draft, priority: String(next) })} /></div>
        <div className="prop"><span className="prop-label">{t('detail.dueDate')}</span><DateInput label={t('detail.dueDate')} value={draft.due_date ?? ''} onChange={(next) => app.setDraft({ ...draft, due_date: next || null })} /></div>
        <ListsProp app={app} task={task} />
        <ParentProp app={app} task={task} />
        <div className="prop"><span className="prop-label">{t('detail.milestone')}</span><MilestoneSelect api={api} project={task.project_id} epoch={app.milestoneEpoch} value={task.milestone} label="Milestone" disabled={app.savingMilestone === task.id} onChange={(milestone) => void app.updateTaskMilestone(task, milestone)} /></div>
        <div className="prop"><span className="prop-label">{t('detail.startDate')}</span><DateInput label={t('detail.startDate')} value={draft.start_date ?? ''} onChange={(next) => app.setDraft({ ...draft, start_date: next || null })} /></div>
        {taskAttributes.map((attribute) => { const definition = app.attributes.find((item) => item.id === attribute.id); return definition ? <div className="prop" key={attribute.id}><span className="prop-label">{attribute.name}</span><AttributeEditor live className="prop-button secondary" attribute={definition} members={app.members} label={attribute.name} value={app.attributeDraft[attribute.id]} onChange={(next) => app.setAttributeDraft((current) => ({ ...current, [attribute.id]: next }))} /></div> : null; })}
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

      <div className="detail-tabs" role="tablist" aria-label={t('detail.tabs')}>
        {(['chat', 'description'] as const).map((tab) => <button key={tab} type="button" role="tab" id={`detail-tab-${tab}`} aria-selected={app.detailTab === tab} aria-controls={`detail-panel-${tab}`} tabIndex={app.detailTab === tab ? 0 : -1} onClick={() => app.setDetailTab(tab)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = tab === 'chat' ? 'description' : 'chat'; app.setDetailTab(next); requestAnimationFrame(() => document.getElementById(`detail-tab-${next}`)?.focus()); } }}>{t(`detail.tab.${tab}`)}</button>)}
      </div>
      {app.detailTab === 'description' && <section className="detail-section tab-panel" role="tabpanel" id="detail-panel-description" aria-labelledby="detail-tab-description" aria-label={t('detail.description')}>
        <p className="muted section-note">Markdown</p>
        <textarea aria-label="Description" rows={7} value={draft.description} placeholder={t('detail.descriptionPlaceholder')} onChange={(event) => app.setDraft({ ...draft, description: event.target.value })} />
        {task.description_html && draft.description === task.description && <article className="task-description-markdown" aria-label={t('detail.renderedDescription')} dangerouslySetInnerHTML={{ __html: task.description_html }} />}
        {task.created_from && <p className="muted">{t('detail.createdFrom')} <a href={taskLink(task.created_from.task_number)}>#{task.created_from.task_number}</a></p>}
      </section>}

      <section className="detail-section" aria-label="Subtasks and checklist">
        <h2>{t('detail.subtasks')}</h2>
        <SubtaskList app={app} task={task} taskLink={taskLink} />
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

      <section className="detail-section tab-panel" role="tabpanel" id="detail-panel-chat" aria-labelledby="detail-tab-chat" aria-label="Comments">
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
        </article> : item.kind === 'change' ? <ChangeItem key={item.id} app={app} item={item} /> : <article key={item.id} className="comment"><span className="muted">{t('detail.deletedComment')}</span></article>)}
        </div>
        {app.replyToComment && <p className="muted">{t('detail.replyingTo')} <button type="button" className="link-button" onClick={() => app.setReplyToComment(null)}>{t('detail.cancelReply')}</button></p>}
        <form className="composer" onSubmit={app.saveComment}>
          <label className="sr-only" htmlFor="comment-body">Markdown comment</label>
          <textarea id="comment-body" ref={app.commentInput} rows={4} value={app.commentBody} onChange={(event) => { app.updateCommentBody(event.target.value, event.target.selectionStart); slash.onChange(event.target.value); }} onKeyDown={(event) => { if (!slash.onKeyDown(event)) app.commentKeyDown(event); }} placeholder={t('detail.commentPlaceholder')} aria-describedby="slash-hint" aria-expanded={slash.open || undefined} required />
          <p id="slash-hint" className="muted composer-hint">{t('detail.slashHint')}</p>
          {slash.menu}
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

function ListsProp({ app, task }: { app: App; task: Task }) {
  const manual = app.taskLists.filter((list) => list.kind === 'manual');
  const [ids, setIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    let active = true;
    if (!app.workspace || manual.length === 0) { setIds([]); return; }
    void Promise.all(manual.map((list) => api<{ tasks: Task[] }>(`/workspaces/${app.workspace!.id}/lists/${list.id}`).then((result) => result.tasks.some((item) => item.id === task.id) ? list.id : null).catch(() => null))).then((found) => { if (active) setIds(found.filter((id): id is string => id !== null)); });
    return () => { active = false; };
  }, [task.id, app.taskLists.length]);
  async function change(next: string[]) {
    const added = next.filter((id) => !ids.includes(id));
    const removed = ids.filter((id) => !next.includes(id));
    setIds(next);
    try {
      for (const id of added) await api(`/lists/${id}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: task.id, request_id: crypto.randomUUID() }) });
      for (const id of removed) await api(`/lists/${id}/tasks/${task.id}`, { method: 'DELETE' });
      if (app.selectedListId && (added.includes(app.selectedListId) || removed.includes(app.selectedListId))) void app.openList(app.selectedListId);
    } catch (reason) { setIds(ids); app.setError(reason instanceof Error ? reason.message : 'Could not change Lists.'); }
  }
  return <div className="prop"><span className="prop-label">{t('detail.lists')}</span><OptionPicker multiple className="prop-button secondary" label={t('detail.lists')} placeholder={manual.length ? t('detail.noLists') : t('detail.noManualLists')} disabled={manual.length === 0} options={manual.map((list) => ({ value: list.id, label: list.name }))} value={ids} onChange={(next) => void change(next as string[])} /></div>;
}

function ParentProp({ app, task }: { app: App; task: Task }) {
  const byId = new Map(app.tasks.map((item) => [item.id, item]));
  const underTask = (candidate: Task) => { let parent = candidate.parent_task_id; let guard = 0; while (parent && guard < 8) { if (parent === task.id) return true; parent = byId.get(parent)?.parent_task_id ?? null; guard += 1; } return false; };
  const options = app.tasks.filter((item) => item.project_id === task.project_id && item.id !== task.id && !underTask(item) && app.taskDepth(item) < 4).map((item) => ({ value: item.id, label: `#${item.number} ${item.title}` }));
  return <div className="prop"><span className="prop-label">{t('detail.parent')}</span><OptionPicker allowClear className="prop-button secondary" label={t('detail.parent')} placeholder={t('detail.noParent')} options={options} value={task.parent_task_id} onChange={(next) => void app.patchTask(task, { parent_task_id: next ?? null }, 'Could not change the parent Task.').then((updated) => { if (updated && app.workspace) void app.loadTask(app.workspace.id, updated.number, updated.id); })} /></div>;
}

function SubtaskList({ app, task, taskLink }: { app: App; task: Task; taskLink: (number: number) => string }) {
  const order = new Map(app.tasks.map((item, index) => [item.id, index]));
  const subtasks = [...task.subtasks].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const children = subtasks.map((child) => app.tasks.find((item) => item.id === child.id)).filter((item): item is Task => Boolean(item));
  const dnd = useDragSort('sub', !app.sort, (drop) => {
    const moved = children.find((item) => item.id === drop.id);
    const target = children.find((item) => item.id === drop.targetId);
    if (moved && target) void app.moveTask(moved, drop.position === 'before' ? { before: target.id } : { after: target.id }, t(drop.position === 'before' ? 'announce.movedBefore' : 'announce.movedAfter', { n: moved.number, other: target.number }));
  });
  if (subtasks.length === 0) return null;
  return <>
    <ul className="plain-list subtask-list" aria-label={t('detail.subtaskList')}>{subtasks.map((child) => {
      const full = children.find((item) => item.id === child.id);
      return <li key={child.id} className={`subtask-row${dropClass(dnd.drag, child.id)} ${dnd.drag?.id === child.id ? 'row-dragged' : ''}`} data-drag-target={child.id} data-drag-kind="sub">
        <span className="drag-handle visible" title={t('table.dragHint')} aria-hidden="true" onPointerDown={dnd.start(child.id, `#${child.number} ${child.title}`)}><svg viewBox="0 0 12 16" width="10" height="14"><path d="M3 3h.01M9 3h.01M3 8h.01M9 8h.01M3 13h.01M9 13h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" /></svg></span>
        <a href={taskLink(child.number)} title={`#${child.number} ${child.title}`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onKeyDown={(event) => { if (event.altKey && full && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); app.stepRow(full, event.key === 'ArrowUp' ? -1 : 1, children); requestAnimationFrame(() => (document.querySelector(`[data-drag-target="${child.id}"] a`) as HTMLElement | null)?.focus()); } }} onClick={(event) => { event.preventDefault(); if (full) app.openPanel(full); }}>{`#${child.number} ${child.title}`}</a>
      </li>;
    })}</ul>
    <DragGhost drag={dnd.drag} />
  </>;
}

function formatChange(app: App, field: string, value: unknown): string {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return t('detail.emptyValue');
  if (field === 'status') return app.statuses.find((status) => status.key === value)?.name ?? String(value);
  if (field === 'priority') return enumLabel('priority', String(value));
  if (field === 'start_date' || field === 'due_date') return formatDate(String(value));
  if (field === 'completed_at') return formatDateTime(String(value));
  if (field === 'parent_task_id') { const parent = app.tasks.find((item) => item.id === value); return parent ? `#${parent.number}` : t('detail.otherTask'); }
  if (field === 'project_id') return app.projects.find((project) => project.id === value)?.name ?? String(value);
  const name = (entry: unknown): string => {
    if (entry && typeof entry === 'object') {
      const record = entry as { id?: string; type?: string; name?: string };
      if (record.name) return record.name;
      if (record.type === 'team') return `@${app.teams.find((team) => team.id === record.id)?.name ?? ''}`;
      const member = app.members.find((item) => item.id === record.id);
      if (member) return displayName(member.email);
    }
    if (typeof entry === 'string') { const member = app.members.find((item) => item.id === entry); if (member) return displayName(member.email); const team = app.teams.find((item) => item.id === entry); if (team) return `@${team.name}`; }
    return typeof entry === 'object' ? JSON.stringify(entry) : String(entry);
  };
  if (Array.isArray(value)) return value.map(name).join(', ');
  if (field === 'description' || field === 'title') return String(value).length > 60 ? `${String(value).slice(0, 57)}…` : String(value);
  return name(value);
}

/** An attribute change in the chat timeline: who, what, old value to new value. */
function ChangeItem({ app, item }: { app: App; item: TimelineItem }) {
  const field = item.field ?? '';
  const attribute = field.startsWith('attribute') ? app.attributes.find((candidate) => field.includes(candidate.id)) : undefined;
  const label = attribute?.name ?? fieldLabel(field);
  const actor = app.members.find((member) => member.id === item.actor_id);
  const known = item.before !== undefined || item.after !== undefined;
  const plain = field === 'description';
  return <article className="timeline-change" aria-label={t('detail.changed', { field: label })}>
    <Icon name="clock" small />
    <span className="change-text">{actor && <strong>{displayName(actor.email)} </strong>}{t('detail.changed', { field: label })}
      {known && !plain && <span className="change-values"> <span className="change-before">{formatChange(app, field, item.before)}</span> <span aria-hidden="true">→</span><span className="sr-only">{t('detail.to')}</span> <strong className="change-after">{formatChange(app, field, item.after)}</strong></span>}</span>
    <span className="muted change-time">{formatDateTime(item.created_at)}</span>
  </article>;
}

type SlashStep = 'root' | 'status' | 'priority' | 'assignee' | 'due';

/** Typing `/` at the start of the composer opens a command menu that changes an attribute without leaving the chat. */
function useSlashCommands(app: App) {
  const [step, setStep] = React.useState<SlashStep | null>(null);
  const [filter, setFilter] = React.useState('');
  const [index, setIndex] = React.useState(0);
  const draft = app.draft;
  const close = () => { setStep(null); setFilter(''); setIndex(0); };
  const addDays = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  type Entry = { key: string; label: React.ReactNode; selected?: boolean; run: () => void };
  const done = (text: string) => { app.announce(text); app.setCommentBody(''); close(); app.commentInput.current?.focus(); };
  const entries = (): Entry[] => {
    if (!draft || !step) return [];
    if (step === 'root') {
      const commands: { key: string; label: string; words: string; next: SlashStep }[] = [
        { key: 'status', label: t('slash.status'), words: 'status', next: 'status' },
        { key: 'assignee', label: t('slash.assignee'), words: 'assignee assign', next: 'assignee' },
        { key: 'due', label: t('slash.due'), words: 'due date', next: 'due' },
        { key: 'priority', label: t('slash.priority'), words: 'priority', next: 'priority' },
      ];
      const needle = filter.toLowerCase();
      return commands.filter((command) => !needle || command.words.includes(needle) || command.label.toLowerCase().includes(needle)).map((command) => ({ key: command.key, label: command.label, run: () => { app.setCommentBody(''); setStep(command.next); setFilter(''); setIndex(0); } }));
    }
    if (step === 'status') return app.statuses.map((status) => ({ key: status.id, selected: status.key === draft.status, label: <><StatusIcon category={status.category} color={status.color} /> {status.name}</>, run: () => { app.setDraft({ ...draft, status: status.key }); done(t('slash.statusSet', { name: status.name })); } }));
    if (step === 'priority') return priorityOptions().map((option) => ({ key: option.value, selected: option.value === draft.priority, label: option.label, run: () => { app.setDraft({ ...draft, priority: option.value }); done(t('slash.prioritySet', { name: option.label })); } }));
    if (step === 'due') return [{ key: 'today', label: t('slash.today'), run: () => { app.setDraft({ ...draft, due_date: addDays(0) }); done(t('slash.dueSet', { date: formatDate(addDays(0)) })); } }, { key: 'tomorrow', label: t('slash.tomorrow'), run: () => { app.setDraft({ ...draft, due_date: addDays(1) }); done(t('slash.dueSet', { date: formatDate(addDays(1)) })); } }, { key: 'week', label: t('slash.nextWeek'), run: () => { app.setDraft({ ...draft, due_date: addDays(7) }); done(t('slash.dueSet', { date: formatDate(addDays(7)) })); } }, { key: 'none', label: t('slash.clearDue'), run: () => { app.setDraft({ ...draft, due_date: null }); done(t('slash.dueCleared')); } }];
    const chosen = new Set(draft.assignees.map(({ type, id }) => `${type}:${id}`));
    const toggle = (type: 'user' | 'team', id: string, name: string) => { const rest = draft.assignees.filter((item) => !(item.type === type && item.id === id)); app.setDraft({ ...draft, assignees: chosen.has(`${type}:${id}`) ? rest : [...rest, { type, id, name }] }); app.announce(t('slash.assigneesChanged')); };
    return [...app.members.map((member) => ({ key: `u${member.id}`, selected: chosen.has(`user:${member.id}`), label: member.email, run: () => toggle('user', member.id, member.email) })), ...app.teams.map((team) => ({ key: `t${team.id}`, selected: chosen.has(`team:${team.id}`), label: `@${team.name}`, run: () => toggle('team', team.id, team.name) }))];
  };
  const list = entries();
  const title = step === 'root' ? t('slash.commands') : step === 'status' ? t('slash.status') : step === 'priority' ? t('slash.priority') : step === 'due' ? t('slash.due') : t('slash.assignee');
  return {
    open: step !== null,
    onChange(value: string) {
      const match = value.match(/^\/([a-z]*)$/i);
      if (match) { setStep('root'); setFilter(match[1]); setIndex(0); } else if (step === 'root') close();
    },
    onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!step) return false;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true; }
      if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((current) => (current + 1) % Math.max(1, list.length)); return true; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((current) => (current + list.length - 1) % Math.max(1, list.length)); return true; }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && list[index]) { event.preventDefault(); list[index].run(); return true; }
      return false;
    },
    menu: step && <div className="slash-menu" role="listbox" aria-label={title} aria-multiselectable={step === 'assignee' || undefined}>
      <p className="option-group">{title}</p>
      {list.map((entry, position) => <button key={entry.key} type="button" role="option" aria-selected={entry.selected ?? position === index} className={`option ${position === index ? 'active' : ''}`} onMouseDown={(event) => event.preventDefault()} onClick={entry.run}><span className="option-name">{entry.label}</span>{entry.selected && <Icon name="check" small />}</button>)}
      {list.length === 0 && <p className="menu-note">{t('picker.noMatches')}</p>}
      {step === 'assignee' && <button type="button" className="option" onMouseDown={(event) => event.preventDefault()} onClick={() => done(t('slash.assigneesChanged'))}><span className="option-name">{t('slash.done')}</span></button>}
    </div>,
  };
}
