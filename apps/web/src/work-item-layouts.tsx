import { Button, buttonVariants } from "@/ui/button";
import { accessReasonText } from "./access-reason";
import React from "react";
import { PhonePropertyStrip } from "./phone-property-strip";
import { Link } from "react-router";
import { ArrowLeft, ArrowRight, BarChart3, CalendarDays, ChevronDown, Check, ChevronLeft, ChevronRight, Columns3, Ellipsis, List, Package, Plus, RefreshCw, SlidersHorizontal, Table2, Tag, Users, ChevronsLeft } from "lucide-react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { calendarPlacement, completeGroups, displayProperties, effectiveSubGroup, ganttPlacement, groupItems, groupings, layouts, moveProperty, parseLayoutParams, serializeLayoutParams, priorityOrder, sortFields, type DisplayProperty, type GanttZoom, type LayoutParams } from "./work-item-layout";
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
import { cn } from "./lib/utils";
import type { Estimate, StateGroup } from "./types";
import { TypeIconMark, type WorkItemType } from "./work-item-types";

import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/ui/dropdown-menu";
type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
type State = { id: string; name: string; group: StateGroup };
type Person = { userId: string; name: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null; accessAsk?: "owner" | "admin" | null; accessOwnerName?: string | null };
type Label = { id: string; name: string; color: string };
type Item = { id: string; displayId: string; title: string; stateId: string; priority: string; estimatePointId?: string | null; assigneeIds: string[]; labelIds: string[]; createdBy: string; startDate: string | null; dueDate: string | null };
type Named = { id: string; name: string; status?: string };
const t = (key: string) => translate(key as MessageKey);
const ghost = "flex items-center gap-1.5 border border-transparent bg-muted px-2.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground";
const toolbarSecondarySm = cn(buttonVariants({ variant: "secondary", size: "sm" }), "bg-transparent text-foreground");
const checkRow = "flex items-center gap-2 text-13";
/** Left padding only: the shared select style keeps room on the right for its chevron. */
const selectClass = "rounded-md border border-input bg-background py-1.5 pl-2 text-13 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11";
const todayClass = "rounded-md border border-border bg-background px-2.5 py-1 text-13 font-medium text-foreground hover:bg-accent";

/** Work items of one project in a layout (list or board) with display options and filters; every setting lives in the URL query string. */
/** True on a device without hover (a touch screen, including a phone browser's desktop-site mode), kept in sync with the media query. */
function useHoverNone() {
  const query = "(hover: none)";
  const [matches, setMatches] = React.useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  React.useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return matches;
}

