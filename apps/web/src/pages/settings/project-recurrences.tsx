import React from "react";
import { formatDate, translate, type MessageKey } from "@weft/shared";
import { action } from "../../api";
import { useProject } from "../../layouts/project-layout";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";
import { priorities, type Estimate, type Label, type Member, type WorkItem, type WorkState } from "../../types";

type Schedule = { unit: "day" | "week" | "month" | "year"; interval: number; time: string; timezone: string; anchorDate: string; weekdays?: number[]; dayOfMonth?: number; month?: number; day?: number };
type Template = { title: string; description?: unknown; priority: typeof priorities[number]; stateId?: string; assigneeIds: string[]; labelIds: string[]; estimatePointId?: string; moduleIds: string[]; parentId?: string; dueDateOffsetDays?: number; addToActiveCycle: boolean };
type Recurrence = { id: string; name: string; template: Template; schedule: string | Schedule; status: string; nextRunAt: string; lastRunAt: string | null; lastWarning: string | null; endDate: string | null; pausedReason?: string | null };
type Named = { id: string; name: string };
const t = (key: string) => translate(key as MessageKey);
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const emptyTemplate = (): Template => ({ title: "", priority: "none", assigneeIds: [], labelIds: [], moduleIds: [], addToActiveCycle: false });
const descriptionText = (value: unknown): string => typeof value === "string" ? value : value && typeof value === "object" && "content" in value ? ((value as { content: Array<{ content?: Array<{ text?: string }> }> }).content ?? []).map((block) => (block.content ?? []).map((node) => node.text ?? "").join("")).join("\n") : "";
const descriptionDocument = (value: string) => ({ type: "doc", content: value.split("\n").map((line) => line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }) });

