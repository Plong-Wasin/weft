import React from "react";
import { CalendarCheck, CalendarClock, Layers, Package, RefreshCw, Tag, Users, X } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "./api";
import { Avatar, EstimateSelect, MultiSelect, PriorityIcon, SingleSelect, StateIcon } from "./property-dropdowns";
import { priorityOrder } from "./work-item-layout";
import type { Estimate, Label, Member, Project, WorkItem, WorkState } from "./types";

type Named = { id: string; name: string; status?: string };
const t = (key: string) => translate(key as MessageKey);

/** Plain text to a rich-text document: one paragraph per line. */
function toDocument(text: string) {
  const lines = text.split("\n");
  return { type: "doc", content: lines.map((line) => line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }) };
}

/** Plane's create work item modal: title, description, and every property a work item can carry at creation. */
export function CreateWorkItemModal({ project, onClose, onCreated }: { project: Project; onClose: () => void; onCreated: (item: WorkItem) => void }) {
  const [states, setStates] = React.useState<WorkState[]>([]);
  const [labels, setLabels] = React.useState<Label[]>([]);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [items, setItems] = React.useState<WorkItem[]>([]);
  const [cycles, setCycles] = React.useState<Named[]>([]);
  const [modules, setModules] = React.useState<Named[]>([]);
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [stateId, setStateId] = React.useState("");
  const [estimate, setEstimate] = React.useState<Estimate | null>(null);
  const [estimatePointId, setEstimatePointId] = React.useState<string | null>(null);
  const [priority, setPriority] = React.useState<string>("none");
  const [assigneeIds, setAssigneeIds] = React.useState<string[]>([]);
  const [labelIds, setLabelIds] = React.useState<string[]>([]);
  const [startDate, setStartDate] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [cycleId, setCycleId] = React.useState("");
  const [moduleIds, setModuleIds] = React.useState<string[]>([]);
  const [parentId, setParentId] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    void (async () => {
      const [stateRows, labelRows, memberRows, itemRows, cycleRows, moduleRows, estimateRow] = await Promise.all([
        action<WorkState[]>("list_states", { projectId: project.id }), action<Label[]>("list_labels", { projectId: project.id }),
        action<Member[]>("list_project_members", { projectId: project.id }), action<WorkItem[]>("list_work_items", { projectId: project.id }),
        project.features.cycles ? action<Named[]>("list_cycles", { projectId: project.id }) : Promise.resolve([]),
        project.features.modules ? action<Named[]>("list_modules", { projectId: project.id }) : Promise.resolve([]),
        action<Estimate | null>("get_estimate", { projectId: project.id }),
      ]);
      setEstimate(estimateRow ?? null);
      setStates(stateRows ?? []); setLabels(labelRows ?? []); setPeople(memberRows ?? []); setItems(itemRows ?? []); setCycles(cycleRows ?? []); setModules(moduleRows ?? []);
      setStateId((current) => current || stateRows?.[0]?.id || "");
    })();
  }, [project]);
  React.useEffect(() => {
    const refreshMembers = () => { void action<Member[]>("list_project_members", { projectId: project.id }).then((rows) => setPeople(rows ?? [])); };
    window.addEventListener("focus", refreshMembers);
    return () => window.removeEventListener("focus", refreshMembers);
  }, [project.id]);
  React.useEffect(() => {
    // Escape closes the modal, unless it is closing an open dropdown first.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector('[data-create-modal] [role="menu"], [data-create-modal] [role="dialog"]')) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    const created = await action<WorkItem>("create_work_item", {
      projectId: project.id, title: title.trim(), ...(description.trim() ? { description: toDocument(description) } : {}), ...(stateId ? { stateId } : {}), priority,
      ...(assigneeIds.length ? { assigneeIds } : {}), ...(labelIds.length ? { labelIds } : {}), ...(parentId ? { parentId } : {}),
      ...(estimate?.enabled && estimatePointId ? { estimatePointId } : {}), ...(startDate ? { startDate } : {}), ...(dueDate ? { dueDate } : {}),
    });
    if (!created) { setBusy(false); return setNote(t("workItems.failed")); }
    // The create Action takes no Cycle or Module: attach them to the new work item with their own Actions.
    let failed = false;
    if (cycleId && (await action<{ added: string[] }>("add_cycle_items", { cycleId, workItemIds: [created.id] }))?.added.includes(created.id) !== true) failed = true;
    for (const moduleId of moduleIds) if (await action("add_module_items", { moduleId, workItemIds: [created.id] }) === null) failed = true;
    onCreated(created);
    if (failed) { setBusy(false); setNote(t("workItems.failed")); return; }
    onClose();
  };

  const stateOf = states.find((state) => state.id === stateId);
  const chipRow = "flex flex-wrap items-center gap-2";
  return <>
    <div aria-hidden className="fixed inset-0 z-40 bg-backdrop" onClick={onClose} />
    <div data-create-modal role="dialog" aria-modal="true" aria-label={t("workItems.modal.title")} className="fixed left-1/2 top-[6vh] z-50 max-h-[88vh] w-[calc(100vw-1.5rem)] max-w-2xl -translate-x-1/2 overflow-auto rounded-lg border border-subtle bg-surface-1 shadow-xl">
      <form className="my-0 grid gap-4 p-5" onSubmit={submit}>
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex-1 text-18 font-semibold text-primary">{t("workItems.modal.title")}</h2>
          <button type="button" className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover" aria-label={t("workItems.modal.cancel")} onClick={onClose}><X aria-hidden size={16} /></button>
        </div>
        <input autoFocus required aria-label={t("workItems.titleField")} placeholder={t("workItems.titleField")} value={title} maxLength={500} className="w-full text-16" onChange={(event) => setTitle(event.target.value)} />
        <textarea aria-label={t("workItems.description")} placeholder={t("workItems.descriptionHint")} rows={4} value={description} className="w-full text-14" onChange={(event) => setDescription(event.target.value)} />
        <div className={chipRow}>
          <SingleSelect label={t("workItems.state")} summary={stateOf?.name ?? ""} value={stateId} icon={<StateIcon group={stateOf?.group ?? "unstarted"} />}
            options={states.map((state) => ({ id: state.id, name: state.name, icon: <StateIcon group={state.group} /> }))} onSelect={setStateId} />
          <SingleSelect label={t("workItems.priority")} summary={t(`workItems.priority.${priority}`)} value={priority} icon={<PriorityIcon priority={priority} />}
            options={priorityOrder.map((id) => ({ id, name: t(`workItems.priority.${id}`), icon: <PriorityIcon priority={id} /> }))} onSelect={setPriority} />
          <EstimateSelect estimate={estimate} pointId={estimatePointId} onSelect={setEstimatePointId} />
          <MultiSelect label={t("workItems.assignees")} selected={assigneeIds} icon={assigneeIds.length ? undefined : <Users aria-hidden size={14} className="text-secondary" />}
            onOpen={() => { void action<Member[]>("list_project_members", { projectId: project.id }).then((rows) => rows && setPeople(rows)); }}
            summary={assigneeIds.length === 0 ? <span className="text-secondary">{t("workItems.noAssignee")}</span> : <span className="flex items-center -space-x-1">{assigneeIds.slice(0, 3).map((id) => <Avatar key={id} name={people.find((person) => person.userId === id)?.name ?? id} />)}</span>}
            options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} />, isAgent: person.isAgent, codeCapable: person.codeCapable, hasAccess: person.hasAccess, accessReason: person.accessReason }))}
            onToggle={(id, on) => setAssigneeIds(on ? [...assigneeIds, id] : assigneeIds.filter((other) => other !== id))} />
          <MultiSelect label={t("workItems.labels")} selected={labelIds} icon={<Tag aria-hidden size={14} className="text-secondary" />}
            summary={labelIds.length === 0 ? <span className="text-secondary">{t("workItems.noLabels")}</span> : <span>{labelIds.map((id) => labels.find((label) => label.id === id)?.name).filter(Boolean).join(", ")}</span>}
            options={labels.map((label) => ({ id: label.id, name: label.name, icon: <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} /> }))}
            onToggle={(id, on) => setLabelIds(on ? [...labelIds, id] : labelIds.filter((other) => other !== id))} />
          {project.features.cycles && <SingleSelect label={t("workItems.cycle")} value={cycleId} icon={<RefreshCw aria-hidden size={14} className="text-secondary" />} summary={cycles.find((cycle) => cycle.id === cycleId)?.name ?? t("workItems.noCycle")}
            options={[{ id: "", name: t("workItems.noCycle") }, ...cycles.filter((cycle) => cycle.status !== "completed").map((cycle) => ({ id: cycle.id, name: cycle.name }))]} onSelect={setCycleId} />}
          {project.features.modules && <MultiSelect label={t("workItems.modules")} selected={moduleIds} icon={<Package aria-hidden size={14} className="text-secondary" />}
            summary={moduleIds.length === 0 ? <span className="text-secondary">{t("workItems.noModules")}</span> : <span>{moduleIds.map((id) => modules.find((module) => module.id === id)?.name).filter(Boolean).join(", ")}</span>}
            options={modules.map((module) => ({ id: module.id, name: module.name }))} onToggle={(id, on) => setModuleIds(on ? [...moduleIds, id] : moduleIds.filter((other) => other !== id))} />}
          <SingleSelect label={t("workItems.modal.parent")} value={parentId} icon={<Layers aria-hidden size={14} className="text-secondary" />} summary={items.find((item) => item.id === parentId)?.displayId ?? t("workItems.addParent")}
            options={[{ id: "", name: t("workItems.noParent") }, ...items.map((item) => ({ id: item.id, name: `${item.displayId} ${item.title}` }))]} onSelect={setParentId} />
        </div>
        <div className={chipRow}>
          <label className="flex items-center gap-2 text-13 text-secondary"><CalendarClock aria-hidden size={14} />{t("workItems.startDate")}
            <input type="date" value={startDate} max={dueDate || undefined} className="w-auto" onChange={(event) => setStartDate(event.target.value)} /></label>
          <label className="flex items-center gap-2 text-13 text-secondary"><CalendarCheck aria-hidden size={14} />{t("workItems.dueDate")}
            <input type="date" value={dueDate} min={startDate || undefined} className="w-auto" onChange={(event) => setDueDate(event.target.value)} /></label>
        </div>
        {note && <p role="alert" className="m-0 text-danger-text">{note}</p>}
        <div className="flex justify-end gap-2 border-t border-subtle pt-4">
          <button type="button" className="secondary" onClick={onClose}>{t("workItems.modal.cancel")}</button>
          <button type="submit" disabled={busy}>{t("workItems.modal.submit")}</button>
        </div>
      </form>
    </div>
  </>;
}
