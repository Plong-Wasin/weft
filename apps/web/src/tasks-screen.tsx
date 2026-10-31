import { CalendarView } from './calendar';
import { TimelineView } from './timeline';
import type { App } from './app-state';
import { TaskTable } from './task-table';
import { TaskBoard } from './task-board';
import { Icon } from './ui/icons';
import { EmptyState, Skeleton } from './ui/primitives';
import { enumLabel, t, useLocale } from './i18n';
import type { Task } from './types';

export function priorityLabel(priority: string) { return enumLabel('priority', priority); }

export function TasksScreen({ app }: { app: App }) {
  useLocale();
  const { workspace, viewTasks, viewMode, statuses, activeView, taskLists, selectedListId, selectedTaskIds, keyboardMode, focusedRowIndex } = app;
  const activeList = activeView === 'list' ? taskLists.find((list) => list.id === selectedListId) : undefined;
  if (!workspace) return null;
  const loaded = app.projectsLoadedFor === workspace.id;

  const body = () => {
    if (viewMode === 'timeline') return <TimelineView tl={app.timeline} onOpen={(item) => app.openPanel(item as Task)} />;
    if (viewMode === 'calendar') return <CalendarView cal={app.calendar} onOpen={(item) => app.openPanel(item as Task)} onUndo={() => app.runHistoryAction(false)} />;
    if (!loaded) return <div className="tasks-loading"><Skeleton rows={9} /></div>;
    if (viewTasks.length === 0) return <EmptyState title={t('tasks.emptyTitle')} action={<button type="button" onClick={() => app.openNewTask()}><Icon name="plus" />{t('topbar.newTask')}</button>}>{t('tasks.empty')}</EmptyState>;
    if (viewMode === 'kanban') return <TaskBoard app={app} />;
    return <TaskTable app={app} />;
  };

  const tableLike = viewMode === 'table' || viewMode === 'kanban';
  return <section className="tasks-screen" aria-label={t('tasks.region')}>
    {tableLike && <div className="tasks-toolbar">
      {viewMode === 'table' ? <><div className="mode-controls" role="group" aria-label={t('tasks.keyboardMode')}>
        {(['browse', 'edit', 'outline'] as const).map((mode) => <button key={mode} type="button" className={`ghost btn-sm ${keyboardMode === mode ? 'selected' : ''}`} aria-label={t(`mode.${mode}.aria`)} aria-pressed={keyboardMode === mode} title={t(`mode.${mode}.hint`)} onClick={() => app.setKeyboardMode(mode)}>{t(`mode.${mode}`)}</button>)}
      </div>
      <span className="toolbar-hint muted">{t(`mode.${keyboardMode}.hint`)}</span></> : null}
      <div className="toolbar-end">
        {app.sort && <button type="button" className="ghost btn-sm sort-reset" onClick={() => app.changeSort(null)}>{t('table.sortedBy', { name: app.sort.key.startsWith('attribute/') ? app.attributes.find((attribute) => attribute.id === app.sort?.key.slice(10))?.name ?? '' : enumLabel('sortkey', app.sort.key), dir: t(app.sort.direction === 'asc' ? 'table.asc' : 'table.desc') })}<span className="sort-reset-x">{t('table.resetManual')}</span></button>}
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
