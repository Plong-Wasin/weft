import React from 'react';

export type Recurrence = { frequency: 'daily' | 'weekly' | 'monthly'; weekdays: number[]; month_day: number | null; last_day_of_month: boolean };
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type RepeatTask = { id: string; version: number; start_date: string | null; due_date: string | null; recurrence?: Recurrence | null };

const weekdayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function describeRecurrence(rule: Recurrence | null | undefined): string {
  if (!rule) return 'Does not repeat';
  if (rule.frequency === 'daily') return 'Repeats every day';
  if (rule.frequency === 'weekly') return `Repeats every ${rule.weekdays.map((day) => weekdayNames[day - 1]).join(', ')}`;
  return rule.last_day_of_month ? 'Repeats on the last day of every month' : `Repeats on day ${rule.month_day} of every month`;
}

// The rule lives on the Task; completing the Task creates the next occurrence on the server in the
// same Operation. Every control here is a plain form field, so the section needs no pointer.
export function RecurrenceSection({ api, task, onChange, onError }: { api: Api; task: RepeatTask; onChange: (updated: RepeatTask) => void; onError: (reason: unknown, fallback: string) => void }) {
  const rule = task.recurrence ?? null;
  const [frequency, setFrequency] = React.useState<string>(rule?.frequency ?? '');
  const [weekdays, setWeekdays] = React.useState<number[]>(rule?.weekdays ?? []);
  const [monthDay, setMonthDay] = React.useState<string>(rule?.last_day_of_month ? 'last' : String(rule?.month_day ?? 1));
  React.useEffect(() => {
    setFrequency(rule?.frequency ?? '');
    setWeekdays(rule?.weekdays ?? []);
    setMonthDay(rule?.last_day_of_month ? 'last' : String(rule?.month_day ?? 1));
  }, [task.id, task.version, rule?.frequency, rule?.last_day_of_month, rule?.month_day, rule?.weekdays?.join(',')]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!frequency) return;
    const body: Record<string, unknown> = { frequency, expected_version: task.version };
    if (frequency === 'weekly') body.weekdays = weekdays;
    if (frequency === 'monthly') { if (monthDay === 'last') body.last_day_of_month = true; else body.month_day = Number(monthDay); }
    try { onChange(await api<RepeatTask>(`/tasks/${task.id}/recurrence`, { method: 'PUT', body: JSON.stringify(body) })); }
    catch (reason) { onError(reason, 'Could not save the repeat rule.'); }
  }
  async function stop() {
    try { onChange(await api<RepeatTask>(`/tasks/${task.id}/recurrence?expected_version=${task.version}`, { method: 'DELETE' })); }
    catch (reason) { onError(reason, 'Could not stop repeating.'); }
  }
  async function skip() {
    try { onChange(await api<RepeatTask>(`/tasks/${task.id}/recurrence/skip`, { method: 'POST', body: JSON.stringify({ expected_version: task.version }) })); }
    catch (reason) { onError(reason, 'Could not skip this occurrence.'); }
  }

  return <section className="task-recurrence" aria-label="Repeat">
    <h3>Repeat</h3>
    <p className="muted" role="status">{describeRecurrence(rule)}</p>
    <form className="capture" onSubmit={(event) => void save(event)}>
      <label>Repeat<select aria-label="Repeat frequency" value={frequency} onChange={(event) => setFrequency(event.target.value)}><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
      {frequency === 'weekly' && <fieldset><legend>Repeat on</legend>{weekdayNames.map((name, index) => <label key={name} className="check-option"><input type="checkbox" checked={weekdays.includes(index + 1)} onChange={(event) => setWeekdays((current) => event.target.checked ? [...current, index + 1].sort() : current.filter((day) => day !== index + 1))} />{name}</label>)}</fieldset>}
      {frequency === 'monthly' && <label>Day of month<select aria-label="Repeat day of month" value={monthDay} onChange={(event) => setMonthDay(event.target.value)}>{Array.from({ length: 31 }, (_, index) => <option key={index} value={String(index + 1)}>{index + 1}</option>)}<option value="last">Last day</option></select></label>}
      <button type="submit" disabled={!frequency || (frequency === 'weekly' && weekdays.length === 0)}>Save repeat</button>
      {rule && <button type="button" className="secondary" onClick={() => void stop()}>Stop repeating</button>}
      {rule && (task.start_date || task.due_date) && <button type="button" className="secondary" onClick={() => void skip()}>Skip this occurrence</button>}
    </form>
  </section>;
}
