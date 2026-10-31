import type { Status, Task, TaskSort } from './types';

/** Columns shown until a person saves their own choice for a Project. */
export const DEFAULT_COLUMNS = ['title', 'status', 'priority', 'assignees', 'due_date', 'milestone'];
/** Older saved Lists named two columns differently. */
export const COLUMN_ALIASES: Record<string, string> = { due_date: 'due', due: 'due_date', assignees: 'assignee', assignee: 'assignees' };

export const BUILTIN_COLUMNS = ['title', 'status', 'priority', 'assignees', 'start_date', 'due_date', 'milestone', 'created_at', 'updated_at', 'completed_at'] as const;
/** Built-in columns the server can sort by. */
export const SORTABLE = new Set(['title', 'status', 'priority', 'start_date', 'due_date', 'created_at', 'updated_at', 'completed_at']);

/** Query string for `GET /tasks`; manual order sends nothing. */
export function sortQuery(sort: TaskSort | null): string {
  return sort ? `?sort=${encodeURIComponent(sort.key)}&direction=${sort.direction}` : '';
}

/** The sort key a column header stands for, or null when the server cannot sort by it. */
export function sortKeyOf(column: string): string | null {
  if (column.startsWith('attribute:')) return `attribute/${column.slice(10)}`;
  return SORTABLE.has(column) ? column : null;
}

/** Roots keep their order, every Task follows its parent; a Task whose parent is not shown counts as a root. */
export function treeOrder(items: Task[]): Task[] {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const item of items) {
    if (item.parent_task_id && ids.has(item.parent_task_id) && item.parent_task_id !== item.id) children.set(item.parent_task_id, [...(children.get(item.parent_task_id) ?? []), item]);
    else roots.push(item);
  }
  if (children.size === 0) return items;
  const out: Task[] = [];
  const seen = new Set<string>();
  const walk = (item: Task) => { if (seen.has(item.id)) return; seen.add(item.id); out.push(item); (children.get(item.id) ?? []).forEach(walk); };
  roots.forEach(walk);
  items.forEach(walk);
  return out;
}

const PRIORITY_ORDER = ['low', 'normal', 'high', 'urgent'];

/** Client-side twin of the server sort for sources the server does not sort (My work, Lists). Empty values sort last. */
export function applySort(items: Task[], sort: TaskSort, statuses: Status[]): Task[] {
  const value = (item: Task): string | number | null => {
    const key = sort.key;
    if (key === 'status') { const status = statuses.find((candidate) => candidate.key === item.status); return status ? status.position : null; }
    if (key === 'priority') return PRIORITY_ORDER.indexOf(item.priority);
    if (key === 'title') return item.title.toLowerCase();
    if (key === 'number') return item.number;
    if (key.startsWith('attribute/')) { const raw = item.attributes?.[key.slice(10)]; if (raw === undefined || raw === null || raw === '') return null; return typeof raw === 'number' ? raw : Array.isArray(raw) ? raw.join(',') : String(raw); }
    const raw = (item as unknown as Record<string, unknown>)[key];
    return raw === undefined || raw === null || raw === '' ? null : String(raw);
  };
  const factor = sort.direction === 'desc' ? -1 : 1;
  return items.map((item, index) => ({ item, index, v: value(item) })).sort((a, b) => {
    if (a.v === null && b.v === null) return a.index - b.index;
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    const order = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v));
    return order === 0 ? a.index - b.index : order * factor;
  }).map((entry) => entry.item);
}
