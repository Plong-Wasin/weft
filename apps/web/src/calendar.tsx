import React from 'react';

// Dates here are calendar dates ("YYYY-MM-DD") with no time zone. All arithmetic goes through
// UTC so the browser's own zone never shifts a day; "today" and the week start come from the
// Workspace settings, not from the browser.

export type CalendarTask = { id: string; number: number; title: string; status: string; start_date: string | null; due_date: string | null; version: number };
export type CalendarSettings = { today: string; week_start: number; time_zone: string };
export type DateKind = 'start' | 'due';
type Entry = { task: CalendarTask; kind: DateKind; date: string };
type Range = 'month' | 'week';
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type DateConflict = { task: CalendarTask; kind: DateKind; wanted: string; current: CalendarTask };

const DAY = 86_400_000;
const parse = (date: string) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const format = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => format(parse(date) + days * DAY);
export function addMonths(date: string, months: number) {
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1 + months, 1);
  const last = new Date(Date.UTC(new Date(target).getUTCFullYear(), new Date(target).getUTCMonth() + 1, 0)).getUTCDate();
  return format(target + (Math.min(d, last) - 1) * DAY);
}
export const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && format(parse(value)) === value;
const weekday = (date: string) => new Date(parse(date)).getUTCDay();
export function startOfWeek(date: string, weekStart: number) { return addDays(date, -((weekday(date) - weekStart + 7) % 7)); }

/** The days on screen: the weeks that touch the cursor's month, or the cursor's week. */
export function visibleDays(cursor: string, range: Range, weekStart: number): string[] {
  if (range === 'week') { const first = startOfWeek(cursor, weekStart); return Array.from({ length: 7 }, (_, i) => addDays(first, i)); }
  const monthStart = `${cursor.slice(0, 7)}-01`;
  const first = startOfWeek(monthStart, weekStart);
  const monthEnd = addDays(addMonths(monthStart, 1), -1);
  const weeks = Math.ceil((parse(monthEnd) - parse(first) + DAY) / DAY / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));
}

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const rangeTitle = (cursor: string, range: Range, days: string[]) => range === 'month'
  ? `${monthNames[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(0, 4)}`
  : `Week of ${days[0]} to ${days[6]}`;

export function entriesByDate(tasks: CalendarTask[]) {
  const map = new Map<string, Entry[]>();
  for (const task of tasks) {
    for (const kind of ['start', 'due'] as const) {
      const date = kind === 'start' ? task.start_date : task.due_date;
      if (date) map.set(date, [...(map.get(date) ?? []), { task, kind, date }]);
    }
  }
  return map;
}

export type Calendar = ReturnType<typeof useCalendar>;

