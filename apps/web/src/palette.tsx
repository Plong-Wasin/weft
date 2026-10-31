import React from 'react';
import { PaletteMilestones } from './milestones';
import { api, COMMAND_PREFIX } from './api';
import type { App } from './app-state';
import { Icon, type IconName } from './ui/icons';
import { Dialog } from './ui/primitives';
import { setLocale, getLocale, t, useLocale } from './i18n';
import { setTheme } from './theme';
import type { Task } from './types';

type Entry = { id: string; icon: IconName; label: string; keys?: string[]; keywords?: string; run: () => void };

function Keys({ keys }: { keys?: string[] }) {
  return keys ? <span className="palette-keys">{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span> : null;
}

export function Palette({ app }: { app: App }) {
  useLocale();
  const { workspace, paletteQuery: query, viewTasks, statuses, aiAvailability } = app;
  const [active, setActive] = React.useState(0);
  const [moved, setMoved] = React.useState(false);
  const list = React.useRef<HTMLDivElement>(null);
  if (!workspace) return null;
  const trimmed = query.trim();
  const helpMode = trimmed === '?';
  const admin = ['owner', 'admin'].includes(workspace.role);
  const ready = aiAvailability.status === 'ready';
  const reason = aiAvailability.status === 'unavailable' ? aiAvailability.reason : t('palette.checking');
  const target = app.task ?? viewTasks[app.focusedRowIndex];
  const go = (target: Parameters<App['goTo']>[0]) => () => { app.closePalette(false); app.goTo(target); };

  const staticCommands: Entry[] = [
    { id: 'new-task', icon: 'plus', label: t('palette.cmd.newTask'), keywords: 'create add task', run: () => { app.closePalette(false); app.openNewTask(); } },
    { id: 'ai', icon: 'sparkles', label: t('palette.cmd.ai'), keywords: 'generate ai plan', run: () => { if (!ready) return; app.closePalette(false); app.openGenerate(); } },
    { id: 'template', icon: 'template', label: t('palette.cmd.template'), keywords: 'templates', run: () => { app.closePalette(false); app.openTemplates(); } },
    { id: 'go-inbox', icon: 'inbox', label: t('palette.cmd.goInbox'), keys: ['g', 'i'], keywords: 'inbox notifications', run: go('inbox') },
    { id: 'go-tasks', icon: 'tasks', label: t('palette.cmd.goTasks'), keys: ['g', 't'], keywords: 'all tasks table', run: go('all') },
    { id: 'go-my', icon: 'user', label: t('palette.cmd.goMyWork'), keys: ['g', 'm'], keywords: 'my work assigned', run: go('my-work') },
    { id: 'go-proposals', icon: 'proposal', label: t('palette.cmd.goProposals'), keys: ['g', 'p'], keywords: 'proposals review approve', run: go('proposal') },
    { id: 'go-knowledge', icon: 'book', label: t('palette.cmd.goKnowledge'), keys: ['g', 'k'], keywords: 'knowledge notes vaults', run: go('knowledge') },
    { id: 'go-blockers', icon: 'flag', label: t('palette.cmd.goBlockers'), keys: ['g', 'b'], keywords: 'blockers blocked', run: go('blockers') },
    { id: 'go-overview', icon: 'layout', label: t('palette.cmd.goOverview'), keys: ['g', 'o'], keywords: 'overview project', run: go('overview') },
    { id: 'go-milestones', icon: 'clock', label: t('palette.cmd.goMilestones'), keys: ['g', 'l'], keywords: 'milestones', run: go('milestones') },
    { id: 'go-settings', icon: 'settings', label: t('palette.cmd.goSettings'), keys: ['g', 's'], keywords: 'settings', run: go('settings') },
    { id: 'go-skills', icon: 'bolt', label: t('palette.cmd.goSkills'), keywords: 'skills', run: go('skills') },
    { id: 'view-table', icon: 'table', label: t('palette.cmd.viewTable'), keywords: 'table view', run: () => { app.closePalette(false); app.goTo('tasks'); app.setViewMode('table'); } },
    { id: 'view-kanban', icon: 'kanban', label: t('palette.cmd.viewKanban'), keywords: 'kanban board view', run: () => { app.closePalette(false); app.goTo('tasks'); app.setViewMode('kanban'); } },
    { id: 'export', icon: 'download', label: t('palette.cmd.export'), keywords: 'export csv', run: () => { app.closePalette(); void app.exportView(); } },
    { id: 'shortcuts', icon: 'keyboard', label: t('palette.cmd.shortcuts'), keys: ['?'], keywords: 'keyboard shortcuts help', run: () => { app.closePalette(false); app.openShortcutHelp(); } },
    { id: 'language', icon: 'globe', label: getLocale() === 'th' ? t('palette.cmd.langEn') : t('palette.cmd.langTh'), keywords: 'language thai english ภาษา', run: () => { app.closePalette(); setLocale(getLocale() === 'th' ? 'en' : 'th'); } },
    { id: 'theme', icon: 'moon', label: t('palette.cmd.theme'), keywords: 'theme dark light mode', run: () => { app.closePalette(); setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); } },
    ...(admin ? [{ id: 'new-project', icon: 'folder' as IconName, label: t('palette.cmd.newProject'), keywords: 'project create', run: () => { app.closePalette(false); app.setProjectDialogOpen(true); } }, { id: 'teams', icon: 'users' as IconName, label: t('palette.cmd.teams'), keywords: 'team manage create', run: () => { app.closePalette(false); app.setTeamsOpen(true); } }] : []),
    { id: 'new-list', icon: 'list', label: t('palette.cmd.newList'), keywords: 'list smart list create', run: () => { app.closePalette(false); app.setNewListOpen(true); } },
    { id: 'signout', icon: 'logout', label: t('menu.signOut'), keywords: 'sign out logout', run: () => { app.closePalette(false); void app.signOut(); } },
  ];

  const lower = trimmed.toLowerCase();
  const commandTyped = COMMAND_PREFIX.test(trimmed);
  const matchedStatic = trimmed === '' ? staticCommands.slice(0, 9) : commandTyped ? [] : staticCommands.filter((entry) => `${entry.label} ${entry.keywords ?? ''}`.toLowerCase().includes(lower));
  const suggestedTasks: Task[] = trimmed === '' ? [...(app.task ? [app.task] : []), ...viewTasks.filter((item) => item.id !== app.task?.id)].slice(0, 5) : [];

  // Keep the highlighted option in range and visible; aria-selected lives on the DOM so legacy option markup stays simple.
  React.useLayoutEffect(() => {
    const options = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? []);
    options.forEach((element, index) => { element.setAttribute('aria-selected', index === active ? 'true' : 'false'); if (index === active) element.scrollIntoView({ block: 'nearest' }); });
  });
  React.useEffect(() => { setActive(0); setMoved(false); }, [query]);

  function keydown(event: React.KeyboardEvent) {
    const options = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? []);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      setMoved(true);
      setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (trimmed === '' || moved) { options[Math.min(active, options.length - 1)]?.click(); return; }
      void app.runPaletteCommand();
    }
  }

  const opt = (entry: Entry) => <button type="button" role="option" key={entry.id} aria-selected="false" onClick={entry.run}><Icon name={entry.icon} small /><strong>{entry.label}</strong><Keys keys={entry.keys} /></button>;
  const disabledOption = (text: string) => <p role="option" aria-selected="false" aria-disabled="true" className="muted palette-note">{text}</p>;
  const split = trimmed.match(/^(?:suggest\s+)?(?:split|links?)(?:\s+.+)?$/i);
  const plan = trimmed.match(/^plan(?:\s+milestones?)?(?:\s+.+)?$/i);
  const generate = trimmed.match(/^(?:generate|ai)(?:\s+.+)?$/i);
  const milestoneQuery = trimmed.match(/^milestone(?:\s+(.*))?$/i);
  const milestoneTarget = app.task ?? viewTasks[app.focusedRowIndex];

  return <Dialog bare label={t('palette.title')} onClose={() => app.closePalette()} className="command-palette">
    <div className="palette-input"><Icon name="search" /><label className="sr-only" htmlFor="command-search">{t('palette.searchLabel')}</label>
      <input id="command-search" data-autofocus ref={app.paletteInputRef} role="searchbox" aria-label={t('palette.searchLabel')} placeholder={t('palette.placeholder')} value={query} onChange={(event) => app.setPaletteQuery(event.target.value)} onKeyDown={keydown} autoComplete="off" />
      <kbd>Esc</kbd></div>
    <div className="palette-results" role="listbox" aria-label={t('palette.results')} ref={list}>
      {helpMode ? <div className="palette-help" role="presentation">
        <h3>{t('palette.helpTitle')}</h3>
        <dl>
          <dt><kbd>g</kbd> <kbd>i</kbd> / <kbd>t</kbd> / <kbd>m</kbd> / <kbd>p</kbd> / <kbd>k</kbd></dt><dd>{t('palette.help.go')}</dd>
          <dt><kbd>Ctrl</kbd>+<kbd>K</kbd></dt><dd>{t('palette.help.open')}</dd>
          <dt><kbd>↑</kbd> <kbd>↓</kbd> <kbd>↵</kbd></dt><dd>{t('palette.help.pick')}</dd>
          <dt>#12</dt><dd>{t('palette.help.number')}</dd>
          <dt>{t('palette.help.typeLabel')}</dt><dd>{t('palette.help.type')}</dd>
        </dl>
      </div> : <>
        {split && (!ready ? disabledOption(t('palette.suggestUnavailable', { reason })) : !target ? disabledOption(t('palette.focusFirst')) : <button type="button" role="option" aria-selected="false" onClick={() => void app.runPaletteCommand()}><Icon name="link" small /><strong>{/split/i.test(trimmed) ? t('ai.split') : t('ai.links')}</strong><span className="muted">Task #{target.number} {target.title}</span></button>)}
        {plan && (ready ? <button type="button" role="option" aria-selected="false" onClick={() => void app.runPaletteCommand()}><Icon name="sparkles" small /><strong>{t('palette.planMilestones')}</strong><span className="muted">{trimmed.replace(/^plan(?:\s+milestones?)?\s*/i, '') || t('palette.describeGoal')}</span></button> : disabledOption(t('palette.planUnavailable', { reason })))}
        {generate && (ready ? <button type="button" role="option" aria-selected="false" onClick={() => void app.runPaletteCommand()}><Icon name="sparkles" small /><strong>{t('palette.cmd.ai')}</strong><span className="muted">{trimmed.replace(/^(?:generate|ai)\s*/i, '') || t('palette.describeGoal')}</span></button> : disabledOption(t('palette.generateUnavailable', { reason })))}
        {trimmed.match(/^templates?(?:\s+.*)?$/i) && <button type="button" role="option" aria-selected="false" onClick={() => void app.runPaletteCommand()}><Icon name="template" small /><strong>{t('palette.createFromTemplate')}</strong><span className="muted">{t('palette.templateHint')}</span></button>}
        {app.schedulePaletteCommands.map((item) => <button type="button" role="option" aria-selected="false" key={`schedule-${item.id}`} onClick={() => { app.closePalette(false); void item.run(); }}><Icon name="clock" small /><strong>{item.label}</strong><span className="muted">{item.detail}</span></button>)}
        {app.timelinePaletteCommands.map((item) => <button type="button" role="option" aria-selected="false" key={`timeline-${item.id}`} onClick={() => { app.closePalette(false); void item.run(); }}><Icon name="timeline" small /><strong>{item.label}</strong><span className="muted">{item.detail}</span></button>)}
        {app.calendarPaletteCommands.map((item) => <button type="button" role="option" aria-selected="false" key={item.id} onClick={() => { app.closePalette(false); void item.run(); }}><Icon name="calendar" small /><strong>{item.label}</strong><span className="muted">{item.detail}</span></button>)}
        {trimmed.match(/^create(?:\s+.+)?$/i) && <button type="button" role="option" aria-selected="false" onClick={() => void app.runPaletteCommand()}><Icon name="plus" small /><strong>{t('palette.createTask')}</strong><span className="muted">{trimmed.replace(/^create\s*/i, '') || t('palette.newTaskDefault')}</span></button>}
        {trimmed.match(/^status\s+.+$/i) && statuses.filter((status) => `${status.key} ${status.name}`.toLowerCase().includes(trimmed.replace(/^status\s+/i, '').toLowerCase())).map((status) => <button type="button" role="option" aria-selected="false" key={status.id} onClick={() => void app.runPaletteCommand()}><span className="dot" style={{ color: status.color }} aria-hidden="true" /><strong>{t('palette.setStatus', { name: status.name })}</strong><span className="muted">Task #{viewTasks[app.focusedRowIndex]?.number ?? '—'}</span></button>)}
        {milestoneQuery && milestoneTarget && <PaletteMilestones api={api} project={milestoneTarget.project_id} epoch={app.milestoneEpoch} filter={milestoneQuery[1] ?? ''} taskNumber={milestoneTarget.number} onPick={(milestone) => { void app.updateTaskMilestone(milestoneTarget, milestone); app.closePalette(); }} />}
        {trimmed.match(/^column\s+move\s+.+\s+(left|right)$/i) && <button type="button" role="option" aria-selected="false" onClick={() => void app.runPaletteCommand()}><Icon name="kanban" small /><strong>{trimmed}</strong><span className="muted">{t('palette.reorderColumn')}</span></button>}
        {app.paletteSearchError && <p role="alert" className="muted">{app.paletteSearchError}</p>}
        {matchedStatic.length > 0 && <div role="group" aria-label={t('palette.commands')}><p className="palette-group" aria-hidden="true">{t('palette.commands')}</p>{matchedStatic.map(opt)}</div>}
        {suggestedTasks.length > 0 && <div role="group" aria-label={t('palette.tasks')}><p className="palette-group" aria-hidden="true">{t('palette.tasks')}</p>{suggestedTasks.map((item) => <button type="button" role="option" aria-selected="false" key={item.id} onClick={() => { app.closePalette(false); app.openPanel(item); }}><span className="number">#{item.number}</span><strong>{item.title}</strong></button>)}</div>}
        {app.paletteSearchResults.length > 0 && <div role="group" aria-label={t('palette.tasks')}><p className="palette-group" aria-hidden="true">{t('palette.tasks')}</p>{app.paletteSearchResults.map((item) => <button type="button" role="option" aria-selected="false" key={item.task_id} onClick={() => { app.closePalette(false); app.openPanel(item); }}><span className="number">#{item.task_number}</span><strong>{item.title}</strong><span className="muted">{item.snippet}</span></button>)}</div>}
        {app.paletteNoteResults.length > 0 && <div role="group" aria-label={t('nav.knowledge')}><p className="palette-group" aria-hidden="true">{t('nav.knowledge')}</p>{app.paletteNoteResults.map((item) => <button type="button" role="option" aria-selected="false" key={`${item.vault_id}:${item.path}`} onClick={() => { app.closePalette(false); void app.openKnowledgeResult(item); }}><Icon name="book" small /><strong>{item.title}</strong><span className="muted">{item.vault_name} · {item.path}</span></button>)}</div>}
        {trimmed !== '' && app.paletteSearchResults.length === 0 && app.paletteNoteResults.length === 0 && !app.paletteSearchError && !commandTyped && matchedStatic.length === 0 && <p className="muted palette-note">{t('palette.noMatch')}</p>}
      </>}
    </div>
    <div className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> {t('palette.navigate')}</span><span><kbd>↵</kbd> {t('palette.select')}</span><span><kbd>?</kbd> {t('palette.help')}</span><span><kbd>Esc</kbd> {t('palette.close')}</span></div>
  </Dialog>;
}
