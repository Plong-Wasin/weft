import React from 'react';
import { Icon } from './ui/icons';
import { PopoverField } from './ui/popover';
import { AssigneePicker, OptionPicker, StatusPicker, groupStatuses } from './ui/pickers';
import { StatusIcon, categoryLabel } from './ui/status-icon';
import { DateInput } from './ui/date-input';
import { AvatarStack } from './ui/avatar';
import { enumLabel, t } from './i18n';
import type { App } from './app-state';
import type { Attribute, Member, Task } from './types';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const priorityOptions = () => PRIORITIES.map((value) => ({ value, label: enumLabel('priority', value) }));

/** One Attribute value editor shared by table cells, the new-row draft, the property bar and the create dialog. */
export function AttributeEditor({ attribute, value, onChange, label, members, live, className = 'cell-button' }: { attribute: Attribute; value: unknown; onChange: (next: unknown) => void; label: string; members: Member[]; live?: boolean; className?: string }) {
  const [text, setText] = React.useState(value === null || value === undefined ? '' : String(value));
  React.useEffect(() => { setText(value === null || value === undefined ? '' : String(value)); }, [value]);
  if (attribute.type === 'single_select') return <OptionPicker label={label} className={className} allowClear options={attribute.options.map((option) => ({ value: option.key, label: option.name }))} value={value as string | null} onChange={(next) => onChange(next)} />;
  if (attribute.type === 'multi_select') return <OptionPicker label={label} className={className} multiple options={attribute.options.map((option) => ({ value: option.key, label: option.name }))} value={Array.isArray(value) ? value.map(String) : []} onChange={(next) => onChange(next)} />;
  if (attribute.type === 'user') return <OptionPicker label={label} className={className} allowClear options={members.map((member) => ({ value: member.id, label: member.email }))} value={value as string | null} onChange={(next) => onChange(next)} />;
  if (attribute.type === 'date') return <DateInput label={label} value={typeof value === 'string' ? value : ''} onChange={(next) => onChange(next || null)} />;
  const kind = attribute.type === 'number' ? 'number' : 'text';
  return <input aria-label={label} type={kind} value={text} onChange={(event) => { setText(event.target.value); if (live) onChange(event.target.value || null); }} onBlur={() => { if (!live && text !== (value === null || value === undefined ? '' : String(value))) onChange(text || null); }} onKeyDown={(event) => { if (event.key === 'Enter' && !live) event.currentTarget.blur(); }} />;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const tone = priority === 'urgent' ? 'danger' : priority === 'high' ? 'warning' : '';
  return <span className={`badge ${tone}`}>{enumLabel('priority', priority)}</span>;
}

/** The row/card menu: open, reorder, indent and the keyboard-reachable "Move to status". */
export function RowMenu({ app, item, variant }: { app: App; item: Task; variant: 'row' | 'card' }) {
  const manual = !app.sort;
  return <PopoverField label={t('row.actions', { n: item.number })} className="ghost icon-button btn-sm row-menu-button" popoverClassName="row-menu" triggerLabel={<Icon name="more" small />}>
    {({ close }) => {
      const run = (action: () => void) => () => { close(false); action(); };
      return <div className="option-list" role="group" aria-label={t('row.actions', { n: item.number })}>
        <button type="button" className="option" data-pop-item onClick={run(() => app.openPanel(item))}><Icon name="layout" small /><span className="option-name">{t('row.open')}</span></button>
        <button type="button" className="option" data-pop-item onClick={run(() => app.openPanel(item, true))}><Icon name="expand" small /><span className="option-name">{t('row.openFull')}</span></button>
        {variant === 'row' && <>
          <button type="button" className="option" data-pop-item disabled={!manual} onClick={run(() => app.stepRow(item, -1))}><span className="option-name">{t('row.moveUp')}</span><kbd>Alt+↑</kbd></button>
          <button type="button" className="option" data-pop-item disabled={!manual} onClick={run(() => app.stepRow(item, 1))}><span className="option-name">{t('row.moveDown')}</span><kbd>Alt+↓</kbd></button>
          <button type="button" className="option" data-pop-item onClick={run(() => void app.indentTask(item, false))}><span className="option-name">{t('row.indent')}</span></button>
          <button type="button" className="option" data-pop-item disabled={!item.parent_task_id} onClick={run(() => void app.indentTask(item, true))}><span className="option-name">{t('row.outdent')}</span></button>
        </>}
        {variant === 'card' && <>
          <button type="button" className="option" data-pop-item disabled={!manual} onClick={run(() => app.stepRow(item, -1, app.viewTasks.filter((candidate) => candidate.status === item.status)))}><span className="option-name">{t('row.moveUp')}</span><kbd>Alt+↑</kbd></button>
          <button type="button" className="option" data-pop-item disabled={!manual} onClick={run(() => app.stepRow(item, 1, app.viewTasks.filter((candidate) => candidate.status === item.status)))}><span className="option-name">{t('row.moveDown')}</span><kbd>Alt+↓</kbd></button>
        </>}
        <p className="option-group" id={`move-status-${item.id}`}>{t('row.moveToStatus')}</p>
        <div role="group" aria-labelledby={`move-status-${item.id}`}>
          {groupStatuses(app.statuses).flatMap((group) => group.items).map((status) => <button key={status.id} type="button" className="option" data-pop-item aria-current={status.key === item.status ? 'true' : undefined} disabled={status.key === item.status} onClick={run(() => void app.moveTask(item, { status: status.key }, t('announce.movedToStatus', { n: item.number, status: status.name })))}>
            <StatusIcon category={status.category} color={status.color} /><span className="option-name">{status.name}</span><span className="muted option-kind">{categoryLabel(status.category)}</span></button>)}
        </div>
      </div>;
    }}
  </PopoverField>;
}

export { StatusPicker, AssigneePicker, OptionPicker, AvatarStack };