export function useCalendar({ workspaceId, api, tasks, onUpdated, onError, showView }: {
  workspaceId: string | undefined;
  api: Api;
  tasks: CalendarTask[];
  onUpdated: (task: CalendarTask) => void;
  onError: (message: string) => void;
  showView: () => void;
}) {
  const [settings, setSettings] = React.useState<CalendarSettings | null>(null);
  const [cursor, setCursor] = React.useState('');
  const [range, setRange] = React.useState<Range>('month');
  const [focused, setFocused] = React.useState<{ taskId: string; kind: DateKind } | null>(null);
  const [conflict, setConflict] = React.useState<DateConflict | null>(null);
  const [message, setMessage] = React.useState('');
  const [canUndo, setCanUndo] = React.useState(false);
  const pendingFocus = React.useRef<string | null>(null);

  React.useEffect(() => {
    setSettings(null); setCursor(''); setConflict(null); setMessage(''); setCanUndo(false);
    if (!workspaceId) return;
    let active = true;
    api<CalendarSettings>(`/workspaces/${workspaceId}/settings`)
      .then((value) => { if (active) { setSettings(value); setCursor(value.today); } })
      .catch((reason) => { if (active) onError(reason instanceof Error ? reason.message : 'Could not load Calendar settings.'); });
    return () => { active = false; };
  }, [workspaceId]);

  const weekStart = settings?.week_start ?? 1;
  const days = React.useMemo(() => (cursor ? visibleDays(cursor, range, weekStart) : []), [cursor, range, weekStart]);
  const byDate = React.useMemo(() => entriesByDate(tasks), [tasks]);

  function select(date: string) { if (isDate(date)) setCursor(date); }
  function step(direction: 1 | -1) { if (cursor) setCursor(range === 'month' ? addMonths(cursor, direction) : addDays(cursor, 7 * direction)); }
  function goToday() { if (settings) setCursor(settings.today); }

  /** One version-checked Task update; a conflict keeps the wanted date as a draft. */
  async function move(task: CalendarTask, kind: DateKind, date: string) {
    if (!workspaceId || !isDate(date)) return;
    const field = kind === 'start' ? 'start_date' : 'due_date';
    if (task[field] === date) return;
    try {
      const updated = await api<CalendarTask>(`/workspaces/${workspaceId}/tasks/${task.number}`, { method: 'PATCH', body: JSON.stringify({ expected_version: task.version, [field]: date }) });
      onUpdated(updated); setConflict(null); setCanUndo(true); setCursor(date);
      pendingFocus.current = `${task.id}:${kind}`;
      setMessage(`Moved Task #${task.number} ${kind} date to ${date}. Undo is available.`);
    } catch (reason) {
      const failure = reason as Error & { status?: number; body?: { current?: CalendarTask } };
      if (failure.status === 409 && failure.body?.current) {
        const current = failure.body.current;
        setConflict({ task, kind, wanted: date, current });
        setMessage(`Task #${task.number} changed on the server; its ${kind} date is now ${current[field] ?? 'empty'}. Your date ${date} was not applied.`);
      } else onError(failure.message);
    }
  }
  const shift = (task: CalendarTask, kind: DateKind, days: number) => {
    const from = kind === 'start' ? task.start_date : task.due_date;
    if (from) void move(task, kind, addDays(from, days));
  };
  async function retryConflict() { if (conflict) await move(conflict.current, conflict.kind, conflict.wanted); }

  const focusedEntry = (): Entry | null => {
    const pick = (taskId: string, kind: DateKind) => { const task = tasks.find((item) => item.id === taskId); const date = task && (kind === 'start' ? task.start_date : task.due_date); return task && date ? { task, kind, date } : null; };
    return (focused && pick(focused.taskId, focused.kind)) ?? byDate.get(cursor)?.[0] ?? null;
  };

  return { settings, cursor, range, days, byDate, focused, conflict, message, canUndo, pendingFocus, weekStart,
    setRange, setFocused, setConflict, setMessage, setCanUndo, select, step, goToday, move, shift, retryConflict, focusedEntry, showView, tasks };
}

/** Palette commands: "calendar today|next|previous|week|month|goto DATE|move due|start DATE|open|undo". */
export function calendarCommands(query: string, cal: Calendar, open: (task: CalendarTask) => void, undo: () => Promise<void>) {
  const text = query.trim().toLowerCase();
  if (!/^cal(e(n(d(a(r)?)?)?)?)?\b/.test(text)) return [];
  const rest = text.replace(/^calendar\s*|^cal\s*/, '');
  const all: { id: string; label: string; detail: string; run: () => void | Promise<void> }[] = [
    { id: 'open', label: 'Calendar: show', detail: 'Switch the Task list to the Calendar', run: () => cal.showView() },
    { id: 'today', label: 'Calendar: go to today', detail: cal.settings?.today ?? '', run: () => { cal.showView(); cal.goToday(); } },
    { id: 'next', label: 'Calendar: next range', detail: 'Next month or week', run: () => { cal.showView(); cal.step(1); } },
    { id: 'previous', label: 'Calendar: previous range', detail: 'Previous month or week', run: () => { cal.showView(); cal.step(-1); } },
    { id: 'week', label: 'Calendar: week range', detail: 'Show one week', run: () => { cal.showView(); cal.setRange('week'); } },
    { id: 'month', label: 'Calendar: month range', detail: 'Show a month', run: () => { cal.showView(); cal.setRange('month'); } },
    { id: 'undo', label: 'Calendar: undo last change', detail: 'Undo the last Workspace change', run: undo },
  ];
  const goto = rest.match(/^(?:goto|go to|day)\s+(\d{4}-\d{2}-\d{2})$/);
  if (goto && isDate(goto[1])) all.push({ id: 'goto', label: `Calendar: go to ${goto[1]}`, detail: 'Pick that day', run: () => { cal.showView(); cal.select(goto[1]); } });
  const move = rest.match(/^move\s+(start|due)\s+(\d{4}-\d{2}-\d{2})$/);
  const entry = cal.focusedEntry();
  if (move && isDate(move[2])) {
    all.push(entry
      ? { id: 'move', label: `Calendar: set Task #${entry.task.number} ${move[1]} date to ${move[2]}`, detail: entry.task.title, run: () => cal.move(entry.task, move[1] as DateKind, move[2]) }
      : { id: 'move', label: 'Calendar: focus a Task first', detail: 'Choose a day with a Task, then run this again', run: () => cal.showView() });
  }
  if (entry) all.push({ id: 'open-task', label: `Calendar: open Task #${entry.task.number}`, detail: entry.task.title, run: () => open(entry.task) });
  return all.filter((item) => !rest || item.id === 'goto' || item.id === 'move' || item.label.toLowerCase().includes(rest) || item.id.startsWith(rest.split(' ')[0]));
}

