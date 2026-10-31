import React from 'react';
import { formatDate, getLocale, t } from '../i18n';
import { Icon } from './icons';
import { PopoverField } from './popover';

/** Parses dd/MM/yyyy (also d/M/yyyy and ISO yyyy-MM-dd) into an ISO date, or null when it is not a real date. */
export function parseDateText(text: string): string | null {
  const value = text.trim();
  let year: number; let month: number; let day: number;
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const local = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
  else if (local) { day = Number(local[1]); month = Number(local[2]); year = Number(local[3]); }
  else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (year: number, month: number, day: number) => `${year}-${pad(month + 1)}-${pad(day)}`;

function MonthGrid({ value, onPick }: { value: string; onPick: (iso: string) => void }) {
  const start = value ? new Date(`${value}T00:00:00`) : new Date();
  const [cursor, setCursor] = React.useState({ year: start.getFullYear(), month: start.getMonth() });
  const locale = getLocale() === 'th' ? 'th-TH-u-ca-gregory' : 'en-GB';
  const first = new Date(cursor.year, cursor.month, 1);
  const offset = (first.getDay() + 6) % 7;
  const count = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const today = new Date();
  const todayIso = isoOf(today.getFullYear(), today.getMonth(), today.getDate());
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(2024, 0, 1 + index)));
  const step = (delta: number) => setCursor((current) => { const next = new Date(current.year, current.month + delta, 1); return { year: next.getFullYear(), month: next.getMonth() }; });
  return <div className="month-grid">
    <div className="month-head">
      <button type="button" className="ghost icon-button btn-sm" data-pop-item aria-label={t('date.prevMonth')} onClick={() => step(-1)}><Icon name="chevron-left" small /></button>
      <strong aria-live="polite">{new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(first)}</strong>
      <button type="button" className="ghost icon-button btn-sm" data-pop-item aria-label={t('date.nextMonth')} onClick={() => step(1)}><Icon name="chevron-right" small /></button>
    </div>
    <div className="month-days" role="grid" aria-label={t('date.calendar')}>
      {weekdays.map((name) => <span key={name} className="month-weekday" role="columnheader">{name}</span>)}
      {Array.from({ length: offset }, (_, index) => <span key={`blank-${index}`} />)}
      {Array.from({ length: count }, (_, index) => {
        const iso = isoOf(cursor.year, cursor.month, index + 1);
        return <button key={iso} type="button" role="gridcell" data-pop-item className={`month-day ${iso === value ? 'selected' : ''} ${iso === todayIso ? 'today' : ''}`} aria-selected={iso === value} aria-label={formatDate(iso)} onClick={() => onPick(iso)}>{index + 1}</button>;
      })}
    </div>
    <div className="month-foot"><button type="button" className="ghost btn-sm" data-pop-item onClick={() => onPick(todayIso)}>{t('date.today')}</button><button type="button" className="ghost btn-sm" data-pop-item onClick={() => onPick('')}>{t('date.clear')}</button></div>
  </div>;
}

/**
 * Date field that always shows dd/MM/yyyy, never the browser's locale format. Type a date (dd/MM/yyyy or ISO) or
 * pick one in the calendar; `onChange` receives an ISO date or '' when cleared.
 */
export function DateInput({ value, onChange, label, id, disabled, required, className = '', onKeyDown, inputRef }: { value: string; onChange: (value: string) => void; label?: string; id?: string; disabled?: boolean; required?: boolean; className?: string; onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void; inputRef?: React.Ref<HTMLInputElement> }) {
  const [text, setText] = React.useState(formatDate(value));
  const [invalid, setInvalid] = React.useState(false);
  React.useEffect(() => { setText(formatDate(value)); setInvalid(false); }, [value, getLocale()]);
  function commit(next: string) {
    if (!next.trim()) { setInvalid(false); if (value) onChange(''); return; }
    const parsed = parseDateText(next);
    if (!parsed) { setInvalid(true); return; }
    setInvalid(false);
    if (parsed !== value) onChange(parsed);
    setText(formatDate(parsed));
  }
  return <span className={`date-input ${invalid ? 'invalid' : ''} ${className}`}>
    <input id={id} ref={inputRef} type="text" inputMode="numeric" autoComplete="off" aria-label={label} aria-invalid={invalid || undefined} disabled={disabled} required={required} placeholder={t('date.placeholder')} value={text}
      onChange={(event) => { setText(event.target.value); const parsed = parseDateText(event.target.value); if (parsed && /^\d{4}-/.test(event.target.value.trim())) commit(event.target.value); else if (parsed && event.target.value.trim().length >= 10) commit(event.target.value); }}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') commit(event.currentTarget.value); onKeyDown?.(event); }} />
    {!disabled && <PopoverField label={t('date.choose')} className="ghost icon-button btn-sm date-pick" popoverClassName="date-popover" triggerLabel={<Icon name="calendar" small />}>
      {({ close }) => <MonthGrid value={value} onPick={(iso) => { onChange(iso); close(); }} />}
    </PopoverField>}
  </span>;
}