export function ProjectRecurrences() {
  const { project } = useProject();
  const canWrite = project.role !== "Guest";
  const [rows, setRows] = React.useState<Recurrence[]>([]);
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [items, setItems] = React.useState<WorkItem[]>([]);
  const [modules, setModules] = React.useState<Named[]>([]);
  const [estimate, setEstimate] = React.useState<Estimate | null>(null);
  const [editing, setEditing] = React.useState<Recurrence | null | false>(false);
  const [name, setName] = React.useState("");
  const [template, setTemplate] = React.useState<Template>(emptyTemplate);
  const [unit, setUnit] = React.useState<Schedule["unit"]>("week");
  const [interval, setInterval] = React.useState(1);
  const [time, setTime] = React.useState("09:00");
  const [timezone, setTimezone] = React.useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [anchorDate, setAnchorDate] = React.useState(today);
  const [weekdays, setWeekdays] = React.useState<number[]>([1]);
  const [dayOfMonth, setDayOfMonth] = React.useState(1);
  const [month, setMonth] = React.useState(1);
  const [yearDay, setYearDay] = React.useState(1);
  const [endDate, setEndDate] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(async () => setRows(await action<Recurrence[]>("list_recurrences", { projectId: project.id }) ?? []), [project.id]);
  React.useEffect(() => {
    void load();
    void (async () => {
      const results = await Promise.all([
        action<WorkState[]>("list_states", { projectId: project.id }), action<Label[]>("list_labels", { projectId: project.id }),
        action<Member[]>("list_project_members", { projectId: project.id }), action<WorkItem[]>("list_work_items", { projectId: project.id }),
        project.features.modules ? action<Named[]>("list_modules", { projectId: project.id }) : Promise.resolve([]),
        action<Estimate | null>("get_estimate", { projectId: project.id }),
      ]);
      setStates(results[0] ?? []); setLabels(results[1] ?? []); setMembers(results[2] ?? []); setItems(results[3] ?? []); setModules(results[4] ?? []); setEstimate(results[5] ?? null);
    })();
  }, [load, project]);
  const field = <K extends keyof Template>(key: K, value: Template[K]) => setTemplate((current) => ({ ...current, [key]: value }));
  const openForm = (row?: Recurrence) => {
    if (!row) {
      setEditing(null); setName(""); setTemplate(emptyTemplate()); setUnit("week"); setInterval(1); setTime("09:00"); setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); setAnchorDate(today());
      setWeekdays([1]); setDayOfMonth(new Date().getDate()); setMonth(new Date().getMonth() + 1); setYearDay(new Date().getDate()); setEndDate(""); return;
    }
    const s = typeof row.schedule === "string" ? JSON.parse(row.schedule) as Schedule : row.schedule;
    setEditing(row); setName(row.name); setTemplate({ ...emptyTemplate(), ...row.template }); setUnit(s.unit); setInterval(s.interval); setTime(s.time); setTimezone(s.timezone); setAnchorDate(s.anchorDate);
    setWeekdays(s.weekdays ?? [1]); setDayOfMonth(s.dayOfMonth ?? 1); setMonth(s.month ?? 1); setYearDay(s.day ?? 1); setEndDate(row.endDate ?? "");
  };
  const guard = async (result: unknown, success = "recurrences.saved") => { setFailed(result === null); setNote(t(result === null ? "recurrences.failed" : success)); await load(); return result !== null; };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const schedule: Schedule = { unit, interval, time, timezone, anchorDate, ...(unit === "week" ? { weekdays } : {}), ...(unit === "month" ? { dayOfMonth } : {}), ...(unit === "year" ? { month, day: yearDay } : {}) };
    const submittedTemplate = { ...template, ...(typeof template.description === "string" && template.description ? { description: descriptionDocument(template.description) } : {}) };
    const result = editing ? await action("update_recurrence", { recurrenceId: editing.id, name, template: submittedTemplate, schedule, endDate: endDate || null }) : await action("create_recurrence", { projectId: project.id, name, template: submittedTemplate, schedule, endDate: endDate || null });
    if (await guard(result)) setEditing(false);
  };
  const toggle = (key: "assigneeIds" | "labelIds" | "moduleIds", id: string, checked: boolean) => field(key, checked ? [...template[key], id] : template[key].filter((value) => value !== id));
  return <section>
    <SettingsHeader title={t("recurrences.title")} description={t("recurrences.description")} />
    {canWrite && <button type="button" className="mb-4" onClick={() => openForm()}>{t("recurrences.create")}</button>}
    {rows.length === 0 ? <p className="text-secondary">{t("recurrences.empty")}</p> : <RowList>{rows.map((row) => {
      const schedule = typeof row.schedule === "string" ? JSON.parse(row.schedule) as Schedule : row.schedule;
      const status = row.status === "active" && row.lastWarning ? "warning" : row.status;
      return <Row key={row.id}>
        <span className="grid min-w-0 flex-1"><strong className="truncate">{row.name}</strong><span className="text-13 text-secondary">{t("recurrences.status." + status)} · {t("recurrences.nextRun")}: {formatDate(row.nextRunAt, undefined, schedule.timezone)} · {t("recurrences.lastRun")}: {row.lastRunAt ? formatDate(row.lastRunAt, undefined, schedule.timezone) : t("recurrences.never")}</span>{row.status === "paused" && row.pausedReason && <span className="text-13 text-secondary">{row.pausedReason}</span>}{row.lastWarning && <span role="status" className="text-13 text-warning-text">{t("recurrences.warning")}: {row.lastWarning}</span>}</span>
        {canWrite && <div className="flex flex-wrap gap-2">
          {row.status !== "ended" && <button type="button" className="secondary" onClick={() => void guard(action(row.status === "paused" ? "resume_recurrence" : "pause_recurrence", { recurrenceId: row.id }))}>{t(row.status === "paused" ? "recurrences.resume" : "recurrences.pause")}</button>}
          <button type="button" className="secondary" onClick={() => openForm(row)}>{t("recurrences.edit")}</button>
          <button type="button" className="secondary" onClick={() => void guard(action("run_recurrence_now", { recurrenceId: row.id }), "recurrences.ranNow")}>{t("recurrences.runNow")}</button>
          <button type="button" className="secondary hover:!text-danger-text" onClick={async () => { if (window.confirm(t("recurrences.deleteConfirm"))) await guard(action("delete_recurrence", { recurrenceId: row.id }), "recurrences.deleted"); }}>{t("recurrences.delete")}</button>
        </div>}
      </Row>;
    })}</RowList>}
    {editing !== false && <form className="my-5 grid gap-4 rounded-lg border border-subtle p-4" onSubmit={submit}>
      <h2 className="text-16 font-medium">{t(editing ? "recurrences.edit" : "recurrences.create")}</h2>
      <SettingsBlock title={t("recurrences.template")}>
        <label>{t("recurrences.name")}<input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>{t("workItems.titleField")}<input required maxLength={500} value={template.title} onChange={(e) => field("title", e.target.value)} /></label>
        <label>{t("workItems.description")}<textarea rows={3} value={descriptionText(template.description)} onChange={(e) => field("description", e.target.value || undefined)} /></label>
        <label>{t("workItems.priority")}<select value={template.priority} onChange={(e) => field("priority", e.target.value as Template["priority"])}>{priorities.map((v) => <option key={v} value={v}>{t("workItems.priority." + v)}</option>)}</select></label>
        <label>{t("workItems.state")}<select value={template.stateId ?? ""} onChange={(e) => field("stateId", e.target.value || undefined)}><option value="">{t("recurrences.defaultState")}</option>{states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <fieldset><legend>{t("workItems.assignees")}</legend>{members.map((m) => <label key={m.userId} className="flex-row"><input type="checkbox" checked={template.assigneeIds.includes(m.userId)} onChange={(e) => toggle("assigneeIds", m.userId, e.target.checked)} />{m.name}</label>)}</fieldset>
        <fieldset><legend>{t("workItems.labels")}</legend>{labels.map((l) => <label key={l.id} className="flex-row"><input type="checkbox" checked={template.labelIds.includes(l.id)} onChange={(e) => toggle("labelIds", l.id, e.target.checked)} />{l.name}</label>)}</fieldset>
        {estimate?.enabled && <label>{t("estimates.title")}<select value={template.estimatePointId ?? ""} onChange={(e) => field("estimatePointId", e.target.value || undefined)}><option value="">{t("recurrences.none")}</option>{estimate.points.map((p) => <option key={p.id} value={p.id}>{p.value}</option>)}</select></label>}
        {project.features.modules && <fieldset><legend>{t("workItems.modules")}</legend>{modules.map((m) => <label key={m.id} className="flex-row"><input type="checkbox" checked={template.moduleIds.includes(m.id)} onChange={(e) => toggle("moduleIds", m.id, e.target.checked)} />{m.name}</label>)}</fieldset>}
        <label>{t("workItems.modal.parent")}<select value={template.parentId ?? ""} onChange={(e) => field("parentId", e.target.value || undefined)}><option value="">{t("recurrences.none")}</option>{items.map((i) => <option key={i.id} value={i.id}>{i.displayId} {i.title}</option>)}</select></label>
        <label>{t("recurrences.dueOffset")}<input type="number" min="0" value={template.dueDateOffsetDays ?? ""} onChange={(e) => field("dueDateOffsetDays", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
        <label className="flex-row"><input type="checkbox" checked={template.addToActiveCycle} onChange={(e) => field("addToActiveCycle", e.target.checked)} />{t("recurrences.addToActiveCycle")}</label>
      </SettingsBlock>
      <SettingsBlock title={t("recurrences.schedule")}>
        <label>{t("recurrences.frequency")}<select value={unit} onChange={(e) => setUnit(e.target.value as Schedule["unit"])}>{(["day", "week", "month", "year"] as const).map((v) => <option key={v} value={v}>{t("recurrences.unit." + v)}</option>)}</select></label>
        <label>{t("recurrences.interval")}<input type="number" min="1" required value={interval} onChange={(e) => setInterval(Number(e.target.value))} /></label>
        {unit === "week" && <fieldset><legend>{t("recurrences.weekdays")}</legend>{[1, 2, 3, 4, 5, 6, 7].map((d) => <label key={d} className="flex-row"><input type="checkbox" checked={weekdays.includes(d)} onChange={(e) => setWeekdays(e.target.checked ? [...weekdays, d] : weekdays.filter((v) => v !== d))} />{t("recurrences.weekday." + d)}</label>)}</fieldset>}
        {unit === "month" && <label>{t("recurrences.dayOfMonth")}<input type="number" min="1" max="31" value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} /></label>}
        {unit === "year" && <><label>{t("recurrences.month")}<input type="number" min="1" max="12" value={month} onChange={(e) => setMonth(Number(e.target.value))} /></label><label>{t("recurrences.day")}<input type="number" min="1" max="31" value={yearDay} onChange={(e) => setYearDay(Number(e.target.value))} /></label></>}
        <label>{t("recurrences.time")}<input type="time" required value={time} onChange={(e) => setTime(e.target.value)} /></label>
        <label>{t("recurrences.timezone")}<input required value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label>
        <label>{t("recurrences.endDate")}<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
      </SettingsBlock>
      <div className="flex justify-end gap-2"><button type="button" className="secondary" onClick={() => setEditing(false)}>{t("settings.cancel")}</button><button type="submit">{t("recurrences.save")}</button></div>
    </form>}
    <Note note={note} error={failed} />
  </section>;
}
