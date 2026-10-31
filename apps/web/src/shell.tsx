import React from 'react';
import { Icon, type IconName } from './ui/icons';
import { Dialog, MenuButton, MenuItem } from './ui/primitives';
import { setLocale, t, useLocale, type Locale } from './i18n';
import { setTheme, useTheme, type ThemeChoice } from './theme';
import type { App } from './app-state';

export function LocaleSwitch() {
  const locale = useLocale();
  const options: [Locale, string][] = [['en', 'EN'], ['th', 'ไทย']];
  return <div className="segmented locale-switch" role="group" aria-label={t('lang.label')}>
    {options.map(([code, label]) => <button key={code} type="button" lang={code} aria-pressed={locale === code} onClick={() => setLocale(code)}>{label}</button>)}
  </div>;
}

export function ThemeSwitch() {
  const theme = useTheme();
  const options: [ThemeChoice, string][] = [['system', t('theme.system')], ['light', t('theme.light')], ['dark', t('theme.dark')]];
  return <div className="segmented" role="group" aria-label={t('theme.label')}>
    {options.map(([code, label]) => <button key={code} type="button" aria-pressed={theme === code} onClick={() => setTheme(code)}>{label}</button>)}
  </div>;
}

function NavItem({ icon, label, current, badge, badgeLabel, onClick }: { icon: IconName; label: string; current?: boolean; badge?: number; badgeLabel?: string; onClick: () => void }) {
  const id = React.useId();
  return <><button type="button" className="nav-item" aria-current={current ? 'page' : undefined} aria-describedby={badge ? id : undefined} onClick={onClick}>
    <Icon name={icon} /><span className="nav-label">{label}</span>
    {badge ? <span className="nav-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span> : null}
  </button>{badge ? <span id={id} className="sr-only">{badgeLabel}</span> : null}</>;
}

export function pendingProposals(app: App) {
  return app.proposal && ['pending', 'ready'].includes(app.proposal.status) ? 1 : 0;
}

export function Sidebar({ app }: { app: App }) {
  useLocale();
  const { workspace, workspaceChoices, activeTab, activeView, showSkills, taskLists, selectedListId, teams, selectedTeam, projects, projectFilter } = app;
  if (!workspace) return null;
  const admin = ['owner', 'admin'].includes(workspace.role);
  const unread = app.inboxEntries.filter((entry) => !entry.read).length;
  const proposals = pendingProposals(app);
  const onTasks = !showSkills && activeTab === 'tasks';
  const here = (condition: boolean) => !showSkills && condition;
  return <aside className="sidebar">
    <div className="sidebar-head">
      <span className="brand-mark" aria-hidden="true"><Icon name="timeline" /></span>
      <div className="workspace-name-wrap">
        <span className="workspace-name">{workspace.name}</span>
        {workspaceChoices.length > 1 && <select className="workspace-select" aria-label={t('nav.workspace')} value={workspace.id} onChange={(event) => { const selected = workspaceChoices.find((item) => item.id === event.target.value); if (selected) void app.chooseWorkspace(selected); }}>{workspaceChoices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        {workspaceChoices.length > 1 && <Icon name="chevron-down" small />}
      </div>
    </div>
    <nav className="side-nav" aria-label={t('nav.primary')}>
      <NavItem icon="inbox" label={t('nav.inbox')} badge={unread} badgeLabel={t('nav.unread', { n: unread })} current={here(activeTab === 'inbox')} onClick={() => app.goTo('inbox')} />
      <NavItem icon="user" label={t('nav.myWork')} current={here(onTasks && activeView === 'my-work')} onClick={() => app.goTo('my-work')} />
      <NavItem icon="tasks" label={t('nav.allTasks')} current={here(onTasks && activeView === 'all' && !projectFilter)} onClick={() => app.goTo('all')} />
      <NavItem icon="proposal" label={t('nav.proposals')} badge={proposals} badgeLabel={t('nav.pending', { n: proposals })} current={here(activeTab === 'proposal')} onClick={() => app.goTo('proposal')} />
      <NavItem icon="flag" label={t('nav.blockers')} current={here(activeTab === 'blockers')} onClick={() => app.goTo('blockers')} />
      <NavItem icon="layout" label={t('nav.overview')} current={here(activeTab === 'overview')} onClick={() => app.goTo('overview')} />
      <NavItem icon="clock" label={t('nav.milestones')} current={here(activeTab === 'milestones')} onClick={() => app.goTo('milestones')} />
      <NavItem icon="book" label={t('nav.knowledge')} current={here(activeTab === 'knowledge')} onClick={() => app.goTo('knowledge')} />

      <div className="nav-section" role="group" aria-label={t('nav.lists')}>
        <div className="nav-section-head"><h2>{t('nav.lists')}</h2><button type="button" className="ghost icon-button btn-sm" aria-label={t('nav.newList')} onClick={() => app.setNewListOpen(true)}><Icon name="plus" small /></button></div>
        {taskLists.length === 0 && <p className="nav-empty">{t('nav.noLists')}</p>}
        {taskLists.map((list) => <button key={list.id} type="button" className="nav-item sub" aria-current={here(onTasks && activeView === 'list' && selectedListId === list.id) ? 'page' : undefined} onClick={() => { app.goTo('tasks'); void app.openList(list.id); app.setActiveView('list'); }}><Icon name={list.kind === 'smart' ? 'filter' : 'list'} small /><span className="nav-label">{list.name}</span></button>)}
      </div>

      <div className="nav-section" role="group" aria-label={t('nav.teams')}>
        <div className="nav-section-head"><h2>{t('nav.teams')}</h2>{admin && <button type="button" className="ghost icon-button btn-sm" aria-label={t('nav.manageTeams')} onClick={() => app.setTeamsOpen(true)}><Icon name="plus" small /></button>}</div>
        {teams.length === 0 && <p className="nav-empty">{t('nav.noTeams')}</p>}
        {teams.map((team) => <button key={team.id} type="button" className="nav-item sub" aria-current={here(onTasks && activeView === 'team-queue' && selectedTeam === team.id) ? 'page' : undefined} onClick={() => { app.goTo('tasks'); void app.showTeamQueue(team.id); }}><Icon name="users" small /><span className="nav-label">{team.name}</span></button>)}
      </div>

      <div className="nav-section" role="group" aria-label={t('nav.projects')}>
        <div className="nav-section-head"><h2>{t('nav.projects')}</h2>{admin && <button type="button" className="ghost icon-button btn-sm" aria-label={t('nav.newProject')} onClick={() => app.setProjectDialogOpen(true)}><Icon name="plus" small /></button>}</div>
        {projects.length === 0 && <p className="nav-empty">{t('nav.noProjects')}</p>}
        {projects.map((project) => <button key={project.id} type="button" className="nav-item sub" aria-current={here(onTasks && projectFilter === project.id) ? 'page' : undefined} onClick={() => { app.goTo('tasks'); app.setActiveView('all'); app.setProjectFilter(project.id); app.setSelectedProject(project.id); }}><Icon name="folder" small /><span className="nav-label">{project.name}</span></button>)}
      </div>
    </nav>
    <div className="sidebar-foot">
      <NavItem icon="menu" label={t('nav.menu')} onClick={() => app.openMenu()} />
    </div>
  </aside>;
}

export function MobileTabs({ app }: { app: App }) {
  useLocale();
  const { activeTab, activeView, showSkills } = app;
  const unread = app.inboxEntries.filter((entry) => !entry.read).length;
  const proposals = pendingProposals(app);
  const tab = (icon: IconName, label: string, current: boolean, onClick: () => void, badge?: number, badgeLabel?: string, extra?: Record<string, unknown>) => {
    const id = `${label}-badge`;
    return <><button type="button" className="tab" aria-current={current ? 'page' : undefined} aria-describedby={badge ? id : undefined} onClick={onClick} {...extra}>
      <span className="tab-icon"><Icon name={icon} />{badge ? <span className="nav-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span> : null}</span>
      <span className="tab-label">{label}</span>
    </button>{badge ? <span id={id} className="sr-only">{badgeLabel}</span> : null}</>;
  };
  return <nav className="mobile-tabs" aria-label={t('nav.primary')}>
    {tab('inbox', t('nav.inbox'), !showSkills && activeTab === 'inbox', () => app.goTo('inbox'), unread, t('nav.unread', { n: unread }))}
    {tab('user', t('nav.myWork'), !showSkills && activeTab === 'tasks' && activeView === 'my-work', () => app.goTo('my-work'))}
    {tab('proposal', t('nav.proposals'), !showSkills && activeTab === 'proposal', () => app.goTo('proposal'), proposals, t('nav.pending', { n: proposals }))}
    {tab('search', t('nav.search'), false, () => app.openPalette(), undefined, undefined, { 'aria-label': t('nav.searchTab') })}
    {tab('menu', t('nav.menu'), app.moreOpen, () => app.openMenu())}
  </nav>;
}

export function Topbar({ app }: { app: App }) {
  useLocale();
  const theme = useTheme();
  const { workspace, activeTab, activeView, showSkills, viewMode, teams, selectedTeam, taskLists, selectedListId, projects, projectFilter, viewTasks } = app;
  if (!workspace) return null;
  const onTasks = !showSkills && activeTab === 'tasks';
  const title = showSkills ? t('screen.skills')
    : activeTab === 'inbox' ? t('screen.inbox')
    : activeTab === 'proposal' ? t('screen.proposals')
    : activeTab === 'blockers' ? t('screen.blockers')
    : activeTab === 'overview' ? t('screen.overview')
    : activeTab === 'milestones' ? t('screen.milestones')
    : activeTab === 'knowledge' ? t('screen.knowledge')
    : activeTab === 'settings' ? t('screen.settings')
    : activeView === 'my-work' ? t('screen.myWork')
    : activeView === 'team-queue' ? t('screen.teamQueue', { name: teams.find((team) => team.id === selectedTeam)?.name ?? t('nav.teams') })
    : activeView === 'list' ? taskLists.find((list) => list.id === selectedListId)?.name ?? t('screen.list')
    : projectFilter ? projects.find((project) => project.id === projectFilter)?.name ?? t('screen.tasks')
    : t('screen.tasks');
  const views: { mode: 'table' | 'kanban' | 'calendar' | 'timeline'; icon: IconName; label: string }[] = [
    { mode: 'table', icon: 'table', label: t('view.table') },
    { mode: 'kanban', icon: 'kanban', label: t('view.kanban') },
    { mode: 'calendar', icon: 'calendar', label: t('view.calendar') },
    { mode: 'timeline', icon: 'timeline', label: t('view.timeline') },
  ];
  const current = views.find((view) => view.mode === viewMode) ?? views[0];
  return <header className="topbar">
    <div className="topbar-title"><h1>{title}</h1>{onTasks && <span className="count">{t('tasks.count', { n: viewTasks.length })}</span>}</div>
    <div className="topbar-actions">
      {onTasks && <>
        <div className="segmented view-switch" role="group" aria-label={t('view.label')}>
          {views.map((view) => <button key={view.mode} type="button" aria-pressed={viewMode === view.mode} onClick={() => app.setViewMode(view.mode)}><Icon name={view.icon} small /><span>{view.label}</span></button>)}
        </div>
        <div className="view-dropdown">
          <MenuButton label={t('view.label')} ariaLabel={`${t('view.label')}: ${current.label}`} icon={current.icon} className="secondary">
            {views.map((view) => <MenuItem key={view.mode} icon={view.icon} checked={viewMode === view.mode} onSelect={() => app.setViewMode(view.mode)}>{view.label}</MenuItem>)}
          </MenuButton>
        </div>
      </>}
      <button type="button" className="secondary palette-trigger" aria-label={t('topbar.openPalette')} onClick={() => app.openPalette()}><Icon name="search" /><span className="desktop-label">{t('topbar.search')}</span><kbd className="desktop-label">⌘K</kbd></button>
      <button type="button" className="new-task" aria-label={t('topbar.newTask')} onClick={() => app.openNewTask()}><Icon name="plus" /><span className="desktop-label">{t('topbar.newTask')}</span></button>
      <div className="topbar-prefs">
        <LocaleSwitch />
        <button type="button" className="ghost icon-button" aria-label={t('theme.toggle')} onClick={() => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark')}><Icon name={theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'sun' : 'moon'} /></button>
      </div>
    </div>
  </header>;
}

export function MenuDialog({ app }: { app: App }) {
  useLocale();
  const { workspace } = app;
  if (!workspace) return null;
  const item = (icon: IconName, label: string, onClick: () => void, extra?: string) => <button type="button" className={`secondary menu-row ${extra ?? ''}`} onClick={onClick}><Icon name={icon} /><span>{label}</span></button>;
  return <Dialog label={t('menu.title')} onClose={() => app.closeMenu()} className="menu-sheet">
    <div className="menu-group mobile-only">
      {item('tasks', t('nav.allTasks'), () => app.goTo('all'))}
      {item('flag', t('nav.blockers'), () => app.goTo('blockers'))}
      {item('layout', t('nav.overview'), () => app.goTo('overview'))}
      {item('clock', t('nav.milestones'), () => app.goTo('milestones'))}
      {item('book', t('nav.knowledge'), () => app.goTo('knowledge'))}
      {item('folder', t('nav.projects'), () => { app.closeMenu(); app.setProjectDialogOpen(false); app.goTo('all'); })}
    </div>
    <div className="menu-group">
      {item('bolt', t('menu.skills'), () => app.goTo('skills'))}
      {item('settings', t('menu.settings'), () => app.goTo('settings'))}
      {item('template', t('menu.templates'), () => { app.closeMenu(); app.openTemplates(true); })}
      {item('keyboard', t('menu.shortcuts'), () => { app.closeMenu(); app.openShortcutHelp(true); })}
    </div>
    <div className="menu-prefs">
      <div className="field"><span className="muted">{t('lang.label')}</span><LocaleSwitch /></div>
      <div className="field"><span className="muted">{t('theme.label')}</span><ThemeSwitch /></div>
    </div>
    <div className="menu-group">{item('logout', t('menu.signOut'), () => void app.signOut(), 'danger')}</div>
  </Dialog>;
}
