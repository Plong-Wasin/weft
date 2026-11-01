import React from "react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { WorkItemViews } from "./work-item-views";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
const statuses = ["backlog", "planned", "in-progress", "paused", "completed", "cancelled"] as const;
type Status = (typeof statuses)[number];
type Module = {
  id: string; name: string; status: Status; leadId: string | null; memberIds: string[]; startDate: string | null; endDate: string | null; archived: boolean;
  itemCount: number; progress: { total: number; completed: number; cancelled: number; percent: number };
};
type ModuleDetail = Module & { workItemIds: string[] };
type Item = { id: string; displayId: string; title: string };
type Person = { userId: string; name: string };
const t = (key: string) => translate(key as MessageKey);

function ModuleForm({ action, projectId, module, onSaved }: { action: Call; projectId: string; module?: Module; onSaved: () => void }) {
  const [name, setName] = React.useState(module?.name ?? "");
  const [status, setStatus] = React.useState<Status>(module?.status ?? "backlog");
  const [leadId, setLeadId] = React.useState(module?.leadId ?? "");
  const [memberIds, setMemberIds] = React.useState<string[]>(module?.memberIds ?? []);
  const [startDate, setStartDate] = React.useState(module?.startDate ?? "");
  const [endDate, setEndDate] = React.useState(module?.endDate ?? "");
  const [people, setPeople] = React.useState<Person[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => { void action<Person[]>("list_project_members", { projectId }).then((rows) => setPeople(rows ?? [])); }, [action, projectId]);
  return <form onSubmit={async (event) => {
    event.preventDefault();
    const body = { name, status, leadId: leadId || null, memberIds, startDate: startDate || null, endDate: endDate || null };
    const saved = module ? await action("update_module", { moduleId: module.id, ...body }) : await action("create_module", { projectId, ...body });
    setNote(saved ? null : t("modules.failed"));
    if (saved) { if (!module) { setName(""); setStatus("backlog"); setLeadId(""); setMemberIds([]); setStartDate(""); setEndDate(""); } onSaved(); }
  }}>
    <label>{t("modules.name")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>{t("modules.status")}<select value={status} onChange={(event) => setStatus(event.target.value as Status)}>
      {statuses.map((value) => <option key={value} value={value}>{t(`modules.status.${value}`)}</option>)}
    </select></label>
    <label>{t("modules.lead")}<select value={leadId} onChange={(event) => setLeadId(event.target.value)}>
      <option value="">{t("modules.noLead")}</option>
      {people.map((person) => <option key={person.userId} value={person.userId}>{person.name}</option>)}
    </select></label>
    <fieldset><legend>{t("modules.members")}</legend>
      {people.map((person) => <label key={person.userId}><input type="checkbox" checked={memberIds.includes(person.userId)}
        onChange={(event) => setMemberIds(event.target.checked ? [...memberIds, person.userId] : memberIds.filter((id) => id !== person.userId))} />{person.name}</label>)}
    </fieldset>
    <label>{t("modules.start")}<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
    <label>{t("modules.end")}<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
    <button>{t(module ? "modules.save" : "modules.create")}</button>
    {note && <p role="alert">{note}</p>}
  </form>;
}

const dates = (module: Module) => module.startDate || module.endDate ? ` · ${module.startDate ?? "…"} → ${module.endDate ?? "…"}` : "";
const progress = (module: Module) => <progress max={100} value={module.progress.percent} aria-label={t("modules.progress")} />;
const badge = (module: Module) => <small>{t(`modules.status.${module.status}`)}{dates(module)} · {t("modules.itemCount").replace("{count}", formatNumber(module.itemCount))} · {t("modules.percent").replace("{percent}", formatNumber(module.progress.percent))}</small>;

export function ModulesPage({ workspaceSlug, projectKey, projectId, canWrite, enabled, action }: { workspaceSlug: string; projectKey: string; projectId: string; canWrite: boolean; enabled: boolean; action: Call }) {
  const [modules, setModules] = React.useState<Module[] | null>(null);
  const [archived, setArchived] = React.useState(false);
  const load = React.useCallback(async () => setModules(enabled ? await action<Module[]>("list_modules", { projectId, archived }) : null), [action, projectId, enabled, archived]);
  React.useEffect(() => { void load(); }, [load]);
  if (!enabled) return <section><p role="status">{t("modules.off")}</p></section>;
  return <section>
    <a href={`/${workspaceSlug}/projects/${projectKey}`}>{t("workItems.back")}</a>
    <h3>{t("modules.title")}</h3>
    <label><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />{t("modules.showArchived")}</label>
    {modules?.length === 0 && <p>{t("modules.empty")}</p>}
    <ul>{(modules ?? []).map((module) => <li key={module.id}><a href={`/${workspaceSlug}/projects/${projectKey}/modules/${module.id}`}>{module.name}</a> {badge(module)} {progress(module)}</li>)}</ul>
    {canWrite && !archived && <ModuleForm action={action} projectId={projectId} onSaved={() => void load()} />}
  </section>;
}

export function ModuleDetailPage({ workspaceSlug, projectKey, projectId, moduleId, canWrite, canAdmin, enabled, action, run: runQuery }: { workspaceSlug: string; projectKey: string; projectId: string; moduleId: string; canWrite: boolean; canAdmin: boolean; enabled: boolean; action: Call; run?: Run }) {
  const [module, setModule] = React.useState<ModuleDetail | null | undefined>(undefined);
  const [candidates, setCandidates] = React.useState<Item[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const back = `/${workspaceSlug}/projects/${projectKey}/modules`;
  const load = React.useCallback(async () => {
    if (!enabled) return setModule(null);
    const found = await action<ModuleDetail>("get_module", { moduleId });
    setModule(found);
    if (!found) return;
    const everyone = await action<Item[]>("list_work_items", { projectId }) ?? [];
    setCandidates(everyone.filter((item) => !found.workItemIds.includes(item.id)));
    setRefreshKey((key) => key + 1);
  }, [action, moduleId, projectId, enabled]);
  React.useEffect(() => { void load(); }, [load]);
  if (!enabled) return <section><p role="status">{t("modules.off")}</p></section>;
  if (module === undefined) return null;
  if (module === null) return <section><p role="alert">{t("modules.failed")}</p><a href={back}>{t("modules.back")}</a></section>;
  const open = !module.archived;
  const run = async (name: string, body: unknown) => { setNote((await action(name, body)) === null ? t("modules.failed") : null); await load(); };
  return <section>
    <a href={back}>{t("modules.back")}</a>
    <h3>{module.name}</h3>
    <p>{badge(module)} {progress(module)}</p>
    {module.archived && <p role="status">{t("modules.archivedNote")}</p>}
    {canWrite && open && <ModuleForm key={`${module.name}${module.status}${module.leadId}${module.memberIds.join()}${module.startDate}${module.endDate}`} action={action} projectId={projectId} module={module} onSaved={() => void load()} />}
    {canAdmin && <div>
      {module.archived ? <button className="secondary" onClick={() => void run("unarchive_module", { moduleId })}>{t("modules.unarchive")}</button>
        : <button className="secondary" disabled={module.status !== "completed" && module.status !== "cancelled"} title={t("modules.archiveHint")} onClick={() => void run("archive_module", { moduleId })}>{t("modules.archive")}</button>}
      <button className="secondary" onClick={async () => {
        if (!window.confirm(t("modules.deleteConfirm"))) return;
        if ((await action("delete_module", { moduleId })) === null) setNote(t("modules.failed")); else window.location.assign(back);
      }}>{t("modules.delete")}</button>
    </div>}
    <h4>{t("modules.workItems")}</h4>
    <WorkItemViews projectId={projectId} workspaceSlug={workspaceSlug} action={action} run={runQuery} refreshKey={refreshKey} moduleId={moduleId}
      rowAction={canWrite && open ? (item) => <button className="secondary" onClick={() => void run("remove_module_items", { moduleId, workItemIds: [item.id] })}>{t("modules.remove")}</button> : undefined} />
    {canWrite && open && <div>
      <h4>{t("modules.addTitle")}</h4>
      <ul>{candidates.map((item) => <li key={item.id}>{item.displayId} · {item.title} <button onClick={() => void run("add_module_items", { moduleId, workItemIds: [item.id] })}>{t("modules.add")}</button></li>)}</ul>
    </div>}
    {note && <p role="alert">{note}</p>}
  </section>;
}
