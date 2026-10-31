import React from 'react';
import { api } from './api';
import { Icon } from './ui/icons';
import { PopoverField } from './ui/popover';
import { CATEGORIES, CATEGORY_COLOR, StatusIcon, categoryLabel, type CategoryKey } from './ui/status-icon';
import { t, useLocale } from './i18n';
import type { Status, Workspace } from './types';

const PALETTE = ['#64748b', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#d97706', '#dc2626', '#c026d3', '#7c3aed', '#78716c'];

function ColorPicker({ status, disabled, onPick }: { status: Status; disabled: boolean; onPick: (color: string) => void }) {
  return <PopoverField label={t('statusSettings.colorFor', { name: status.name })} className="swatch-button" disabled={disabled} popoverClassName="color-popover" triggerLabel={<span className="swatch" style={{ background: status.color }} aria-hidden="true" />}>
    {({ close }) => <div className="palette">
      <div className="palette-grid" role="group" aria-label={t('statusSettings.palette')}>
        {PALETTE.map((color) => <button key={color} type="button" data-pop-item className="swatch-option" aria-label={color} aria-pressed={color.toLowerCase() === status.color.toLowerCase()} style={{ background: color }} onClick={() => { close(); onPick(color); }} />)}
      </div>
      <label className="check-option">{t('statusSettings.custom')}<input type="color" aria-label={t('statusSettings.customColorFor', { name: status.name })} defaultValue={status.color} onBlur={(event) => { if (event.target.value.toLowerCase() !== status.color.toLowerCase()) onPick(event.target.value); }} /></label>
    </div>}
  </PopoverField>;
}

/** Settings > Statuses: five fixed category groups; inside each, add, rename, recolour, reorder, set the default and archive. */
export function StatusSettings({ workspace, admin, statuses, reload, setMessage }: { workspace: Workspace; admin: boolean; statuses: Status[]; reload: () => Promise<void>; setMessage: (text: string) => void }) {
  useLocale();
  const [adding, setAdding] = React.useState<Record<string, string>>({});
  const [archivePreview, setArchivePreview] = React.useState<{ id: string; affected_tasks: number; affected_views: number } | null>(null);
  const live = (category: CategoryKey) => statuses.filter((status) => status.category === category && !status.archived).sort((a, b) => a.position - b.position);
  const archived = (category: CategoryKey) => statuses.filter((status) => status.category === category && status.archived);

  async function run(action: () => Promise<unknown>, success: string, failure: string) {
    try { await action(); await reload(); setMessage(success); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : failure); }
  }
  const save = (status: Status, patch: Partial<Status>) => run(() => api(`/workspaces/${workspace.id}/statuses/${status.id}`, { method: 'PATCH', body: JSON.stringify(patch) }), t('statusSettings.saved'), t('statusSettings.saveFailed'));
  const create = (category: CategoryKey) => (event: React.FormEvent) => {
    event.preventDefault();
    const name = (adding[category] ?? '').trim();
    if (!name) return;
    void run(() => api(`/workspaces/${workspace.id}/statuses`, { method: 'POST', body: JSON.stringify({ name, category, color: CATEGORY_COLOR[category] }) }), t('statusSettings.created'), t('statusSettings.createFailed')).then(() => setAdding((current) => ({ ...current, [category]: '' })));
  };
  const move = (status: Status, delta: number) => {
    const group = live(status.category as CategoryKey);
    const from = group.findIndex((item) => item.id === status.id);
    const to = from + delta;
    if (to < 0 || to >= group.length) return;
    [group[from], group[to]] = [group[to], group[from]];
    const ids = CATEGORIES.flatMap((category) => (category === status.category ? group : live(category)).map((item) => item.id));
    void run(() => api(`/workspaces/${workspace.id}/statuses/reorder`, { method: 'POST', body: JSON.stringify({ status_ids: ids }) }), t('statusSettings.reordered'), t('statusSettings.reorderFailed'));
  };

  return <section aria-label={t('settings.statuses')}><h3>{t('settings.statuses')}</h3>
    <p className="muted">{admin ? t('statusSettings.intro') : t('statusSettings.readOnly')}</p>
    <div className="status-groups">
      {CATEGORIES.map((category) => {
        const items = live(category);
        return <section key={category} className="status-group" aria-label={categoryLabel(category)}>
          <h4><StatusIcon category={category} color={CATEGORY_COLOR[category]} />{categoryLabel(category)} <span className="count">{items.length}</span></h4>
          <ul className="settings-list">{items.map((status, index) => <li key={status.id}>
            <div className="status-row">
              <StatusIcon category={status.category} color={status.color} />
              <input className="status-name" aria-label={t('statusSettings.nameFor', { name: status.name })} disabled={!admin} defaultValue={status.name} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== status.name) void save(status, { name: event.target.value.trim() }); }} />
              <ColorPicker status={status} disabled={!admin} onPick={(color) => void save(status, { color })} />
              {status.is_default && <span className="badge accent">{t('statusSettings.default')}</span>}
              {admin && <span className="status-actions">
                {category === 'not_started' && !status.is_default && <button type="button" className="ghost btn-sm" aria-label={t('statusSettings.makeDefaultFor', { name: status.name })} onClick={() => void save(status, { is_default: true })}>{t('statusSettings.makeDefault')}</button>}
                <button type="button" className="ghost icon-button btn-sm move-up" aria-label={t('statusSettings.moveUp', { name: status.name })} disabled={index === 0} onClick={() => move(status, -1)}><Icon name="chevron-down" small /><span className="sr-only">{t('statusSettings.up')}</span></button>
                <button type="button" className="ghost icon-button btn-sm" aria-label={t('statusSettings.moveDown', { name: status.name })} disabled={index === items.length - 1} onClick={() => move(status, 1)}><Icon name="chevron-down" small /></button>
                <button type="button" className="ghost btn-sm danger-text" disabled={status.is_default} title={status.is_default ? t('statusSettings.defaultKept') : undefined} aria-label={t('statusSettings.archiveFor', { name: status.name })} onClick={async () => { try { setArchivePreview({ id: status.id, ...(await api<{ affected_tasks: number; affected_views: number }>(`/workspaces/${workspace.id}/statuses/${status.id}/archive-preview`)) }); } catch (reason) { setMessage(reason instanceof Error ? reason.message : t('statusSettings.previewFailed')); } }}>{t('statusSettings.archive')}</button>
              </span>}
            </div>
            {archivePreview?.id === status.id && <div className="archive-preview" role="group" aria-label={t('statusSettings.archivePreview', { name: status.name })}><p>{t('statusSettings.affects', { tasks: archivePreview.affected_tasks, views: archivePreview.affected_views })}</p>
              <label>{t('statusSettings.replacement')}<select aria-label="Replacement Status" defaultValue=""><option value="">{t('statusSettings.chooseReplacement')}</option>{statuses.filter((item) => !item.archived && item.id !== status.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <button type="button" onClick={(event) => { const replacement = event.currentTarget.parentElement?.querySelector('select')?.value ?? ''; if (replacement || archivePreview.affected_tasks === 0) void run(() => api(`/workspaces/${workspace.id}/statuses/${status.id}/archive`, { method: 'POST', body: JSON.stringify({ replacement_id: replacement || null }) }), t('statusSettings.archived'), t('statusSettings.archiveFailed')).then(() => setArchivePreview(null)); }}>{t('statusSettings.confirmArchive')}</button>
              <button type="button" className="secondary" onClick={() => setArchivePreview(null)}>{t('common.cancel')}</button></div>}
          </li>)}
          {archived(category).map((status) => <li key={status.id} className="archived-row"><div className="status-row"><StatusIcon category={status.category} color={status.color} /><span className="status-name-archived">{status.name}</span><span className="muted">{t('statusSettings.archivedTag')}</span></div></li>)}
          </ul>
          {admin && <form className="status-add" aria-label={t('statusSettings.addTo', { category: categoryLabel(category) })} onSubmit={create(category)}>
            <input aria-label={t('statusSettings.newNameIn', { category: categoryLabel(category) })} placeholder={t('statusSettings.newPlaceholder')} value={adding[category] ?? ''} onChange={(event) => setAdding((current) => ({ ...current, [category]: event.target.value }))} />
            <button type="submit" className="secondary btn-sm" aria-label={t('statusSettings.addButtonIn', { category: categoryLabel(category) })} disabled={!(adding[category] ?? '').trim()}><Icon name="plus" small />{t('statusSettings.add')}</button>
          </form>}
        </section>;
      })}
    </div>
  </section>;
}
