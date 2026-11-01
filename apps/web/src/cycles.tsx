import React from "react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { WorkItemViews } from "./work-item-views";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Cycle = { id: string; name: string; startDate: string; endDate: string; status: "upcoming" | "active" | "completed"; itemCount: number };
type CycleDetail = Cycle & { workItemIds: string[] };
type Item = { id: string; displayId: string; title: string };
const t = (key: string) => translate(key as MessageKey);

/** Warns, never blocks: shows the Cycles whose dates overlap the chosen range. */
function useOverlap(action: Call, projectId: string, startDate: string, endDate: string, cycleId?: string) {
  const [names, setNames] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!startDate || !endDate || startDate > endDate) { setNames([]); return; }
    let live = true;
    void action<{ overlapping: Cycle[] }>("check_cycle_dates", { projectId, startDate, endDate, ...(cycleId ? { cycleId } : {}) }).then((result) => { if (live) setNames((result?.overlapping ?? []).map((cycle) => cycle.name)); });
    return () => { live = false; };
  }, [action, projectId, startDate, endDate, cycleId]);
  return names;
}

function CycleForm({ action, projectId, cycle, canWrite, onSaved }: { action: Call; projectId: string; cycle?: Cycle; canWrite: boolean; onSaved: () => void }) {
  const [name, setName] = React.useState(cycle?.name ?? "");
  const [startDate, setStartDate] = React.useState(cycle?.startDate ?? "");
  const [endDate, setEndDate] = React.useState(cycle?.endDate ?? "");
  const [note, setNote] = React.useState<string | null>(null);
  const overlap = useOverlap(action, projectId, startDate, endDate, cycle?.id);
  if (!canWrite) return null;
  return <form onSubmit={async (event) => {
    event.preventDefault();
    const saved = cycle ? await action("update_cycle", { cycleId: cycle.id, name, startDate, endDate }) : await action("create_cycle", { projectId, name, startDate, endDate });
    setNote(saved ? null : t("cycles.failed"));
    if (saved) { if (!cycle) { setName(""); setStartDate(""); setEndDate(""); } onSaved(); }
  }}>
    <label>{t("cycles.name")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>{t("cycles.start")}<input required type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
    <label>{t("cycles.end")}<input required type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
    {overlap.length > 0 && <p role="status" data-testid="cycle-overlap">{t("cycles.overlap").replace("{names}", overlap.join(", "))}</p>}
    <button>{t(cycle ? "cycles.save" : "cycles.create")}</button>
    {note && <p role="alert">{note}</p>}
  </form>;
}

const badge = (cycle: Cycle) => <small>{t(`cycles.status.${cycle.status}`)} · {cycle.startDate} → {cycle.endDate} · {t("cycles.itemCount").replace("{count}", formatNumber(cycle.itemCount))}</small>;

export function CyclesPage({ workspaceSlug, projectKey, projectId, canWrite, enabled, action }: { workspaceSlug: string; projectKey: string; projectId: string; canWrite: boolean; enabled: boolean; action: Call }) {
  const [cycles, setCycles] = React.useState<Cycle[] | null>(null);
  const load = React.useCallback(async () => setCycles(enabled ? await action<Cycle[]>("list_cycles", { projectId }) : null), [action, projectId, enabled]);
  React.useEffect(() => { void load(); }, [load]);
  if (!enabled) return <section><p role="status">{t("cycles.off")}</p></section>;
  return <section>
    <a href={`/${workspaceSlug}/projects/${projectKey}`}>{t("workItems.back")}</a>
    <h3>{t("cycles.title")}</h3>
    {cycles?.length === 0 && <p>{t("cycles.empty")}</p>}
    <ul>{(cycles ?? []).map((cycle) => <li key={cycle.id}><a href={`/${workspaceSlug}/projects/${projectKey}/cycles/${cycle.id}`}>{cycle.name}</a> {badge(cycle)}</li>)}</ul>
    <CycleForm action={action} projectId={projectId} canWrite={canWrite} onSaved={() => void load()} />
  </section>;
}

export function CycleDetailPage({ workspaceSlug, projectKey, projectId, cycleId, canWrite, enabled, action }: { workspaceSlug: string; projectKey: string; projectId: string; cycleId: string; canWrite: boolean; enabled: boolean; action: Call }) {
  const [cycle, setCycle] = React.useState<CycleDetail | null | undefined>(undefined);
  const [candidates, setCandidates] = React.useState<Item[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const load = React.useCallback(async () => {
    if (!enabled) return setCycle(null);
    const found = await action<CycleDetail>("get_cycle", { cycleId });
    setCycle(found);
    if (!found) return;
    const everyone = await action<Array<Item & { id: string }>>("list_work_items", { projectId }) ?? [];
    setCandidates(everyone.filter((item) => !found.workItemIds.includes(item.id)));
    setRefreshKey((key) => key + 1);
  }, [action, cycleId, projectId, enabled]);
  React.useEffect(() => { void load(); }, [load]);
  if (!enabled) return <section><p role="status">{t("cycles.off")}</p></section>;
  if (cycle === undefined) return null;
  if (cycle === null) return <section><p role="alert">{t("cycles.failed")}</p><a href={`/${workspaceSlug}/projects/${projectKey}/cycles`}>{t("cycles.back")}</a></section>;
  const ended = cycle.status === "completed";
  const add = async (workItemId: string) => {
    const result = await action<{ added: string[]; skipped: unknown[] }>("add_cycle_items", { cycleId, workItemIds: [workItemId] });
    setNote(result === null ? t("cycles.failed") : result.skipped.length ? t("cycles.skipped").replace("{count}", formatNumber(result.skipped.length)) : null);
    await load();
  };
  const remove = async (workItemId: string) => { setNote((await action("remove_cycle_items", { cycleId, workItemIds: [workItemId] })) === null ? t("cycles.failed") : null); await load(); };
  return <section>
    <a href={`/${workspaceSlug}/projects/${projectKey}/cycles`}>{t("cycles.back")}</a>
    <h3>{cycle.name}</h3>
    <p>{badge(cycle)}</p>
    <CycleForm action={action} projectId={projectId} cycle={cycle} canWrite={canWrite} onSaved={() => void load()} />
    <h4>{t("cycles.workItems")}</h4>
    <WorkItemViews projectId={projectId} workspaceSlug={workspaceSlug} action={action} refreshKey={refreshKey} cycleId={cycleId}
      rowAction={canWrite ? (item) => <button className="secondary" onClick={() => void remove(item.id)}>{t("cycles.remove")}</button> : undefined} />
    {canWrite && <div>
      <h4>{t("cycles.addTitle")}</h4>
      {ended && <p role="status">{t("cycles.ended")}</p>}
      <ul>{candidates.map((item) => <li key={item.id}>{item.displayId} · {item.title} <button disabled={ended} onClick={() => void add(item.id)}>{t("cycles.add")}</button></li>)}</ul>
    </div>}
    {note && <p role="alert">{note}</p>}
  </section>;
}
