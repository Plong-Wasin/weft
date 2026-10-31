import { t, type MessageKey } from '../i18n';

/** The five fixed Status categories, in display order. */
export const CATEGORIES = ['not_started', 'active', 'blocked', 'wont_do', 'completed'] as const;
export type CategoryKey = (typeof CATEGORIES)[number];

export function categoryLabel(category: string): string {
  return t(`cat.${category}` as MessageKey);
}

export const CATEGORY_COLOR: Record<CategoryKey, string> = {
  not_started: '#64748b',
  active: '#2563eb',
  blocked: '#d97706',
  wont_do: '#78716c',
  completed: '#16a34a',
};

/** One drawn set, one symbol per category, tinted by the Status colour (currentColor). */
export function StatusIcon({ category, color, size = 16 }: { category: string; color?: string; size?: number }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const };
  return <svg className="status-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" style={{ color: color ?? 'var(--text-3)' }} data-category={category}>
    {category === 'completed' ? <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M4.8 8.3l2.2 2.2 4.2-4.6" fill="none" stroke="var(--surface)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </> : category === 'active' ? <>
      <circle cx="8" cy="8" r="6.2" {...common} />
      <path d="M8 3.6a4.4 4.4 0 0 1 0 8.8z" fill="currentColor" />
    </> : category === 'blocked' ? <>
      <circle cx="8" cy="8" r="6.2" {...common} />
      <path d="M5 8h6" {...common} strokeWidth={2} />
    </> : category === 'wont_do' ? <>
      <circle cx="8" cy="8" r="6.2" {...common} />
      <path d="M4.6 11.4l6.8-6.8" {...common} />
    </> : <>
      <circle cx="8" cy="8" r="6.2" {...common} strokeDasharray="2.3 2.3" />
    </>}
  </svg>;
}
