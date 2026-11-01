export const priorityOrder = ["urgent", "high", "medium", "low", "none"] as const;
export const layouts = ["list", "board"] as const;
export const groupings = ["none", "state", "priority", "assignee"] as const;
export const filterModes = ["filters", "pql"] as const;
export const sortFields = ["manual", "priority", "title", "created", "updated", "dueDate"] as const;
/** The inline properties a list row can show; the display bar toggles them. */
export const displayProperties = ["id", "state", "priority", "assignee", "labels", "dates", "cycle", "modules"] as const;
export type DisplayProperty = (typeof displayProperties)[number];

export interface LayoutParams {
  layout: (typeof layouts)[number];
  group: (typeof groupings)[number];
  state: string[];
  priority: string[];
  assignee: string[];
  label: string[];
  /** One Module id, or "" for no Module filter. */
  module: string;
  sort: (typeof sortFields)[number];
  dir: "asc" | "desc";
  /** "pql" sends `q` as the query and leaves the normal filters out of the request. */
  mode: (typeof filterModes)[number];
  q: string;
  /** The visible row properties, in display order. */
  props: DisplayProperty[];
}

export const defaultParams: LayoutParams = { layout: "list", group: "state", state: [], priority: [], assignee: [], label: [], module: "", sort: "manual", dir: "asc", mode: "filters", q: "", props: [...displayProperties] };

const pick = <T extends string>(allowed: readonly T[], value: string | null, fallback: T): T => (allowed as readonly string[]).includes(value ?? "") ? value as T : fallback;
const many = (value: string | null) => (value ?? "").split(",").filter(Boolean);

/** Reads the layout and display settings from a URL query string; anything unknown falls back to the default. */
export function parseLayoutParams(search: string): LayoutParams {
  const query = new URLSearchParams(search);
  const props = query.get("props");
  return {
    layout: pick(layouts, query.get("layout"), defaultParams.layout), group: pick(groupings, query.get("group"), defaultParams.group),
    state: many(query.get("state")), priority: many(query.get("priority")), assignee: many(query.get("assignee")), label: many(query.get("label")), module: query.get("module") ?? "",
    sort: pick(sortFields, query.get("sort"), defaultParams.sort), dir: query.get("dir") === "desc" ? "desc" : "asc",
    mode: pick(filterModes, query.get("mode"), defaultParams.mode), q: query.get("q") ?? "",
    props: props === null ? [...displayProperties] : displayProperties.filter((property) => many(props).includes(property)),
  };
}

/** Writes only the settings that differ from the defaults, so the plain project URL stays clean. */
export function serializeLayoutParams(params: LayoutParams): string {
  const query = new URLSearchParams();
  if (params.layout !== defaultParams.layout) query.set("layout", params.layout);
  if (params.group !== defaultParams.group) query.set("group", params.group);
  for (const key of ["state", "priority", "assignee", "label"] as const) if (params[key].length) query.set(key, params[key].join(","));
  if (params.module) query.set("module", params.module);
  if (params.sort !== defaultParams.sort) query.set("sort", params.sort);
  if (params.dir !== defaultParams.dir) query.set("dir", params.dir);
  if (params.mode !== defaultParams.mode) query.set("mode", params.mode);
  if (params.q !== defaultParams.q) query.set("q", params.q);
  if (params.props.join(",") !== defaultParams.props.join(",")) query.set("props", params.props.join(","));
  const text = query.toString();
  return text ? `?${text}` : "";
}

interface Groupable { id: string; stateId: string; priority: string; assigneeIds: string[] }
export interface ItemGroup<T> { key: string; items: T[] }

/** Splits ordered items into groups; an item with several assignees appears under each, with none under "none". */
export function groupItems<T extends Groupable>(items: T[], group: LayoutParams["group"], stateIds: string[]): ItemGroup<T>[] {
  if (group === "none") return [{ key: "all", items }];
  if (group === "state") return stateIds.map((id) => ({ key: id, items: items.filter((item) => item.stateId === id) }));
  if (group === "priority") return priorityOrder.map((key) => ({ key, items: items.filter((item) => item.priority === key) }));
  const assignees = [...new Set(items.flatMap((item) => item.assigneeIds))];
  return [...assignees.map((key) => ({ key, items: items.filter((item) => item.assigneeIds.includes(key)) })), { key: "none", items: items.filter((item) => item.assigneeIds.length === 0) }];
}
