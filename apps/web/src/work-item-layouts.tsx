import { accessReasonText } from "./access-reason";
import React from "react";
import { Link } from "react-router";
import { ArrowLeft, ArrowRight, BarChart3, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Columns3, List, Package, Plus, RefreshCw, SlidersHorizontal, Table2, Tag, Users } from "lucide-react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { calendarPlacement, completeGroups, displayProperties, effectiveSubGroup, ganttPlacement, groupItems, groupings, moveProperty, parseLayoutParams, serializeLayoutParams, priorityOrder, sortFields, type DisplayProperty, type GanttZoom, type LayoutParams } from "./work-item-layout";
import { paths } from "./routes";
import { Popover } from "./shell/popover";
import { WorkItemDetail } from "./work-item-detail";
import { Board, type BoardColumn } from "./work-item-board";
import { BulkBar } from "./work-item-bulk-bar";
import { FilterChips, FilterPicker, FilterQueryEditor, FilterQueryToggle, type FilterSection } from "./filter-bar";
import { countFilters, emptyFilters, filtersToFilterQuery, filterQueryToFilters, type Filters, type Lookup } from "./filter-query";
import { DatesMenu, EstimateSelect, MultiSelect, PriorityIcon, SingleSelect, StateIcon } from "./property-dropdowns";
import { Avatar } from "./avatar";
import { EmptyState } from "./empty-state";
import type { Estimate, StateGroup } from "./types";
import { TypeIconMark, type WorkItemType } from "./work-item-types";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
type State = { id: string; name: string; group: StateGroup };
type Person = { userId: string; name: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null; accessAsk?: "owner" | "admin" | null; accessOwnerName?: string | null };
type Label = { id: string; name: string; color: string };
type Item = { id: string; displayId: string; title: string; stateId: string; priority: string; estimatePointId?: string | null; assigneeIds: string[]; labelIds: string[]; createdBy: string; startDate: string | null; dueDate: string | null };
type Named = { id: string; name: string; status?: string };
const t = (key: string) => translate(key as MessageKey);
const ghost = "flex items-center gap-1.5 rounded-lg border border-transparent bg-layer-1 px-2.5 py-1 text-13 font-medium text-secondary hover:bg-layer-transparent-hover hover:text-primary";
const checkRow = "flex items-center gap-2 text-13";

