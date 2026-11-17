/** A picker shows its search field only when it holds more options than this. */
export const SEARCH_THRESHOLD = 6;

type Named = { name: string };
type Grouped = { isAgent?: boolean };
type Accessible = Grouped & { name?: string; hasAccess?: boolean };

/** Whether a picker shows its search field: above SEARCH_THRESHOLD options, or always when the picker asks for it (the Assignee picker). */
export function isSearchable(options: readonly unknown[], always = false) {
  return always || options.length > SEARCH_THRESHOLD;
}

/** Keeps the options whose name contains the query, ignoring case and surrounding spaces. An empty query keeps all. */
export function filterPickerOptions<T extends Named>(options: readonly T[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? options.filter((option) => option.name.toLocaleLowerCase().includes(needle)) : [...options];
}

/** People come before Agents; each group keeps its own order. */
export function groupPickerOptions<T extends Grouped>(options: readonly T[]) {
  return [...options.filter((option) => !option.isAgent), ...options.filter((option) => option.isAgent)];
}

/** An Agent the person lacks access to is shown with its reason but cannot be picked. */
export function isPickable(option: Accessible) {
  return !(option.isAgent && option.hasAccess === false);
}

/** The highlighted index after an arrow key, clamped to the list; -1 when the list is empty. */
export function moveActive(index: number, step: 1 | -1, length: number) {
  if (length === 0) return -1;
  return Math.min(length - 1, Math.max(0, index + step));
}
