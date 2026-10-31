import React from 'react';
import type { App } from './app-state';
import { Icon } from './ui/icons';
import { DragGhost, dropClass, useDragSort } from './ui/drag';
import { StatusIcon } from './ui/status-icon';
import { groupStatuses } from './ui/pickers';
import { AssigneePicker, PriorityBadge, RowMenu } from './task-cells';
import { formatDate, t, useLocale } from './i18n';
import type { Status } from './types';

/** The add-task row at the bottom of a column: Enter creates in that Status and stays open, Escape or an empty blur closes it. */
function ColumnAdd({ app, status }: { app: App; status: Status }) {
  const [text, setText] = React.useState('');
  const textRef = React.useRef(text);
  textRef.current = text;
  const input = React.useRef<HTMLInputElement>(null);
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());
  React.useEffect(() => { input.current?.focus(); }, []);
  return <form className="column-add" onSubmit={(event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    queue.current = queue.current.then(() => app.createInlineTask({ title: value, status: status.key }).then((ok) => { if (!ok) setText((now) => now || value); }));
  }}>
    <input ref={input} aria-label={t('board.addTitle', { name: status.name })} placeholder={t('board.addPlaceholder')} value={text} onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); app.setCreatingInColumn(null); } }}
      onBlur={() => { requestAnimationFrame(() => { if (!textRef.current.trim()) app.setCreatingInColumn(null); }); }} />
  </form>;
}

export function TaskBoard({ app }: { app: App }) {
  useLocale();
  const { viewTasks, statuses } = app;
  const columns = groupStatuses(statuses).flatMap((group) => group.items);
  const byId = React.useMemo(() => new Map(app.tasks.map((item) => [item.id, item])), [app.tasks]);
  const dnd = useDragSort('card', true, (drop) => {
    const item = byId.get(drop.id);
    if (!item) return;
    const target = drop.targetId ? byId.get(drop.targetId) : undefined;
    const status = target?.status ?? columns.find((column) => column.key === drop.zone)?.key;
    if (status) app.dropOnBoard(item, status, drop.targetId, drop.position);
  });
  const canCreate = (app.activeView === 'all' || app.activeView === 'list') && app.projects.length > 0;
  return <div className="kanban-board" data-drag-scroll aria-label={t('tasks.kanbanLabel')}>
    {columns.map((status) => {
      const cards = viewTasks.filter((item) => item.status === status.key);
      return <section key={status.id} className={`kanban-column ${dnd.drag?.zone === status.key ? 'drop-zone-active' : ''}`} data-drag-zone={status.key} aria-label={t('tasks.columnLabel', { name: status.name })}>
        <div className="kanban-heading"><h3><StatusIcon category={status.category} color={status.color} />{status.name} <span className="count">{cards.length}</span></h3></div>
        <div className="kanban-cards">
          {cards.map((item) => {
            const siblings = cards;
            return <article key={item.id} className={`kanban-card ${dnd.drag?.id === item.id ? 'row-dragged' : ''}${dropClass(dnd.drag, item.id)}`} data-drag-target={item.id} data-drag-kind="card" onPointerDown={dnd.start(item.id, `#${item.number} ${item.title}`)}>
              <button type="button" className="kanban-open" aria-label={`Task #${item.number}, ${item.title}, ${status.name}`} onClick={() => app.openPanel(item)} onKeyDown={(event) => {
                if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); app.stepRow(item, event.key === 'ArrowUp' ? -1 : 1, siblings); return; }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  const index = columns.findIndex((column) => column.id === status.id) + (event.key === 'ArrowRight' ? 1 : -1);
                  const next = columns[index];
                  if (next) void app.moveTask(item, { status: next.key }, t('announce.movedToStatus', { n: item.number, status: next.name }));
                }
              }}>
                <span className="kanban-title"><span className="number">#{item.number}</span><strong title={item.title}>{item.title}</strong></span>
              </button>
              <div className="kanban-meta"><PriorityBadge priority={item.priority} />{item.due_date && <span className="muted tnum">{formatDate(item.due_date)}</span>}
                <span className="kanban-tools"><AssigneePicker value={item.assignees} members={app.members} teams={app.teams} label={t('table.assigneesFor', { n: item.number })} className="cell-button card-assignees" onChange={(next) => void app.updateTaskAssignees(item, next)} /><RowMenu app={app} item={item} variant="card" /></span>
              </div>
            </article>;
          })}
          {cards.length === 0 && <p className="kanban-empty muted">{t('board.empty')}</p>}
        </div>
        {canCreate && (app.creatingInColumn === status.key ? <ColumnAdd app={app} status={status} /> : <button type="button" className="add-row column-add-button" aria-label={t('board.addTask', { name: status.name })} onClick={() => app.setCreatingInColumn(status.key)}><Icon name="plus" small /><span>{t('table.addTask')}</span></button>)}
      </section>;
    })}
    <DragGhost drag={dnd.drag} />
  </div>;
}
