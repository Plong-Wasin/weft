import React from "react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { filterModes, groupItems, parseViewParams, serializeViewParams, priorityOrder, sortFields, type ViewParams } from "./work-item-view";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
type State = { id: string; name: string };
type Person = { userId: string; name: string };
type Label = { id: string; name: string };
type Item = { id: string; displayId: string; title: string; stateId: string; priority: string; assigneeIds: string[]; labelIds: string[] };
const t = (key: string) => translate(key as MessageKey);

function Toggle({ legend, options, selected, onChange }: { legend: string; options: Array<{ id: string; name: string }>; selected: string[]; onChange: (next: string[]) => void }) {
  return <fieldset><legend>{legend}</legend>{options.map((option) => <label key={option.id}>
    <input type="checkbox" checked={selected.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))} />{option.name}</label>)}</fieldset>;
}

/** List and kanban views of one project's work items. The view settings live in the URL query string. */
export function WorkItemViews({ projectId, workspaceSlug, action, run: runProp, refreshKey, cycleId, moduleId, modulesEnabled, rowAction }: { projectId: string; workspaceSlug: string; action: Call; run?: Run; refreshKey: number; cycleId?: string; moduleId?: string; modulesEnabled?: boolean; rowAction?: (item: Item) => React.ReactNode }) {
  // Every page passes an error-aware `run` so a PQL error shows; the fallback over `action` drops the server message and is only for callers that have no runner.
  const run: Run = React.useMemo(() => runProp ?? (async <T,>(name: string, body: unknown) => { const data = await action<T>(name, body); return data === null ? { error: "" } : { data }; }), [runProp, action]);
  const [params, setParams] = React.useState<ViewParams>(() => parseViewParams(window.location.search));
  const [items, setItems] = React.useState<Item[]>([]);
  const [states, setStates] = React.useState<State[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [moduleOptions, setModuleOptions] = React.useState<Array<{ id: string; name: string }>>([]);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState(params.q);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  const update = (patch: Partial<ViewParams>) => {
    const next = { ...params, ...patch };
    window.history.pushState(null, "", `${window.location.pathname}${serializeViewParams(next)}`);
    setParams(next);
  };
  React.useEffect(() => {
    const onPop = () => { const next = parseViewParams(window.location.search); setParams(next); setDraft(next.q); };
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
    if (!modulesEnabled || moduleId) return setModuleOptions([]);
    void action<Array<{ id: string; name: string }>>("list_modules", { projectId }).then((rows) => setModuleOptions(rows ?? []));
  }, [projectId, modulesEnabled, moduleId, action]);
  const kanban = params.view === "kanban";
  const load = React.useCallback(async () => {
    const usePql = params.mode === "pql" && params.q.trim() !== "";
    const moduleSel = moduleId ?? (params.mode !== "pql" && params.module && modulesEnabled ? params.module : "");
    const result = await run<Item[]>("list_work_items", {
      projectId, ...(cycleId ? { cycleId } : {}), ...(moduleSel ? { moduleId: moduleSel } : {}), ...(usePql ? { query: params.q } : { stateIds: params.state, priorities: params.priority, assigneeIds: params.assignee, labelIds: params.label }),
      sort: kanban ? "manual" : params.sort, direction: kanban ? "asc" : params.dir,
    });
    if ("error" in result) { setItems([]); setQueryError(usePql ? result.error : null); return; }
    setQueryError(null);
    setItems(result.data);
  }, [projectId, params, kanban, run, cycleId, moduleId, modulesEnabled]);
  React.useEffect(() => { void load(); }, [load, refreshKey]);

  const label = (group: string, key: string) => group === "state" ? states.find((state) => state.id === key)?.name ?? key
    : group === "priority" ? t(`workItems.priority.${key}`) : key === "none" ? t("views.unassigned") : people.find((person) => person.userId === key)?.name ?? key;
  const drop = async (stateId: string, beforeId?: string) => {
    const id = dragging;
    setDragging(null);
    if (!id || id === beforeId) return;
    setNote((await action("move_work_item", { workItemId: id, stateId, ...(beforeId ? { beforeId } : {}) })) === null ? t("workItems.failed") : null);
    await load();
  };
  const row = (item: Item) => <li key={item.id}>
    <a href={`/${workspaceSlug}/work-items/${item.displayId}`}>{item.displayId} · {item.title}</a>{" "}
    <small>{states.find((state) => state.id === item.stateId)?.name} · {t(`workItems.priority.${item.priority}`)}</small>
    {rowAction && <> {rowAction(item)}</>}
  </li>;
  const stateIds = states.map((state) => state.id);
  const pqlMode = params.mode === "pql";
  const filtered = pqlMode ? params.q.trim() !== "" : params.state.length + params.priority.length + params.assignee.length + params.label.length + (params.module && modulesEnabled && !moduleId ? 1 : 0) > 0;

  return <div>
    <div role="tablist" aria-label={t("views.switch")}>
      {(["list", "kanban"] as const).map((mode) => <button key={mode} role="tab" aria-selected={params.view === mode} className={params.view === mode ? undefined : "secondary"} onClick={() => update({ view: mode })}>{t(`views.${mode}`)}</button>)}
    </div>
    <details open={filtered || pqlMode}>
      <summary>{t("views.filters")}</summary>
      <div role="tablist" aria-label={t("views.filter.mode")}>
        {filterModes.map((mode) => <button key={mode} role="tab" aria-selected={params.mode === mode} className={params.mode === mode ? undefined : "secondary"} onClick={() => update({ mode })}>{t(`views.filter.mode.${mode}`)}</button>)}
      </div>
      {pqlMode ? <form onSubmit={(event) => { event.preventDefault(); update({ q: draft }); }}>
        <label>{t("views.pql.label")}<input value={draft} maxLength={2000} spellCheck={false} aria-invalid={queryError !== null} placeholder={t("views.pql.placeholder")} onChange={(event) => setDraft(event.target.value)} /></label>
        <button type="submit">{t("views.pql.apply")}</button>
        {queryError && <p role="alert" data-testid="pql-error">{queryError}</p>}
      </form> : <div>
      <Toggle legend={t("views.filter.state")} options={states} selected={params.state} onChange={(state) => update({ state })} />
      <Toggle legend={t("views.filter.priority")} options={priorityOrder.map((id) => ({ id, name: t(`workItems.priority.${id}`) }))} selected={params.priority} onChange={(priority) => update({ priority })} />
      <Toggle legend={t("views.filter.assignee")} options={[{ id: "none", name: t("views.unassigned") }, ...people.map((person) => ({ id: person.userId, name: person.name }))]} selected={params.assignee} onChange={(assignee) => update({ assignee })} />
      <Toggle legend={t("views.filter.label")} options={labels} selected={params.label} onChange={(label) => update({ label })} />
      {moduleOptions.length > 0 && <label>{t("views.filter.module")}<select value={params.module} onChange={(event) => update({ module: event.target.value })}>
        <option value="">{t("views.filter.moduleAny")}</option>
        {moduleOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select></label>}
      </div>}
      {(filtered || pqlMode) && <button className="secondary" onClick={() => { setDraft(""); update({ state: [], priority: [], assignee: [], label: [], module: "", q: "" }); }}>{t("views.clear")}</button>}
    </details>
    {!kanban && <div>
      <label>{t("views.group")}<select value={params.group} onChange={(event) => update({ group: event.target.value as ViewParams["group"] })}>
        {(["none", "state", "priority", "assignee"] as const).map((value) => <option key={value} value={value}>{t(`views.group.${value}`)}</option>)}
      </select></label>
      <label>{t("views.sort")}<select value={params.sort} onChange={(event) => update({ sort: event.target.value as ViewParams["sort"] })}>
        {sortFields.map((value) => <option key={value} value={value}>{t(`views.sort.${value}`)}</option>)}
      </select></label>
      <label>{t("views.direction")}<select value={params.dir} onChange={(event) => update({ dir: event.target.value as ViewParams["dir"] })}>
        {(["asc", "desc"] as const).map((value) => <option key={value} value={value}>{t(`views.direction.${value}`)}</option>)}
      </select></label>
    </div>}
    {note && <p role="alert">{note}</p>}
    {!kanban && (items.length === 0 ? <p>{t(filtered ? "views.noMatch" : "workItems.empty")}</p>
      : groupItems(items, params.group, stateIds).filter((group) => params.group === "none" || group.items.length > 0 || params.group === "state").map((group) => <section key={group.key} aria-label={params.group === "none" ? undefined : label(params.group, group.key)}>
        {params.group !== "none" && <h4>{label(params.group, group.key)} ({formatNumber(group.items.length)})</h4>}
        <ul>{group.items.map(row)}</ul>
      </section>))}
    {kanban && <div className="board">
      {states.filter((state) => pqlMode || params.state.length === 0 || params.state.includes(state.id)).map((state) => <section key={state.id} className="column" data-testid={`column-${state.name}`} aria-label={state.name}
        onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void drop(state.id); }}>
        <h4>{state.name} ({formatNumber(items.filter((item) => item.stateId === state.id).length)})</h4>
        {items.filter((item) => item.stateId === state.id).map((item) => <article key={item.id} className="card" draggable data-testid={`card-${item.displayId}`}
          onDragStart={(event) => { event.dataTransfer.setData("text/plain", item.id); setDragging(item.id); }}
          onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void drop(state.id, item.id); }}>
          <a href={`/${workspaceSlug}/work-items/${item.displayId}`}>{item.displayId}</a> {item.title}
          <br /><small>{t(`workItems.priority.${item.priority}`)}</small>
          {rowAction && <> {rowAction(item)}</>}
        </article>)}
      </section>)}
    </div>}
  </div>;
}
