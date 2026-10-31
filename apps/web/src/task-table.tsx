import React from 'react';
import { MilestoneSelect } from './milestones';
import { api } from './api';
import { ROW_HEIGHT, ROW_WINDOW, type App } from './app-state';
import { Icon } from './ui/icons';
import { PopoverField } from './ui/popover';
import { DateInput } from './ui/date-input';
import { DragGhost, dropClass, useDragSort } from './ui/drag';
import { AssigneePicker, AttributeEditor, OptionPicker, RowMenu, StatusPicker, priorityOptions } from './task-cells';
import { BUILTIN_COLUMNS, sortKeyOf } from './task-order';
import { formatDate, t, useLocale, type MessageKey } from './i18n';
import type { Assignee, Attribute, Task } from './types';

const COLUMN_WIDTH: Record<string, string> = { title: 'minmax(300px, 3fr)', status: '176px', priority: '120px', assignees: '140px', start_date: '150px', due_date: '150px', milestone: '180px', created_at: '120px', updated_at: '120px', completed_at: '120px' };
const COLUMN_LABEL: Record<string, MessageKey> = { title: 'col.task', status: 'col.status', priority: 'col.priority', assignees: 'col.assignee', start_date: 'col.start', due_date: 'col.due', milestone: 'col.milestone', created_at: 'col.created', updated_at: 'col.updated', completed_at: 'col.completed' };

export function assigneeSummary(task: Task) {
  if (task.assignees.length === 0) return '';
  const first = task.assignees[0].name.split('@')[0];
  return task.assignees.length > 1 ? `${first} +${task.assignees.length - 1}` : first;
}

type TableColumn = { id: string; label: string; width: string; attribute?: Attribute };

/** The draft row at the bottom of the table: Enter creates and re-opens an empty row, Escape or an empty blur removes it. */
function NewTaskRow({ app, columns, shownAttributes }: { app: App; columns: TableColumn[]; shownAttributes: Attribute[] }) {
  const empty = { title: '', status: '', assignees: [] as Assignee[], due: '', attrs: {} as Record<string, unknown> };
  const [draft, setDraft] = React.useState(empty);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const rowRef = React.useRef<HTMLDivElement>(null);
  const titleRef = React.useRef<HTMLInputElement>(null);
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());
  const project = app.projects.find((item) => item.id === (app.projectFilter || app.selectedProject));
  React.useEffect(() => { titleRef.current?.focus(); }, []);
  const defaultStatus = app.statuses.find((status) => status.is_default) ?? app.statuses.find((status) => status.category === 'not_started') ?? app.statuses[0];

  function submit() {
    const current = draftRef.current;
    if (!current.title.trim()) return;
    // Clear at once so the next title can be typed while this one is saved; saves run one after another to keep their order.
    setDraft(empty);
    queue.current = queue.current.then(async () => {
      const ok = await app.createInlineTask({ title: current.title, status: current.status || undefined, assignees: current.assignees, due: current.due, attrs: current.attrs });
      if (!ok) setDraft((now) => now.title ? now : current);
    });
    requestAnimationFrame(() => titleRef.current?.focus());
  }
  function leave() {
    requestAnimationFrame(() => {
      const row = rowRef.current;
      if (!row || row.contains(document.activeElement)) return;
      if (!draftRef.current.title.trim()) app.setCreatingRow(false);
    });
  }
  function cancel() { app.setCreatingRow(false); requestAnimationFrame(() => app.gridRef.current?.focus()); }

  return <div role="row" ref={rowRef} className="table-row new-row" aria-label={t('table.newRow')} onBlur={leave}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
      else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); event.stopPropagation(); submit(); }
    }}>
    {columns.map((column) => {
      if (column.id === 'title') return <div role="gridcell" key="title" className="table-task"><span className="number muted">+</span><input ref={titleRef} aria-label={t('table.newTitle')} placeholder={t('table.newPlaceholder', { project: project?.name ?? '' })} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></div>;
      if (column.id === 'status') return <div role="gridcell" key="status"><StatusPicker statuses={app.statuses} value={draft.status || defaultStatus?.key || ''} label={t('table.newStatus')} onChange={(key) => setDraft({ ...draft, status: key })} /></div>;
      if (column.id === 'assignees') return <div role="gridcell" key="assignees"><AssigneePicker value={draft.assignees} members={app.members} teams={app.teams} label={t('table.newAssignees')} onChange={(next) => setDraft({ ...draft, assignees: next })} /></div>;
      if (column.id === 'due_date') return <div role="gridcell" key="due"><DateInput label={t('table.newDue')} value={draft.due} onChange={(next) => setDraft({ ...draft, due: next })} /></div>;
      const attribute = column.attribute;
      if (attribute && shownAttributes.includes(attribute) && attribute.project_ids?.includes(app.projectFilter || app.selectedProject)) return <div role="gridcell" key={column.id}><AttributeEditor live attribute={attribute} members={app.members} label={t('table.newAttr', { name: attribute.name })} value={draft.attrs[attribute.id]} onChange={(next) => setDraft({ ...draft, attrs: { ...draft.attrs, [attribute.id]: next } })} /></div>;
      return <div role="gridcell" key={column.id} aria-hidden="true" />;
    })}
    <div role="gridcell" className="row-end"><span className="muted new-row-hint">{t('table.newHint')}</span></div>
  </div>;
}

