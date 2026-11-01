import React from "react";
import { Link } from "react-router";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Columns3, List, Package, Plus, RefreshCw, SlidersHorizontal, Table2, Tag, Users } from "lucide-react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { displayProperties, filterModes, groupItems, moveProperty, parseLayoutParams, serializeLayoutParams, priorityOrder, sortFields, type DisplayProperty, type LayoutParams } from "./work-item-layout";
import { paths } from "./routes";
import { Popover } from "./shell/popover";
import { Avatar, DatesMenu, MultiSelect, PriorityIcon, SingleSelect, StateIcon } from "./property-dropdowns";
import type { StateGroup } from "./types";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
type State = { id: string; name: string; group: StateGroup };
type Person = { userId: string; name: string };
type Label = { id: string; name: string; color: string };
type Item = { id: string; displayId: string; title: string; stateId: string; priority: string; assigneeIds: string[]; labelIds: string[]; startDate: string | null; dueDate: string | null };
type Named = { id: string; name: string; status?: string };
const t = (key: string) => translate(key as MessageKey);
const ghost = "flex items-center gap-1.5 rounded-md border border-subtle bg-surface-1 px-2.5 py-1 text-13 font-medium text-primary hover:bg-layer-transparent-hover";
const checkRow = "flex items-center gap-2 text-13";

function Toggle({ legend, options, selected, onChange }: { legend: string; options: Array<{ id: string; name: string }>; selected: string[]; onChange: (next: string[]) => void }) {
  return <fieldset className="grid gap-1"><legend className="pb-1 text-12 font-medium text-tertiary">{legend}</legend>{options.map((option) => <label key={option.id} className={checkRow}>
    <input type="checkbox" checked={selected.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))} />{option.name}</label>)}</fieldset>;
}

