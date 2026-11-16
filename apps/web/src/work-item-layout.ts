export const priorityOrder = ["urgent", "high", "medium", "low", "none"] as const;
export const layouts = ["list", "board", "spreadsheet", "calendar", "gantt"] as const;
export const groupings = ["none", "state", "priority", "type", "assignee", "label", "cycle", "module", "creator", "dueDate"] as const;
export const sortFields = ["manual", "priority", "title", "created", "updated", "dueDate"] as const;
/** The inline properties a list row can show; the display bar toggles them. */
export const displayProperties = ["id", "state", "priority", "assignee", "labels", "dates", "cycle", "modules", "estimate"] as const;
export type DisplayProperty = (typeof displayProperties)[number];

export interface LayoutParams {
  layout: (typeof layouts)[number];
  group: (typeof groupings)[number];
  /** A second dimension for board swimlanes and nested list sections. */
  subGroup: (typeof groupings)[number];
  sort: (typeof sortFields)[number];
  dir: "asc" | "desc";
  /** The applied filter: PQL is the single stored form, the filter chips are read from it. */
  q: string;
  /** The visible row properties; the spreadsheet shows them as columns in this order. */
  props: DisplayProperty[];
}

export const defaultParams: LayoutParams = { layout: "list", group: "state", subGroup: "none", sort: "manual", dir: "asc", q: "", props: [...displayProperties] };

const pick = <T extends string>(allowed: readonly T[], value: string | null, fallback: T): T => (allowed as readonly string[]).includes(value ?? "") ? value as T : fallback;
const many = (value: string | null) => (value ?? "").split(",").filter(Boolean);

/** Reads the layout and display settings from a URL query string; anything unknown falls back to the default. */
export function parseLayoutParams(search: string): LayoutParams {
  const query = new URLSearchParams(search);
  const props = query.get("props");
  const group = pick(groupings, query.get("group"), defaultParams.group);
  const subGroup = pick(groupings, query.get("subgroup"), defaultParams.subGroup);
  return {
    layout: pick(layouts, query.get("layout"), defaultParams.layout), group, subGroup: subGroup === group ? "none" : subGroup,
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
  if (params.subGroup !== defaultParams.subGroup && params.subGroup !== params.group) query.set("subgroup", params.subGroup);
  if (params.sort !== defaultParams.sort) query.set("sort", params.sort);
  if (params.dir !== defaultParams.dir) query.set("dir", params.dir);
  if (params.q !== defaultParams.q) query.set("q", params.q);
  if (params.props.join(",") !== defaultParams.props.join(",")) query.set("props", params.props.join(","));
  const text = query.toString();
  return text ? `?${text}` : "";
}

interface Groupable { id: string; stateId: string; priority: string; typeId?: string | null; assigneeIds: string[]; labelIds?: string[]; moduleIds?: string[]; cycleId?: string | null; creatorId?: string | null; dueDate?: string | null }
export interface ItemGroup<T> { key: string; items: T[] }

export interface CalendarDay<T> { date: string; items: T[] }
export interface CalendarPlacement<T> { days: CalendarDay<T>[]; undated: T[] }

export type GanttZoom = "week" | "month" | "quarter";
export interface GanttBar<T> { item: T; left: number; width: number }
export interface GanttPlacement<T> { start: string; days: string[]; today: number; bars: GanttBar<T>[]; undated: T[] }

/** Maps dated work items onto an inclusive day axis; one-sided dates become a one-day bar. */
export function ganttPlacement<T extends { startDate?: string | null; dueDate?: string | null }>(items: T[], anchor: Date, zoom: GanttZoom, today = new Date()): GanttPlacement<T> {
  const dateAt = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const ordinal = (value: string) => { const [year, month, day] = value.slice(0, 10).split("-").map(Number); return Date.UTC(year!, month! - 1, day!) / 86400000; };
  const format = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const pivot = dateAt(anchor);
  const quarterMonth = Math.floor(pivot.getMonth() / 3) * 3;
  const start = zoom === "week" ? new Date(pivot.getFullYear(), pivot.getMonth(), pivot.getDate() - ((pivot.getDay() + 6) % 7) - 7)
    : zoom === "month" ? new Date(pivot.getFullYear(), pivot.getMonth(), 1) : new Date(pivot.getFullYear(), quarterMonth, 1);
  const count = zoom === "week" ? 14 : zoom === "month"
    ? new Date(pivot.getFullYear(), pivot.getMonth() + 1, 0).getDate()
    : ordinal(format(new Date(pivot.getFullYear(), quarterMonth + 3, 1))) - ordinal(format(start));
  const days = Array.from({ length: count }, (_, index) => format(new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)));
  const first = ordinal(format(start));
  const bars = items.flatMap((item) => {
    if (!item.startDate && !item.dueDate) return [];
    const from = item.startDate ? ordinal(item.startDate) : ordinal(item.dueDate!);
    const through = item.dueDate ? ordinal(item.dueDate) : ordinal(item.startDate!);
    const left = Math.max(0, from - first);
    const right = Math.min(count - 1, through - first);
    return right < 0 || left >= count || right < left ? [] : [{ item, left, width: right - left + 1 }];
  });
  return { start: format(start), days, today: ordinal(format(dateAt(today))) - first, bars, undated: items.filter((item) => !item.startDate && !item.dueDate) };
}

/** Places dated work items in a six-week, Monday-first month grid; undated items stay in the side list. */
export function calendarPlacement<T extends { dueDate?: string | null }>(items: T[], month: Date): CalendarPlacement<T> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { date: key, items: items.filter((item) => item.dueDate?.slice(0, 10) === key) };
  });
  return { days, undated: items.filter((item) => !item.dueDate) };
}

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
  const keysFor = (item: T): string[] => group === "assignee" ? item.assigneeIds : group === "label" ? item.labelIds ?? [] : group === "module" ? item.moduleIds ?? [] : [group === "cycle" ? item.cycleId ?? "" : group === "type" ? item.typeId ?? "" : item.creatorId ?? ""].filter(Boolean);
  const keys = [...new Set(items.flatMap(keysFor))];
  return [...keys.map((key) => ({ key, items: items.filter((item) => keysFor(item).includes(key)) })), { key: "none", items: items.filter((item) => keysFor(item).length === 0) }];
}

/** The Sub-group a layout really uses: it never repeats the Group-by property, so a clash falls back to none. */
export function effectiveSubGroup(group: LayoutParams["group"], subGroup: LayoutParams["subGroup"]): LayoutParams["subGroup"] {
  return subGroup === group ? "none" : subGroup;
}

/** Lists every wanted key as a group (empty ones included), in that order, then any other groups, with "none" last. */
export function completeGroups<T>(groups: ItemGroup<T>[], keys: string[]): ItemGroup<T>[] {
  if (keys.length === 0) return groups;
  const present = new Map(groups.map((group) => [group.key, group]));
  const wanted = keys.map((key) => present.get(key) ?? { key, items: [] });
  const rest = groups.filter((group) => group.key !== "none" && !keys.includes(group.key));
  const none = present.get("none");
  return [...wanted, ...rest, ...(none ? [none] : [])];
}

/** Moves a visible property one place earlier (-1) or later (1); a move past either end changes nothing. */
export function moveProperty(props: DisplayProperty[], property: DisplayProperty, step: -1 | 1): DisplayProperty[] {
  const from = props.indexOf(property), to = from + step;
  if (from < 0 || to < 0 || to >= props.length) return props;
  const next = [...props];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}
