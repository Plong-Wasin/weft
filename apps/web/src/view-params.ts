import { displayProperties, layouts, groupings, sortFields, type DisplayProperty, type LayoutParams } from "./work-item-layout";

/** A saved View as the registry returns it. */
export type SavedView = {
  id: string; projectId: string | null; scope: "project" | "workspace"; workspaceId: string; name: string; description: string; query: string; layout: string; groupBy: string; subGroupBy?: string; orderBy: string; orderDirection: string;
  properties: string[]; access: "public" | "private"; ownerId: string; createdAt: string; updatedAt: string;
};

/** The settings a View stores, as the fields `create_view` and `update_view` take. */
export type ViewSettings = { query: string; layout: LayoutParams["layout"]; groupBy: LayoutParams["group"]; subGroupBy: LayoutParams["subGroup"]; orderBy: LayoutParams["sort"]; orderDirection: LayoutParams["dir"]; properties: DisplayProperty[] };

const known = <T extends string>(allowed: readonly T[], value: string, fallback: T): T => (allowed as readonly string[]).includes(value) ? value as T : fallback;

/** The Layout settings a View reopens with. */
export function viewToParams(view: SavedView): LayoutParams {
  const group = known(groupings, view.groupBy, "state");
  const subGroup = known(groupings, view.subGroupBy ?? "none", "none");
  return {
    layout: known(layouts, view.layout, "list"), group, subGroup: subGroup === group ? "none" : subGroup, sort: known(sortFields, view.orderBy, "manual"),
    dir: view.orderDirection === "desc" ? "desc" : "asc", q: view.query, props: view.properties.filter((property): property is DisplayProperty => (displayProperties as readonly string[]).includes(property)),
  };
}

export function paramsToSettings(params: LayoutParams): ViewSettings {
  return { query: params.q, layout: params.layout, groupBy: params.group, subGroupBy: params.subGroup === params.group ? "none" : params.subGroup, orderBy: params.sort, orderDirection: params.dir, properties: params.props };
}

/** True when the applied Layout settings differ from what the View stores. */
export function differsFromView(view: SavedView, params: LayoutParams): boolean {
  const saved = viewToParams(view);
  return saved.layout !== params.layout || saved.group !== params.group || saved.sort !== params.sort || saved.dir !== params.dir || saved.q.trim() !== params.q.trim()
    || saved.props.join(",") !== params.props.join(",") || saved.subGroup !== params.subGroup;
}