export function WorkItemLayouts({ projectId, workspaceSlug, action, run: runProp, refreshKey, cycleId, moduleId, cyclesEnabled, modulesEnabled, typesEnabled = false, canWrite = true, canCreate = false, onAddItem, rowAction, toolbarExtra, phoneToolbar }: { projectId: string; workspaceSlug: string; action: Call; run?: Run; refreshKey: number; cycleId?: string; moduleId?: string; cyclesEnabled?: boolean; typesEnabled?: boolean; modulesEnabled?: boolean; canWrite?: boolean; canCreate?: boolean; /** Opens the Create work item dialog. Passed by the project Work items page only: it turns on the empty-project state, whose button needs it. */ onAddItem?: () => void; rowAction?: (item: Item) => React.ReactNode; /** Extra toolbar controls after Display (Save as view, Update view); gets the settings now applied. */ toolbarExtra?: (params: LayoutParams) => React.ReactNode; phoneToolbar?: { onSaveView?: (params: LayoutParams) => void; settingsPath: string } }) {
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
  const hoverNone = useHoverNone();
  /** Board cards whose overflow properties a pointer user opened with the "+N" button. */
  const [expandedCards, setExpandedCards] = React.useState<string[]>([]);
  // Set once the first list has arrived, so an empty project is not announced while the list is still loading or after it failed to load.
  const [loaded, setLoaded] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
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
  const [activeSheetRow, setActiveSheetRow] = React.useState<string | null>(null);
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
  const phoneToolbarMenu = React.useRef<HTMLButtonElement>(null);
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
      const [stateRows, labelRows, members, projectEstimate] = await Promise.all([
        action<State[]>("list_states", { projectId }),
        action<Label[]>("list_labels", { projectId }),
        action<Person[]>("list_project_members", { projectId }),
        action<Estimate | null>("get_estimate", { projectId }),
      ]);
      setStates(stateRows ?? []);
      setLabels(labelRows ?? []);
      setPeople(members ?? []);
      setEstimate(projectEstimate);
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
    if ("error" in result) {
      setLoadFailed(true);
      setQueryError(params.q.trim() ? result.error : null);
      return false;
    }
    setLoadFailed(false);
    setQueryError(null);
    setItems(result.data);
    setLoaded(true);
    return true;
  }, [fetchItems, params.q]);
  // A different project, cycle or module starts again as not loaded; this effect is declared before the load so its reset never lands after the new list.
  React.useEffect(() => { setLoaded(false); setLoadFailed(false); }, [projectId, cycleId, moduleId]);
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
    : grouping === "cycle" ? <RefreshCw aria-hidden size={14} className="text-muted-foreground" />
    : grouping === "module" ? <Package aria-hidden size={14} className="text-muted-foreground" />
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
      case "assignee": return <MultiSelect label={t("workItems.assignees")} readOnly={readOnly} selected={assignees} quiet={rowQuiet} searchAlways onOpen={() => { void action<Person[]>("list_project_members", { projectId }).then((rows) => rows && setPeople(rows)); }} icon={assignees.length === 0 ? <Users aria-hidden size={14} className="text-muted-foreground" /> : undefined}
          summary={assignees.length === 0 ? rowQuiet ? <span className="text-muted-foreground">—</span> : compact ? <span className="hidden text-11 max-sm:inline">{t("workItems.noAssignee")}</span> : <span className="text-muted-foreground">{t("workItems.noAssignee")}</span> : <span className="flex items-center -space-x-1">{assignees.slice(0, 3).map((id) => <Avatar key={id} name={personName(id)} id={id} agent={isAgentId(id)} />)}{assignees.length > 3 && <span className="pl-2 text-12">+{formatNumber(assignees.length - 3)}</span>}</span>}
          options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} />, isAgent: person.isAgent, codeCapable: person.codeCapable, hasAccess: person.hasAccess, accessReason: accessReasonText(person) }))}
          onToggle={(id, on) => void change(item, { assigneeIds: on ? [...assignees, id] : assignees.filter((other) => other !== id) })} />;
      case "labels": {
        const labelNames = item.labelIds.map((id) => labels.find((label) => label.id === id)?.name).filter(Boolean).join(", ");
        const labelSummary = rowQuiet && item.labelIds.length > 0
          ? <span className="flex max-w-24 min-w-0 items-center gap-1.5">{item.labelIds.slice(0, 1).map((id) => { const label = labels.find((candidate) => candidate.id === id); return label && <span key={id} className="inline-flex min-w-0 items-center gap-1"><span aria-hidden className="size-2 rounded-full shrink-0" style={{ backgroundColor: label.color }} /><span className="thai-room truncate" title={label.name}>{label.name}</span></span>; })}{item.labelIds.length > 1 && <span className="shrink-0">+{formatNumber(item.labelIds.length - 1)}</span>}</span>
          : item.labelIds.length === 0 ? rowQuiet ? <span className="text-muted-foreground">—</span> : compact ? <span className="hidden text-11 max-sm:inline">{t("layout.noLabel")}</span> : <span className="text-muted-foreground">{t("layout.noLabel")}</span> : <span className="block max-w-28 thai-room truncate" title={labelNames}>{labelNames}</span>;
        return <MultiSelect label={t("workItems.labels")} readOnly={readOnly} selected={item.labelIds} quiet={rowQuiet} icon={<Tag aria-hidden size={14} className="text-muted-foreground" />}
          summary={labelSummary}
          options={labels.map((label) => ({ id: label.id, name: label.name, icon: <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} /> }))}
          onToggle={(id, on) => void change(item, { labelIds: on ? [...item.labelIds, id] : item.labelIds.filter((other) => other !== id) })} />;
      }
      case "estimate": return <EstimateSelect estimate={estimate} pointId={item.estimatePointId ?? null} readOnly={readOnly} iconOnlyWhenEmpty={compact} quiet={rowQuiet} emptyLabel={rowQuiet ? "—" : undefined} onSelect={(estimatePointId) => void change(item, { estimatePointId })} />;
      case "dates": return <DatesMenu iconOnlyWhenEmpty={compact} startDate={item.startDate} dueDate={item.dueDate} stateGroup={states.find((state) => state.id === item.stateId)?.group} readOnly={readOnly} quiet={rowQuiet} emptyLabel={rowQuiet ? "—" : undefined} onChange={(dates) => void change(item, dates)} />;
      case "cycle": return <SingleSelect iconOnly={compact && !cycleOf[item.id]} label={t("workItems.cycle")} readOnly={readOnly} quiet={rowQuiet} value={cycleOf[item.id] ?? ""} icon={<RefreshCw aria-hidden size={14} className="text-muted-foreground" />}
          summary={cycleOptions.find((cycle) => cycle.id === cycleOf[item.id])?.name ?? t("workItems.noCycle")} display={rowQuiet && !cycleOf[item.id] ? "—" : undefined}
          options={[{ id: "", name: t("workItems.noCycle") }, ...cycleOptions.filter((cycle) => cycle.status !== "completed" || cycle.id === cycleOf[item.id]).map((cycle) => ({ id: cycle.id, name: cycle.name }))]} onSelect={(id) => void setCycle(item, id)} />;
      case "modules": {
        const moduleNames = mine.map((id) => moduleOptions.find((module) => module.id === id)?.name).filter(Boolean).join(", ");
        return <MultiSelect label={t("workItems.modules")} readOnly={readOnly} selected={mine} quiet={rowQuiet} icon={<Package aria-hidden size={14} className="text-muted-foreground" />}
          summary={mine.length === 0 ? rowQuiet ? <span className="text-muted-foreground">—</span> : compact ? <span className="hidden text-11 max-sm:inline">{t("workItems.noModules")}</span> : <span className="text-muted-foreground">{t("workItems.noModules")}</span> : <span className="block max-w-28 thai-room truncate" title={moduleNames}>{moduleNames}</span>}
          options={moduleOptions.map((module) => ({ id: module.id, name: module.name }))} onToggle={(id, on) => void setModule(item, id, on)} />;
      }
      default: return null;
    }
  };
  /** The properties a board card shows, in the same order as a list row. */
  const propertiesOf = (item: Item, hideState = false) => (["state", "priority", "estimate", "assignee", "labels", "dates", "cycle", "modules"] as const)
    .filter((property) => listShows(property) && !(hideState && property === "state"));
  /** An empty value with a mouse is a muted dash that appears on row hover or focus. A touch device (hover: none, at any width, including a phone browser's desktop-site mode) has no hover to reveal it, so the empty cell keeps its grid track but is not painted; phones leave empty properties out of the row entirely. */
  const isEmptyProperty = (item: Item, property: DisplayProperty) => property === "priority" ? item.priority === "none" : property === "estimate" ? !item.estimatePointId
    : property === "assignee" ? item.assigneeIds.length === 0 : property === "labels" ? item.labelIds.length === 0 : property === "dates" ? !item.startDate && !item.dueDate
    : property === "cycle" ? !cycleOf[item.id] : property === "modules" ? (modulesOf[item.id] ?? []).length === 0 : false;
  /** Reserve stable tracks for each visible property; shed dates, modules and cycle before the title loses room. */
  const slotRem: Record<string, number> = { state: 6.5, priority: 5.75, estimate: 4, labels: 7, cycle: 6, modules: 5, dates: 8.5, assignee: 5 };
  const allListProperties = (["estimate", "labels", "cycle", "modules", "dates", "assignee"] as const).filter((property) => listShows(property));
  const leadingProperties = (["priority", "state"] as const).filter((property) => listShows(property));
  const gapPx = 8;
  // On touch the checkbox, Priority and State tracks are 44px wide, so their 44px tap areas sit side by side instead of overlapping.
  const boxTrackPx = hoverNone ? 44 : 16;
  const iconTrackPx = hoverNone ? 44 : 28;
  // The row action is an icon Button: 32px, or 44px on touch.
  const rowActionPx = hoverNone ? 44 : 32;
  const tracksFor = (properties: readonly (typeof allListProperties)[number][]) => [`${boxTrackPx / 16}rem`, ...(leadingProperties.includes("priority") ? [`${iconTrackPx / 16}rem`] : []), "5rem", ...(leadingProperties.includes("state") ? [`${iconTrackPx / 16}rem`] : []), "minmax(7rem,1fr)", ...properties.map((property) => `${slotRem[property]}rem`), ...(rowAction ? [`${rowActionPx / 16}rem`] : [])];
  const widthFor = (properties: readonly (typeof allListProperties)[number][]) => {
    const tracks = tracksFor(properties);
    return 40 + boxTrackPx + 80 + 112 + leadingProperties.length * iconTrackPx + properties.reduce((sum, property) => sum + slotRem[property] * 16, 0)
      + (rowAction ? rowActionPx : 0) + Math.max(0, tracks.length - 1) * gapPx;
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
  const emptyPropertyClass = "[@media(hover:none)]:invisible [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-hover/row:pointer-events-auto [@media(hover:hover)]:group-has-[:focus-visible]/row:opacity-100 [@media(hover:hover)]:group-has-[:focus-visible]/row:pointer-events-auto";
  const propertyCell = (item: Item, property: (typeof allListProperties)[number], mobile = false) => {
    const empty = isEmptyProperty(item, property);
    return <span key={property} data-list-property={property} data-empty-property={empty ? "true" : undefined} className={cn(
      "flex min-w-0 items-center justify-end whitespace-nowrap sm:order-6 [&>*]:max-w-full [&_*]:min-w-0 [&_svg]:shrink-0 [&_button]:max-w-full [&_button>span]:overflow-hidden",
      mobile && "rounded-md bg-muted text-[length:var(--text-11)] text-muted-foreground [&_button]:px-1 [&_button]:py-0 [&_button]:text-11",
      empty && emptyPropertyClass,
    )}>
      {cellOf(item, property, false, true)}
    </span>;
  };
  const rowOf = (item: Item) => {
    const checkbox = pickBox(item, true);
    const rowActionCell = rowAction?.(item);
    const phoneProperties = allListProperties.filter((property) => !isEmptyProperty(item, property));
    const priorityEmpty = isEmptyProperty(item, "priority");
    return <li key={item.id} data-testid={`row-${item.displayId}`} data-list-row className="work-item-list-row group/row border-b border-border px-1 py-0.5 max-sm:py-0">
      <div style={columnStyle} className={cn(
        "mx-1 grid min-w-0 grid-cols-1 gap-y-0 rounded-lg px-3 py-1 max-sm:pb-0 max-sm:pt-2.5 sm:grid-cols-[var(--cols)] sm:items-center sm:gap-x-2 sm:gap-y-0 sm:py-0 [@media(hover:none)]:sm:min-h-10",
        selected.includes(item.id) ? "bg-background" : "bg-transparent hover:bg-accent",
      )}>
        <div className="flex min-h-10 min-w-0 items-center gap-2 max-sm:min-h-6 sm:contents [@media(pointer:coarse)]:max-sm:gap-3.5">
          <span className="flex size-4 shrink-0 items-center justify-center sm:order-1 sm:justify-self-center">{checkbox ? React.cloneElement(checkbox, { className: cn(checkbox.props.className, "rounded-sm") }) : <span aria-hidden />}</span>
          <span className="flex min-w-0 flex-1 items-center sm:order-5 sm:[@media(hover:none)]:h-[2.625rem]">
            <Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} title={item.title} className="w-full min-w-0 thai-room truncate text-14 font-medium text-foreground sm:[@media(hover:none)]:line-clamp-2 sm:[@media(hover:none)]:leading-5 sm:[@media(hover:none)]:whitespace-normal sm:[@media(hover:none)]:[overflow-wrap:anywhere]">{item.title}</Link>
          </span>
        </div>
        <div data-testid="work-item-row-metadata" className="work-item-row-metadata flex min-h-11 min-w-0 items-center gap-1 sm:contents">
          {leadingProperties.includes("priority") && <span data-list-property="priority" data-empty-property={priorityEmpty ? "true" : undefined} className={cn("flex min-w-7 shrink-0 items-center justify-center [@media(pointer:coarse)]:max-sm:min-w-11 sm:order-2 sm:[&>*]:max-w-full sm:[&_button]:max-w-full sm:[&_button]:px-1 [&_svg]:shrink-0", priorityEmpty && emptyPropertyClass)}>{cellOf(item, "priority", false, true, true)}</span>}
          {shows("id") ? <span title={item.displayId} className="min-w-0 shrink-0 truncate whitespace-nowrap text-11 tabular-nums text-muted-foreground max-sm:order-first max-sm:min-w-12 sm:order-3 sm:text-12">{item.displayId}</span> : <span aria-hidden className="max-sm:order-first max-sm:min-w-12 sm:order-3" />}
          {leadingProperties.includes("state") && <span className="flex min-w-7 shrink-0 items-center justify-center pointer-coarse:max-sm:min-w-11 sm:order-4 sm:[&>*]:max-w-full sm:[&_button]:max-w-full sm:[&_button]:px-1 [&_svg]:shrink-0">{cellOf(item, "state", false, true, true)}</span>}
          <div className="hidden sm:contents">
            {oneLine ? shownProperties.map((property) => propertyCell(item, property))
              : <div data-testid="list-property-wrap" className="flex min-w-0 flex-wrap items-center justify-end gap-x-1 gap-y-1 sm:col-span-full">{shownProperties.map((property) => propertyCell(item, property))}</div>}
          </div>
          {phoneProperties.length > 0 && <PhonePropertyStrip>
            {phoneProperties.map((property) => <span key={property} data-phone-property className="flex min-w-11 max-w-32 shrink-0 justify-center">{propertyCell(item, property, true)}</span>)}
          </PhonePropertyStrip>}
          {rowActionCell && <span className="sm:order-7">{rowActionCell}</span>}
        </div>
      </div>
    </li>;
  };

  const quickForm = (groupKey: string) => <form className="mx-1 my-1 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted px-3 py-2" onSubmit={(event) => { event.preventDefault(); void create(groupKey); }}>
    <Input autoFocus aria-label={t("workItems.titleField")} placeholder={t("workItems.quickTitle")} value={quickTitle} maxLength={500} className="min-w-0 flex-1 max-sm:basis-full" onChange={(event) => setQuickTitle(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") { setQuick(null); setQuickTitle(""); } }} />
    <Button type="submit" className={`${ghost} max-sm:ml-auto whitespace-nowrap`}>{t("workItems.create")}</Button>
  </form>;
  const newButton = (groupKey: string) => <Button type="button" className="mx-1 my-1 flex w-[calc(100%-0.5rem)] items-center gap-2 bg-muted py-2 text-left font-medium text-muted-foreground hover:bg-accent" onClick={() => { setQuick(groupKey); setQuickTitle(""); }}>
    <Plus aria-hidden size={14} />{t("workItems.new")}</Button>;

  const groupedItems = items.map((item) => ({ ...item, cycleId: cycleOf[item.id] ?? null, moduleIds: modulesOf[item.id] ?? [], creatorId: item.createdBy }));
  const grouped = groupItems(groupedItems, grouping, stateIds).filter((group) => grouping === "none" || group.items.length > 0 || grouping === "state");
  const groups = grouped.map((group) => ({ ...group, items: group.items.map((item) => items.find((row) => row.id === item.id)!) }));
  // The project's Work items page (the only caller with onAddItem) shows one empty state in the list, board and spreadsheet layouts, not five empty status groups. Cycles, Modules and Views keep their groups.
  const emptyProject = onAddItem !== undefined && loaded && !filtered && items.length === 0 && (params.layout === "list" || board || sheet);
  const emptyBlock = <div className="rounded-xl border border-border bg-card"><EmptyState title={t("workItems.empty")} description={t("workItems.emptyHint")}
    action={onAddItem && canCreate && canWrite ? <Button variant="primary" type="button" className={cn("flex items-center gap-1.5", phoneToolbar?.onSaveView && "phone-layout:hidden")} onClick={onAddItem}><Plus aria-hidden size={14} />{t("workItems.addNew")}</Button> : undefined} /></div>;

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
  const pickBox = (item: Item, revealOnHover = false) => selectable && <Checkbox data-no-drag hitArea="overlay" className={cn(
    "size-4 shrink-0",
    revealOnHover && "relative z-10",
    revealOnHover && !selected.includes(item.id) && "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-has-[:focus-visible]/row:opacity-100",
  )} aria-label={t("bulk.selectItem").replace("{id}", item.displayId)} checked={selected.includes(item.id)}
    onChange={() => undefined} onClick={(event) => pick(item.id, event.shiftKey)} />;
  // Collapsing a group hides its work items, so they leave the selection too: the bar never acts on what the user cannot see.
  const visibleKey = orderedIds.join(",");
  React.useEffect(() => setSelected((ids) => ids.every((id) => orderedIds.includes(id)) ? ids : ids.filter((id) => orderedIds.includes(id))), [visibleKey]);
  const allPicked = orderedIds.length > 0 && orderedIds.every((id) => selected.includes(id));
  const columns = params.props.filter((property) => property !== "id" && listShows(property));
  const cell = "border-b border-border px-3 text-left align-middle whitespace-nowrap";
  const sheetColumnMinWidth: Partial<Record<DisplayProperty, string>> = {
    state: "min-w-28", priority: "min-w-28", assignee: "min-w-28", labels: "min-w-40", dates: "min-w-32", cycle: "min-w-28", modules: "min-w-32", estimate: "min-w-24",
  };
  const contentReady = loaded && lookupsReady;
  const sheetView = <div className="min-w-0 max-w-full rounded-xl border border-border bg-card">
    {filtered && items.length === 0 && <p className="border-b border-border bg-card px-5 py-3 text-14 text-muted-foreground">{t("layout.noMatch")}</p>}
    <div role="region" aria-label={t("layout.spreadsheet")} tabIndex={0} className="min-w-0 max-w-full overflow-x-auto rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" data-testid="sheet-scroll"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        event.currentTarget.scrollLeft += (event.key === "ArrowRight" ? 1 : -1) * Math.max(80, event.currentTarget.clientWidth * 0.8);
      }}>
      <table className="w-max min-w-full table-fixed border-separate border-spacing-0 bg-card text-13">
        <caption className="sr-only">{t("layout.spreadsheet")}</caption>
        <thead><tr className="bg-muted text-12 font-medium text-muted-foreground">
          <th scope="col" style={{ width: "24rem", maxWidth: "24rem" }} className={`${cell} py-2 sticky left-0 z-10 w-96 min-w-80 max-sm:!w-64 max-sm:!max-w-64 max-sm:min-w-64 bg-muted`}>{t("layout.sheet.workItem")}</th>
          {columns.map((property) => <th key={property} scope="col" className={`${cell} py-2 ${sheetColumnMinWidth[property] ?? ""}`}>{t(`layout.property.${property}`)}</th>)}
          {rowAction && <th scope="col" className={`${cell} py-2 min-w-24`}><span className="sr-only">{t("layout.sheet.actions")}</span></th>}
        </tr></thead>
        <tbody>{items.map((item) => <tr key={item.id} data-testid={`row-${item.displayId}`} className="group h-12"
          onPointerEnter={() => setActiveSheetRow(item.id)}
          onPointerLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setActiveSheetRow(null); }}
          onFocusCapture={() => setActiveSheetRow(item.id)}
          onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActiveSheetRow(null); }}>
          <th scope="row" style={{ width: "24rem", maxWidth: "24rem" }} className={`${cell} h-12 py-0 sticky left-0 z-10 w-96 min-w-80 max-sm:!w-64 max-sm:!max-w-64 max-sm:min-w-64 bg-card font-normal group-hover:bg-muted pointer-coarse:pl-4`}>
            <span className="flex min-w-0 items-center gap-3 pointer-coarse:gap-3.5">{pickBox(item)}{shows("id") && <span className="shrink-0 text-12 text-muted-foreground">{item.displayId}</span>}
              <Link title={item.title} to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} className="block min-w-0 flex-1 thai-room truncate text-14 font-medium text-foreground">{item.title}</Link></span>
          </th>
          {columns.map((property) => {
            const empty = isEmptyProperty(item, property);
            return <td key={property} data-empty-property={empty || undefined} className={`${cell} h-12 py-0 ${sheetColumnMinWidth[property] ?? ""} [&_button]:rounded-md [&_button]:border-transparent [&_button]:bg-transparent [&_button]:px-1 [&_button]:py-1 group-hover:bg-muted`}>
              <span className={empty && activeSheetRow !== item.id ? "opacity-0" : ""}>{cellOf(item, property, false, true)}</span>
            </td>;
          })}
          {rowAction && <td className={`${cell} h-12 py-0 min-w-24`}>{rowAction(item)}</td>}
        </tr>)}</tbody>
      </table>
    </div>
    {canCreate && canWrite && (quick === "end" ? quickForm("all") : newButton("end"))}
  </div>;

  const calendar = calendarPlacement(items, calendarMonth);
  const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const calendarWeeks = Array.from({ length: 6 }, (_, weekIndex) => {
    const days = calendar.days.slice(weekIndex * 7, weekIndex * 7 + 7);
    const first = days[0]!.date;
    const last = days[6]!.date;
    const occupied: number[][] = [];
    const segments = items.flatMap((item) => {
      const from = (item.startDate ?? item.dueDate)?.slice(0, 10);
      const through = (item.dueDate ?? item.startDate)?.slice(0, 10);
      if (!from || !through || through < first || from > last) return [];
      const start = Math.max(0, days.findIndex((day) => day.date >= from));
      const end = Math.min(6, days.findLastIndex((day) => day.date <= through));
      if (start > end) return [];
      let lane = 0;
      while (occupied[lane]?.some((column) => column >= start && column <= end)) lane++;
      occupied[lane] ??= [];
      for (let column = start; column <= end; column++) occupied[lane]!.push(column);
      return [{ item, start, span: end - start + 1, lane }];
    }).sort((a, b) => a.lane - b.lane || a.start - b.start);
    return { days, segments, lanes: occupied.length };
  });
  const monthName = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(calendarMonth);
  const calendarView = <section aria-label={t("layout.calendar")} className="rounded-xl border border-border bg-card p-2" data-testid="calendar-layout">
    <header className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2">
      <div className="flex items-center gap-1"><Button type="button" aria-label={t("layout.calendar.previous")} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}><ChevronLeft aria-hidden size={16} /></Button>
        <h2 className="min-w-36 text-center text-14 font-medium text-foreground">{monthName}</h2><Button type="button" aria-label={t("layout.calendar.next")} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}><ChevronRight aria-hidden size={16} /></Button></div>
      <Button type="button" className={todayClass} onClick={() => setCalendarMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}><CalendarDays aria-hidden size={14} />{t("layout.calendar.today")}</Button>
    </header>
    <div className="mt-2 hidden grid-cols-7 gap-px rounded-md bg-border md:grid">{weekdays.map((day) => <div key={day} className="bg-card px-2 py-1 text-12 font-medium text-muted-foreground">{t(`layout.weekday.${day}`)}</div>)}</div>
    <div className="hidden gap-px overflow-hidden rounded-md bg-border md:grid" data-testid="calendar-month-grid">
      {calendarWeeks.map(({ days, segments, lanes }) => <div key={days[0]!.date} data-calendar-week className="relative grid grid-cols-7 gap-px bg-border" style={{ minHeight: Math.max(112, 56 + lanes * 28 + 12) }}>
        {days.map((day) => {
          const inMonth = day.date.slice(0, 7) === `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}`;
          return <div key={day.date} data-calendar-date={day.date} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain"); if (id) void reschedule(id, day.date); }}
            className={`group relative min-h-28 bg-card p-2 ${inMonth ? "" : "bg-muted/60 text-muted-foreground"}`} style={{ minHeight: Math.max(112, 56 + lanes * 28 + 12) }}>
            <div className="flex h-7 items-center justify-between text-12 [@media(pointer:coarse)]:h-11"><time dateTime={day.date} aria-label={new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${day.date}T12:00:00`))}>{Number(day.date.slice(-2))}</time>
              {canCreate && canWrite && <Button type="button" aria-label={t("layout.calendar.add").replace("{date}", day.date)} className="size-7 shrink-0 rounded-md border-transparent bg-transparent p-0 text-muted-foreground opacity-0 shadow-none hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100" onClick={() => { setQuick(day.date); setQuickTitle(""); }}>+</Button>}</div>
            {quick === day.date && <form className="absolute inset-x-2 top-14 z-20 flex gap-1 rounded-md border border-border bg-popover p-1 shadow-sm" onSubmit={(event) => { event.preventDefault(); void createForDate(day.date); }}><Input autoFocus aria-label={t("workItems.titleField")} value={quickTitle} className="min-w-0 w-full" onChange={(event) => setQuickTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuick(null); }} /><Button type="submit" aria-label={t("workItems.create")}>+</Button></form>}
          </div>;
        })}
        {segments.length > 0 && <div className="pointer-events-none absolute inset-x-0 top-14 grid grid-cols-7 gap-x-px" style={{ gridTemplateRows: `repeat(${lanes}, 1.75rem)` }}>
          {segments.map(({ item, start, span, lane }) => <Link key={item.id} to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} draggable={canWrite} onDragStart={(event) => { event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const week = event.currentTarget.closest<HTMLElement>("[data-calendar-week]"); const date = Array.from(week?.querySelectorAll<HTMLElement>("[data-calendar-date]") ?? []).find((cell) => { const box = cell.getBoundingClientRect(); return event.clientX >= box.left && event.clientX <= box.right; })?.dataset.calendarDate; const id = event.dataTransfer.getData("text/plain"); if (id && date) void reschedule(id, date); }} data-testid={`calendar-card-${item.displayId}`}
            className="pointer-events-auto mx-0.5 block min-w-0 self-center thai-room truncate rounded-md border border-border/70 bg-muted px-2 py-1 text-12 font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ gridColumn: `${start + 1} / span ${span}`, gridRow: lane + 1 }} title={item.title}>{item.title}</Link>)}
        </div>}
      </div>)}
    </div>
    <div className="grid gap-2 md:hidden" data-testid="calendar-days">
      {calendar.days.filter((day) => day.items.length > 0).map((day) => <section key={day.date} className="relative rounded-lg border border-border bg-card p-3" data-calendar-date={day.date}>
        <div className="mb-2 flex items-center justify-between"><time dateTime={day.date} className="text-13 font-medium">{new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(new Date(`${day.date}T12:00:00`))}</time>
          {canCreate && canWrite && <Button type="button" aria-label={t("layout.calendar.add").replace("{date}", day.date)} className="size-11 p-0 text-muted-foreground" onClick={() => { setQuick(day.date); setQuickTitle(""); }}>+</Button>}</div>
        <div className="grid gap-1">{day.items.map((item) => <Link key={item.id} to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} draggable={canWrite} onDragStart={(event) => { event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; }} data-testid={`calendar-agenda-card-${item.displayId}`} className="block thai-room truncate rounded-md bg-muted px-3 py-2 text-13 font-medium text-foreground hover:bg-accent">{item.title}</Link>)}</div>
        {quick === day.date && <form className="absolute inset-x-3 top-12 z-20 flex gap-1 rounded-md border border-border bg-popover p-1 shadow-sm" onSubmit={(event) => { event.preventDefault(); void createForDate(day.date); }}><Input autoFocus aria-label={t("workItems.titleField")} value={quickTitle} className="min-w-0 w-full" onChange={(event) => setQuickTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuick(null); }} /><Button type="submit" aria-label={t("workItems.create")}>+</Button></form>}
      </section>)}
    </div>
    <aside aria-label={t("layout.calendar.undated")} className="mt-2 rounded-lg bg-muted p-3"><h3 className="mb-2 text-13 font-medium">{t("layout.calendar.undated")}</h3>
      {calendar.undated.length ? <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">{calendar.undated.map((item) => <li key={item.id} className="min-w-0"><Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} className="block rounded border border-border px-2 py-1.5 text-13 text-foreground [overflow-wrap:anywhere] hover:bg-accent">{item.title}</Link></li>)}</ul> : <p className="text-13 text-muted-foreground">{t("layout.calendar.noUndated")}</p>}
    </aside>
  </section>;

  const ganttView = <section aria-label={t("layout.gantt")} data-testid="gantt-layout" data-gantt-start={gantt.start} data-gantt-days={gantt.days.length} className={`min-w-0 max-w-full rounded-xl border border-border bg-card p-2 ${ganttDrag ? "select-none" : ""}`}>
    <p className="m-0 border-b border-border px-3 py-2 text-12 text-muted-foreground md:hidden">{t("layout.gantt.scrollHint")}</p>
    <header className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2">
      <div className="flex items-center gap-1"><Button type="button" aria-label={t("layout.gantt.previous")} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => shiftGanttAnchor(-1)}><ChevronLeft aria-hidden size={16} /></Button>
        <h2 className="min-w-36 text-center text-14 font-medium">{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(ganttAnchor)}</h2>
        <Button type="button" aria-label={t("layout.gantt.next")} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => shiftGanttAnchor(1)}><ChevronRight aria-hidden size={16} /></Button>
        <Button type="button" className={todayClass} onClick={() => setGanttAnchor(new Date())}>{t("layout.calendar.today")}</Button></div>
      <label className="flex items-center gap-2 text-13 font-medium text-foreground">{t("layout.gantt.zoom")}<select aria-label={t("layout.gantt.zoom")} className={selectClass} value={ganttZoom} onChange={(event) => setGanttZoom(event.target.value as GanttZoom)}>{(["week", "month", "quarter"] as const).map((zoom) => <option key={zoom} value={zoom}>{t(`layout.gantt.${zoom}`)}</option>)}</select></label>
    </header>
    <div className="mt-2 overflow-x-auto rounded-lg border border-border [--gantt-label:9rem] md:[--gantt-label:12rem] xl:[--gantt-label:20rem]"><div style={{ minWidth: `calc(var(--gantt-label) + ${Math.max(gantt.days.length * 18, 580)}px)` }}>
      <div className="grid grid-cols-[var(--gantt-label)_minmax(0,1fr)] border-b border-border bg-muted"><div className="px-3 py-2 text-13 font-medium text-muted-foreground">{t("layout.sheet.workItem")}</div><div className="grid" style={{ gridTemplateColumns: `repeat(${gantt.days.length}, minmax(0, 1fr))` }}>{gantt.days.map((date, index) => <div key={date} title={date} className="border-l border-border px-0.5 py-2 text-center text-12 tabular-nums text-muted-foreground">{index % (ganttZoom === "week" ? 1 : 7) === 0 ? Number(date.slice(-2)) : ""}</div>)}</div></div>
      <div className="relative">
        {gantt.today >= 0 && gantt.today < gantt.days.length && <div aria-label={t("layout.gantt.todayMarker")} data-testid="gantt-today" className="pointer-events-none absolute bottom-0 top-0 z-0 border-l border-dashed border-destructive" style={{ left: `calc(var(--gantt-label) + (100% - var(--gantt-label)) * ${gantt.today / gantt.days.length})` }} />}
        {gantt.bars.map(({ item, left, width }) => {
          const drag = ganttDrag?.id === item.id ? ganttDrag : ganttSaving[item.id] ?? null;
          const end = left + width;
          const labelOnRight = end < gantt.days.length - 3;
          const labelOnLeft = !labelOnRight && left >= 3;
          const stateGroup = states.find((state) => state.id === item.stateId)?.group;
          const barTone = stateGroup === "completed" ? "bg-emerald-500/20 dark:bg-emerald-400/20" : stateGroup === "cancelled" ? "bg-muted" : stateGroup === "started" ? "bg-sky-500/20 dark:bg-sky-400/25" : stateGroup === "backlog" ? "bg-muted-foreground/10 dark:bg-muted-foreground/20" : "bg-primary/20 dark:bg-primary/30";
          /** An item with one date has no other edge to cross: the handle just places that date, and the bar stays one day wide. */
          const oneSided = drag?.kind === "start" ? !item.dueDate : drag?.kind === "due" ? !item.startDate : false;
          /** With both dates the preview stops at the other edge and is ringed red when the pointer is past it; the server refuses that range (start after due). */
          const invalid = !oneSided && (drag?.kind === "start" ? drag.at > end - 1 : drag?.kind === "due" ? drag.at < left : false);
          const shownLeft = drag?.kind === "move" ? left + drag.at : oneSided ? drag!.at : drag?.kind === "start" ? Math.min(drag.at, end - 1) : left;
          const shownWidth = oneSided ? 1 : drag?.kind === "start" ? end - shownLeft : drag?.kind === "due" ? Math.max(1, drag.at - left + 1) : width;
          return <div key={item.id} className="grid min-h-11 grid-cols-[var(--gantt-label)_minmax(0,1fr)] border-b border-border" data-testid={`gantt-row-${item.displayId}`}>
          <Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} className="thai-room truncate px-3 py-3 text-13 font-medium text-foreground">{item.title}</Link>
          <div className="relative">
            {gantt.days.map((date, index) => <div key={date} data-gantt-date={date} data-testid={`gantt-drop-${date}`} className={`absolute inset-y-0 ${[0, 6].includes(new Date(`${date}T12:00:00`).getDay()) ? "bg-muted/50" : ""}`} style={{ left: `${index / gantt.days.length * 100}%`, width: `${100 / gantt.days.length}%` }} />)}
            {drag && <div aria-hidden data-testid="gantt-origin" className="pointer-events-none absolute top-2 h-7 rounded border border-dashed border-ring" style={{ left: `${left / gantt.days.length * 100}%`, width: `${Math.max(width / gantt.days.length * 100, 1.2)}%` }} />}
            <div onPointerDown={canWrite ? (event) => { if (ganttSaving[item.id] || (event.target as HTMLElement).closest("[data-gantt-edge]")) return; event.currentTarget.setPointerCapture(event.pointerId); ganttPointerStart.current = { x: event.clientX }; } : undefined} onPointerMove={canWrite ? (event) => ganttMovePreview(event, item) : undefined} onPointerUp={canWrite ? (event) => ganttMove(event, item) : undefined} onPointerCancel={() => { ganttPointerStart.current = null; ganttEdgeStart.current = null; setGanttDrag(null); }} onDragStart={(event) => event.preventDefault()} className={`absolute top-2 z-10 h-5 select-none rounded-sm border border-primary/20 ${barTone} ${canWrite ? "cursor-grab active:cursor-grabbing" : ""} ${drag ? `z-30 shadow-xl ring-2 ${invalid ? "ring-destructive" : "ring-ring"}` : "shadow-sm"}`} style={{ left: `${shownLeft / gantt.days.length * 100}%`, width: `${Math.max(shownWidth / gantt.days.length * 100, 1.2)}%` }} data-testid={`gantt-bar-${item.displayId}`}>
              {canWrite && !startClipped(item) && <span data-gantt-edge role="button" tabIndex={0} aria-keyshortcuts="ArrowLeft ArrowRight" aria-label={`${t("layout.gantt.resizeStart")} ${item.displayId}`} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); void ganttResizeByKeyboard(item, "start", event.key === "ArrowLeft" ? -1 : 1); }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); if (ganttSaving[item.id]) return; event.currentTarget.setPointerCapture(event.pointerId); ganttEdgeStart.current = { x: event.clientX }; }} onPointerMove={(event) => ganttEdgePreview(event, item, "start")} onPointerUp={(event) => ganttResize(event, item, "start")} className="absolute inset-y-0 left-0 z-20 w-1 cursor-ew-resize rounded-l bg-primary" />}
              {startClipped(item) && <span aria-hidden data-gantt-overflow="start" className="pointer-events-none absolute inset-y-0 left-0 z-20 flex w-4 items-center justify-center rounded-l-sm bg-card/90 text-muted-foreground"><ChevronLeft size={12} /></span>}
              {dueClipped(item) && <span aria-hidden data-gantt-overflow="due" className="pointer-events-none absolute inset-y-0 right-0 z-20 flex w-4 items-center justify-center rounded-r-sm bg-card/90 text-muted-foreground"><ChevronRight size={12} /></span>}
              {canWrite && !dueClipped(item) && <span data-gantt-edge role="button" tabIndex={0} aria-keyshortcuts="ArrowLeft ArrowRight" aria-label={`${t("layout.gantt.resizeDue")} ${item.displayId}`} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); void ganttResizeByKeyboard(item, "due", event.key === "ArrowLeft" ? -1 : 1); }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); if (ganttSaving[item.id]) return; event.currentTarget.setPointerCapture(event.pointerId); ganttEdgeStart.current = { x: event.clientX }; }} onPointerMove={(event) => ganttEdgePreview(event, item, "due")} onPointerUp={(event) => ganttResize(event, item, "due")} className="absolute inset-y-0 right-0 z-20 w-1 cursor-ew-resize rounded-r bg-primary" />}
            </div>
            {(labelOnRight || labelOnLeft) && <span data-testid={`gantt-label-${item.displayId}`} className="pointer-events-none absolute top-2 z-20 h-5 w-14 thai-room truncate bg-card px-1 text-12 leading-5 text-foreground" style={{ left: `${(labelOnRight ? end : left - 3) / gantt.days.length * 100}%`, textAlign: labelOnRight ? "left" : "right" }}>{item.displayId}</span>}
          </div>
        </div>; })}
      </div>
    </div></div>
    <aside aria-label={t("layout.gantt.undated")} className="mt-2 rounded-lg bg-muted p-3"><h3 className="mb-2 text-13 font-medium">{t("layout.gantt.undated")}</h3>{gantt.undated.length ? <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">{gantt.undated.map((item) => <li key={item.id} className="min-w-0"><Link to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} className="block rounded-md px-2 py-1.5 text-13 text-foreground [overflow-wrap:anywhere] hover:bg-accent">{item.title}</Link></li>)}</ul> : <p className="text-13 text-muted-foreground">{t("layout.gantt.noUndated")}</p>}</aside>
  </section>;

  const toggleSelectShown = () => setSelected(allPicked ? [] : orderedIds.slice(0, 500));
  const isQueryOpen = filterQueryOpen || queryError !== null;
  const toggleQuery = () => setFilterQueryOpen(!filterQueryOpen);
  const toolbar = <div data-testid="work-items-toolbar" className={cn("work-items-toolbar @container/work-items-toolbar flex min-w-0 flex-wrap items-center gap-2 pointer-coarse:gap-y-3 [@media(max-height:480px)]:[&_span:not([data-slot=checkbox]):not([data-slot=checkbox]_*):not(:has([data-slot=checkbox]))]:sr-only", phoneToolbar && "phone-layout:flex-nowrap")}>
    {phoneToolbar && <select aria-label={t("layout.switch")} className={cn(selectClass, "hidden min-h-11 w-auto flex-1 phone-layout:block")} value={params.layout} onChange={(event) => update({ layout: event.target.value as LayoutParams["layout"] })}>
      {layouts.map((layout) => <option key={layout} value={layout}>{t(`layout.${layout}`)}</option>)}
    </select>}
    <div role="group" aria-label={t("layout.switch")} className={cn("flex min-w-0 flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5", phoneToolbar && "phone-layout:hidden")}>
      {layouts.map((layout) => { const Icon = layout === "list" ? List : layout === "board" ? Columns3 : layout === "spreadsheet" ? Table2 : layout === "calendar" ? CalendarDays : BarChart3; return <Button key={layout} variant={params.layout === layout ? "secondary" : "ghost"} type="button" data-layout-switch aria-pressed={params.layout === layout} aria-label={t(`layout.${layout}`)} title={t(`layout.${layout}`)}
        className={cn(
          "inline-flex items-center rounded-md p-1.5 hover:text-foreground max-sm:min-h-9 max-sm:min-w-9 max-sm:flex-col max-sm:justify-center max-sm:gap-0.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:rounded-none",
          params.layout === layout ? "bg-card text-foreground shadow-sm" : "bg-transparent text-muted-foreground hover:bg-accent max-sm:text-foreground",
        )} onClick={() => update({ layout })}><Icon aria-hidden size={16} /><span className="hidden text-11 leading-none max-sm:inline @max-[19rem]/work-items-toolbar:sr-only">{t(`layout.${layout}`)}</span></Button>; })}
    </div>
    {selectable && <label className={cn("inline-flex min-h-11 cursor-pointer items-center", phoneToolbar && "phone-layout:hidden")} title={t("bulk.selectAll")}><span className={cn(toolbarSecondarySm, "gap-2")}><Checkbox hitArea="overlay" className="size-4" checked={allPicked} onChange={toggleSelectShown} /><span className="sr-only">{t("bulk.selectAll")}</span><span aria-hidden>{t("bulk.selectShown")}</span></span></label>}
    <FilterPicker sections={sections} filters={chips ?? emptyFilters()} count={filterCount} compactOnPhone={!!phoneToolbar} onChange={setFilters} onClear={() => update({ q: "" })} />
    <FilterQueryToggle className={phoneToolbar ? "phone-layout:hidden" : undefined} open={isQueryOpen} onToggle={toggleQuery} />
    <Popover label={t("layout.display")} className={cn(toolbarSecondarySm, phoneToolbar && "phone-layout:size-11 phone-layout:shrink-0 phone-layout:justify-center phone-layout:p-0")} panelRole="dialog" panelClassName="grid w-72 max-w-[calc(100vw-2rem)] max-h-[70dvh] gap-3 overflow-auto p-3" trigger={<><SlidersHorizontal aria-hidden size={14} /><span className={cn("max-sm:sr-only", phoneToolbar && "phone-layout:sr-only")}>{t("layout.display")}</span></>}>
      {() => <>
        {!sheet && <label>{t("layout.group")}<select className={selectClass} value={board ? boardGroup : params.group} onChange={(event) => { const group = event.target.value as LayoutParams["group"]; update({ group, subGroup: params.subGroup === group ? "none" : params.subGroup }); }}>
          {(board ? groupings.filter((value) => value !== "none") : groupings).filter((value) => value !== "type" || typesEnabled).map((value) => <option key={value} value={value}>{t(`layout.group.${value}`)}</option>)}
        </select></label>}
        {supportsSubGroup && <label>{t("layout.subGroup")}<select className={selectClass} value={subGroup} onChange={(event) => update({ subGroup: event.target.value as LayoutParams["subGroup"] })}>
          {groupings.filter((value) => value === "none" || value !== grouping).filter((value) => value !== "type" || typesEnabled).map((value) => <option key={value} value={value}>{t(`layout.group.${value}`)}</option>)}
        </select></label>}
        {!board && <>
          <label>{t("layout.sort")}<select className={selectClass} value={params.sort} onChange={(event) => update({ sort: event.target.value as LayoutParams["sort"] })}>
            {sortFields.map((value) => <option key={value} value={value}>{t(`layout.sort.${value}`)}</option>)}
          </select></label>
          <label>{t("layout.direction")}<select className={selectClass} value={params.dir} onChange={(event) => update({ dir: event.target.value as LayoutParams["dir"] })}>
            {(["asc", "desc"] as const).map((value) => <option key={value} value={value}>{t(`layout.direction.${value}`)}</option>)}
          </select></label>
        </>}
        <fieldset className="grid gap-1.5"><legend className="pb-1 text-12 font-medium text-muted-foreground">{t("layout.properties")}</legend>
          {(sheet ? [...params.props, ...displayProperties.filter((property) => !params.props.includes(property))] : [...displayProperties]).filter((property) => property !== "estimate" || !!estimate?.enabled).map((property) => <div key={property} className="flex items-center gap-1">
            <label className={`${checkRow} flex-1 pointer-coarse:min-h-11 pointer-coarse:pl-1`}>
              <Checkbox hitArea="overlay" checked={params.props.includes(property)} onChange={(event) => update({ props: sheet ? (event.target.checked ? [...params.props, property] : params.props.filter((other) => other !== property)) : displayProperties.filter((other) => other === property ? event.target.checked : params.props.includes(other)) })} />{t(`layout.property.${property}`)}</label>
            {sheet && params.props.includes(property) && <>
              <Button variant="ghost" type="button" className="rounded-md bg-transparent p-1 text-muted-foreground hover:bg-accent" aria-label={`${t("layout.column.earlier")}: ${t(`layout.property.${property}`)}`} onClick={() => update({ props: moveProperty(params.props, property, -1) })}><ArrowLeft aria-hidden size={14} /></Button>
              <Button variant="ghost" type="button" className="rounded-md bg-transparent p-1 text-muted-foreground hover:bg-accent" aria-label={`${t("layout.column.later")}: ${t(`layout.property.${property}`)}`} onClick={() => update({ props: moveProperty(params.props, property, 1) })}><ArrowRight aria-hidden size={14} /></Button>
            </>}
          </div>)}
        </fieldset>
      </>}
    </Popover>
    {phoneToolbar && <div className="hidden shrink-0 phone-layout:block">
      <DropdownMenu>
        <DropdownMenuTrigger ref={phoneToolbarMenu} render={<Button type="button" variant="ghost" />} aria-label={t("workItems.moreActions")} className="size-11">
          <Ellipsis aria-hidden size={18} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {selectable && <DropdownMenuCheckboxItem className="min-h-11" checked={allPicked} onCheckedChange={toggleSelectShown} closeOnClick>
            <span aria-hidden className="absolute start-2.5">{allPicked ? <Check size={14} /> : null}</span>
            {t("bulk.selectShown")}
          </DropdownMenuCheckboxItem>}
          <DropdownMenuCheckboxItem className="min-h-11" checked={isQueryOpen} onCheckedChange={toggleQuery} closeOnClick>
            <span aria-hidden className="absolute start-2.5">{isQueryOpen ? <Check size={14} /> : null}</span>
            {t("layout.filterQuery.button")}
          </DropdownMenuCheckboxItem>
          {phoneToolbar.onSaveView && <DropdownMenuItem className="min-h-11" onClick={() => { phoneToolbarMenu.current?.focus(); phoneToolbar.onSaveView?.(params); }}>{t("views.saveAs")}</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link to={phoneToolbar.settingsPath} />} className="min-h-11">{t("projects.settings")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>}
    {toolbarExtra?.(params)}
  </div>;

  const renderBoard = (columns: Array<BoardColumn<Item>>) => <Board columns={columns} canDrag={canWrite && ["state", "priority", "assignee"].includes(boardGroup)} reorderWithinColumn={boardGroup === "state" && !/\border\s+by\b/i.test(params.q)} announcePosition={boardGroup === "state" && !/\border\s+by\b/i.test(params.q)} canAdd={canCreate && canWrite} collapsed={collapsedColumns} onDrop={(id, column, beforeId, sourceColumn) => dropCard(id, column, beforeId, sourceColumn)}
    onToggle={(column) => setCollapsedColumns((list) => list.includes(column) ? list.filter((key) => key !== column) : [...list, column])}
    onAdd={(column) => { setQuick(column); setQuickTitle(""); }} quick={quick} quickForm={quickForm}
    renderCard={(item, reorderHandle, active) => {
      const cardProperties = propertiesOf(item, boardGroup === "state");
      const setCardProperties = cardProperties.filter((property) => !isEmptyProperty(item, property));
      const visibleCardProperties = setCardProperties.slice(0, 3);
      const hiddenCardProperties = setCardProperties.slice(3);
      return <div className="grid gap-2">
        <div className="flex items-start justify-between gap-2 pointer-coarse:gap-3.5">
          <span data-testid="card-selection" className={`opacity-0 ${active || selected.includes(item.id) ? "opacity-100" : ""}`}>{pickBox(item)}</span>
          <div className="grid min-w-0 flex-1 gap-1">
            {shows("id") && <span className="text-12 text-muted-foreground">{item.displayId}</span>}
            <Link title={item.title} to={paths.workItem(workspaceSlug, item.displayId)} onClick={openPeek(item.displayId)} draggable={false} data-testid="card-title" className="thai-room line-clamp-2 text-14 font-medium text-foreground [overflow-wrap:anywhere]">{item.title}</Link>
          </div>
          {reorderHandle}{rowAction && <span data-no-drag>{rowAction(item)}</span>}
        </div>
        {cardProperties.length > 0 && <div className="flex min-w-0 items-center gap-1.5 [@media(pointer:coarse)]:gap-2">
          {/* The toggle sits before the scrolling strip: Tab goes from it into the chips it reveals, and scrolling never carries it away. */}
          {hiddenCardProperties.length > 0 && <Button variant="ghost" type="button" data-no-drag aria-expanded={expandedCards.includes(item.id)} aria-label={`${t("workItems.more")}: ${hiddenCardProperties.map((property) => t(`layout.property.${property}`)).join(", ")}`} title={hiddenCardProperties.map((property) => t(`layout.property.${property}`)).join(", ")}
            className="shrink-0 rounded-md bg-transparent px-1.5 py-0.5 text-12 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setExpandedCards((list) => list.includes(item.id) ? list.filter((id) => id !== item.id) : [...list, item.id])}>{expandedCards.includes(item.id) ? <ChevronsLeft aria-hidden size={14} /> : `+${hiddenCardProperties.length}`}</Button>}
          <div data-testid="card-properties" className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto [@media(pointer:coarse)]:gap-2">
          {visibleCardProperties.map((property) => <React.Fragment key={property}>{cellOf(item, property, true)}</React.Fragment>)}
          {/* Overflow properties stay rendered and in the tab order: a keyboard user reveals each by focusing it, a pointer user opens them all with "+N". */}
          {hiddenCardProperties.length > 0 && <span data-testid="card-overflow-properties" onFocus={(event) => event.target.scrollIntoView({ block: "nearest", inline: "nearest" })} className={`flex shrink-0 items-center gap-1.5 [@media(pointer:coarse)]:gap-2 ${expandedCards.includes(item.id) ? "" : "max-w-0 overflow-hidden focus-within:max-w-none focus-within:overflow-visible"}`}>
            {hiddenCardProperties.map((property) => <React.Fragment key={property}>{cellOf(item, property, true)}</React.Fragment>)}
          </span>}
          {cardProperties.filter((property) => isEmptyProperty(item, property)).map((property) => <span key={property} className={active ? "" : "opacity-0"}>{cellOf(item, property, true)}</span>)}
          </div>
        </div>}
      </div>;
    }}
    ghost={(item) => <div className="flex items-baseline gap-2"><span className="text-12 text-muted-foreground">{item.displayId}</span><span className="text-14 font-medium text-foreground">{item.title}</span></div>} />;

  const peekPanel = peek && <>
    <div aria-hidden className="fixed inset-0 z-40 bg-black/30" onClick={() => setPeek(null)} />
    <aside data-peek role="dialog" aria-label={t("workItems.peek.title")} className="@container fixed inset-y-0 right-0 z-50 w-full rounded-l-xl border-l border-border bg-card shadow-xl sm:w-[80vw] sm:max-w-[1160px]">
      <WorkItemDetail key={peek} displayId={peek} mode="peek" onChanged={() => void load()} onClose={() => setPeek(null)} />
    </aside>
  </>;

  return <div className={cn("grid gap-3", phoneToolbar && "phone-layout:gap-1")}>
    {peekPanel}
    {toolbar}
    <FilterChips filters={chips ?? emptyFilters()} sections={sections} custom={chips === null} onChange={setFilters} onClear={() => update({ q: "" })} />
    {(filterQueryOpen || queryError !== null) && <FilterQueryEditor text={params.q} error={queryError} onApply={(text) => void applyFilterQuery(text)} generate={{ projectId }} />}
    {note && <p role="alert" className="text-destructive">{note}</p>}
    {selectable && selected.length > 0 && <BulkBar projectId={projectId} selected={items.filter((item) => selected.includes(item.id))} states={states} people={people} labels={labels} estimate={estimate} run={run}
      cycleOptions={cyclesEnabled && !cycleId ? cycleOptions : null} moduleOptions={modulesEnabled && !moduleId ? moduleOptions : null} onClear={() => { setSelected([]); anchor.current = null; }} onApplied={() => void load()} />}
    {/* A query error already shows in the filter editor above. */}
    {!contentReady && queryError === null && (loadFailed
      ? <p role="alert" className="text-sm text-destructive">{t("account.loadFailed")} <Button type="button" size="sm" onClick={() => void load()}>{t("offline.retry")}</Button></p>
      : <div role="status" data-testid="work-items-skeleton" className="grid min-h-[60dvh] content-start gap-1 rounded-xl border border-border bg-card p-2">
        <span className="sr-only">{t("account.loading")}</span>
        {Array.from({ length: 8 }, (_, index) => <span key={index} aria-hidden className="h-11 rounded-md bg-muted motion-safe:animate-pulse" />)}
      </div>)}
    {contentReady && emptyProject && emptyBlock}
    {contentReady && sheet && !emptyProject && sheetView}
    {contentReady && params.layout === "calendar" && calendarView}
    {contentReady && params.layout === "gantt" && ganttView}
    {contentReady && !board && !sheet && !emptyProject && params.layout !== "calendar" && params.layout !== "gantt" && <div ref={setListBox} data-testid="work-items-list-container" className="min-w-0 rounded-xl border border-border bg-card">
      {filtered && items.length === 0 && <p className="border-b border-border bg-card px-5 py-3 text-14 text-muted-foreground">{t("layout.noMatch")}</p>}
      {groups.map((group) => {
        const empty = group.items.length === 0;
        // An empty group stays open while its quick-create form is open; the toggle collapses it and closes the form, so it never traps.
        const open = empty ? expandedEmpty.includes(group.key) || quick === group.key : !collapsed.includes(group.key);
        const name = params.group === "none" ? "" : groupLabel(group.key);
        return <section key={group.key} aria-label={params.group === "none" ? undefined : name}>
          {params.group !== "none" && <div className={cn("mx-1 my-1 flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5", phoneToolbar && "phone-layout:my-0 phone-layout:py-0")}>
            <Button variant="ghost" type="button" aria-expanded={open} aria-label={`${t("layout.toggleGroup")}: ${name}`} className="flex flex-1 items-center justify-start gap-2 bg-transparent p-0 text-left font-medium text-foreground hover:bg-transparent max-[360px]:h-auto max-[360px]:min-h-9 max-[360px]:min-w-0 max-[360px]:whitespace-normal max-[360px]:[&_svg]:shrink-0 phone-layout:min-h-11"
              onClick={() => empty ? (open ? (setExpandedEmpty(expandedEmpty.filter((key) => key !== group.key)), quick === group.key && setQuick(null)) : setExpandedEmpty([...expandedEmpty, group.key])) : setCollapsed(open ? [...collapsed, group.key] : collapsed.filter((key) => key !== group.key))}>
              {open ? <ChevronDown aria-hidden size={14} className="text-muted-foreground" /> : <ChevronRight aria-hidden size={14} className="text-muted-foreground" />}
              {groupIcon(group.key)}<span className="max-[360px]:[overflow-wrap:anywhere]">{name}</span><span className="text-13 font-normal text-muted-foreground max-[360px]:shrink-0">{formatNumber(group.items.length)}</span>
            </Button>
            {canCreate && canWrite && <Button variant="ghost" type="button" aria-label={t("layout.addToGroup").replace("{group}", name)} title={t("layout.addToGroup").replace("{group}", name)} className="inline-flex items-center gap-1 rounded-md bg-transparent p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => { setCollapsed(collapsed.filter((key) => key !== group.key)); setExpandedEmpty(expandedEmpty.includes(group.key) ? expandedEmpty : [...expandedEmpty, group.key]); setQuick(group.key); setQuickTitle(""); }}><Plus aria-hidden size={14} /><span className="hidden text-11 max-sm:inline">{t("layout.addShort")}</span></Button>}
          </div>}
          {open && <>
            {subGroup === "none" ? <ul className="m-0 list-none p-0">{group.items.map((item) => rowOf(item))}</ul>  : groupItems(group.items.map((item) => ({ ...item, cycleId: cycleOf[item.id] ?? null, moduleIds: modulesOf[item.id] ?? [], creatorId: item.createdBy })), subGroup, stateIds).filter((sub) => sub.items.length > 0).map((sub) => {
              const key = `${group.key}:${sub.key}`;
              const subOpen = !collapsed.includes(key);
              const subName = labelFor(subGroup, sub.key);
              return <section key={sub.key} aria-label={subName} className="border-b border-border">
                <div className="flex items-center gap-2 bg-card px-6 py-2">
                  <Button variant="ghost" type="button" aria-expanded={subOpen} aria-label={`${t("layout.toggleGroup")}: ${subName}`} className="flex flex-1 items-center gap-2 bg-transparent p-0 text-left font-medium text-muted-foreground hover:bg-transparent"
                    onClick={() => setCollapsed(subOpen ? [...collapsed, key] : collapsed.filter((value) => value !== key))}>
                    {subOpen ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}{groupIconFor(subGroup, sub.key)}<span>{subName}</span><span className="text-12 font-normal text-muted-foreground">{formatNumber(sub.items.length)}</span>
                  </Button>
                </div>
                {subOpen && <ul className="m-0 list-none p-0">{sub.items.map((item) => rowOf(items.find((row) => row.id === item.id)!))}</ul>}
              </section>;
            })}
            {quick === group.key && quickForm(group.key)}
          </>}
        </section>;
      })}
    </div>}
    {contentReady && board && !emptyProject && (subGroup === "none" || boardLanes.length === 0 ? renderBoard(boardColumns) : <div className="grid gap-5" data-testid="board-swimlanes">{boardLanes.map((lane) => {
      const laneItems = new Set(lane.items.map((item) => item.id));
      const laneName = labelFor(subGroup, lane.key);
      return <section key={lane.key} aria-label={`${t(`layout.group.${subGroup}`)}: ${laneName}`} className="grid gap-1">
        <h3 className="m-0 flex items-center gap-2 border-b border-border pb-2 text-14 font-semibold text-foreground">{groupIconFor(subGroup, lane.key)}{laneName}</h3>
        {renderBoard(boardColumns.map((column) => ({ ...column, items: column.items.filter((item) => laneItems.has(item.id)) })))}
      </section>;
    })}</div>)}
    {selectable && selected.length > 0 && <div aria-hidden className="h-60 sm:h-28" />}
  </div>;
}
