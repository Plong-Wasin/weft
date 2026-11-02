export const priorityOrder = ["urgent", "high", "medium", "low", "none"] as const;
export const layouts = ["list", "board", "spreadsheet"] as const;
export const groupings = ["none", "state", "priority", "assignee", "label", "cycle", "module", "creator", "dueDate"] as const;
export const sortFields = ["manual", "priority", "title", "created", "updated", "dueDate"] as const;
/** The inline properties a list row can show; the display bar toggles them. */
export const displayProperties = ["id", "state", "priority", "assignee", "labels", "dates", "cycle", "modules"] as const;
export type DisplayProperty = (typeof displayProperties)[number];

export interface LayoutParams {
  layout: (typeof layouts)[number];
  group: (typeof groupings)[number];
  sort: (typeof sortFields)[number];
  dir: "asc" | "desc";
  /** The applied filter: PQL is the single stored form, the filter chips are read from it. */
  q: string;
  /** The visible row properties; the spreadsheet shows them as columns in this order. */
  props: DisplayProperty[];
}

export const defaultParams: LayoutParams = { layout: "list", group: "state", sort: "manual", dir: "asc", q: "", props: [...displayProperties] };

const pick = <T extends string>(allowed: readonly T[], value: string | null, fallback: T): T => (allowed as readonly string[]).includes(value ?? "") ? value as T : fallback;
const many = (value: string | null) => (value ?? "").split(",").filter(Boolean);

/** Reads the layout and display settings from a URL query string; anything unknown falls back to the default. */
export function parseLayoutParams(search: string): LayoutParams {
  const query = new URLSearchParams(search);
  const props = query.get("props");
  return {
    layout: pick(layouts, query.get("layout"), defaultParams.layout), group: pick(groupings, query.get("group"), defaultParams.group),
    sort: pick(sortFields, query.get("sort"), defaultParams.sort), dir: query.get("dir") === "desc" ? "desc" : "asc",
    q: query.get("q") ?? "",
    props: props === null ? [...displayProperties] : [...new Set(many(props))].filter((property): property is DisplayProperty => (displayProperties as readonly string[]).includes(property)),
  };
}

/** Writes only the settings that differ from the defaults, so the plain project URL stays clean. */
export function serializeLayoutParams(params: LayoutParams): string {
  const query = new URLSearchParams();
  if (params.layout !== defaultParams.layout) query.set("layout", params.layout);
  if (params.group !== defaultParams.group) query.set("group", params.group);
  if (params.sort !== defaultParams.sort) query.set("sort", params.sort);
  if (params.dir !== defaultParams.dir) query.set("dir", params.dir);
  if (params.q !== defaultParams.q) query.set("q", params.q);
  if (params.props.join(",") !== defaultParams.props.join(",")) query.set("props", params.props.join(","));
  const text = query.toString();
  return text ? `?${text}` : "";
}

interface Groupable { id: string; stateId: string; priority: string; assigneeIds: string[]; labelIds?: string[]; moduleIds?: string[]; cycleId?: string | null; creatorId?: string | null; dueDate?: string | null }
export interface ItemGroup<T> { key: string; items: T[] }

const dueDateGroupKeys = ["overdue", "today", "thisWeek", "nextWeek", "later", "noDueDate"] as const;

/** Splits ordered items into groups; multi-valued properties repeat items, while empty values appear under "none". */
export function groupItems<T extends Groupable>(items: T[], group: LayoutParams["group"], stateIds: string[], today = new Date()): ItemGroup<T>[] {
  if (group === "none") return [{ key: "all", items }];
  if (group === "state") return stateIds.map((id) => ({ key: id, items: items.filter((item) => item.stateId === id) }));
  if (group === "priority") return priorityOrder.map((key) => ({ key, items: items.filter((item) => item.priority === key) }));
  if (group === "dueDate") {
    const localDate = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const start = localDate(today);
    const mondayOffset = (start.getDay() + 6) % 7;
    const shiftDays = (date: Date, days: number) => { const shifted = new Date(date); shifted.setDate(shifted.getDate() + days); return shifted; };
    const thisMonday = shiftDays(start, -mondayOffset);
    const nextMonday = shiftDays(thisMonday, 7);
    const followingMonday = shiftDays(nextMonday, 7);
    const keyFor = (item: T) => {
      if (!item.dueDate) return "noDueDate";
      const [year, month, date] = item.dueDate.slice(0, 10).split("-").map(Number);
      const due = new Date(year!, month! - 1, date!);
      if (due < start) return "overdue";
      if (due.getTime() === start.getTime()) return "today";
      if (due < nextMonday) return "thisWeek";
      if (due < followingMonday) return "nextWeek";
      return "later";
    };
    return dueDateGroupKeys.map((key) => ({ key, items: items.filter((item) => keyFor(item) === key) }));
  }
  const keysFor = (item: T): string[] => group === "assignee" ? item.assigneeIds : group === "label" ? item.labelIds ?? [] : group === "module" ? item.moduleIds ?? [] : [group === "cycle" ? item.cycleId ?? "" : item.creatorId ?? ""].filter(Boolean);
  const keys = [...new Set(items.flatMap(keysFor))];
  return [...keys.map((key) => ({ key, items: items.filter((item) => keysFor(item).includes(key)) })), { key: "none", items: items.filter((item) => keysFor(item).length === 0) }];
}

/** Moves a visible property one place earlier (-1) or later (1); a move past either end changes nothing. */
export function moveProperty(props: DisplayProperty[], property: DisplayProperty, step: -1 | 1): DisplayProperty[] {
  const from = props.indexOf(property), to = from + step;
  if (from < 0 || to < 0 || to >= props.length) return props;
  const next = [...props];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}