function ColumnsMenu({ app, attributes }: { app: App; attributes: Attribute[] }) {
  const admin = app.workspace ? ['owner', 'admin'].includes(app.workspace.role) : false;
  const current = app.effectiveColumns;
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...current.filter((item) => item !== id), id] : current.filter((item) => item !== id);
    app.changeColumns(next.includes('title') ? next : ['title', ...next]);
  };
  const entries = [...BUILTIN_COLUMNS.filter((id) => id !== 'title').map((id) => ({ id: id as string, label: t(COLUMN_LABEL[id]) })), ...attributes.map((attribute) => ({ id: `attribute:${attribute.id}`, label: attribute.name }))];
  return <PopoverField label={t('table.columns')} className="ghost icon-button btn-sm columns-button" popoverClassName="columns-popover" triggerLabel={<Icon name="plus" small />} title={t('table.columns')}>
    {({ close }) => <div className="option-list">
      <p className="option-group">{t('table.columns')}</p>
      {entries.map((entry) => { const on = current.includes(entry.id) || (entry.id === 'due_date' && current.includes('due')) || (entry.id === 'assignees' && current.includes('assignee')); return <label key={entry.id} className="option check-option"><input type="checkbox" data-pop-item checked={on} onChange={(event) => toggle(entry.id, event.target.checked)} /><span className="option-name">{entry.label}</span></label>; })}
      {admin && <><div className="menu-sep" /><button type="button" className="option" data-pop-item onClick={() => { close(false); app.setAttributeDialogOpen(true); }}><Icon name="plus" small /><span className="option-name">{t('table.newAttribute')}</span></button></>}
    </div>}
  </PopoverField>;
}

