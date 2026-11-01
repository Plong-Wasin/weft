export const priorityOrder = ["urgent", "high", "medium", "low", "none"] as const;
export const viewModes = ["list", "kanban"] as const;
export const groupings = ["none", "state", "priority", "assignee"] as const;
export const sortFields = ["manual", "priority", "title", "created", "updated", "dueDate"] as const;

export interface ViewParams {
  view: (typeof viewModes)[number];
  group: (typeof groupings)[number];
  state: string[];
  priority: string[];
  assignee: string[];
  label: string[];
  sort: (typeof sortFields)[number];
  dir: "asc" | "desc";
}

export const defaultParams: ViewParams = { view: "list", group: "none", state: [], priority: [], assignee: [], label: [], sort: "manual", dir: "asc" };

const pick = <T extends string>(allowed: readonly T[], value: string | null, fallback: T): T => (allowed as readonly string[]).includes(value ?? "") ? value as T : fallback;
const many = (value: string | null) => (value ?? "").split(",").filter(Boolean);

/** Reads the work item view settings from a URL query string; anything unknown falls back to the default. */
export function parseViewParams(search: string): ViewParams {
  const query = new URLSearchParams(search);
  return {
    view: pick(viewModes, query.get("view"), defaultParams.view), group: pick(groupings, query.get("group"), defaultParams.group),
    state: many(query.get("state")), priority: many(query.get("priority")), assignee: many(query.get("assignee")), label: many(query.get("label")),
    sort: pick(sortFields, query.get("sort"), defaultParams.sort), dir: query.get("dir") === "desc" ? "desc" : "asc",
  };
}

/** Writes only the settings that differ from the defaults, so the plain project URL stays clean. */
export function serializeViewParams(params: ViewParams): string {
  const query = new URLSearchParams();
  if (params.view !== defaultParams.view) query.set("view", params.view);
  if (params.group !== defaultParams.group) query.set("group", params.group);
  for (const key of ["state", "priority", "assignee", "label"] as const) if (params[key].length) query.set(key, params[key].join(","));
  if (params.sort !== defaultParams.sort) query.set("sort", params.sort);
  if (params.dir !== defaultParams.dir) query.set("dir", params.dir);
  const text = query.toString();
  return text ? `?${text}` : "";
}

interface Groupable { id: string; stateId: string; priority: string; assigneeIds: string[] }
export interface ItemGroup<T> { key: string; items: T[] }

/** Splits ordered items into groups; an item with several assignees appears under each, with none under "none". */
export function groupItems<T extends Groupable>(items: T[], group: ViewParams["group"], stateIds: string[]): ItemGroup<T>[] {
  if (group === "none") return [{ key: "all", items }];
  if (group === "state") return stateIds.map((id) => ({ key: id, items: items.filter((item) => item.stateId === id) }));
  if (group === "priority") return priorityOrder.map((key) => ({ key, items: items.filter((item) => item.priority === key) }));
  const assignees = [...new Set(items.flatMap((item) => item.assigneeIds))];
  return [...assignees.map((key) => ({ key, items: items.filter((item) => item.assigneeIds.includes(key)) })), { key: "none", items: items.filter((item) => item.assigneeIds.length === 0) }];
}
