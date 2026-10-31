import { api } from './api';
import type { App } from './app-state';
import { Icon } from './ui/icons';
import { EmptyState } from './ui/primitives';
import { enumLabel, t, useLocale } from './i18n';

export function InboxScreen({ app }: { app: App }) {
  useLocale();
  const { workspace, inboxEntries, tasks, statuses } = app;
  if (!workspace) return null;
  return <section className="screen inbox-screen" aria-label="Inbox">
    <div className="screen-toolbar"><p className="muted">{t('inbox.intro')}</p><button type="button" className="secondary btn-sm" onClick={() => void app.refresh(workspace.id)}>{t('common.refresh')}</button></div>
    {inboxEntries.length === 0 ? <EmptyState title={t('inbox.clear')}>{t('inbox.clearHint')}</EmptyState> : <ul className="inbox-list">{inboxEntries.map((entry) => {
      const status = statuses.find((item) => item.key === entry.task.status)?.name ?? enumLabel('status', entry.task.status);
      return <li key={entry.id} className={entry.read ? 'inbox-read' : 'inbox-unread'}>
        <span className="inbox-marker" aria-hidden="true">{!entry.read && <span className="dot" />}</span>
        <div className="inbox-main"><div><strong>{entry.task.title}</strong> <span className="number">#{entry.task.number}</span></div><p>{entry.reasons.map((reason) => enumLabel('reason', reason)).join(', ')} · {status}{entry.unread_count ? ` · ${t('inbox.unreadCount', { n: entry.unread_count })}` : ` · ${t('inbox.read')}`}</p></div>
        <div className="actions inbox-actions">
          <button type="button" className="secondary btn-sm" onClick={() => { const item = tasks.find((candidate) => candidate.id === entry.task.id); if (item) app.openPanel(item); else void app.loadTask(workspace.id, entry.task.number); }}><Icon name="chevron-right" small />Open Task #{entry.task.number}</button>
          {!entry.read && <button type="button" className="ghost btn-sm" onClick={async () => { try { await api(`/inbox/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ read: true }) }); app.setInboxEntries((items) => items.map((item) => item.id === entry.id ? { ...item, read: true, unread_count: 0 } : item)); } catch (reason) { app.setError(reason instanceof Error ? reason.message : t('err.inboxRead')); } }}>{t('inbox.markRead')}</button>}
          <button type="button" className="ghost btn-sm" onClick={async () => { try { await api(`/inbox/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ dismissed: true }) }); app.setInboxEntries((items) => items.filter((item) => item.id !== entry.id)); } catch (reason) { app.setError(reason instanceof Error ? reason.message : t('err.inboxDismiss')); } }}>{t('inbox.dismiss')}</button>
          <button type="button" className="ghost btn-sm" onClick={async () => { try { await api(`/tasks/${entry.task.id}/watch`, { method: 'PUT', body: JSON.stringify({ events: [], muted: true }) }); app.setInboxEntries((items) => items.filter((item) => item.task.id !== entry.task.id)); } catch (reason) { app.setError(reason instanceof Error ? reason.message : t('err.inboxMute')); } }}>{t('inbox.muteTask')}</button>
        </div>
      </li>;
    })}</ul>}
  </section>;
}