export function TaskTable({ app }: { app: App }) {
  useLocale();
  const { viewTasks, focusedRowIndex, virtualStart, virtualEnd, visibleTasks, selectedTaskIds, editingTaskId, inlineTitle, attributes, activeView, taskLists, selectedListId } = app;
  const activeList = activeView === 'list' ? taskLists.find((list) => list.id === selectedListId) : undefined;
  const groupField = activeList?.query.group ?? null;
  const manual = !app.sort;
  const byId = React.useMemo(() => new Map(app.tasks.map((item) => [item.id, item])), [app.tasks]);
  const dnd = useDragSort('row', manual, (drop) => { const item = byId.get(drop.id); if (item) app.reorderRow(item, drop.targetId, drop.position); });

  const shownAttributes = attributes.filter((attribute) => app.effectiveColumns.includes(`attribute:${attribute.id}`) && viewTasks.some((item) => attribute.project_ids?.includes(item.project_id)));
  const columns: TableColumn[] = [
    ...BUILTIN_COLUMNS.filter((id) => app.showColumn(id)).map((id) => ({ id: id as string, label: t(COLUMN_LABEL[id]), width: COLUMN_WIDTH[id] })),
    ...shownAttributes.map((attribute) => ({ id: `attribute:${attribute.id}`, label: attribute.name, width: '170px', attribute })),
  ];
  const gridStyle = { '--cols': `${columns.map((column) => column.width).join(' ')} 84px`, minWidth: `${300 + (columns.length - 1) * 150 + 84}px` } as React.CSSProperties;
  const canCreate = (activeView === 'all' || (activeView === 'list' && activeList?.kind === 'manual')) && app.projects.length > 0;

  function cycleSort(column: TableColumn) {
    const key = sortKeyOf(column.id);
    if (!key) return;
    const current = app.sort;
    if (!current || current.key !== key) app.changeSort({ key, direction: 'asc' });
    else if (current.direction === 'asc') app.changeSort({ key, direction: 'desc' });
    else app.changeSort(null);
  }

  const cell = (column: TableColumn, item: Task, index: number) => {
    const n = item.number;
    switch (column.id) {
      case 'status': return <div role="gridcell" key="status" onClick={() => app.focusRow(index)}><StatusPicker statuses={app.statuses} value={item.status} label={t('table.statusFor', { n })} onChange={(key) => void app.updateTaskStatus(item, key)} /></div>;
      case 'priority': return <div role="gridcell" key="priority"><OptionPicker label={t('table.priorityFor', { n })} options={priorityOptions()} value={item.priority} onChange={(next) => void app.updateTaskPriority(item, String(next))} /></div>;
      case 'assignees': return <div role="gridcell" key="assignees" title={item.assignees.map((assignee) => assignee.name).join(', ')}><AssigneePicker value={item.assignees} members={app.members} teams={app.teams} label={t('table.assigneesFor', { n })} onChange={(next) => void app.updateTaskAssignees(item, next)} /></div>;
      case 'start_date': return <div role="gridcell" key="start"><DateInput label={t('table.startFor', { n })} value={item.start_date ?? ''} onChange={(next) => void app.updateTaskDate(item, 'start_date', next)} /></div>;
      case 'due_date': return <div role="gridcell" key="due"><DateInput label={t('table.dueFor', { n })} value={item.due_date ?? ''} onChange={(next) => void app.updateTaskDate(item, 'due_date', next)} /></div>;
      case 'milestone': return <div role="gridcell" key="milestone" onClick={() => app.focusRow(index)}><MilestoneSelect api={api} project={item.project_id} epoch={app.milestoneEpoch} value={item.milestone} label={`Milestone for #${n}`} disabled={app.savingMilestone === item.id} onChange={(milestone) => void app.updateTaskMilestone(item, milestone)} /></div>;
      case 'created_at': case 'updated_at': case 'completed_at': return <div role="gridcell" key={column.id} className="tnum muted cell-text">{formatDate((item as unknown as Record<string, string | null | undefined>)[column.id])}</div>;
      default: {
        const attribute = column.attribute;
        if (!attribute) return null;
        return <div role="gridcell" key={column.id}>{attribute.project_ids?.includes(item.project_id) ? <AttributeEditor attribute={attribute} members={app.members} label={t('tasks.attrFor', { name: attribute.name, n })} value={item.attributes[attribute.id]} onChange={(next) => void app.updateTaskAttribute(item, attribute, next)} /> : null}</div>;
      }
    }
  };

  return <div className="table-scroll" data-drag-scroll onScroll={(event) => { const next = Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT); const start = Math.min(next, Math.max(0, viewTasks.length - ROW_WINDOW)); if (Math.abs(start - virtualStart) > 3) app.setVirtualStart(start); }}>
    <div role="grid" style={gridStyle} aria-label="Tasks" aria-rowcount={viewTasks.length + 1} aria-activedescendant={`task-row-${viewTasks[focusedRowIndex]?.id ?? ''}`} tabIndex={0} ref={app.gridRef} onKeyDown={app.handleGridKeyDown} className={dnd.drag ? 'is-dragging' : ''}>
      <div role="row" className="table-row table-header">
        {columns.map((column) => {
          const key = sortKeyOf(column.id);
          const active = key !== null && app.sort?.key === key;
          return <span role="columnheader" key={column.id} className={column.id === 'title' ? 'table-task-head' : ''} aria-sort={active ? (app.sort?.direction === 'asc' ? 'ascending' : 'descending') : key ? 'none' : undefined}>
            {key ? <button type="button" className="col-sort" aria-label={t('table.sortBy', { name: column.label })} onClick={() => cycleSort(column)}><span className="cell-text">{column.label}</span><span className={`sort-mark ${active ? 'on' : ''}`} aria-hidden="true">{active ? (app.sort?.direction === 'asc' ? '↑' : '↓') : ''}</span></button> : <span className="col-label cell-text">{column.label}</span>}
          </span>;
        })}
        <span role="columnheader" className="row-end"><ColumnsMenu app={app} attributes={attributes} /></span>
      </div>
      {virtualStart > 0 && <div aria-hidden="true" style={{ height: virtualStart * ROW_HEIGHT }} />}
      {visibleTasks.map((item, offset) => {
        const index = virtualStart + offset;
        const depth = app.taskDepth(item);
        const editable = editingTaskId === item.id;
        const heading = groupField && (index === 0 || app.groupLabel(viewTasks[index - 1], groupField) !== app.groupLabel(item, groupField)) ? <div role="row" className="table-group-heading" key={`group-${item.id}`}><h3 role="gridcell">{app.groupLabel(item, groupField)}</h3></div> : null;
        return <React.Fragment key={item.id}>{heading}<div role="row" id={`task-row-${item.id}`} data-drag-target={item.id} data-drag-kind="row" aria-selected={selectedTaskIds.includes(item.id)} aria-label={`#${item.number} ${item.title}`} className={`table-row ${selectedTaskIds.includes(item.id) ? 'row-selected' : ''} ${index === focusedRowIndex ? 'row-focused' : ''} ${dnd.drag?.id === item.id ? 'row-dragged' : ''}${dropClass(dnd.drag, item.id)}`} onClick={(event) => { if (event.target instanceof HTMLElement && event.target.closest('select,input,button,[role="dialog"]')) return; app.focusRow(index); }}>
          {columns.map((column) => column.id === 'title'
            ? <div role="gridcell" key="title" className="table-task" style={{ paddingLeft: `${12 + depth * 20}px` }}>
              {manual && <span className="drag-handle" title={t('table.dragHint')} onPointerDown={dnd.start(item.id, `#${item.number} ${item.title}`)} aria-hidden="true"><svg viewBox="0 0 12 16" width="10" height="14"><path d="M3 3h.01M9 3h.01M3 8h.01M9 8h.01M3 13h.01M9 13h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" /></svg></span>}
              <span className="number">#{item.number}</span>
              {editable ? <input aria-label={`Edit title for #${item.number}`} autoFocus value={inlineTitle} onChange={(event) => app.setInlineTitle(event.target.value)} onBlur={() => { if (!inlineTitle.trim()) app.setInlineTitle(item.title); }} /> : <button type="button" className="table-task-title" title={item.title} onClick={() => { app.focusRow(index); app.openPanel(item); }}>{item.title}</button>}
            </div>
            : cell(column, item, index))}
          <div role="gridcell" className="row-end"><RowMenu app={app} item={item} variant="row" /></div>
        </div></React.Fragment>;
      })}
      {virtualEnd < viewTasks.length && <div aria-hidden="true" style={{ height: (viewTasks.length - virtualEnd) * ROW_HEIGHT }} />}
      {canCreate && (app.creatingRow
        ? <NewTaskRow app={app} columns={columns} shownAttributes={shownAttributes} />
        : <div role="row" className="table-row new-row-ghost"><div role="gridcell" className="table-task"><button type="button" className="add-row" onClick={() => app.setCreatingRow(true)}><Icon name="plus" small /><span>{t('table.addTask')}</span></button></div></div>)}
    </div>
    <DragGhost drag={dnd.drag} />
  </div>;
}