/** Work items of one project in a layout (list or board) with display options and filters; every setting lives in the URL query string. */
export function WorkItemLayouts({ projectId, workspaceSlug, action, run: runProp, refreshKey, cycleId, moduleId, cyclesEnabled, modulesEnabled, typesEnabled = false, canWrite = true, canCreate = false, onAddItem, rowAction, toolbarExtra }: { projectId: string; workspaceSlug: string; action: Call; run?: Run; refreshKey: number; cycleId?: string; moduleId?: string; cyclesEnabled?: boolean; typesEnabled?: boolean; modulesEnabled?: boolean; canWrite?: boolean; canCreate?: boolean; /** Opens the Create work item dialog. Passed by the project Work items page only: it turns on the empty-project state, whose button needs it. */ onAddItem?: () => void; rowAction?: (item: Item) => React.ReactNode; /** Extra toolbar controls after Display (Save as view, Update view); gets the settings now applied. */ toolbarExtra?: (params: LayoutParams) => React.ReactNode }) {
  // Every page passes an error-aware `run` so a filter query error shows; the fallback over `action` drops the server message and is only for callers that have no runner.
  const run: Run = React.useMemo(() => runProp ?? (async <T,>(name: string, body: unknown) => { const data = await action<T>(name, body); return data === null ? { error: "" } : { data }; }), [runProp, action]);
  const [params, setParams] = React.useState<LayoutParams>(() => parseLayoutParams(window.location.search));
  const [calendarMonth, setCalendarMonth] = React.useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [ganttZoom, setGanttZoom] = React.useState<GanttZoom>("month");
  const [ganttAnchor, setGanttAnchor] = React.useState(() => new Date());
  const ganttPointerStart = React.useRef<{ x: number } | null>(null);
  /** `at` is a day delta for "move" and a day index for the "start" and "due" edges. */
  type GanttPreview = { id: string; kind: "move" | "start" | "due"; at: number };
  /** Preview of the bar being dragged now. */
  const [ganttDrag, setGanttDrag] = React.useState<GanttPreview | null>(null);
  /** Previews of released bars whose save is still running, so a bar never snaps back before the server answers. */
  const [ganttSaving, setGanttSaving] = React.useState<Record<string, GanttPreview>>({});
  const [items, setItems] = React.useState<Item[]>([]);
  // Set once the first list has arrived, so an empty project is not announced while the list is still loading or after it failed to load.
  const [loaded, setLoaded] = React.useState(false);
  const [states, setStates] = React.useState<State[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [estimate, setEstimate] = React.useState<Estimate | null>(null);
  const [moduleOptions, setModuleOptions] = React.useState<Named[]>([]);
  const [cycleOptions, setCycleOptions] = React.useState<Named[]>([]);
  const [cycleOf, setCycleOf] = React.useState<Record<string, string>>({});
  const [modulesOf, setModulesOf] = React.useState<Record<string, string[]>>({});
  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  /** Empty groups start collapsed; the ones listed here were expanded on purpose. */
  const [expandedEmpty, setExpandedEmpty] = React.useState<string[]>([]);
  const [quick, setQuick] = React.useState<string | null>(null);
  const [quickTitle, setQuickTitle] = React.useState("");
  const [collapsedColumns, setCollapsedColumns] = React.useState<string[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  /** Ids picked for a Bulk edit, in the order they were picked; `anchor` is the last one clicked, where a shift-click range starts. */
  const [selected, setSelected] = React.useState<string[]>([]);
  const anchor = React.useRef<string | null>(null);
  /** Width of the list box, measured so each row knows whether its properties fit on the title's line. */
  const [listBox, setListBox] = React.useState<HTMLElement | null>(null);
  const [listWidth, setListWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!listBox) return;
    setListWidth(listBox.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setListWidth(listBox.clientWidth));
    observer.observe(listBox);
    return () => observer.disconnect();
  }, [listBox]);
  const [filterQueryOpen, setFilterQueryOpen] = React.useState(false);
  const [lookupsLoaded, setLookupsLoaded] = React.useState({ base: false, cycles: false, modules: false, types: false });
  const [typeOptions, setTypeOptions] = React.useState<WorkItemType[]>([]);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  const [peek, setPeekState] = React.useState<string | null>(() => new URLSearchParams(window.location.search).get("peek"));
  const urlFor = (next: LayoutParams, peekId: string | null) => {
    const query = serializeLayoutParams(next);
    return `${window.location.pathname}${peekId ? `${query ? `${query}&` : "?"}peek=${encodeURIComponent(peekId)}` : query}`;
  };
  const update = (patch: Partial<LayoutParams>) => {
    const next = { ...params, ...patch };
    window.history.pushState(null, "", urlFor(next, peek));
    setParams(next);
  };
  /** Opens a work item in the peek panel (or closes it with null); the id lives in the URL so a reload keeps the peek. */
  const setPeek = (id: string | null) => {
    window.history.pushState(null, "", urlFor(params, id));
    setPeekState(id);
  };
  const openPeek = (displayId: string) => (event: React.MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setPeek(displayId);
  };
  React.useEffect(() => {
    if (!peek) return;
    // Escape closes the peek, unless it is closing an open dropdown first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[data-peek] [role="menu"], [data-peek] [role="dialog"]')) return;
      setPeek(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  React.useEffect(() => {
    const onPop = () => { setParams(parseLayoutParams(window.location.search)); setPeekState(new URLSearchParams(window.location.search).get("peek")); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  React.useEffect(() => {
    void (async () => {
      setStates(await action<State[]>("list_states", { projectId }) ?? []);
      setLabels(await action<Label[]>("list_labels", { projectId }) ?? []);
      setPeople(await action<Person[]>("list_project_members", { projectId }) ?? []);
      setEstimate(await action<Estimate | null>("get_estimate", { projectId }) ?? null);
      setLookupsLoaded((loaded) => ({ ...loaded, base: true }));
    })();
  }, [projectId]);
  React.useEffect(() => {
    const refreshMembers = () => { void action<Person[]>("list_project_members", { projectId }).then((rows) => setPeople(rows ?? [])); };
    window.addEventListener("focus", refreshMembers);
    return () => window.removeEventListener("focus", refreshMembers);
  }, [projectId]);
  React.useEffect(() => {
    if (!modulesEnabled) { setModuleOptions([]); return setLookupsLoaded((loaded) => ({ ...loaded, modules: true })); }
    void action<Named[]>("list_modules", { projectId }).then((rows) => { setModuleOptions(rows ?? []); setLookupsLoaded((loaded) => ({ ...loaded, modules: true })); });
  }, [projectId, modulesEnabled, action, refreshKey]);
  React.useEffect(() => {
    if (!typesEnabled) { setTypeOptions([]); return setLookupsLoaded((loaded) => ({ ...loaded, types: true })); }
    void action<WorkItemType[]>("list_work_item_types", { projectId }).then((rows) => { setTypeOptions(rows ?? []); setLookupsLoaded((loaded) => ({ ...loaded, types: true })); });
  }, [projectId, typesEnabled, action, refreshKey]);
  React.useEffect(() => {
    if (!cyclesEnabled) { setCycleOptions([]); return setLookupsLoaded((loaded) => ({ ...loaded, cycles: true })); }
    void action<Named[]>("list_cycles", { projectId }).then((rows) => { setCycleOptions(rows ?? []); setLookupsLoaded((loaded) => ({ ...loaded, cycles: true })); });
  }, [projectId, cyclesEnabled, action, refreshKey]);
  // The work item payload carries no Cycle or Module, so a row learns its memberships from one listing per Cycle or Module.
  const showCycle = !!cyclesEnabled && !cycleId && (params.props.includes("cycle") || params.group === "cycle" || params.subGroup === "cycle");
  const showModules = !!modulesEnabled && !moduleId && (params.props.includes("modules") || params.group === "module" || params.subGroup === "module");
  React.useEffect(() => {
    if (!showCycle) return setCycleOf({});
    void (async () => {
      const next: Record<string, string> = {};
      for (const cycle of cycleOptions) for (const item of await action<Item[]>("list_work_items", { projectId, cycleId: cycle.id }) ?? []) next[item.id] = cycle.id;
      setCycleOf(next);
    })();
  }, [showCycle, cycleOptions, projectId, action, refreshKey]);
  React.useEffect(() => {
    if (!showModules) return setModulesOf({});
    void (async () => {
      const next: Record<string, string[]> = {};
      for (const module of moduleOptions) for (const item of await action<Item[]>("list_work_items", { projectId, moduleId: module.id }) ?? []) next[item.id] = [...next[item.id] ?? [], module.id];
      setModulesOf(next);
    })();
  }, [showModules, moduleOptions, projectId, action, refreshKey]);

  const board = params.layout === "board";
  const supportsSubGroup = params.layout === "board" || params.layout === "list";
  /** The board always has columns, so "no grouping" falls back to State. */
  const boardGroup = params.group === "none" ? "state" : params.group;
  const sheet = params.layout === "spreadsheet";
  // The spreadsheet is one flat table, so it ignores group by.
  const grouping = sheet ? "none" : board ? boardGroup : params.group;
  /** The Sub-group in effect: never the same property as the Group-by the layout really uses, and only where the layout supports one. */
  const subGroup = supportsSubGroup ? effectiveSubGroup(grouping, params.subGroup) : "none";
  // The filter is always sent as a filter query; an invalid query leaves the last result on screen and shows the server's message.
  const fetchItems = React.useCallback((query: string) => run<Item[]>("list_work_items", {
    projectId, ...(cycleId ? { cycleId } : {}), ...(moduleId ? { moduleId } : {}), ...(query.trim() ? { query } : {}),
    sort: board ? "manual" : params.sort, direction: board ? "asc" : params.dir,
  }), [projectId, cycleId, moduleId, board, params.sort, params.dir, run]);
  const load = React.useCallback(async () => {
    const result = await fetchItems(params.q);
    if ("error" in result) { setQueryError(params.q.trim() ? result.error : null); return false; }
    setQueryError(null);
    setItems(result.data);
    setLoaded(true);
    return true;
  }, [fetchItems, params.q]);
  // A different project, cycle or module starts again as not loaded; this effect is declared before the load so its reset never lands after the new list.
  React.useEffect(() => { setLoaded(false); }, [projectId, cycleId, moduleId]);
  React.useEffect(() => { void load(); }, [load, refreshKey]);
  // A selection never outlives its context: another project, layout or filter clears it, and items that left the list (archived, deleted, filtered out) drop out of it.
  React.useEffect(() => { setSelected([]); anchor.current = null; }, [projectId, params.layout, params.q, cycleId, moduleId]);
  React.useEffect(() => setSelected((ids) => ids.every((id) => items.some((row) => row.id === id)) ? ids : ids.filter((id) => items.some((row) => row.id === id))), [items]);
  React.useEffect(() => {
    if (selected.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || peek || document.querySelector('[role="menu"], [role="dialog"]') || (event.target as HTMLElement | null)?.closest("input:not([type=checkbox]), textarea, select")) return;
      setSelected([]); anchor.current = null;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected.length, peek]);

  const fail = () => setNote(t("workItems.failed"));
  const change = async (item: Item, body: Record<string, unknown>) => {
    const updated = await action<Item>("update_work_item", { workItemId: item.id, ...body });
    if (!updated) return fail();
    setNote(null);
    setItems((rows) => rows.map((row) => row.id === item.id ? { ...row, ...updated } : row));
  };
  const setCycle = async (item: Item, to: string) => {
    const from = cycleOf[item.id];
    if (from === (to || undefined)) return;
    if (from && await action("remove_cycle_items", { cycleId: from, workItemIds: [item.id] }) === null) return fail();
    if (to) {
      const added = await action<{ added: string[] }>("add_cycle_items", { cycleId: to, workItemIds: [item.id] });
      if (!added?.added.includes(item.id)) { await load(); return fail(); }
    }
    setNote(null);
    setCycleOf((map) => { const { [item.id]: _gone, ...rest } = map; return to ? { ...rest, [item.id]: to } : rest; });
  };
  const setModule = async (item: Item, id: string, on: boolean) => {
    if (await action(on ? "add_module_items" : "remove_module_items", { moduleId: id, workItemIds: [item.id] }) === null) return fail();
    setNote(null);
    setModulesOf((map) => ({ ...map, [item.id]: on ? [...map[item.id] ?? [], id] : (map[item.id] ?? []).filter((other) => other !== id) }));
  };
  const create = async (groupKey: string) => {
    const title = quickTitle.trim();
    if (!title) return;
    const preset = grouping === "state" ? { stateId: groupKey } : grouping === "priority" ? { priority: groupKey } : grouping === "assignee" && groupKey !== "none" ? { assigneeIds: [groupKey] } : {};
    const created = await action<Item>("create_work_item", { projectId, title, ...preset });
    if (!created) return fail();
    setNote(null);
    setQuickTitle("");
    await load();
  };
  const createForDate = async (date: string) => {
    const title = quickTitle.trim();
    if (!title) return;
    const created = await action<Item>("create_work_item", { projectId, title, dueDate: date });
    if (!created) return fail();
    setNote(null); setQuickTitle(""); setQuick(null); await load();
  };
  const reschedule = async (id: string, dueDate: string) => {
    const item = items.find((row) => row.id === id);
    if (!item || item.dueDate?.slice(0, 10) === dueDate) return;
    const result = await run<Item>("update_work_item", { workItemId: id, dueDate });
    if ("error" in result) { setNote(result.error || t("workItems.failed")); return; }
    setNote(null);
    setItems((rows) => rows.map((row) => row.id === id ? { ...row, ...result.data } : row));
  };
  const gantt = ganttPlacement(items, ganttAnchor, ganttZoom);
  const shiftGanttAnchor = (direction: -1 | 1) => setGanttAnchor((date) => ganttZoom === "week"
    ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + direction * 14)
    : ganttZoom === "month" ? new Date(date.getFullYear(), date.getMonth() + direction, 1)
      : new Date(date.getFullYear(), date.getMonth() + direction * 3, 1));
  const ganttEdgeStart = React.useRef<{ x: number } | null>(null);
  const ganttLastDay = gantt.days[gantt.days.length - 1]!;
  const startClipped = (item: Item) => (item.startDate ?? item.dueDate ?? "").slice(0, 10) < gantt.start;
  const dueClipped = (item: Item) => (item.dueDate ?? item.startDate ?? "").slice(0, 10) > ganttLastDay;
  /** Keeps the same object when nothing changed, so a pointermove inside one day does not re-render the whole layout. */
  const showGanttDrag = (next: GanttPreview) => setGanttDrag((prev) => prev && prev.id === next.id && prev.kind === next.kind && prev.at === next.at ? prev : next);
  const clearGanttDrag = () => setGanttDrag(null);
  /** Moves a released drag to the saving slot, where a press on another bar cannot wipe it. Returns the function that drops it once the request is answered. */
  const saveGanttPreview = (preview: GanttPreview) => {
    setGanttSaving((rows) => ({ ...rows, [preview.id]: preview }));
    clearGanttDrag();
    return () => setGanttSaving((rows) => rows[preview.id] === preview ? Object.fromEntries(Object.entries(rows).filter(([id]) => id !== preview.id)) : rows);
  };
  const ganttEdgePreview = (event: React.PointerEvent<HTMLSpanElement>, item: Item, edge: "start" | "due") => {
    const started = ganttEdgeStart.current;
    const timeline = event.currentTarget.parentElement?.parentElement;
    if (!started || !timeline) return;
    if (Math.abs(event.clientX - started.x) < 3) { clearGanttDrag(); return; }
    const bounds = timeline.getBoundingClientRect();
    const day = Math.max(0, Math.min(gantt.days.length - 1, Math.floor((event.clientX - bounds.left) / bounds.width * gantt.days.length)));
    showGanttDrag({ id: item.id, kind: edge, at: day });
  };
  const ganttMovePreview = (event: React.PointerEvent<HTMLDivElement>, item: Item) => {
    const initial = ganttPointerStart.current;
    const timeline = event.currentTarget.parentElement;
    if (!initial || !timeline) return;
    if (Math.abs(event.clientX - initial.x) < 3) { clearGanttDrag(); return; }
    const bounds = timeline.getBoundingClientRect();
    showGanttDrag({ id: item.id, kind: "move", at: Math.round((event.clientX - initial.x) / bounds.width * gantt.days.length) });
  };
  /** The preview stays until the update answers, so the bar does not jump back to its old place while the request runs. */
  const ganttResize = (event: React.PointerEvent<HTMLSpanElement>, item: Item, edge: "start" | "due") => {
    const started = ganttEdgeStart.current;
    ganttEdgeStart.current = null;
    if (!started || Math.abs(event.clientX - started.x) < 3) { clearGanttDrag(); return; }
    const timeline = event.currentTarget.parentElement?.parentElement;
    if (!timeline) { clearGanttDrag(); return; }
    const bounds = timeline.getBoundingClientRect();
    const day = Math.max(0, Math.min(gantt.days.length - 1, Math.floor((event.clientX - bounds.left) / bounds.width * gantt.days.length)));
    const date = gantt.days[day]!;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const saved = saveGanttPreview({ id: item.id, kind: edge, at: day });
    void run<Item>("update_work_item", { workItemId: item.id, [edge === "start" ? "startDate" : "dueDate"]: date }).then((result) => {
      saved();
      if ("error" in result) { setNote(result.error || t("workItems.failed")); return; }
      setNote(null); setItems((rows) => rows.map((row) => row.id === item.id ? { ...row, ...result.data } : row));
    }).finally(saved);
  };
  const ganttResizeByKeyboard = async (item: Item, edge: "start" | "due", delta: -1 | 1) => {
    const field = edge === "start" ? "startDate" : "dueDate";
    const source = item[field] ?? item[edge === "start" ? "dueDate" : "startDate"];
    if (!source) return;
    const next = new Date(`${source.slice(0, 10)}T12:00:00`);
    next.setDate(next.getDate() + delta);
    const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
    if (edge === "start" && item.dueDate && date > item.dueDate.slice(0, 10)) return setNote(t("layout.gantt.invalidRange"));
    if (edge === "due" && item.startDate && date < item.startDate.slice(0, 10)) return setNote(t("layout.gantt.invalidRange"));
    const result = await run<Item>("update_work_item", { workItemId: item.id, [field]: date });
    if ("error" in result) { setNote(result.error || t("workItems.failed")); return; }
    setNote(null);
    setItems((rows) => rows.map((row) => row.id === item.id ? { ...row, ...result.data } : row));
  };
  const ganttMove = (event: React.PointerEvent<HTMLDivElement>, item: Item) => {
    const initial = ganttPointerStart.current;
    ganttPointerStart.current = null;
    // An edge handle's pointerup bubbles here with no press recorded: it must leave the edge's own preview alone.
    if (!initial) return;
    if (Math.abs(event.clientX - initial.x) < 3) { clearGanttDrag(); return; }
    const timeline = event.currentTarget.parentElement;
    if (!timeline) { clearGanttDrag(); return; }
    const bounds = timeline.getBoundingClientRect();
    const delta = Math.round((event.clientX - initial.x) / bounds.width * gantt.days.length);
    if (!delta) { clearGanttDrag(); return; }
    const shift = (value: string) => {
      const next = new Date(`${value.slice(0, 10)}T12:00:00`);
      next.setDate(next.getDate() + delta);
      return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
    };
    const body = {
      ...(item.startDate ? { startDate: shift(item.startDate) } : {}),
      ...(item.dueDate ? { dueDate: shift(item.dueDate) } : {}),
    };
    if (!item.startDate && !item.dueDate) { clearGanttDrag(); return; }
    const saved = saveGanttPreview({ id: item.id, kind: "move", at: delta });
    void run<Item>("update_work_item", { workItemId: item.id, ...body }).then((result) => {
      saved();
      if ("error" in result) { setNote(result.error || t("workItems.failed")); return; }
      setNote(null); setItems((rows) => rows.map((row) => row.id === item.id ? { ...row, ...result.data } : row));
    }).finally(saved);
  };
  /** A card dropped in a column: State columns move it through `move_work_item` (state and order); Priority and Assignee columns change that property. */
  const dropCard = async (id: string, column: string, beforeId: string | null, sourceColumn: string) => {
    const item = items.find((row) => row.id === id);
    if (!item || id === beforeId) return false;
    let result: unknown;
    if (boardGroup === "state") result = await action("move_work_item", { workItemId: id, stateId: column, ...(beforeId ? { beforeId } : {}) });
    else if (boardGroup === "priority") { if (item.priority === column) return false; result = await action("update_work_item", { workItemId: id, priority: column }); }
    else if (boardGroup === "assignee") { if (sourceColumn === column || (item.assigneeIds.length === 0 && column === "none") || (item.assigneeIds.length === 1 && item.assigneeIds[0] === column)) return false; result = await action("update_work_item", { workItemId: id, assigneeIds: column === "none" ? [] : [column] }); }
    else return false;
    const refreshed = await load();
    setNote(result === null ? t("workItems.failed") : refreshed ? null : t("board.refreshFailed"));
    return result !== null && refreshed;
  };

  const personName = (id: string) => people.find((person) => person.userId === id)?.name ?? id;
  const isAgentId = (id: string) => people.find((person) => person.userId === id)?.isAgent;
  const labelFor = (grouping: LayoutParams["group"], key: string) => grouping === "state" ? states.find((state) => state.id === key)?.name ?? key
    : grouping === "priority" ? t(`workItems.priority.${key}`)
    : grouping === "type" ? typeOptions.find((type) => type.id === key)?.name ?? (key === "none" ? t("types.none") : key)
    : grouping === "label" ? labels.find((label) => label.id === key)?.name ?? (key === "none" ? t("layout.noLabel") : key)
    : grouping === "cycle" ? cycleOptions.find((cycle) => cycle.id === key)?.name ?? (key === "none" ? t("workItems.noCycle") : key)
    : grouping === "module" ? moduleOptions.find((module) => module.id === key)?.name ?? (key === "none" ? t("workItems.noModules") : key)
    : grouping === "dueDate" ? t(`layout.dueDate.${key}`)
    : key === "none" ? t("layout.unassigned") : personName(key);
  const groupLabel = (key: string) => labelFor(params.group, key);
  const groupIconFor = (grouping: string, key: string) => grouping === "state" ? <StateIcon group={states.find((state) => state.id === key)?.group ?? "unstarted"} />
    : grouping === "priority" ? <PriorityIcon priority={key} />
    : grouping === "type" && typeOptions.find((type) => type.id === key) ? <TypeIconMark icon={typeOptions.find((type) => type.id === key)!.icon} color={typeOptions.find((type) => type.id === key)!.color} />
    : grouping === "label" ? labels.find((label) => label.id === key) ? <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: labels.find((label) => label.id === key)!.color }} /> : null
    : grouping === "cycle" ? <RefreshCw aria-hidden size={14} className="text-secondary" />
    : grouping === "module" ? <Package aria-hidden size={14} className="text-secondary" />
    : grouping === "creator" && key !== "none" ? <Avatar name={personName(key)} id={key} agent={isAgentId(key)} /> : null;
  const groupIcon = (key: string) => groupIconFor(params.group, key);
  const stateIds = states.map((state) => state.id);
  const lookup: Lookup = {
    state: states, label: labels, assignee: people.map((person) => ({ id: person.userId, name: person.name })), createdBy: people.map((person) => ({ id: person.userId, name: person.name })),
    estimate: estimate?.enabled ? estimate.points.map((point) => ({ id: point.id, name: point.value })) : [],
    cycle: cyclesEnabled && !cycleId ? cycleOptions : [], module: modulesEnabled && !moduleId ? moduleOptions : [],
    type: typesEnabled ? typeOptions.map((type) => ({ id: type.id, name: type.name })) : [],
  };
  const lookupsReady = lookupsLoaded.base && lookupsLoaded.cycles && lookupsLoaded.modules && lookupsLoaded.types;
  // Chips are read from the applied filter query; null means it says something the chips cannot show.
  const chips: Filters | null = !params.q.trim() ? emptyFilters() : lookupsReady ? filterQueryToFilters(params.q, lookup) : emptyFilters();
  const filterCount = chips ? countFilters(chips) : 1;
  const filtered = params.q.trim() !== "";
  const sections: FilterSection[] = [
    { key: "state", options: states.map((state) => ({ id: state.id, name: state.name, icon: <StateIcon group={state.group} /> })) },
    { key: "priority", options: priorityOrder.map((id) => ({ id, name: t(`workItems.priority.${id}`), icon: <PriorityIcon priority={id} /> })) },
    ...(typesEnabled ? [{ key: "type" as const, options: typeOptions.map((type) => ({ id: type.id, name: type.name, icon: <TypeIconMark icon={type.icon} color={type.color} /> })) }] : []),
    ...(estimate?.enabled ? [{ key: "estimate" as const, options: estimate.points.map((point) => ({ id: point.id, name: point.value })) }] : []),
    { key: "assignee", options: [{ id: "none", name: t("layout.unassigned") }, ...people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} />, isAgent: person.isAgent, codeCapable: person.codeCapable, hasAccess: person.hasAccess, accessReason: accessReasonText(person) }))] },
    { key: "label", options: labels.map((label) => ({ id: label.id, name: label.name, icon: <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} /> })) },
    ...(cyclesEnabled && !cycleId ? [{ key: "cycle" as const, options: cycleOptions.map((cycle) => ({ id: cycle.id, name: cycle.name })) }] : []),
    ...(modulesEnabled && !moduleId ? [{ key: "module" as const, options: moduleOptions.map((module) => ({ id: module.id, name: module.name })) }] : []),
    { key: "createdBy", options: people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} /> })) },
  ];
  const setFilters = (next: Filters) => update({ q: filtersToFilterQuery(next, lookup) });
  const applyFilterQuery = async (text: string) => {
    const result = await fetchItems(text);
    if ("error" in result) return setQueryError(result.error || t("workItems.failed"));
    setQueryError(null);
    setItems(result.data);
    update({ q: text.trim() });
  };
  const shows = (property: DisplayProperty) => params.props.includes(property);
  const readOnly = !canWrite;
  const showEstimate = !!estimate?.enabled && shows("estimate");
  const listShows = (property: DisplayProperty) => property === "estimate" ? showEstimate : property === "cycle" ? showCycle : property === "modules" ? showModules : shows(property);

  /** `compact` (board cards) shows an empty property as its icon alone. */
  const cellOf = (item: Item, property: DisplayProperty, compact = false, rowQuiet = false, iconOnly = false): React.ReactNode => {
    const assignees = item.assigneeIds;
    const mine = modulesOf[item.id] ?? [];
    switch (property) {
      case "state": return <SingleSelect label={t("workItems.state")} summary={states.find((state) => state.id === item.stateId)?.name ?? ""} value={item.stateId} readOnly={readOnly} quiet={rowQuiet} iconOnly={iconOnly} hideIconOnlyTextOnPhone={iconOnly}
          icon={<StateIcon group={states.find((state) => state.id === item.stateId)?.group ?? "unstarted"} />}
          options={states.map((state) => ({ id: state.id, name: state.name, icon: <StateIcon group={state.group} /> }))} onSelect={(stateId) => void change(item, { stateId })} />;
      case "priority": return <SingleSelect label={t("workItems.priority")} iconOnly={iconOnly || (compact && item.priority === "none")} quiet={rowQuiet} summary={t(`workItems.priority.${item.priority}`)} display={rowQuiet && item.priority === "none" && !iconOnly ? "—" : undefined} value={item.priority} readOnly={readOnly} icon={<PriorityIcon priority={item.priority} />} hideIconOnlyTextOnPhone={iconOnly}
          options={priorityOrder.map((id) => ({ id, name: t(`workItems.priority.${id}`), icon: <PriorityIcon priority={id} /> }))} onSelect={(priority) => void change(item, { priority })} />;
      case "assignee": return <MultiSelect label={t("workItems.assignees")} readOnly={readOnly} selected={assignees} quiet={rowQuiet} searchAlways onOpen={() => { void action<Person[]>("list_project_members", { projectId }).then((rows) => rows && setPeople(rows)); }} icon={assignees.length === 0 ? <Users aria-hidden size={14} className="text-secondary" /> : undefined}
          summary={assignees.length === 0 ? rowQuiet ? <span className="text-tertiary">—</span> : compact ? <span className="hidden text-11 max-sm:inline">{t("workItems.noAssignee")}</span> : <span className="text-secondary">{t("workItems.noAssignee")}</span> : <span className="flex items-center -space-x-1">{assignees.slice(0, 3).map((id) => <Avatar key={id} name={personName(id)} id={id} agent={isAgentId(id)} />)}{assignees.length > 3 && <span className="pl-2 text-12">+{formatNumber(assignees.length - 3)}</span>}</span>}
          options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} />, isAgent: person.isAgent, codeCapable: person.codeCapable, hasAccess: person.hasAccess, accessReason: accessReasonText(person) }))}
          onToggle={(id, on) => void change(item, { assigneeIds: on ? [...assignees, id] : assignees.filter((other) => other !== id) })} />;
      case "labels": {
        const labelNames = item.labelIds.map((id) => labels.find((label) => label.id === id)?.name).filter(Boolean).join(", ");
        const labelSummary = rowQuiet && item.labelIds.length > 0
          ? <span className="flex max-w-24 min-w-0 items-center gap-1.5">{item.labelIds.slice(0, 2).map((id) => { const label = labels.find((candidate) => candidate.id === id); return label && <span key={id} className="inline-flex min-w-0 items-center gap-1"><span aria-hidden className="size-2 rounded-full shrink-0" style={{ backgroundColor: label.color }} /><span className="truncate" title={label.name}>{label.name}</span></span>; })}{item.labelIds.length > 2 && <span className="shrink-0">+{item.labelIds.length - 2}</span>}</span>
          : item.labelIds.length === 0 ? rowQuiet ? <span className="text-tertiary">—</span> : compact ? <span className="hidden text-11 max-sm:inline">{t("layout.noLabel")}</span> : <span className="text-secondary">{t("layout.noLabel")}</span> : <span className="block max-w-28 truncate" title={labelNames}>{labelNames}</span>;
        return <MultiSelect label={t("workItems.labels")} readOnly={readOnly} selected={item.labelIds} quiet={rowQuiet} icon={<Tag aria-hidden size={14} className="text-secondary" />}
          summary={labelSummary}
          options={labels.map((label) => ({ id: label.id, name: label.name, icon: <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} /> }))}
          onToggle={(id, on) => void change(item, { labelIds: on ? [...item.labelIds, id] : item.labelIds.filter((other) => other !== id) })} />;
      }
      case "estimate": return <EstimateSelect estimate={estimate} pointId={item.estimatePointId ?? null} readOnly={readOnly} iconOnlyWhenEmpty={compact} quiet={rowQuiet} emptyLabel={rowQuiet ? "—" : undefined} onSelect={(estimatePointId) => void change(item, { estimatePointId })} />;
      case "dates": return <DatesMenu iconOnlyWhenEmpty={compact} startDate={item.startDate} dueDate={item.dueDate} stateGroup={states.find((state) => state.id === item.stateId)?.group} readOnly={readOnly} quiet={rowQuiet} emptyLabel={rowQuiet ? "—" : undefined} onChange={(dates) => void change(item, dates)} />;
      case "cycle": return <SingleSelect iconOnly={compact && !cycleOf[item.id]} label={t("workItems.cycle")} readOnly={readOnly} quiet={rowQuiet} value={cycleOf[item.id] ?? ""} icon={<RefreshCw aria-hidden size={14} className="text-secondary" />}
          summary={cycleOptions.find((cycle) => cycle.id === cycleOf[item.id])?.name ?? t("workItems.noCycle")} display={rowQuiet && !cycleOf[item.id] ? "—" : undefined}
          options={[{ id: "", name: t("workItems.noCycle") }, ...cycleOptions.filter((cycle) => cycle.status !== "completed" || cycle.id === cycleOf[item.id]).map((cycle) => ({ id: cycle.id, name: cycle.name }))]} onSelect={(id) => void setCycle(item, id)} />;
      case "modules": {
        const moduleNames = mine.map((id) => moduleOptions.find((module) => module.id === id)?.name).filter(Boolean).join(", ");
        return <MultiSelect label={t("workItems.modules")} readOnly={readOnly} selected={mine} quiet={rowQuiet} icon={<Package aria-hidden size={14} className="text-secondary" />}
          summary={mine.length === 0 ? rowQuiet ? <span className="text-tertiary">—</span> : compact ? <span className="hidden text-11 max-sm:inline">{t("workItems.noModules")}</span> : <span className="text-secondary">{t("workItems.noModules")}</span> : <span className="block max-w-28 truncate" title={moduleNames}>{moduleNames}</span>}
          options={moduleOptions.map((module) => ({ id: module.id, name: module.name }))} onToggle={(id, on) => void setModule(item, id, on)} />;
      }
      default: return null;
    }
  };
  /** The properties a board card shows, in the same order as a list row. */
  const propertiesOf = (item: Item, hideState = false, compact = false) => <>
    {(["state", "priority", "estimate", "assignee", "labels", "dates", "cycle", "modules"] as const).filter((property) => listShows(property) && !(hideState && property === "state")).map((property) => <React.Fragment key={property}>{cellOf(item, property, compact)}</React.Fragment>)}
  </>;
  /** An empty value stays a reachable control showing a muted dash. The icon is dropped for an empty cell only in the one-line table; phones and the narrow fallback keep icon and dash so each cell stays identifiable without the header. */
  const isEmptyProperty = (item: Item, property: DisplayProperty) => property === "priority" ? item.priority === "none" : property === "estimate" ? !item.estimatePointId
    : property === "assignee" ? item.assigneeIds.length === 0 : property === "labels" ? item.labelIds.length === 0 : property === "dates" ? !item.startDate && !item.dueDate
    : property === "cycle" ? !cycleOf[item.id] : property === "modules" ? (modulesOf[item.id] ?? []).length === 0 : false;
  /** Reserve stable tracks for each visible property; shed dates, modules and cycle before the title loses room. */
  const slotRem: Record<string, number> = { state: 6.5, priority: 5.75, estimate: 4, labels: 5.5, cycle: 6, modules: 5, dates: 7.5, assignee: 5 };
  const allListProperties = (["estimate", "labels", "cycle", "modules", "dates", "assignee"] as const).filter((property) => listShows(property));
  const leadingProperties = (["priority", "state"] as const).filter((property) => listShows(property));
  const gapPx = 8;
  const tracksFor = (properties: readonly (typeof allListProperties)[number][]) => ["1rem", ...(leadingProperties.includes("priority") ? ["1.75rem"] : []), "5rem", ...(leadingProperties.includes("state") ? ["1.75rem"] : []), "minmax(7rem,1fr)", ...properties.map((property) => `${slotRem[property]}rem`), ...(rowAction ? ["7rem"] : [])];
  const widthFor = (properties: readonly (typeof allListProperties)[number][]) => {
    const tracks = tracksFor(properties);
    return 40 + 16 + 80 + 112 + leadingProperties.length * 28 + properties.reduce((sum, property) => sum + slotRem[property] * 16, 0)
      + (rowAction ? 112 : 0) + Math.max(0, tracks.length - 1) * gapPx;
  };
  const responsiveProperties = [...allListProperties];
  for (const property of ["dates", "modules", "cycle"] as const) {
    if (listWidth >= widthFor(responsiveProperties)) break;
    const index = responsiveProperties.indexOf(property);
    if (index >= 0) responsiveProperties.splice(index, 1);
  }
  for (const property of ["estimate", "labels", "assignee"] as const) {
    if (listWidth >= widthFor(responsiveProperties)) break;
    const index = responsiveProperties.indexOf(property);
    if (index >= 0) responsiveProperties.splice(index, 1);
  }
  const shownProperties = responsiveProperties;
  const columnTracks = tracksFor(shownProperties);
  const gridColumns = columnTracks.join(" ");
  const oneLine = listWidth >= widthFor(shownProperties);
  const columnStyle = { "--cols": gridColumns } as React.CSSProperties;
  const propertyCell = (item: Item, property: (typeof allListProperties)[number], mobile = false) => <span key={property} className={`flex min-w-0 items-center justify-end whitespace-nowrap sm:order-6 ${mobile ? "rounded-md bg-layer-1 px-1.5 py-0.5 text-11 text-secondary [&_button]:px-1 [&_button]:py-0 [&_button]:text-11" : ""} ${isEmptyProperty(item, property) ? "[&_button]:text-transparent [&_button_span]:!text-transparent sm:[&_svg]:hidden [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-hover/row:pointer-events-auto [@media(hover:hover)]:group-has-[:focus-visible]/row:opacity-100 [@media(hover:hover)]:group-has-[:focus-visible]/row:pointer-events-auto" : ""} [&>*]:max-w-full [&_*]:min-w-0 [&_svg]:shrink-0`}>
    {cellOf(item, property, false, true)}
  </span>;
  const rowOf = (item: Item) => {
    const checkbox = pickBox(item, true);
    const rowActionCell = rowAction?.(item);
    const phoneProperties = allListProperties.filter((property) => !isEmptyProperty(item, property));
    const priorityEmpty = isEmptyProperty(item, "priority");
    return <li key={item.id} data-testid={`row-${item.displayId}`} className="group/row border-b border-subtle px-1 py-0.5">
      <div style={columnStyle} className={`mx-1 grid min-w-0 grid-cols-1 gap-y-1 rounded-lg px-3 py-1 ${selected.includes(item.id) ? "bg-layer-2" : "bg-transparent hover:bg-layer-transparent-hover"} sm:grid-cols-[var(--cols)] sm:gap-x-2 sm:gap-y-0 sm:py-0`}>
        <div className="flex min-w-0 items-center gap-2 sm:contents">
          <span className="flex size-4 shrink-0 items-center justify-center sm:order-1">{checkbox ? React.cloneElement(checkbox, { className: `${checkbox.props.className ?? ""} rounded-sm` }) : <span aria-hidden />}</span>
          <Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} className="line-clamp-2 min-w-0 flex-1 text-14 font-medium text-primary sm:order-5 sm:truncate">{item.title}</Link>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1 sm:contents max-sm:flex-nowrap max-sm:justify-start max-sm:overflow-x-auto">
          {leadingProperties.includes("priority") && <span className={`flex min-w-7 shrink-0 items-center justify-center sm:order-2 ${priorityEmpty ? "opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100" : ""}`}>{cellOf(item, "priority", false, true, true)}</span>}
          {shows("id") ? <span title={item.displayId} className="min-w-0 shrink-0 truncate whitespace-nowrap text-11 tabular-nums text-tertiary sm:order-3 sm:text-12">{item.displayId}</span> : <span aria-hidden className="sm:order-3" />}
          {leadingProperties.includes("state") && <span className="flex min-w-7 shrink-0 items-center justify-center sm:order-4">{cellOf(item, "state", false, true, true)}</span>}
          {allListProperties.filter((property) => !shownProperties.includes(property) && !isEmptyProperty(item, property)).map((property) => <span key={property} className="shrink-0 sm:hidden">{propertyCell(item, property, true)}</span>)}
          {oneLine ? shownProperties.map((property) => propertyCell(item, property))
            : <div data-testid="list-property-wrap" className="flex min-w-0 flex-wrap items-center justify-end gap-x-1 gap-y-1 sm:col-span-full">{shownProperties.map((property) => propertyCell(item, property))}</div>}
          {rowActionCell && <span className="sm:order-7">{rowActionCell}</span>}
        </div>
      </div>
    </li>;
  };

  const quickForm = (groupKey: string) => <form className="mx-1 my-1 flex flex-wrap items-center gap-2 rounded-xl border border-subtle bg-layer-1 px-3 py-2" onSubmit={(event) => { event.preventDefault(); void create(groupKey); }}>
    <input autoFocus aria-label={t("workItems.titleField")} placeholder={t("workItems.quickTitle")} value={quickTitle} maxLength={500} className="min-w-0 flex-1 max-sm:basis-full" onChange={(event) => setQuickTitle(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") { setQuick(null); setQuickTitle(""); } }} />
    <button type="submit" className={`${ghost} max-sm:ml-auto whitespace-nowrap`}>{t("workItems.create")}</button>
  </form>;
  const newButton = (groupKey: string) => <button type="button" className="mx-1 my-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg bg-layer-1 px-3 py-2 text-left text-13 font-medium text-secondary hover:bg-layer-transparent-hover" onClick={() => { setQuick(groupKey); setQuickTitle(""); }}>
    <Plus aria-hidden size={14} />{t("workItems.new")}</button>;

  const groupedItems = items.map((item) => ({ ...item, cycleId: cycleOf[item.id] ?? null, moduleIds: modulesOf[item.id] ?? [], creatorId: item.createdBy }));
  const grouped = groupItems(groupedItems, grouping, stateIds).filter((group) => grouping === "none" || group.items.length > 0 || grouping === "state");
  const groups = grouped.map((group) => ({ ...group, items: group.items.map((item) => items.find((row) => row.id === item.id)!) }));
  // The project's Work items page (the only caller with onAddItem) shows one empty state in the list, board and spreadsheet layouts, not five empty status groups. Cycles, Modules and Views keep their groups.
  const emptyProject = onAddItem !== undefined && loaded && !filtered && items.length === 0 && (params.layout === "list" || board || sheet);
  const emptyBlock = <div className="rounded-xl border border-subtle bg-surface-1"><EmptyState title={t("workItems.empty")} description={t("workItems.emptyHint")}
    action={onAddItem && canCreate && canWrite ? <button type="button" className="primary flex items-center gap-1.5" onClick={onAddItem}><Plus aria-hidden size={14} />{t("workItems.addNew")}</button> : undefined} /></div>;

  const boardStateIds = stateIds.filter((id) => !chips || chips.state.length === 0 || chips.state.includes(id));
  const boardPeople = people.length > 0 ? people.map((person) => person.userId) : [];
  const boardColumns: Array<BoardColumn<Item>> = !board ? [] : completeGroups(groupItems(groupedItems, boardGroup, boardStateIds), boardGroup === "assignee" ? boardPeople : []).map(({ key, items: groupItemsForColumn }) => ({ key, name: boardGroup === "state" ? states.find((state) => state.id === key)?.name ?? key : boardGroup === "priority" ? t(`workItems.priority.${key}`) : boardGroup === "label" ? labels.find((label) => label.id === key)?.name ?? key : boardGroup === "cycle" ? cycleOptions.find((cycle) => cycle.id === key)?.name ?? t("workItems.noCycle") : boardGroup === "module" ? moduleOptions.find((module) => module.id === key)?.name ?? t("workItems.noModules") : boardGroup === "dueDate" ? t(`layout.dueDate.${key}`) : key === "none" ? t("layout.unassigned") : personName(key), icon: groupIconFor(boardGroup, key), items: groupItemsForColumn.map((item) => items.find((row) => row.id === item.id)!) }));
  const boardLanes = subGroup === "none" ? [] : groupItems(groupedItems, subGroup, stateIds).filter((lane) => lane.items.length > 0);

  /** Work items in the order they appear on screen, so a shift-click picks the stretch between two rows. */
  const selectable = canWrite && ["list", "board", "spreadsheet"].includes(params.layout);
  // Only what is on screen: a collapsed group or column hides its work items, so a range or "select all" must not reach them. A work item shown under several groups counts once.
  const visibleGroupItems = (group: { key: string; items: Item[] }) => {
    if (group.items.length === 0 || (grouping !== "none" && collapsed.includes(group.key))) return [];
    return subGroup === "none" ? group.items : groupItems(group.items.map((item) => ({ ...item, cycleId: cycleOf[item.id] ?? null, moduleIds: modulesOf[item.id] ?? [], creatorId: item.createdBy })), subGroup, stateIds)
      .filter((sub) => !collapsed.includes(`${group.key}:${sub.key}`)).flatMap((sub) => sub.items.map((item) => items.find((row) => row.id === item.id)!));
  };
  const orderedIds = [...new Set(sheet ? items.map((item) => item.id) : board ? boardColumns.filter((column) => !collapsedColumns.includes(column.key)).flatMap((column) => column.items.map((item) => item.id)) : groups.flatMap((group) => visibleGroupItems(group).map((item) => item.id)))];
  const pick = (id: string, shift: boolean) => {
    // The anchor is read before the update is queued, so the range does not depend on when React runs the updater.
    const from = anchor.current ? orderedIds.indexOf(anchor.current) : -1;
    const to = orderedIds.indexOf(id);
    setSelected((ids) => {
      if (shift && from >= 0 && to >= 0) return [...new Set([...ids, ...orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1)])].slice(0, 500);
      return ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];
    });
    anchor.current = id;
  };
  const pickBox = (item: Item, revealOnHover = false) => selectable && <input type="checkbox" data-no-drag className={`size-4 shrink-0 ${revealOnHover ? `relative z-10 ${selected.includes(item.id) ? "" : "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-has-[:focus-visible]/row:opacity-100"}` : ""}`} aria-label={t("bulk.selectItem").replace("{id}", item.displayId)} checked={selected.includes(item.id)}
    onChange={() => undefined} onClick={(event) => pick(item.id, event.shiftKey)} />;
  // Collapsing a group hides its work items, so they leave the selection too: the bar never acts on what the user cannot see.
  const visibleKey = orderedIds.join(",");
  React.useEffect(() => setSelected((ids) => ids.every((id) => orderedIds.includes(id)) ? ids : ids.filter((id) => orderedIds.includes(id))), [visibleKey]);
  const allPicked = orderedIds.length > 0 && orderedIds.every((id) => selected.includes(id));
  const columns = params.props.filter((property) => property !== "id" && listShows(property));
  const cell = "border-b border-subtle px-3 py-2 text-left align-middle whitespace-nowrap";
  const sheetColumnMinWidth: Partial<Record<DisplayProperty, string>> = {
    state: "min-w-28", priority: "min-w-28", assignee: "min-w-28", labels: "min-w-32", dates: "min-w-32", cycle: "min-w-28", modules: "min-w-32", estimate: "min-w-24",
  };
  const sheetView = <div className="min-w-0 max-w-full rounded-xl border border-subtle bg-surface-1">
    {filtered && items.length === 0 && <p className="border-b border-subtle bg-surface-1 px-5 py-3 text-14 text-secondary">{t("layout.noMatch")}</p>}
    <div role="region" aria-label={t("layout.spreadsheet")} tabIndex={0} className="min-w-0 max-w-full overflow-x-auto rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary" data-testid="sheet-scroll"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        event.currentTarget.scrollLeft += (event.key === "ArrowRight" ? 1 : -1) * Math.max(80, event.currentTarget.clientWidth * 0.8);
      }}>
      <table className="w-max min-w-full table-auto border-separate border-spacing-0 bg-surface-1 text-13">
        <caption className="sr-only">{t("layout.spreadsheet")}</caption>
        <thead><tr className="bg-layer-1 text-12 font-medium text-tertiary">
          <th scope="col" className={`${cell} sticky left-0 z-10 w-80 min-w-64 max-sm:w-52 max-sm:min-w-52 bg-layer-1`}>{t("layout.sheet.workItem")}</th>
          {columns.map((property) => <th key={property} scope="col" className={`${cell} ${sheetColumnMinWidth[property] ?? ""}`}>{t(`layout.property.${property}`)}</th>)}
          {rowAction && <th scope="col" className={`${cell} min-w-24`}><span className="sr-only">{t("layout.sheet.actions")}</span></th>}
        </tr></thead>
        <tbody>{items.map((item) => <tr key={item.id} data-testid={`row-${item.displayId}`} className="group">
          <th scope="row" className={`${cell} sticky left-0 z-10 w-80 min-w-64 max-sm:w-52 max-sm:min-w-52 bg-surface-1 font-normal group-hover:bg-layer-1`}>
            <span className="flex min-w-0 items-center gap-3">{pickBox(item)}{shows("id") && <span className="shrink-0 text-12 text-tertiary">{item.displayId}</span>}
              <Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} className="block min-w-0 max-w-48 whitespace-normal text-14 font-medium text-primary [overflow-wrap:anywhere]">{item.title}</Link></span>
          </th>
          {columns.map((property) => <td key={property} className={`${cell} ${sheetColumnMinWidth[property] ?? ""} [&_button]:rounded-md [&_button]:border-transparent [&_button]:bg-transparent [&_button]:px-1 [&_button]:py-1 group-hover:bg-layer-1`}>{cellOf(item, property, false, true)}</td>)}
          {rowAction && <td className={`${cell} min-w-24`}>{rowAction(item)}</td>}
        </tr>)}</tbody>
      </table>
    </div>
    {canCreate && canWrite && (quick === "end" ? quickForm("all") : newButton("end"))}
  </div>;

  const calendar = calendarPlacement(items, calendarMonth);
  const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const monthName = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(calendarMonth);
  const calendarView = <section aria-label={t("layout.calendar")} className="rounded-xl border border-subtle bg-surface-1 p-2" data-testid="calendar-layout">
    <header className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-layer-1 px-3 py-2">
      <div className="flex items-center gap-1"><button type="button" aria-label={t("layout.calendar.previous")} className="rounded-md p-1.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}><ChevronLeft aria-hidden size={16} /></button>
        <h2 className="min-w-36 text-center text-14 font-medium text-primary">{monthName}</h2><button type="button" aria-label={t("layout.calendar.next")} className="rounded-md p-1.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}><ChevronRight aria-hidden size={16} /></button></div>
      <button type="button" className={ghost} onClick={() => setCalendarMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}><CalendarDays aria-hidden size={14} />{t("layout.calendar.today")}</button>
    </header>
    <div className="mt-2 grid grid-cols-7 gap-1 max-[767px]:hidden">{weekdays.map((day) => <div key={day} className="px-2 py-1 text-12 font-medium text-tertiary">{t(`layout.weekday.${day}`)}</div>)}</div>
    <div className="grid grid-cols-7 max-[767px]:grid-cols-1" data-testid="calendar-days">
      {calendar.days.map((day) => <div key={day.date} data-calendar-date={day.date} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain"); if (id) void reschedule(id, day.date); }}
        className={`min-h-28 rounded-lg border border-subtle p-2 max-[767px]:min-h-0 ${day.date.slice(0, 7) === `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}` ? "bg-surface-1" : "bg-layer-1/40 text-tertiary"}`}>
        <div className="mb-1 flex items-center justify-between text-12"><time dateTime={day.date}>{new Intl.DateTimeFormat(undefined, { day: "numeric", weekday: "short", month: "short" }).format(new Date(`${day.date}T12:00:00`))}</time>
          {canCreate && canWrite && <button type="button" aria-label={t("layout.calendar.add").replace("{date}", day.date)} className="rounded-md px-1.5 text-secondary hover:bg-layer-transparent-hover" onClick={() => { setQuick(day.date); setQuickTitle(""); }}>+</button>}</div>
        <div className="grid gap-1">{day.items.map((item) => <Link key={item.id} to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} draggable={canWrite} onDragStart={(event) => { event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; }} data-testid={`calendar-card-${item.displayId}`}
          className="block truncate rounded-md border border-transparent bg-layer-1 px-2 py-1.5 text-12 font-medium text-primary hover:bg-layer-transparent-hover">{item.title}</Link>)}</div>
        {quick === day.date && <form className="mt-1 flex gap-1" onSubmit={(event) => { event.preventDefault(); void createForDate(day.date); }}><input autoFocus aria-label={t("workItems.titleField")} value={quickTitle} className="min-w-0 w-full" onChange={(event) => setQuickTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuick(null); }} /><button type="submit" aria-label={t("workItems.create")}>+</button></form>}
      </div>)}
    </div>
    <aside aria-label={t("layout.calendar.undated")} className="mt-2 rounded-lg bg-layer-1 p-3"><h3 className="mb-2 text-13 font-medium">{t("layout.calendar.undated")}</h3>
      {calendar.undated.length ? <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">{calendar.undated.map((item) => <li key={item.id}><Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} className="block rounded border border-subtle px-2 py-1.5 text-13 text-primary hover:bg-layer-transparent-hover">{item.title}</Link></li>)}</ul> : <p className="text-13 text-tertiary">{t("layout.calendar.noUndated")}</p>}
    </aside>
  </section>;

  const ganttView = <section aria-label={t("layout.gantt")} data-testid="gantt-layout" data-gantt-start={gantt.start} data-gantt-days={gantt.days.length} className={`min-w-0 max-w-full rounded-xl border border-subtle bg-surface-1 p-2 ${ganttDrag ? "select-none" : ""}`}>
    <p className="m-0 border-b border-subtle px-3 py-2 text-12 text-secondary md:hidden">{t("layout.gantt.scrollHint")}</p>
    <header className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-layer-1 px-3 py-2">
      <div className="flex items-center gap-1"><button type="button" aria-label={t("layout.gantt.previous")} className="rounded-md p-1.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={() => shiftGanttAnchor(-1)}><ChevronLeft aria-hidden size={16} /></button>
        <h2 className="min-w-36 text-center text-14 font-medium">{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(ganttAnchor)}</h2>
        <button type="button" aria-label={t("layout.gantt.next")} className="rounded-md p-1.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={() => shiftGanttAnchor(1)}><ChevronRight aria-hidden size={16} /></button>
        <button type="button" className={ghost} onClick={() => setGanttAnchor(new Date())}>{t("layout.calendar.today")}</button></div>
      <label className="flex items-center gap-2 text-13">{t("layout.gantt.zoom")}<select aria-label={t("layout.gantt.zoom")} value={ganttZoom} onChange={(event) => setGanttZoom(event.target.value as GanttZoom)}>{(["week", "month", "quarter"] as const).map((zoom) => <option key={zoom} value={zoom}>{t(`layout.gantt.${zoom}`)}</option>)}</select></label>
    </header>
    <div className="mt-2 overflow-x-auto rounded-lg border border-subtle"><div style={{ minWidth: `calc(20rem + ${Math.max(gantt.days.length * 12, 580)}px)` }}>
      <div className="grid grid-cols-[minmax(12rem,20rem)_minmax(0,1fr)] border-b border-subtle bg-layer-1"><div className="px-3 py-2 text-12 font-medium text-tertiary">{t("layout.sheet.workItem")}</div><div className="grid" style={{ gridTemplateColumns: `repeat(${gantt.days.length}, minmax(0, 1fr))` }}>{gantt.days.map((date, index) => <div key={date} title={date} className="border-l border-subtle px-0.5 py-2 text-center text-[9px] text-tertiary">{index % (ganttZoom === "week" ? 1 : 7) === 0 ? Number(date.slice(-2)) : ""}</div>)}</div></div>
      <div className="relative">
        {gantt.today >= 0 && gantt.today < gantt.days.length && <div aria-label={t("layout.gantt.todayMarker")} data-testid="gantt-today" className="pointer-events-none absolute bottom-0 top-0 z-10 border-l-2 border-danger-text" style={{ left: `calc(20rem + (100% - 20rem) * ${gantt.today / gantt.days.length})` }} />}
        {gantt.bars.map(({ item, left, width }) => {
          const drag = ganttDrag?.id === item.id ? ganttDrag : ganttSaving[item.id] ?? null;
          const end = left + width;
          /** An item with one date has no other edge to cross: the handle just places that date, and the bar stays one day wide. */
          const oneSided = drag?.kind === "start" ? !item.dueDate : drag?.kind === "due" ? !item.startDate : false;
          /** With both dates the preview stops at the other edge and is ringed red when the pointer is past it; the server refuses that range (start after due). */
          const invalid = !oneSided && (drag?.kind === "start" ? drag.at > end - 1 : drag?.kind === "due" ? drag.at < left : false);
          const shownLeft = drag?.kind === "move" ? left + drag.at : oneSided ? drag!.at : drag?.kind === "start" ? Math.min(drag.at, end - 1) : left;
          const shownWidth = oneSided ? 1 : drag?.kind === "start" ? end - shownLeft : drag?.kind === "due" ? Math.max(1, drag.at - left + 1) : width;
          return <div key={item.id} className="grid min-h-11 grid-cols-[minmax(12rem,20rem)_minmax(0,1fr)] border-b border-subtle" data-testid={`gantt-row-${item.displayId}`}>
          <Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} className="truncate px-3 py-3 text-13 font-medium text-primary">{item.title}</Link>
          <div className="relative">
            {gantt.days.map((date, index) => <div key={date} data-gantt-date={date} data-testid={`gantt-drop-${date}`} className="absolute inset-y-0" style={{ left: `${index / gantt.days.length * 100}%`, width: `${100 / gantt.days.length}%` }} />)}
            {drag && <div aria-hidden data-testid="gantt-origin" className="pointer-events-none absolute top-2 h-7 rounded border border-dashed border-accent-strong" style={{ left: `${left / gantt.days.length * 100}%`, width: `${Math.max(width / gantt.days.length * 100, 1.2)}%` }} />}
            <div onPointerDown={canWrite ? (event) => { if (ganttSaving[item.id] || (event.target as HTMLElement).closest("[data-gantt-edge]")) return; event.currentTarget.setPointerCapture(event.pointerId); ganttPointerStart.current = { x: event.clientX }; } : undefined} onPointerMove={canWrite ? (event) => ganttMovePreview(event, item) : undefined} onPointerUp={canWrite ? (event) => ganttMove(event, item) : undefined} onPointerCancel={() => { ganttPointerStart.current = null; ganttEdgeStart.current = null; setGanttDrag(null); }} onDragStart={(event) => event.preventDefault()} className={`absolute top-2 h-7 select-none rounded bg-accent-primary/80 text-white ${canWrite ? "cursor-grab active:cursor-grabbing" : ""} ${drag ? `z-30 shadow-xl ring-2 ${invalid ? "ring-danger-strong" : "ring-accent-strong"}` : "shadow-sm"}`} style={{ left: `${shownLeft / gantt.days.length * 100}%`, width: `${Math.max(shownWidth / gantt.days.length * 100, 1.2)}%` }} data-testid={`gantt-bar-${item.displayId}`}>
              {canWrite && !startClipped(item) && <span data-gantt-edge role="button" tabIndex={0} aria-keyshortcuts="ArrowLeft ArrowRight" aria-label={`${t("layout.gantt.resizeStart")} ${item.displayId}`} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); void ganttResizeByKeyboard(item, "start", event.key === "ArrowLeft" ? -1 : 1); }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); if (ganttSaving[item.id]) return; event.currentTarget.setPointerCapture(event.pointerId); ganttEdgeStart.current = { x: event.clientX }; }} onPointerMove={(event) => ganttEdgePreview(event, item, "start")} onPointerUp={(event) => ganttResize(event, item, "start")} className="absolute inset-y-0 left-0 z-20 w-1 cursor-ew-resize rounded-l bg-accent-primary" />}
              <span className="block truncate px-2 text-12 leading-7">{item.displayId}</span>
              {canWrite && !dueClipped(item) && <span data-gantt-edge role="button" tabIndex={0} aria-keyshortcuts="ArrowLeft ArrowRight" aria-label={`${t("layout.gantt.resizeDue")} ${item.displayId}`} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); void ganttResizeByKeyboard(item, "due", event.key === "ArrowLeft" ? -1 : 1); }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); if (ganttSaving[item.id]) return; event.currentTarget.setPointerCapture(event.pointerId); ganttEdgeStart.current = { x: event.clientX }; }} onPointerMove={(event) => ganttEdgePreview(event, item, "due")} onPointerUp={(event) => ganttResize(event, item, "due")} className="absolute inset-y-0 right-0 z-20 w-1 cursor-ew-resize rounded-r bg-accent-primary" />}
            </div>
          </div>
        </div>; })}
      </div>
    </div></div>
    <aside aria-label={t("layout.gantt.undated")} className="mt-2 rounded-lg bg-layer-1 p-3"><h3 className="mb-2 text-13 font-medium">{t("layout.gantt.undated")}</h3>{gantt.undated.length ? <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">{gantt.undated.map((item) => <li key={item.id}><Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} className="block rounded-md px-2 py-1.5 text-13 text-primary hover:bg-layer-transparent-hover">{item.title}</Link></li>)}</ul> : <p className="text-13 text-tertiary">{t("layout.gantt.noUndated")}</p>}</aside>
  </section>;

  const toolbar = <div className="flex flex-wrap items-center gap-2">
    <div role="group" aria-label={t("layout.switch")} className="flex items-center gap-0.5 rounded-lg bg-layer-1 p-0.5">
      {(["list", "board", "spreadsheet", "calendar", "gantt"] as const).map((layout) => { const Icon = layout === "list" ? List : layout === "board" ? Columns3 : layout === "spreadsheet" ? Table2 : layout === "calendar" ? CalendarDays : BarChart3; return <button key={layout} type="button" aria-pressed={params.layout === layout} aria-label={t(`layout.${layout}`)} title={t(`layout.${layout}`)}
        className={`inline-flex items-center rounded-md p-1.5 max-sm:min-h-9 max-sm:min-w-9 max-sm:flex-col max-sm:justify-center max-sm:gap-0.5 ${params.layout === layout ? "bg-surface-1 text-primary shadow-sm" : "bg-transparent text-secondary hover:bg-layer-transparent-hover"} hover:text-primary`} onClick={() => update({ layout })}><Icon aria-hidden size={16} /><span className="hidden text-11 leading-none max-sm:inline">{t(`layout.${layout}`)}</span></button>; })}
    </div>
    {selectable && <label className={`${ghost} cursor-pointer max-sm:min-h-9 max-sm:gap-1`} title={t("bulk.selectAll")}><input type="checkbox" className="size-4" checked={allPicked} onChange={() => setSelected(allPicked ? [] : orderedIds.slice(0, 500))} /><span className="sr-only">{t("bulk.selectAll")}</span><span aria-hidden className="text-12">{t("bulk.selectShown")}</span></label>}
    <FilterPicker sections={sections} filters={chips ?? emptyFilters()} count={filterCount} onChange={setFilters} onClear={() => update({ q: "" })} />
    <FilterQueryToggle open={filterQueryOpen || (queryError !== null)} onToggle={() => setFilterQueryOpen(!filterQueryOpen)} />
    <Popover label={t("layout.display")} className={`${ghost} max-sm:min-h-9`} panelRole="dialog" panelClassName="grid w-72 max-w-[calc(100vw-2rem)] max-h-[70vh] gap-3 overflow-auto p-3" trigger={<><SlidersHorizontal aria-hidden size={14} /><span className="max-sm:sr-only">{t("layout.display")}</span></>}>
      {() => <>
        {!sheet && <label>{t("layout.group")}<select value={board ? boardGroup : params.group} onChange={(event) => { const group = event.target.value as LayoutParams["group"]; update({ group, subGroup: params.subGroup === group ? "none" : params.subGroup }); }}>
          {(board ? groupings.filter((value) => value !== "none") : groupings).filter((value) => value !== "type" || typesEnabled).map((value) => <option key={value} value={value}>{t(`layout.group.${value}`)}</option>)}
        </select></label>}
        {supportsSubGroup && <label>{t("layout.subGroup")}<select value={subGroup} onChange={(event) => update({ subGroup: event.target.value as LayoutParams["subGroup"] })}>
          {groupings.filter((value) => value === "none" || value !== grouping).filter((value) => value !== "type" || typesEnabled).map((value) => <option key={value} value={value}>{t(`layout.group.${value}`)}</option>)}
        </select></label>}
        {!board && <>
          <label>{t("layout.sort")}<select value={params.sort} onChange={(event) => update({ sort: event.target.value as LayoutParams["sort"] })}>
            {sortFields.map((value) => <option key={value} value={value}>{t(`layout.sort.${value}`)}</option>)}
          </select></label>
          <label>{t("layout.direction")}<select value={params.dir} onChange={(event) => update({ dir: event.target.value as LayoutParams["dir"] })}>
            {(["asc", "desc"] as const).map((value) => <option key={value} value={value}>{t(`layout.direction.${value}`)}</option>)}
          </select></label>
        </>}
        <fieldset className="grid gap-1.5"><legend className="pb-1 text-12 font-medium text-tertiary">{t("layout.properties")}</legend>
          {(sheet ? [...params.props, ...displayProperties.filter((property) => !params.props.includes(property))] : [...displayProperties]).filter((property) => property !== "estimate" || !!estimate?.enabled).map((property) => <div key={property} className="flex items-center gap-1">
            <label className={`${checkRow} flex-1`}>
              <input type="checkbox" checked={params.props.includes(property)} onChange={(event) => update({ props: sheet ? (event.target.checked ? [...params.props, property] : params.props.filter((other) => other !== property)) : displayProperties.filter((other) => other === property ? event.target.checked : params.props.includes(other)) })} />{t(`layout.property.${property}`)}</label>
            {sheet && params.props.includes(property) && <>
              <button type="button" className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover" aria-label={`${t("layout.column.earlier")}: ${t(`layout.property.${property}`)}`} onClick={() => update({ props: moveProperty(params.props, property, -1) })}><ArrowLeft aria-hidden size={14} /></button>
              <button type="button" className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover" aria-label={`${t("layout.column.later")}: ${t(`layout.property.${property}`)}`} onClick={() => update({ props: moveProperty(params.props, property, 1) })}><ArrowRight aria-hidden size={14} /></button>
            </>}
          </div>)}
        </fieldset>
      </>}
    </Popover>
    {toolbarExtra?.(params)}
  </div>;

  const renderBoard = (columns: Array<BoardColumn<Item>>) => <Board columns={columns} canDrag={canWrite && ["state", "priority", "assignee"].includes(boardGroup)} reorderWithinColumn={boardGroup === "state" && !/\border\s+by\b/i.test(params.q)} announcePosition={boardGroup === "state" && !/\border\s+by\b/i.test(params.q)} canAdd={canCreate && canWrite} collapsed={collapsedColumns} onDrop={(id, column, beforeId, sourceColumn) => dropCard(id, column, beforeId, sourceColumn)}
    onToggle={(column) => setCollapsedColumns((list) => list.includes(column) ? list.filter((key) => key !== column) : [...list, column])}
    onAdd={(column) => { setQuick(column); setQuickTitle(""); }} quick={quick} quickForm={quickForm}
    renderCard={(item, reorderHandle) => <div className="grid gap-2">
      <div className="flex items-start justify-between gap-2">{pickBox(item)}<div className="grid min-w-0 flex-1 gap-1">
        {shows("id") && <span className="text-12 text-tertiary">{item.displayId}</span>}
        <Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} draggable={false} data-testid="card-title" className="text-14 font-medium text-primary [overflow-wrap:anywhere]">{item.title}</Link></div>
        {reorderHandle}{rowAction && <span data-no-drag>{rowAction(item)}</span>}</div>
      <div className="flex flex-wrap items-center gap-1.5">{propertiesOf(item, boardGroup === "state", true)}</div>
    </div>}
    ghost={(item) => <div className="flex items-baseline gap-2"><span className="text-12 text-tertiary">{item.displayId}</span><span className="text-14 font-medium text-primary">{item.title}</span></div>} />;

  const peekPanel = peek && <>
    <div aria-hidden className="fixed inset-0 z-40 bg-backdrop" onClick={() => setPeek(null)} />
    <aside data-peek role="dialog" aria-label={t("workItems.peek.title")} className="@container fixed inset-y-0 right-0 z-50 w-full border-l border-subtle bg-surface-1 shadow-xl sm:w-[80vw] sm:max-w-[1160px]">
      <WorkItemDetail key={peek} displayId={peek} mode="peek" onChanged={() => void load()} onClose={() => setPeek(null)} />
    </aside>
  </>;

  return <div className="grid gap-3">
    {peekPanel}
    {toolbar}
    <FilterChips filters={chips ?? emptyFilters()} sections={sections} custom={chips === null} onChange={setFilters} onClear={() => update({ q: "" })} />
    {(filterQueryOpen || queryError !== null) && <FilterQueryEditor text={params.q} error={queryError} onApply={(text) => void applyFilterQuery(text)} generate={{ projectId }} />}
    {note && <p role="alert" className="text-danger-text">{note}</p>}
    {selectable && selected.length > 0 && <BulkBar projectId={projectId} selected={items.filter((item) => selected.includes(item.id))} states={states} people={people} labels={labels} estimate={estimate} run={run}
      cycleOptions={cyclesEnabled && !cycleId ? cycleOptions : null} moduleOptions={modulesEnabled && !moduleId ? moduleOptions : null} onClear={() => { setSelected([]); anchor.current = null; }} onApplied={() => void load()} />}
    {emptyProject && emptyBlock}
    {sheet && !emptyProject && sheetView}
    {params.layout === "calendar" && calendarView}
    {params.layout === "gantt" && ganttView}
    {!board && !sheet && !emptyProject && params.layout !== "calendar" && params.layout !== "gantt" && <div ref={setListBox} className="overflow-hidden rounded-xl border border-subtle bg-surface-1">
      {filtered && items.length === 0 && <p className="border-b border-subtle bg-surface-1 px-5 py-3 text-14 text-secondary">{t("layout.noMatch")}</p>}
      {groups.map((group) => {
        const empty = group.items.length === 0;
        // An empty group stays open while its quick-create form is open; the toggle collapses it and closes the form, so it never traps.
        const open = empty ? expandedEmpty.includes(group.key) || quick === group.key : !collapsed.includes(group.key);
        const name = params.group === "none" ? "" : groupLabel(group.key);
        return <section key={group.key} aria-label={params.group === "none" ? undefined : name}>
          {params.group !== "none" && <div className="mx-1 my-1 flex items-center gap-2 rounded-lg border border-subtle bg-layer-1 px-3 py-1.5">
            <button type="button" aria-expanded={open} aria-label={`${t("layout.toggleGroup")}: ${name}`} className="flex flex-1 items-center gap-2 bg-transparent p-0 text-left text-14 font-medium text-primary hover:bg-transparent"
              onClick={() => empty ? (open ? (setExpandedEmpty(expandedEmpty.filter((key) => key !== group.key)), quick === group.key && setQuick(null)) : setExpandedEmpty([...expandedEmpty, group.key])) : setCollapsed(open ? [...collapsed, group.key] : collapsed.filter((key) => key !== group.key))}>
              {open ? <ChevronDown aria-hidden size={14} className="text-secondary" /> : <ChevronRight aria-hidden size={14} className="text-secondary" />}
              {groupIcon(group.key)}<span>{name}</span><span className="text-13 font-normal text-tertiary">{formatNumber(group.items.length)}</span>
            </button>
            {canCreate && canWrite && <button type="button" aria-label={t("layout.addToGroup").replace("{group}", name)} title={t("layout.addToGroup").replace("{group}", name)} className="inline-flex items-center gap-1 rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover hover:text-primary"
              onClick={() => { setCollapsed(collapsed.filter((key) => key !== group.key)); setExpandedEmpty(expandedEmpty.includes(group.key) ? expandedEmpty : [...expandedEmpty, group.key]); setQuick(group.key); setQuickTitle(""); }}><Plus aria-hidden size={14} /><span className="hidden text-11 max-sm:inline">{t("layout.addShort")}</span></button>}
          </div>}
          {open && <>
            {subGroup === "none" ? <ul className="m-0 list-none p-0">{group.items.map((item) => rowOf(item))}</ul>  : groupItems(group.items.map((item) => ({ ...item, cycleId: cycleOf[item.id] ?? null, moduleIds: modulesOf[item.id] ?? [], creatorId: item.createdBy })), subGroup, stateIds).filter((sub) => sub.items.length > 0).map((sub) => {
              const key = `${group.key}:${sub.key}`;
              const subOpen = !collapsed.includes(key);
              const subName = labelFor(subGroup, sub.key);
              return <section key={sub.key} aria-label={subName} className="border-b border-subtle">
                <div className="flex items-center gap-2 bg-surface-1 px-6 py-2">
                  <button type="button" aria-expanded={subOpen} aria-label={`${t("layout.toggleGroup")}: ${subName}`} className="flex flex-1 items-center gap-2 bg-transparent p-0 text-left text-13 font-medium text-secondary hover:bg-transparent"
                    onClick={() => setCollapsed(subOpen ? [...collapsed, key] : collapsed.filter((value) => value !== key))}>
                    {subOpen ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}{groupIconFor(subGroup, sub.key)}<span>{subName}</span><span className="text-12 font-normal text-tertiary">{formatNumber(sub.items.length)}</span>
                  </button>
                </div>
                {subOpen && <ul className="m-0 list-none p-0">{sub.items.map((item) => rowOf(items.find((row) => row.id === item.id)!))}</ul>}
              </section>;
            })}
            {quick === group.key && quickForm(group.key)}
          </>}
        </section>;
      })}
    </div>}
    {board && !emptyProject && (subGroup === "none" || boardLanes.length === 0 ? renderBoard(boardColumns) : <div className="grid gap-5" data-testid="board-swimlanes">{boardLanes.map((lane) => {
      const laneItems = new Set(lane.items.map((item) => item.id));
      const laneName = labelFor(subGroup, lane.key);
      return <section key={lane.key} aria-label={`${t(`layout.group.${subGroup}`)}: ${laneName}`} className="grid gap-1">
        <h3 className="m-0 flex items-center gap-2 border-b border-subtle pb-2 text-14 font-semibold text-primary">{groupIconFor(subGroup, lane.key)}{laneName}</h3>
        {renderBoard(boardColumns.map((column) => ({ ...column, items: column.items.filter((item) => laneItems.has(item.id)) })))}
      </section>;
    })}</div>)}
  </div>;
}