/** Work items of one project in a layout (list or board) with display options and filters; every setting lives in the URL query string. */
export function WorkItemLayouts({ projectId, workspaceSlug, action, run: runProp, refreshKey, cycleId, moduleId, cyclesEnabled, modulesEnabled, canWrite = true, canCreate = false, rowAction }: { projectId: string; workspaceSlug: string; action: Call; run?: Run; refreshKey: number; cycleId?: string; moduleId?: string; cyclesEnabled?: boolean; modulesEnabled?: boolean; canWrite?: boolean; canCreate?: boolean; rowAction?: (item: Item) => React.ReactNode }) {
  // Every page passes an error-aware `run` so a PQL error shows; the fallback over `action` drops the server message and is only for callers that have no runner.
  const run: Run = React.useMemo(() => runProp ?? (async <T,>(name: string, body: unknown) => { const data = await action<T>(name, body); return data === null ? { error: "" } : { data }; }), [runProp, action]);
  const [params, setParams] = React.useState<LayoutParams>(() => parseLayoutParams(window.location.search));
  const [items, setItems] = React.useState<Item[]>([]);
  const [states, setStates] = React.useState<State[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [moduleOptions, setModuleOptions] = React.useState<Named[]>([]);
  const [cycleOptions, setCycleOptions] = React.useState<Named[]>([]);
  const [cycleOf, setCycleOf] = React.useState<Record<string, string>>({});
  const [modulesOf, setModulesOf] = React.useState<Record<string, string[]>>({});
  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  const [quick, setQuick] = React.useState<string | null>(null);
  const [quickTitle, setQuickTitle] = React.useState("");
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState(params.q);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  const update = (patch: Partial<LayoutParams>) => {
    const next = { ...params, ...patch };
    window.history.pushState(null, "", `${window.location.pathname}${serializeLayoutParams(next)}`);
    setParams(next);
  };
  React.useEffect(() => {
    const onPop = () => { const next = parseLayoutParams(window.location.search); setParams(next); setDraft(next.q); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  React.useEffect(() => {
    void (async () => {
      setStates(await action<State[]>("list_states", { projectId }) ?? []);
      setLabels(await action<Label[]>("list_labels", { projectId }) ?? []);
      setPeople(await action<Person[]>("list_project_members", { projectId }) ?? []);
    })();
  }, [projectId]);
  React.useEffect(() => {
    if (!modulesEnabled) return setModuleOptions([]);
    void action<Named[]>("list_modules", { projectId }).then((rows) => setModuleOptions(rows ?? []));
  }, [projectId, modulesEnabled, action, refreshKey]);
  React.useEffect(() => {
    if (!cyclesEnabled) return setCycleOptions([]);
    void action<Named[]>("list_cycles", { projectId }).then((rows) => setCycleOptions(rows ?? []));
  }, [projectId, cyclesEnabled, action, refreshKey]);
  // The work item payload carries no Cycle or Module, so a row learns its memberships from one listing per Cycle or Module.
  const showCycle = !!cyclesEnabled && !cycleId && params.props.includes("cycle");
  const showModules = !!modulesEnabled && !moduleId && params.props.includes("modules");
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
  const sheet = params.layout === "spreadsheet";
  // The spreadsheet is one flat table, so it ignores group by.
  const grouping = sheet ? "none" : params.group;
  const load = React.useCallback(async () => {
    const usePql = params.mode === "pql" && params.q.trim() !== "";
    const moduleSel = moduleId ?? (params.mode !== "pql" && params.module && modulesEnabled ? params.module : "");
    const result = await run<Item[]>("list_work_items", {
      projectId, ...(cycleId ? { cycleId } : {}), ...(moduleSel ? { moduleId: moduleSel } : {}), ...(usePql ? { query: params.q } : { stateIds: params.state, priorities: params.priority, assigneeIds: params.assignee, labelIds: params.label }),
      sort: board ? "manual" : params.sort, direction: board ? "asc" : params.dir,
    });
    if ("error" in result) { setItems([]); setQueryError(usePql ? result.error : null); return; }
    setQueryError(null);
    setItems(result.data);
  }, [projectId, params, board, run, cycleId, moduleId, modulesEnabled]);
  React.useEffect(() => { void load(); }, [load, refreshKey]);

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
  const drop = async (stateId: string, beforeId?: string) => {
    const id = dragging;
    setDragging(null);
    if (!id || id === beforeId) return;
    setNote((await action("move_work_item", { workItemId: id, stateId, ...(beforeId ? { beforeId } : {}) })) === null ? t("workItems.failed") : null);
    await load();
  };

  const personName = (id: string) => people.find((person) => person.userId === id)?.name ?? id;
  const groupLabel = (key: string) => params.group === "state" ? states.find((state) => state.id === key)?.name ?? key
    : params.group === "priority" ? t(`workItems.priority.${key}`) : key === "none" ? t("layout.unassigned") : personName(key);
  const groupIcon = (key: string) => params.group === "state" ? <StateIcon group={states.find((state) => state.id === key)?.group ?? "unstarted"} />
    : params.group === "priority" ? <PriorityIcon priority={key} /> : key === "none" ? null : <Avatar name={personName(key)} />;
  const stateIds = states.map((state) => state.id);
  const pqlMode = params.mode === "pql";
  const filterCount = pqlMode ? (params.q.trim() !== "" ? 1 : 0) : params.state.length + params.priority.length + params.assignee.length + params.label.length + (params.module && modulesEnabled && !moduleId ? 1 : 0);
  const filtered = filterCount > 0;
  const shows = (property: DisplayProperty) => params.props.includes(property);
  const readOnly = !canWrite;
  const listShows = (property: DisplayProperty) => property === "cycle" ? showCycle : property === "modules" ? showModules : shows(property);

  const cellOf = (item: Item, property: DisplayProperty): React.ReactNode => {
    const assignees = item.assigneeIds;
    const mine = modulesOf[item.id] ?? [];
    switch (property) {
      case "state": return <SingleSelect label={t("workItems.state")} summary={states.find((state) => state.id === item.stateId)?.name ?? ""} value={item.stateId} readOnly={readOnly}
          icon={<StateIcon group={states.find((state) => state.id === item.stateId)?.group ?? "unstarted"} />}
          options={states.map((state) => ({ id: state.id, name: state.name, icon: <StateIcon group={state.group} /> }))} onSelect={(stateId) => void change(item, { stateId })} />;
      case "priority": return <SingleSelect label={t("workItems.priority")} summary={t(`workItems.priority.${item.priority}`)} value={item.priority} readOnly={readOnly} icon={<PriorityIcon priority={item.priority} />}
          options={priorityOrder.map((id) => ({ id, name: t(`workItems.priority.${id}`), icon: <PriorityIcon priority={id} /> }))} onSelect={(priority) => void change(item, { priority })} />;
      case "assignee": return <MultiSelect label={t("workItems.assignees")} readOnly={readOnly} selected={assignees} icon={assignees.length === 0 ? <Users aria-hidden size={14} className="text-secondary" /> : undefined}
          summary={assignees.length === 0 ? <span className="text-secondary">{t("workItems.noAssignee")}</span> : <span className="flex items-center -space-x-1">{assignees.slice(0, 3).map((id) => <Avatar key={id} name={personName(id)} />)}{assignees.length > 3 && <span className="pl-2 text-12">+{formatNumber(assignees.length - 3)}</span>}</span>}
          options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} /> }))}
          onToggle={(id, on) => void change(item, { assigneeIds: on ? [...assignees, id] : assignees.filter((other) => other !== id) })} />;
      case "labels": return <MultiSelect label={t("workItems.labels")} readOnly={readOnly} selected={item.labelIds} icon={<Tag aria-hidden size={14} className="text-secondary" />}
          summary={item.labelIds.length === 0 ? <span className="text-secondary">{t("workItems.noLabels")}</span> : <span>{item.labelIds.map((id) => labels.find((label) => label.id === id)?.name).filter(Boolean).join(", ")}</span>}
          options={labels.map((label) => ({ id: label.id, name: label.name, icon: <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} /> }))}
          onToggle={(id, on) => void change(item, { labelIds: on ? [...item.labelIds, id] : item.labelIds.filter((other) => other !== id) })} />;
      case "dates": return <DatesMenu startDate={item.startDate} dueDate={item.dueDate} readOnly={readOnly} onChange={(dates) => void change(item, dates)} />;
      case "cycle": return <SingleSelect label={t("workItems.cycle")} readOnly={readOnly} value={cycleOf[item.id] ?? ""} icon={<RefreshCw aria-hidden size={14} className="text-secondary" />}
          summary={cycleOptions.find((cycle) => cycle.id === cycleOf[item.id])?.name ?? t("workItems.noCycle")}
          options={[{ id: "", name: t("workItems.noCycle") }, ...cycleOptions.filter((cycle) => cycle.status !== "completed" || cycle.id === cycleOf[item.id]).map((cycle) => ({ id: cycle.id, name: cycle.name }))]} onSelect={(id) => void setCycle(item, id)} />;
      case "modules": return <MultiSelect label={t("workItems.modules")} readOnly={readOnly} selected={mine} icon={<Package aria-hidden size={14} className="text-secondary" />}
          summary={mine.length === 0 ? <span className="text-secondary">{t("workItems.noModules")}</span> : <span>{mine.map((id) => moduleOptions.find((module) => module.id === id)?.name).filter(Boolean).join(", ")}</span>}
          options={moduleOptions.map((module) => ({ id: module.id, name: module.name }))} onToggle={(id, on) => void setModule(item, id, on)} />;
      default: return null;
    }
  };
  const rowOf = (item: Item) => <li key={item.id} data-testid={`row-${item.displayId}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-subtle bg-surface-1 px-5 py-2.5 hover:bg-layer-transparent-hover">
    {shows("id") && <span className="w-16 shrink-0 text-12 text-tertiary">{item.displayId}</span>}
    <Link to={paths.workItem(workspaceSlug, item.displayId)} className="min-w-40 flex-1 truncate text-14 font-medium text-primary">{item.title}</Link>
    <div className="flex flex-wrap items-center gap-2">
      {(["state", "priority", "assignee", "labels", "dates", "cycle", "modules"] as const).filter(listShows).map((property) => <React.Fragment key={property}>{cellOf(item, property)}</React.Fragment>)}
      {rowAction?.(item)}
    </div>
  </li>;

  const quickForm = (groupKey: string) => <form className="my-0 flex items-center gap-2 border-b border-subtle bg-surface-1 px-5 py-2" onSubmit={(event) => { event.preventDefault(); void create(groupKey); }}>
    <input autoFocus aria-label={t("workItems.titleField")} placeholder={t("workItems.quickTitle")} value={quickTitle} maxLength={500} className="flex-1" onChange={(event) => setQuickTitle(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") { setQuick(null); setQuickTitle(""); } }} />
    <button type="submit">{t("workItems.create")}</button>
  </form>;
  const newButton = (groupKey: string) => <button type="button" className="flex w-full items-center gap-2 border-b border-subtle bg-surface-1 px-5 py-2.5 text-left text-13 font-medium text-secondary hover:bg-layer-transparent-hover" onClick={() => { setQuick(groupKey); setQuickTitle(""); }}>
    <Plus aria-hidden size={14} />{t("workItems.new")}</button>;

  const groups = groupItems(items, grouping, stateIds).filter((group) => grouping === "none" || group.items.length > 0 || grouping === "state");
  const endKey = groups[0]?.key ?? "all";

  const columns = params.props.filter((property) => property !== "id" && listShows(property));
  const cell = "border-b border-subtle px-3 py-2 text-left align-middle whitespace-nowrap";
  const sheetView = <div className="overflow-hidden rounded-lg border border-subtle">
    {filtered && items.length === 0 && <p className="border-b border-subtle bg-surface-1 px-5 py-3 text-14 text-secondary">{t("layout.noMatch")}</p>}
    {!filtered && items.length === 0 && <p className="border-b border-subtle bg-surface-1 px-5 py-3 text-14 text-secondary">{t("workItems.empty")}</p>}
    <div className="overflow-x-auto" data-testid="sheet-scroll">
      <table className="w-full border-separate border-spacing-0 bg-surface-1 text-13">
        <thead><tr className="bg-layer-1 text-12 font-medium text-tertiary">
          <th scope="col" className={`${cell} sticky left-0 z-10 min-w-64 bg-layer-1`}>{t("layout.sheet.workItem")}</th>
          {columns.map((property) => <th key={property} scope="col" className={cell}>{t(`layout.property.${property}`)}</th>)}
          {rowAction && <th scope="col" className={cell}><span className="sr-only">{t("layout.sheet.actions")}</span></th>}
        </tr></thead>
        <tbody>{items.map((item) => <tr key={item.id} data-testid={`row-${item.displayId}`} className="group hover:bg-layer-transparent-hover">
          <th scope="row" className={`${cell} sticky left-0 z-10 min-w-64 bg-surface-1 font-normal group-hover:bg-layer-1`}>
            <span className="flex items-center gap-3">{shows("id") && <span className="shrink-0 text-12 text-tertiary">{item.displayId}</span>}
              <Link to={paths.workItem(workspaceSlug, item.displayId)} className="max-w-72 truncate text-14 font-medium text-primary">{item.title}</Link></span>
          </th>
          {columns.map((property) => <td key={property} className={cell}>{cellOf(item, property)}</td>)}
          {rowAction && <td className={cell}>{rowAction(item)}</td>}
        </tr>)}</tbody>
      </table>
    </div>
    {canCreate && canWrite && (quick === "end" ? quickForm("all") : newButton("end"))}
  </div>;

  const toolbar = <div className="flex flex-wrap items-center gap-2">
    <div role="tablist" aria-label={t("layout.switch")} className="flex items-center gap-0.5 rounded-md border border-subtle bg-layer-1 p-0.5">
      {(["list", "board", "spreadsheet"] as const).map((layout) => { const Icon = layout === "list" ? List : layout === "board" ? Columns3 : Table2; return <button key={layout} type="button" role="tab" aria-selected={params.layout === layout} aria-label={t(`layout.${layout}`)} title={t(`layout.${layout}`)}
        className={`rounded-md p-1.5 ${params.layout === layout ? "bg-surface-1 text-primary shadow-sm" : "bg-transparent text-secondary hover:bg-layer-transparent-hover"} hover:text-primary`} onClick={() => update({ layout })}><Icon aria-hidden size={16} /></button>; })}
    </div>
    <Popover label={filtered ? t("layout.filtersActive").replace("{count}", String(filterCount)) : t("layout.filters")} className={ghost} panelRole="dialog" panelClassName="grid w-80 max-w-[calc(100vw-2rem)] max-h-[70vh] gap-3 overflow-auto p-3" trigger={<span>{filtered ? t("layout.filtersActive").replace("{count}", String(filterCount)) : t("layout.filters")}</span>}>
      {() => <>
        <div role="tablist" aria-label={t("layout.filter.mode")} className="flex gap-1">
          {filterModes.map((mode) => <button key={mode} type="button" role="tab" aria-selected={params.mode === mode} className={params.mode === mode ? undefined : "secondary"} onClick={() => update({ mode })}>{t(`layout.filter.mode.${mode}`)}</button>)}
        </div>
        {pqlMode ? <form className="my-0" onSubmit={(event) => { event.preventDefault(); update({ q: draft }); }}>
          <label>{t("layout.pql.label")}<input value={draft} maxLength={2000} spellCheck={false} aria-invalid={queryError !== null} placeholder={t("layout.pql.placeholder")} onChange={(event) => setDraft(event.target.value)} /></label>
          <button type="submit">{t("layout.pql.apply")}</button>
          {queryError && <p role="alert" data-testid="pql-error" className="text-danger-text">{queryError}</p>}
        </form> : <div className="grid gap-3">
          <Toggle legend={t("layout.filter.state")} options={states} selected={params.state} onChange={(state) => update({ state })} />
          <Toggle legend={t("layout.filter.priority")} options={priorityOrder.map((id) => ({ id, name: t(`workItems.priority.${id}`) }))} selected={params.priority} onChange={(priority) => update({ priority })} />
          <Toggle legend={t("layout.filter.assignee")} options={[{ id: "none", name: t("layout.unassigned") }, ...people.map((person) => ({ id: person.userId, name: person.name }))]} selected={params.assignee} onChange={(assignee) => update({ assignee })} />
          <Toggle legend={t("layout.filter.label")} options={labels} selected={params.label} onChange={(label) => update({ label })} />
          {modulesEnabled && !moduleId && moduleOptions.length > 0 && <label>{t("layout.filter.module")}<select value={params.module} onChange={(event) => update({ module: event.target.value })}>
            <option value="">{t("layout.filter.moduleAny")}</option>
            {moduleOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select></label>}
        </div>}
        {filtered && <button type="button" className="secondary" onClick={() => { setDraft(""); update({ state: [], priority: [], assignee: [], label: [], module: "", q: "" }); }}>{t("layout.clear")}</button>}
      </>}
    </Popover>
    <Popover label={t("layout.display")} className={ghost} panelRole="dialog" panelClassName="grid w-72 max-w-[calc(100vw-2rem)] max-h-[70vh] gap-3 overflow-auto p-3" trigger={<><SlidersHorizontal aria-hidden size={14} /><span>{t("layout.display")}</span></>}>
      {() => <>
        {!board && <>
          {!sheet && <label>{t("layout.group")}<select value={params.group} onChange={(event) => update({ group: event.target.value as LayoutParams["group"] })}>
            {(["none", "state", "priority", "assignee"] as const).map((value) => <option key={value} value={value}>{t(`layout.group.${value}`)}</option>)}
          </select></label>}
          <label>{t("layout.sort")}<select value={params.sort} onChange={(event) => update({ sort: event.target.value as LayoutParams["sort"] })}>
            {sortFields.map((value) => <option key={value} value={value}>{t(`layout.sort.${value}`)}</option>)}
          </select></label>
          <label>{t("layout.direction")}<select value={params.dir} onChange={(event) => update({ dir: event.target.value as LayoutParams["dir"] })}>
            {(["asc", "desc"] as const).map((value) => <option key={value} value={value}>{t(`layout.direction.${value}`)}</option>)}
          </select></label>
        </>}
        <fieldset className="grid gap-1.5"><legend className="pb-1 text-12 font-medium text-tertiary">{t("layout.properties")}</legend>
          {(sheet ? [...params.props, ...displayProperties.filter((property) => !params.props.includes(property))] : [...displayProperties]).map((property) => <div key={property} className="flex items-center gap-1">
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
  </div>;

  return <div className="grid gap-3">
    {toolbar}
    {note && <p role="alert" className="text-danger-text">{note}</p>}
    {sheet && sheetView}
    {!board && !sheet && <div className="overflow-hidden rounded-lg border border-subtle">
      {filtered && items.length === 0 && <p className="border-b border-subtle bg-surface-1 px-5 py-3 text-14 text-secondary">{t("layout.noMatch")}</p>}
      {!filtered && items.length === 0 && params.group === "none" && <p className="border-b border-subtle bg-surface-1 px-5 py-3 text-14 text-secondary">{t("workItems.empty")}</p>}
      {groups.map((group) => {
        const open = !collapsed.includes(group.key);
        const name = params.group === "none" ? "" : groupLabel(group.key);
        return <section key={group.key} aria-label={params.group === "none" ? undefined : name}>
          {params.group !== "none" && <div className="flex items-center gap-2 border-b border-subtle bg-layer-1 px-3 py-2">
            <button type="button" aria-expanded={open} aria-label={`${t("layout.toggleGroup")}: ${name}`} className="flex flex-1 items-center gap-2 bg-transparent p-0 text-left text-14 font-medium text-primary hover:bg-transparent"
              onClick={() => setCollapsed(open ? [...collapsed, group.key] : collapsed.filter((key) => key !== group.key))}>
              {open ? <ChevronDown aria-hidden size={14} className="text-secondary" /> : <ChevronRight aria-hidden size={14} className="text-secondary" />}
              {groupIcon(group.key)}<span>{name}</span><span className="text-13 font-normal text-tertiary">{formatNumber(group.items.length)}</span>
            </button>
            {canCreate && canWrite && <button type="button" aria-label={t("layout.addToGroup").replace("{group}", name)} title={t("layout.addToGroup").replace("{group}", name)} className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover hover:text-primary"
              onClick={() => { setCollapsed(collapsed.filter((key) => key !== group.key)); setQuick(group.key); setQuickTitle(""); }}><Plus aria-hidden size={14} /></button>}
          </div>}
          {open && <>
            <ul className="m-0 list-none p-0">{group.items.map(rowOf)}</ul>
            {quick === group.key && quickForm(group.key)}
          </>}
        </section>;
      })}
      {canCreate && canWrite && (quick === "end" ? quickForm(endKey) : newButton("end"))}
    </div>}
    {board && <div className="board">
      {states.filter((state) => pqlMode || params.state.length === 0 || params.state.includes(state.id)).map((state) => <section key={state.id} className="column" data-testid={`column-${state.name}`} aria-label={state.name}
        onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void drop(state.id); }}>
        <h4>{state.name} ({formatNumber(items.filter((item) => item.stateId === state.id).length)})</h4>
        {items.filter((item) => item.stateId === state.id).map((item) => <article key={item.id} className="card" draggable data-testid={`card-${item.displayId}`}
          onDragStart={(event) => { event.dataTransfer.setData("text/plain", item.id); setDragging(item.id); }}
          onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void drop(state.id, item.id); }}>
          <Link to={paths.workItem(workspaceSlug, item.displayId)}>{item.displayId}</Link> {item.title}
          <br /><small>{t(`workItems.priority.${item.priority}`)}</small>
          {rowAction && <> {rowAction(item)}</>}
        </article>)}
      </section>)}
    </div>}
  </div>;
}
