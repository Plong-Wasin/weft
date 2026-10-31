import React from 'react';
import type { ApiFn } from './generate';

// The Blocker view: open Tasks that wait on open Tasks. The server reads every Task with the
// viewer's own access, so a blocker the viewer cannot read arrives as one neutral placeholder.

type BlockerTask = { id: string; number: number; title: string; project_id: string; status: string };
type Blocker = BlockerTask | { unreadable: true };
export type BlockedEntry = { task: BlockerTask & { due_date: string | null }; blockers: Blocker[] };

export function BlockerView({ api, workspaceId, liveTick, onOpenTask }: { api: ApiFn; workspaceId: string; liveTick: number; onOpenTask: (number: number, id: string) => void }) {
  const [entries, setEntries] = React.useState<BlockedEntry[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const listRef = React.useRef<HTMLUListElement>(null);
  const load = React.useCallback(() => {
    let current = true;
    api<{ blocked: BlockedEntry[] }>(`/workspaces/${workspaceId}/blockers`)
      .then((result) => { if (current) { setEntries(result.blocked); setFailed(false); } })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [api, workspaceId]);
  // Reload on mount and on every realtime hint; a stale response never overwrites a newer one.
  React.useEffect(() => load(), [load, liveTick]);
  // Arrow keys walk the Task buttons so the whole view is reachable without Tab spam.
  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-blocker-open]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };
  return <section className="task-list blocker-screen" aria-label="Blockers">
    <div className="table-heading"><div><h2>Blockers</h2><p className="muted">Open Tasks that are waiting on other open Tasks. Arrow keys move between Tasks.</p></div><button type="button" className="secondary" onClick={() => load()}>Refresh</button></div>
    {failed && <p className="notice" role="alert">Could not load the Blocker view.</p>}
    {entries === null ? <p className="muted" role="status">Loading blockers…</p> : entries.length === 0 ? <p className="muted" role="status">Nothing is blocked.</p> : <ul className="blocker-list" ref={listRef} onKeyDown={onKeyDown}>{entries.map((entry) => <li key={entry.task.id} aria-label={`Blocked Task ${entry.task.number}`}>
      <div><button type="button" data-blocker-open onClick={() => onOpenTask(entry.task.number, entry.task.id)}>Open Task #{entry.task.number} {entry.task.title}</button> <span className="muted">{entry.task.status}{entry.task.due_date ? ` · due ${entry.task.due_date}` : ''}</span></div>
      <ul className="blocker-by" aria-label={`Blocked by for Task ${entry.task.number}`}>{entry.blockers.map((blocker, index) => 'unreadable' in blocker
        ? <li key={`hidden-${index}`} className="muted">Blocked by a Task you cannot read</li>
        : <li key={blocker.id}><button type="button" className="secondary" data-blocker-open onClick={() => onOpenTask(blocker.number, blocker.id)}>Blocked by #{blocker.number} {blocker.title}</button> <span className="muted">{blocker.status}</span></li>)}</ul>
    </li>)}</ul>}
  </section>;
}