function usePhone() {
  const query = '(max-width: 640px)';
  const [phone, setPhone] = React.useState(() => window.matchMedia(query).matches);
  React.useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setPhone(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return phone;
}

export function CalendarView({ cal, onOpen, onUndo }: { cal: Calendar; onOpen: (task: CalendarTask) => void; onUndo: () => Promise<void> }) {
  const phone = usePhone();
  const gridRef = React.useRef<HTMLDivElement>(null);
  const cellFocus = React.useRef(false);
  const { settings, cursor, range, days, byDate } = cal;

  React.useEffect(() => {
    const key = cal.pendingFocus.current;
    if (!key) return;
    const target = document.querySelector<HTMLElement>(`[data-entry="${key}"]`);
    if (target) { target.focus(); cal.pendingFocus.current = null; }
  });
  React.useEffect(() => {
    if (cellFocus.current) { gridRef.current?.querySelector<HTMLElement>(`[data-day="${cursor}"]`)?.focus(); cellFocus.current = false; }
  }, [cursor]);

  if (!settings || !cursor) return <p className="muted" role="status">Loading Calendar…</p>;

  const names = Array.from({ length: 7 }, (_, i) => dayNames[(cal.weekStart + i) % 7]);
  const title = rangeTitle(cursor, range, days);
  const inMonth = (day: string) => range === 'week' || day.slice(0, 7) === cursor.slice(0, 7);

  function cellKey(event: React.KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(cursor, -1), ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7), ArrowDown: () => addDays(cursor, 7),
      PageUp: () => (range === 'month' ? addMonths(cursor, -1) : addDays(cursor, -7)),
      PageDown: () => (range === 'month' ? addMonths(cursor, 1) : addDays(cursor, 7)),
      Home: () => startOfWeek(cursor, cal.weekStart), End: () => addDays(startOfWeek(cursor, cal.weekStart), 6),
    };
    if (event.key === 't' || event.key === 'T') { event.preventDefault(); cellFocus.current = true; cal.goToday(); return; }
    if (event.key === 'Enter') { const first = byDate.get(cursor)?.[0]; if (first) { event.preventDefault(); document.querySelector<HTMLElement>(`[data-entry="${first.task.id}:${first.kind}"]`)?.focus(); } return; }
    const next = moves[event.key]?.();
    if (next) { event.preventDefault(); cellFocus.current = true; cal.select(next); }
  }

  function entryKey(event: React.KeyboardEvent<HTMLElement>, entry: Entry) {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && step[event.key]) { event.preventDefault(); cal.shift(entry.task, entry.kind, step[event.key]); }
    else if (event.key === 'Escape' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); cellFocus.current = true; cal.select(entry.date); gridRef.current?.querySelector<HTMLElement>(`[data-day="${entry.date}"]`)?.focus(); }
  }

  const entryLabel = (entry: Entry) => `Task #${entry.task.number} ${entry.task.title}, ${entry.kind} ${entry.date}`;

  return <div className="calendar" aria-label="Calendar">
    <div className="calendar-toolbar">
      <h3 aria-live="polite">{title}</h3>
      <div className="calendar-controls">
        <button type="button" className="secondary" onClick={() => cal.step(-1)}>Previous {range}</button>
        <button type="button" className="secondary" onClick={cal.goToday}>Today</button>
        <button type="button" className="secondary" onClick={() => cal.step(1)}>Next {range}</button>
        <button type="button" className={range === 'month' ? 'selected' : 'secondary'} aria-pressed={range === 'month'} onClick={() => cal.setRange('month')}>Month</button>
        <button type="button" className={range === 'week' ? 'selected' : 'secondary'} aria-pressed={range === 'week'} onClick={() => cal.setRange('week')}>Week</button>
        <label>Go to date<input type="date" aria-label="Go to date" value={cursor} onChange={(event) => cal.select(event.target.value)} /></label>
      </div>
    </div>
    <p className="muted" id="calendar-help">Arrow keys choose a day, Page Up and Page Down change the range, T is today. On a Task: Enter opens it, Shift+Arrow moves its date by a day or a week, Escape returns to the day. Ctrl+Z undoes. Palette: “calendar …”.</p>
    <p role="status" className="calendar-status">{cal.message}{cal.canUndo && !cal.conflict && <> <button type="button" className="link-button" onClick={() => void onUndo().then(() => { cal.setCanUndo(false); cal.setMessage('Change undone.'); })}>Undo</button></>}</p>
    {cal.conflict && <div className="conflict" role="alert"><strong>Task #{cal.conflict.task.number} changed on the server.</strong><p>Current {cal.conflict.kind} date: {(cal.conflict.kind === 'start' ? cal.conflict.current.start_date : cal.conflict.current.due_date) ?? 'none'}. Your date {cal.conflict.wanted} is kept here.</p><button type="button" onClick={() => void cal.retryConflict()}>Apply {cal.conflict.wanted} to the current Task</button> <button type="button" className="secondary" onClick={() => { cal.setConflict(null); cal.setMessage(''); }}>Discard my date</button></div>}
    {phone ? <section className="calendar-agenda" aria-label="Calendar agenda">
      {days.filter((day) => inMonth(day) && byDate.has(day)).length === 0 && <p className="muted">No Task dates in this range.</p>}
      <ul>{days.filter((day) => inMonth(day) && byDate.has(day)).map((day) => <li key={day} className={day === settings.today ? 'today' : ''}>
        <h4>{day}{day === settings.today ? ' · Today' : ''}</h4>
        <ul>{byDate.get(day)!.map((entry) => <li key={`${entry.task.id}:${entry.kind}`} className="agenda-entry">
          <button type="button" className="secondary" data-entry={`${entry.task.id}:${entry.kind}`} onFocus={() => cal.setFocused({ taskId: entry.task.id, kind: entry.kind })} onClick={() => onOpen(entry.task)}><span className="number">#{entry.task.number}</span> {entry.task.title} <span className="muted">· {entry.kind === 'start' ? 'Starts' : 'Due'}</span></button>
          <label>{entry.kind === 'start' ? 'Start date' : 'Due date'} of Task #{entry.task.number}<input type="date" value={entry.date} onChange={(event) => void cal.move(entry.task, entry.kind, event.target.value)} /></label>
        </li>)}</ul>
      </li>)}</ul>
    </section> : <div className="calendar-scroll"><div role="grid" ref={gridRef} aria-label={`Calendar ${title}`} aria-describedby="calendar-help" className="calendar-grid">
      <div role="row" className="calendar-row calendar-head">{names.map((name) => <span role="columnheader" key={name}>{name.slice(0, 3)}</span>)}</div>
      {Array.from({ length: days.length / 7 }, (_, week) => <div role="row" className="calendar-row" key={week}>{days.slice(week * 7, week * 7 + 7).map((day) => {
        const entries = byDate.get(day) ?? [];
        return <div role="gridcell" key={day} data-day={day} tabIndex={day === cursor ? 0 : -1} aria-selected={day === cursor} aria-label={`${day}${day === settings.today ? ', today' : ''}, ${entries.length} Task dates`} className={`calendar-cell${inMonth(day) ? '' : ' outside'}${day === settings.today ? ' today' : ''}${day === cursor ? ' chosen' : ''}`} onClick={(event) => { if (event.target === event.currentTarget) cal.select(day); }} onKeyDown={cellKey}>
          <span className="calendar-date" aria-hidden="true">{Number(day.slice(8))}</span>
          {entries.map((entry) => <button type="button" key={`${entry.task.id}:${entry.kind}`} data-entry={`${entry.task.id}:${entry.kind}`} className={`calendar-entry ${entry.kind}`} aria-label={entryLabel(entry)} tabIndex={day === cursor ? 0 : -1} onFocus={() => { cal.setFocused({ taskId: entry.task.id, kind: entry.kind }); }} onClick={() => onOpen(entry.task)} onKeyDown={(event) => entryKey(event, entry)}><span aria-hidden="true">{entry.kind === 'start' ? '▶' : '◼'} #{entry.task.number} {entry.task.title}</span></button>)}
        </div>;
      })}</div>)}
    </div></div>}
  </div>;
}
