import React from 'react';
import { MilestoneSelect } from './milestones';
import { CalendarView } from './calendar';
import { TimelineView } from './timeline';
import { api } from './api';
import { ROW_HEIGHT, ROW_WINDOW, type App } from './app-state';
import { Icon } from './ui/icons';
import { EmptyState, Skeleton } from './ui/primitives';
import { enumLabel, formatDate, t, useLocale } from './i18n';
import type { Attribute, Task } from './types';

export function priorityLabel(priority: string) { return enumLabel('priority', priority); }
export function assigneeSummary(task: Task) {
  if (task.assignees.length === 0) return '';
  const first = task.assignees[0].name.split('@')[0];
  return task.assignees.length > 1 ? `${first} +${task.assignees.length - 1}` : first;
}

function PriorityMark({ priority }: { priority: string }) {
  const tone = priority === 'urgent' ? 'danger' : priority === 'high' ? 'warning' : '';
  return <span className={`badge ${tone}`}>{priorityLabel(priority)}</span>;
}

export function TasksScreen({ app }: { app: App }) {
  useLocale();
  const { workspace, viewTasks, viewMode, statuses, attributes, members, activeView, taskLists, selectedListId, selectedTaskIds, keyboardMode, focusedRowIndex, virtualStart, virtualEnd, visibleTasks, editingTaskId, inlineTitle } = app;
  if (!workspace) return null;
  const admin = ['owner', 'admin'].includes(workspace.role);
  const loaded = app.projectsLoadedFor === workspace.id;
  const activeList = activeView === 'list' ? taskLists.find((list) => list.id === selectedListId) : undefined;

  const statusSelect = (value: Task, label: string) => {
    const status = statuses.find((item) => item.key === value.status);
    return <span className="status-cell"><span className="dot" style={{ color: status?.color }} aria-hidden="true" /><select aria-label={label} value={value.status} onChange={(event) => void app.updateTaskStatus(value, event.target.value)}>{statuses.map((item) => <option key={item.id} value={item.key}>{item.name}</option>)}</select></span>;
  };
  const attributeSelect = (value: Task, attribute: Attribute, label: string) => <select aria-label={label} value={String(value.attributes[attribute.id] ?? '')} onChange={(event) => void app.updateTaskAttribute(value, attribute, event.target.value || null)}><option value="">—</option>{attribute.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select>;
  const attributeEditor = (value: Task, attribute: Attribute) => {
    const label = t('tasks.attrFor', { name: attribute.name, n: value.number });
    const current = value.attributes[attribute.id];
    if (attribute.type === 'single_select') return attributeSelect(value, attribute, label);
    if (attribute.type === 'multi_select') return <select multiple aria-label={label} value={Array.isArray(current) ? current.map(String) : []} onChange={(event) => void app.updateTaskAttribute(value, attribute, Array.from(event.target.selectedOptions, (option) => option.value))}>{attribute.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select>;
    if (attribute.type === 'user') return <select aria-label={label} value={String(current ?? '')} onChange={(event) => void app.updateTaskAttribute(value, attribute, event.target.value || null)}><option value="">—</option>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select>;
    const draftKey = `${value.id}:${attribute.id}`;
    const inputType = attribute.type === 'number' || attribute.type === 'date' ? attribute.type : 'text';
    return <input aria-label={label} type={inputType} value={app.tableAttributeDrafts[draftKey] ?? String(current ?? '')} onChange={(event) => app.setTableAttributeDrafts((items) => ({ ...items, [draftKey]: event.target.value }))} onBlur={(event) => { if (draftKey in app.tableAttributeDrafts) { void app.updateTaskAttribute(value, attribute, event.target.value || null); app.setTableAttributeDrafts((items) => { const next = { ...items }; delete next[draftKey]; return next; }); } }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
  };

  const shownAttributes = attributes.filter((attribute) => app.selectedColumns.includes(`attribute:${attribute.id}`) && viewTasks.some((item) => attribute.project_ids?.includes(item.project_id)));
  const columns = [
    app.showColumn('title') && 'minmax(260px, 3fr)',
    app.showColumn('status') && '168px',
    app.showColumn('priority') && '96px',
    app.showColumn('due') && '104px',
    app.showColumn('assignee') && '128px',
    ...shownAttributes.map(() => '150px'),
    app.showColumn('milestone') && '180px',
  ].filter(Boolean) as string[];
  const gridStyle = { '--cols': columns.join(' '), minWidth: `${columns.length * 128 + 120}px` } as React.CSSProperties;

  const groupField = activeList?.query.group ?? null;

  const body = () => {
    if (viewMode === 'timeline') return <TimelineView tl={app.timeline} onOpen={(item) => app.openPanel(item as Task)} />;
    if (viewMode === 'calendar') return <CalendarView cal={app.calendar} onOpen={(item) => app.openPanel(item as Task)} onUndo={() => app.runHistoryAction(false)} />;
    if (!loaded) return <div className="tasks-loading"><Skeleton rows={9} /></div>;
    if (viewTasks.length === 0) return <EmptyState title={t('tasks.emptyTitle')} action={<button type="button" onClick={() => app.openNewTask()}><Icon name="plus" />{t('topbar.newTask')}</button>}>{t('tasks.empty')}</EmptyState>;
    if (viewMode === 'kanban') return <div className="kanban-board" aria-label={t('tasks.kanbanLabel')}>{statuses.map((status, columnIndex) => <section key={status.id} className="kanban-column" aria-label={t('tasks.columnLabel', { name: status.name })}>
      <div className="kanban-heading"><h3><span className="dot" style={{ color: status.color }} aria-hidden="true" />{status.name} <span className="count">{viewTasks.filter((item) => item.status === status.key).length}</span></h3>{admin && <span className="kanban-column-controls"><button type="button" className="ghost icon-button btn-sm" aria-label={t('tasks.moveColumnLeft', { name: status.name })} disabled={columnIndex === 0} onClick={() => void app.moveKanbanColumn(status.id, -1)}><Icon name="chevron-left" small /></button><button type="button" className="ghost icon-button btn-sm" aria-label={t('tasks.moveColumnRight', { name: status.name })} disabled={columnIndex === statuses.length - 1} onClick={() => void app.moveKanbanColumn(status.id, 1)}><Icon name="chevron-right" small /></button></span>}</div>
      {viewTasks.filter((item) => item.status === status.key).map((item) => <button type="button" key={item.id} className="kanban-card" aria-label={`Task #${item.number}, ${item.title}, ${status.name}`} onClick={() => app.openPanel(item)} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = statuses[columnIndex + (event.key === 'ArrowRight' ? 1 : -1)]; if (next) void app.updateTaskStatus(item, next.key); } }}>
        <span className="kanban-title"><span className="number">#{item.number}</span><strong>{item.title}</strong></span>
        <span className="kanban-meta"><PriorityMark priority={item.priority} />{item.due_date && <span className="muted tnum">{formatDate(item.due_date)}</span>}{item.assignees.length > 0 && <span className="muted">{assigneeSummary(item)}</span>}</span>
      </button>)}
    </section>)}</div>;
    return <div className="table-scroll" onScroll={(event) => { const next = Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT); const start = Math.min(next, Math.max(0, viewTasks.length - ROW_WINDOW)); if (Math.abs(start - virtualStart) > 3) app.setVirtualStart(start); }}>
      <div role="grid" style={gridStyle} aria-label="Tasks" aria-rowcount={viewTasks.length + 1} aria-activedescendant={`task-row-${viewTasks[focusedRowIndex]?.id ?? ''}`} tabIndex={0} ref={app.gridRef} onKeyDown={app.handleGridKeyDown}>
        <div role="row" className="table-row table-header">
          {app.showColumn('title') && <span role="columnheader">{t('col.task')}</span>}
          {app.showColumn('status') && <span role="columnheader">{t('col.status')}</span>}
          {app.showColumn('priority') && <span role="columnheader">{t('col.priority')}</span>}
          {app.showColumn('due') && <span role="columnheader">{t('col.due')}</span>}
          {app.showColumn('assignee') && <span role="columnheader">{t('col.assignee')}</span>}
          {shownAttributes.map((attribute) => <span role="columnheader" key={attribute.id}>{attribute.name}</span>)}
          {app.showColumn('milestone') && <span role="columnheader">{t('col.milestone')}</span>}
        </div>
        {virtualStart > 0 && <div aria-hidden="true" style={{ height: virtualStart * ROW_HEIGHT }} />}
        {visibleTasks.map((item, offset) => {
          const index = virtualStart + offset;
          const depth = app.taskDepth(item);
          const editable = editingTaskId === item.id;
          const heading = groupField && (index === 0 || app.groupLabel(viewTasks[index - 1], groupField) !== app.groupLabel(item, groupField)) ? <div role="row" className="table-group-heading" key={`group-${item.id}`}><h3 role="gridcell">{app.groupLabel(item, groupField)}</h3></div> : null;
          return <React.Fragment key={item.id}>{heading}<div role="row" id={`task-row-${item.id}`} aria-selected={selectedTaskIds.includes(item.id)} aria-label={`#${item.number} ${item.title}`} className={`table-row ${selectedTaskIds.includes(item.id) ? 'row-selected' : ''} ${index === focusedRowIndex ? 'row-focused' : ''}`} onClick={(event) => { if (event.target instanceof HTMLElement && event.target.closest('select,input,button')) return; app.focusRow(index); }}>
            {app.showColumn('title') && <div role="gridcell" className="table-task" style={{ paddingLeft: `${12 + depth * 20}px` }}><span className="number">#{item.number}</span>{editable ? <input aria-label={`Edit title for #${item.number}`} autoFocus value={inlineTitle} onChange={(event) => app.setInlineTitle(event.target.value)} onBlur={() => { if (!inlineTitle.trim()) app.setInlineTitle(item.title); }} /> : <button type="button" className="table-task-title" onClick={() => { app.focusRow(index); app.openPanel(item); }}>{item.title}</button>}</div>}
            {app.showColumn('status') && <div role="gridcell" onClick={() => app.focusRow(index)}>{statusSelect(item, `Status for #${item.number}`)}</div>}
            {app.showColumn('priority') && <div role="gridcell"><PriorityMark priority={item.priority} /></div>}
            {app.showColumn('due') && <div role="gridcell" className="tnum muted">{formatDate(item.due_date)}</div>}
            {app.showColumn('assignee') && <div role="gridcell" className="cell-text" title={item.assignees.map((assignee) => assignee.name).join(', ')}>{assigneeSummary(item)}</div>}
            {shownAttributes.map((attribute) => <div role="gridcell" key={attribute.id}>{attribute.project_ids?.includes(item.project_id) ? attributeEditor(item, attribute) : null}</div>)}
            {app.showColumn('milestone') && <div role="gridcell" onClick={() => app.focusRow(index)}><MilestoneSelect api={api} project={item.project_id} epoch={app.milestoneEpoch} value={item.milestone} label={`Milestone for #${item.number}`} disabled={app.savingMilestone === item.id} onChange={(milestone) => void app.updateTaskMilestone(item, milestone)} /></div>}
          </div></React.Fragment>;
        })}
        {virtualEnd < viewTasks.length && <div aria-hidden="true" style={{ height: (viewTasks.length - virtualEnd) * ROW_HEIGHT }} />}
      </div>
    </div>;
  };

  const tableLike = viewMode === 'table' || viewMode === 'kanban';
  return <section className="tasks-screen" aria-label={t('tasks.region')}>
    {tableLike && <div className="tasks-toolbar">
      {viewMode === 'table' ? <><div className="mode-controls" role="group" aria-label={t('tasks.keyboardMode')}>
        {(['browse', 'edit', 'outline'] as const).map((mode) => <button key={mode} type="button" className={`ghost btn-sm ${keyboardMode === mode ? 'selected' : ''}`} aria-label={t(`mode.${mode}.aria`)} aria-pressed={keyboardMode === mode} title={t(`mode.${mode}.hint`)} onClick={() => app.setKeyboardMode(mode)}>{t(`mode.${mode}`)}</button>)}
      </div>
      <span className="toolbar-hint muted">{t(`mode.${keyboardMode}.hint`)}</span></> : null}
      <div className="toolbar-end">
        {activeView === 'list' && app.listTotal > app.listTasks.length && <span className="muted" role="status">{t('tasks.listPartial', { shown: app.listTasks.length, total: app.listTotal })}</span>}
        <button type="button" className="ghost icon-button" aria-label={t('tasks.exportCsv')} title={t('tasks.exportCsv')} onClick={() => void app.exportView()} disabled={viewTasks.length === 0 && !(activeView === 'list' && selectedListId)}><Icon name="download" /></button>
      </div>
    </div>}
    {app.exportNotice && <p role="status" className="muted export-notice">{app.exportNotice}</p>}
    {selectedTaskIds.length > 1 && tableLike && <div className="bulk-actions" role="group" aria-label={t('tasks.bulk')}>
      <span className="tnum">{t('tasks.selected', { n: selectedTaskIds.length })}</span>
      <label>{t('tasks.setStatus')}<select aria-label="Set status" defaultValue="" onChange={(event) => { if (event.target.value) void app.bulkSetStatus(event.target.value); }}><option value="" disabled>{t('tasks.chooseStatus')}</option>{statuses.map((status) => <option key={status.id} value={status.key}>{status.name}</option>)}</select></label>
      {app.bulkAttributes.map((attribute) => <label key={attribute.id}>{t('tasks.setAttr', { name: attribute.name })}<select aria-label={`Set ${attribute.name}`} defaultValue="" onChange={(event) => { if (event.target.value) void app.bulkSetAttribute(attribute, event.target.value); }}><option value="" disabled>{t('tasks.chooseValue')}</option>{attribute.options.map((option) => <option key={option.id} value={option.key}>{option.name}</option>)}</select></label>)}
      <button type="button" className="ghost" onClick={() => app.setSelectedTaskIds([])}>{t('tasks.clearSelection')}</button>
    </div>}
    {activeView === 'list' && selectedListId && activeList?.kind === 'manual' && tableLike && <div className="bulk-actions"><button type="button" className="secondary btn-sm" disabled={!viewTasks[focusedRowIndex]} onClick={() => { const item = viewTasks[focusedRowIndex]; if (item) void app.changeListMembership(item, false); }}>{t('tasks.removeFromList')}</button><button type="button" className="secondary btn-sm" disabled={!app.tasks[focusedRowIndex]} onClick={() => { const item = app.tasks[focusedRowIndex]; if (item) void app.changeListMembership(item, true); }}>{t('tasks.addToList')}</button></div>}
    <div className="tasks-body">{body()}</div>
  </section>;
}
