import React from 'react';
import { PopoverField } from './popover';
import { CATEGORIES, StatusIcon, categoryLabel } from './status-icon';
import { Avatar, AvatarStack, displayName } from './avatar';
import { Icon } from './icons';
import { t } from '../i18n';
import type { Assignee, Member, Status, Team } from '../types';

/** Statuses grouped by the five fixed categories (display order), each group sorted by position. */
export function groupStatuses(statuses: Status[]) {
  return CATEGORIES.map((category) => ({ category, items: statuses.filter((status) => status.category === category).sort((a, b) => a.position - b.position) })).filter((group) => group.items.length > 0);
}

export function StatusPicker({ statuses, value, onChange, label, iconOnly, disabled, className = 'cell-button' }: { statuses: Status[]; value: string; onChange: (key: string) => void; label: string; iconOnly?: boolean; disabled?: boolean; className?: string }) {
  const current = statuses.find((status) => status.key === value);
  return <PopoverField label={`${label}: ${current?.name ?? value}`} className={className} disabled={disabled} popoverClassName="status-popover"
    triggerLabel={<><StatusIcon category={current?.category ?? 'not_started'} color={current?.color} />{!iconOnly && <span className="cell-text">{current?.name ?? value}</span>}</>}>
    {({ close }) => <div role="listbox" aria-label={label} className="option-list">
      {groupStatuses(statuses).map((group) => <div role="group" key={group.category} aria-label={categoryLabel(group.category)}>
        <p className="option-group">{categoryLabel(group.category)}</p>
        {group.items.map((status) => <button key={status.id} type="button" role="option" aria-selected={status.key === value} className="option" onClick={() => { close(); if (status.key !== value) onChange(status.key); }}>
          <StatusIcon category={status.category} color={status.color} /><span className="option-name">{status.name}</span>{status.key === value && <Icon name="check" small />}
        </button>)}
      </div>)}
    </div>}
  </PopoverField>;
}

export type PickerOption = { value: string; label: string; swatch?: string };

/** Single or multi select popover for priority and select/user attributes. */
export function OptionPicker({ options, value, onChange, label, multiple, allowClear, className = 'cell-button', placeholder = '—', disabled }: { options: PickerOption[]; value: string | string[] | null | undefined; onChange: (value: string | string[] | null) => void; label: string; multiple?: boolean; allowClear?: boolean; className?: string; placeholder?: string; disabled?: boolean }) {
  const selected = new Set(Array.isArray(value) ? value.map(String) : value === null || value === undefined || value === '' ? [] : [String(value)]);
  const names = options.filter((option) => selected.has(option.value)).map((option) => option.label);
  const summary = names.length ? names.join(', ') : placeholder;
  return <PopoverField label={`${label}: ${names.length ? names.join(', ') : t('picker.none')}`} className={className} disabled={disabled}
    triggerLabel={<span className={`cell-text ${names.length ? '' : 'muted'}`}>{summary}</span>}>
    {({ close }) => <div role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="option-list">
      {allowClear && !multiple && <button type="button" role="option" aria-selected={selected.size === 0} className="option" onClick={() => { close(); onChange(null); }}><span className="option-name muted">{t('picker.none')}</span></button>}
      {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={selected.has(option.value)} className="option" onClick={() => {
        if (multiple) { const next = new Set(selected); if (next.has(option.value)) next.delete(option.value); else next.add(option.value); onChange(options.filter((item) => next.has(item.value)).map((item) => item.value)); }
        else { close(); onChange(option.value); }
      }}>{option.swatch && <span className="dot" style={{ color: option.swatch }} aria-hidden="true" />}<span className="option-name">{option.label}</span>{selected.has(option.value) && <Icon name="check" small />}</button>)}
      {options.length === 0 && <p className="menu-note">{t('picker.noOptions')}</p>}
    </div>}
  </PopoverField>;
}

/** Multi-select of Workspace members and Teams with avatars; usable from a cell, a card, the property bar and the `/` command. */
export function AssigneePicker({ value, members, teams, onChange, label, className = 'cell-button', showNames, disabled }: { value: Assignee[]; members: Member[]; teams: Team[]; onChange: (next: Assignee[]) => void; label: string; className?: string; showNames?: boolean; disabled?: boolean }) {
  const [query, setQuery] = React.useState('');
  const selected = new Set(value.map(({ type, id }) => `${type}:${id}`));
  const summary = value.length ? value.map((item) => item.type === 'team' ? `@${item.name}` : displayName(item.name)).join(', ') : t('detail.unassigned');
  function toggle(type: 'user' | 'team', id: string, name: string) {
    const rest = value.filter((item) => !(item.type === type && item.id === id));
    onChange(selected.has(`${type}:${id}`) ? rest : [...rest, { type, id, name }]);
  }
  const needle = query.trim().toLowerCase();
  const people = members.filter((member) => member.email.toLowerCase().includes(needle));
  const groups = teams.filter((team) => team.name.toLowerCase().includes(needle));
  return <PopoverField label={`${label}: ${summary}`} className={className} disabled={disabled} popoverClassName="assignee-popover" onOpenChange={(open) => { if (!open) setQuery(''); }}
    triggerLabel={<>{value.length ? <AvatarStack assignees={value} /> : <span className="avatar avatar-empty" aria-hidden="true"><Icon name="user" small /></span>}{showNames && <span className={`cell-text ${value.length ? '' : 'muted'}`}>{summary}</span>}</>}>
    {() => <>
      <input data-autofocus className="popover-search" type="search" aria-label={t('picker.searchPeople')} placeholder={t('picker.searchPeople')} value={query} onChange={(event) => setQuery(event.target.value)} />
      <div role="listbox" aria-label={label} aria-multiselectable="true" className="option-list">
        {people.map((member) => <button key={member.id} type="button" role="option" aria-selected={selected.has(`user:${member.id}`)} className="option" onClick={() => toggle('user', member.id, member.email)}>
          <Avatar name={member.email} id={member.id} /><span className="option-name">{member.email}</span>{selected.has(`user:${member.id}`) && <Icon name="check" small />}</button>)}
        {groups.map((team) => <button key={team.id} type="button" role="option" aria-selected={selected.has(`team:${team.id}`)} className="option" onClick={() => toggle('team', team.id, team.name)}>
          <Avatar name={team.name} id={team.id} team /><span className="option-name">@{team.name}</span><span className="muted option-kind">{t('picker.team')}</span>{selected.has(`team:${team.id}`) && <Icon name="check" small />}</button>)}
        {people.length === 0 && groups.length === 0 && <p className="menu-note">{t('picker.noMatches')}</p>}
      </div>
      <p className="menu-note">{t('detail.assignNoAccess')}</p>
    </>}
  </PopoverField>;
}
