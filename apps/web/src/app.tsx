import React from 'react';
import { BlockerView } from './blockers';
import { ProjectOverview } from './project-overview';
import { MilestonePanel } from './milestones';
import { TemplatesDialog } from './templates';
import { GenerateDialog } from './generate';
import { api } from './api';
import { useAppState } from './app-state';
import { SignInScreen, WorkspacePicker } from './auth-screens';
import { MenuDialog, MobileTabs, Sidebar, Topbar } from './shell';
import { TasksScreen } from './tasks-screen';
import { TaskDetail } from './task-detail';
import { Palette } from './palette';
import { InboxScreen } from './inbox';
import { KnowledgeScreen } from './knowledge';
import { SkillsScreen } from './skills';
import { ProposalScreen } from './proposal-screen';
import { SettingsScreen } from './settings';
import { NewAttributeDialog, NewListDialog, NewTaskDialog, ProjectDialog, ShortcutHelpDialog, TeamsDialog } from './dialogs';
import { EmptyState, ToastRegion } from './ui/primitives';
import { t, useLocale } from './i18n';

export function App() {
  useLocale();
  const app = useAppState();
  const { workspace, signedIn, needsWorkspaceChoice, task, draft, showSkills, activeTab, projects } = app;
  // A short reconnect after load is normal; only a lasting gap is worth a banner.
  const reconnecting = !app.offline && signedIn && !app.realtimeConnected;
  const [lateReconnect, setLateReconnect] = React.useState(false);
  React.useEffect(() => {
    if (!reconnecting) { setLateReconnect(false); return; }
    const timer = window.setTimeout(() => setLateReconnect(true), 4000);
    return () => window.clearTimeout(timer);
  }, [reconnecting]);
  if (!signedIn) return <SignInScreen app={app} />;
  if (needsWorkspaceChoice || !workspace) return <WorkspacePicker app={app} />;

  const openTask = (number: number, id: string) => { const item = app.tasks.find((candidate) => candidate.id === id); if (item) app.openPanel(item); else void app.loadTask(workspace.id, number); };
  const milestoneProject = projects.find((item) => item.id === app.selectedProject) ?? projects[0];
  const panelOpen = Boolean(task && draft && !showSkills);

  let screen: React.ReactNode;
  if (showSkills) screen = <SkillsScreen app={app} />;
  else if (activeTab === 'settings') screen = <SettingsScreen projectsReady={app.projectsLoadedFor === workspace.id} key={app.settingsSection?.nonce ?? 'default'} initialSection={app.settingsSection?.section} scheduleAdmin={app.scheduleAdmin} onOpenProposal={(id) => void app.openProposalById(id)} workspace={workspace} projects={projects} selectedProject={app.selectedProject} onSignOut={() => void app.signOut()} onRefresh={() => app.refresh(workspace.id)} />;
  else if (activeTab === 'inbox') screen = <InboxScreen app={app} />;
  else if (activeTab === 'proposal') screen = <ProposalScreen app={app} />;
  else if (activeTab === 'blockers') screen = <BlockerView api={api} workspaceId={workspace.id} liveTick={app.liveTick} onOpenTask={openTask} />;
  else if (activeTab === 'overview') screen = <ProjectOverview api={api} workspaceId={workspace.id} projects={projects} liveTick={app.liveTick} onOpenTask={openTask} />;
  else if (activeTab === 'knowledge') screen = <KnowledgeScreen app={app} />;
  else if (activeTab === 'milestones') screen = <section className="screen milestones-screen" aria-label={t('screen.milestones')}>
    {projects.length > 1 && <label className="field project-pick">{t('dlg.project')}<select aria-label="Project" value={milestoneProject?.id ?? ''} onChange={(event) => app.setSelectedProject(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
    {milestoneProject ? <MilestonePanel api={api} project={milestoneProject.id} projectName={milestoneProject.name} epoch={app.milestoneEpoch} onPlan={app.aiAvailability.status === 'ready' ? () => app.openGenerate('', 'plan') : undefined} onReview={app.aiAvailability.status === 'ready' ? () => app.openGenerate(`Review the progress of Project "${milestoneProject.name}": overdue Tasks, blocked chains, Tasks without an Assignee, and empty or late Milestones. Give each risk a reason and the Sources you read, and say when anything was truncated.`, 'progress_review') : undefined} onChanged={() => { app.setMilestoneEpoch((value) => value + 1); void app.refresh(workspace.id); }} /> : <EmptyState title={t('milestones.noProject')}>{t('milestones.noProjectHint')}</EmptyState>}
  </section>;
  else screen = <TasksScreen app={app} />;

  return <div className={`app ${panelOpen ? 'has-panel' : ''} ${panelOpen && app.fullPage ? 'panel-full' : ''}`} data-keyboard-mode={app.keyboardMode}>
    <a className="skip-link" href="#main">{t('nav.skip')}</a>
    <Sidebar app={app} />
    <div className="app-main">
      <Topbar app={app} />
      {app.offline && <p className="banner warning" role="status">{t('banner.offline')}</p>}
      {reconnecting && lateReconnect && <p className="banner warning" role="status">{t('banner.reconnecting')}</p>}
      {app.error && <div className="notice error-notice" role="alert"><span>{app.error}</span><button type="button" className="ghost icon-button btn-sm" aria-label={t('common.dismissMessage')} onClick={() => app.setError('')}>×</button></div>}
      <div className="main-split">
        <main id="main" className="main-screen" tabIndex={-1}>{screen}</main>
        {panelOpen && <TaskDetail app={app} />}
      </div>
    </div>
    <MobileTabs app={app} />
    {app.generateOpen && app.aiAvailability.status === 'ready' && <GenerateDialog capability={app.generateCapability} focusTask={app.generateFocus} api={api} workspaceId={workspace.id} connection={app.aiAvailability.connection} projects={projects} vaults={app.vaults} selectedTaskIds={app.generateFocus ? [app.generateFocus.id] : app.selectedTaskIds} defaultProjectId={app.generateFocus?.project_id ?? app.selectedProject} initialGoal={app.generateGoal} onClose={app.closeGenerate} onDone={(id, context) => void app.finishGeneration(id, context)} />}
    {app.paletteOpen && <Palette app={app} />}
    {app.templatesOpen && <TemplatesDialog workspaceId={workspace.id} isAdmin={['owner', 'admin'].includes(workspace.role)} projects={projects} statuses={app.statuses} api={api} onClose={() => { app.setTemplatesOpen(false); app.restoreFocus(); }} onChanged={() => app.refresh(workspace.id)} onUndo={async () => { await api(`/workspaces/${workspace.id}/history/undo`, { method: 'POST', body: '{}' }); await app.refresh(workspace.id); }} />}
    {app.moreOpen && <MenuDialog app={app} />}
    {app.newTaskOpen && <NewTaskDialog app={app} />}
    {app.attributeDialogOpen && <NewAttributeDialog app={app} />}
    {app.newListOpen && <NewListDialog app={app} />}
    {app.projectDialogOpen && <ProjectDialog app={app} />}
    {app.teamsOpen && <TeamsDialog app={app} />}
    {app.shortcutHelpOpen && <ShortcutHelpDialog app={app} />}
    {app.proposalApplying && <div className="overlay-backdrop"><section className="dialog proposal-lock-sheet" role="dialog" aria-modal="true" aria-label="Applying Proposal"><div className="dialog-body"><h2>Applying Proposal</h2><p>We’re briefly locking this Proposal while its selected changes are applied together.</p></div></section></div>}
    <div className="sr-only" aria-live="polite" aria-atomic="true" id="live-announcer">{app.announcement}</div>
    <ToastRegion />
  </div>;
}
