import { Button } from "@/ui/button";
import { accessReasonText } from "./access-reason";
import React from "react";
import { Layers, Package, RefreshCw, Tag, Users, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";
import { translate, type MessageKey } from "@weft/shared";
import { action, actionResult } from "./api";
import { EstimateSelect, MultiSelect, PriorityIcon, SingleSelect, StateIcon } from "./property-dropdowns";
import { Avatar } from "./avatar";
import { priorityOrder } from "./work-item-layout";
import type { Estimate, Label, Member, Project, WorkItem, WorkState } from "./types";
import { PropertyFields, TypePicker, missingRequired, propertiesOfType, useWorkItemTypes, hasValue, type WorkItemType } from "./work-item-types";

import { Input } from "@/ui/input";
import { DatePicker } from "@/ui/date-picker";
import { Textarea } from "@/ui/textarea";
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
  // The modal is mounted open, so Base UI never sees an open transition: return focus to the opener it was mounted from.
  const [opener] = React.useState(() => document.activeElement as HTMLElement | null);
  const { types, properties, ready: typesReady } = useWorkItemTypes(project);
  const typesOn = project.features.types === true;
  const [typeId, setTypeId] = React.useState("");
  const [propertyValues, setPropertyValues] = React.useState<Map<string, unknown>>(new Map());
  const typeOf = (id: string): WorkItemType | undefined => types.find((type) => type.id === id);
  /** Changing the type starts the new type's properties from their defaults; a new work item has no values to lose. */
  const chooseType = (id: string) => {
    setTypeId(id);
    setPropertyValues(new Map(propertiesOfType(properties, id).filter((property) => property.defaultValue !== null && property.defaultValue !== undefined).map((property) => [property.id, property.defaultValue])));
  };
  React.useEffect(() => {
    if (typesReady && !typeId && types[0]) chooseType(types[0].id);
    // chooseType reads the loaded properties, so it runs once they are in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typesReady, types.length, properties.length]);
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
  // Typed title or description is unsaved input: a stray backdrop click must not discard it. Escape, Cancel and the close button still close.
  const unsaved = title.trim() !== "" || description.trim() !== "";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !title.trim()) return;
    const typeProperties = typesOn ? propertiesOfType(properties, typeId) : [];
    const missing = missingRequired(typeProperties, propertyValues);
    if (missing.length > 0) return setNote(t("types.requiredNote").replace("{names}", missing.join(", ")).replace("{type}", typeOf(typeId)?.name ?? ""));
    setBusy(true);
    const values = typeProperties.filter((property) => hasValue(propertyValues.get(property.id))).map((property) => ({ propertyId: property.id, value: propertyValues.get(property.id) }));
    const result = await actionResult<WorkItem>("create_work_item", {
      projectId: project.id, title: title.trim(), ...(description.trim() ? { description: toDocument(description) } : {}), ...(stateId ? { stateId } : {}), priority,
      ...(assigneeIds.length ? { assigneeIds } : {}), ...(labelIds.length ? { labelIds } : {}), ...(parentId ? { parentId } : {}),
      ...(estimate?.enabled && estimatePointId ? { estimatePointId } : {}), ...(startDate ? { startDate } : {}), ...(dueDate ? { dueDate } : {}),
      ...(typesOn && typeId ? { typeId } : {}), ...(typesOn && values.length ? { properties: values } : {}),
    });
    const created = "data" in result ? result.data : null;
    if (!created) { setBusy(false); return setNote("error" in result && result.error ? result.error : t("workItems.failed")); }
    // The create Action takes no Cycle or Module: attach them to the new work item with their own Actions.
    let failed = false;
    if (cycleId && (await action<{ added: string[] }>("add_cycle_items", { cycleId, workItemIds: [created.id] }))?.added.includes(created.id) !== true) failed = true;
    for (const moduleId of moduleIds) if (await action("add_module_items", { moduleId, workItemIds: [created.id] }) === null) failed = true;
    onCreated(created);
    if (failed) { setBusy(false); setNote(t("workItems.failed")); return; }
    onClose();
  };

  const stateOf = states.find((state) => state.id === stateId);
  const chipRow = "grid grid-cols-2 gap-2 sm:grid-cols-3";
  return <DialogPrimitive.Root open disablePointerDismissal={unsaved} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup data-create-modal aria-label={t("workItems.modal.title")} finalFocus={() => (opener?.isConnected ? opener : true)} className="fixed left-1/2 top-[6dvh] z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 overflow-y-auto rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg outline-none">
      <form className="my-0 grid gap-5 p-6 max-sm:gap-4 max-sm:p-4 pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_input]:min-h-11" onSubmit={submit}>
        <div className="flex items-center gap-2">
          <DialogTitle className="m-0 flex-1">{t("workItems.modal.title")}</DialogTitle>
          <Button type="button" className="size-11 rounded-md bg-transparent p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground" aria-label={t("workItems.modal.cancel")} onClick={onClose}><X aria-hidden size={16} /></Button>
        </div>
        <Input autoFocus required aria-label={t("workItems.titleField")} placeholder={t("workItems.titleField")} value={title} maxLength={500} className="w-full text-16" onChange={(event) => setTitle(event.target.value)} />
        <Textarea aria-label={t("workItems.description")} placeholder={t("workItems.descriptionHint")} rows={4} value={description} className="w-full resize-none text-14" onChange={(event) => setDescription(event.target.value)} />
        {typesOn && types.length > 0 && <div className="grid gap-3">
          <div className="grid gap-1"><span className="text-12 font-medium text-muted-foreground">{t("types.type")}</span><div className={chipRow}><TypePicker types={types} value={typeId} onSelect={chooseType} /></div></div>
          <PropertyFields properties={propertiesOfType(properties, typeId)} values={propertyValues} members={people} idPrefix="create"
            onChange={(property, value) => setPropertyValues((current) => new Map(current).set(property.id, value))} />
        </div>}
        <div data-testid="create-property-grid" className={chipRow}>
          <SingleSelect className="h-9 w-full min-w-0 justify-start border-input bg-background px-2.5 text-foreground shadow-xs" label={t("workItems.state")} summary={stateOf?.name ?? ""} value={stateId} icon={<StateIcon group={stateOf?.group ?? "unstarted"} />}
            options={states.map((state) => ({ id: state.id, name: state.name, icon: <StateIcon group={state.group} /> }))} onSelect={setStateId} />
          <SingleSelect className="h-9 w-full min-w-0 justify-start border-input bg-background px-2.5 text-foreground shadow-xs" label={t("workItems.priority")} summary={t(`workItems.priority.${priority}`)} value={priority} icon={<PriorityIcon priority={priority} />}
            options={priorityOrder.map((id) => ({ id, name: t(`workItems.priority.${id}`), icon: <PriorityIcon priority={id} /> }))} onSelect={setPriority} />
          <EstimateSelect className="h-9 w-full min-w-0 justify-start border-input bg-background px-2.5 text-foreground shadow-xs" estimate={estimate} pointId={estimatePointId} onSelect={setEstimatePointId} />
          <MultiSelect className="h-9 w-full min-w-0 justify-start border-input bg-background px-2.5 text-foreground shadow-xs" label={t("workItems.assignees")} selected={assigneeIds} searchAlways icon={assigneeIds.length ? undefined : <Users aria-hidden size={14} className="text-muted-foreground" />}
            onOpen={() => { void action<Member[]>("list_project_members", { projectId: project.id }).then((rows) => rows && setPeople(rows)); }}
            summary={assigneeIds.length === 0 ? <span>{t("workItems.noAssignee")}</span> : <span className="flex min-w-0 items-center -space-x-1">{assigneeIds.slice(0, 3).map((id) => <Avatar key={id} name={people.find((person) => person.userId === id)?.name ?? id} id={id} agent={people.find((person) => person.userId === id)?.isAgent} />)}</span>}
            options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} />, isAgent: person.isAgent, codeCapable: person.codeCapable, hasAccess: person.hasAccess, accessReason: accessReasonText(person) }))}
            onToggle={(id, on) => setAssigneeIds(on ? [...assigneeIds, id] : assigneeIds.filter((other) => other !== id))} />
          <MultiSelect className="h-9 w-full min-w-0 justify-start border-input bg-background px-2.5 text-foreground shadow-xs" label={t("workItems.labels")} selected={labelIds} icon={<Tag aria-hidden size={14} className="text-muted-foreground" />}
            summary={labelIds.length === 0 ? <span>{t("workItems.noLabels")}</span> : <span className="truncate">{labelIds.map((id) => labels.find((label) => label.id === id)?.name).filter(Boolean).join(", ")}</span>}
            options={labels.map((label) => ({ id: label.id, name: label.name, icon: <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} /> }))}
            onToggle={(id, on) => setLabelIds(on ? [...labelIds, id] : labelIds.filter((other) => other !== id))} />
          {project.features.cycles && <SingleSelect className="h-9 w-full min-w-0 justify-start border-input bg-background px-2.5 text-foreground shadow-xs" label={t("workItems.cycle")} value={cycleId} icon={<RefreshCw aria-hidden size={14} className="text-muted-foreground" />} summary={cycles.find((cycle) => cycle.id === cycleId)?.name ?? t("workItems.noCycle")}
            options={[{ id: "", name: t("workItems.noCycle") }, ...cycles.filter((cycle) => cycle.status !== "completed").map((cycle) => ({ id: cycle.id, name: cycle.name }))]} onSelect={setCycleId} />}
          {project.features.modules && <MultiSelect className="h-9 w-full min-w-0 justify-start border-input bg-background px-2.5 text-foreground shadow-xs" label={t("workItems.modules")} selected={moduleIds} icon={<Package aria-hidden size={14} className="text-muted-foreground" />}
            summary={moduleIds.length === 0 ? <span>{t("workItems.noModules")}</span> : <span className="truncate">{moduleIds.map((id) => modules.find((module) => module.id === id)?.name).filter(Boolean).join(", ")}</span>}
            options={modules.map((module) => ({ id: module.id, name: module.name }))} onToggle={(id, on) => setModuleIds(on ? [...moduleIds, id] : moduleIds.filter((other) => other !== id))} />}
          <div data-testid="create-parent-control" className="col-span-2 min-w-0 sm:col-span-1">
            <SingleSelect className="h-9 w-full min-w-0 justify-start border-input bg-background px-2.5 text-foreground shadow-xs" label={t("workItems.modal.parent")} value={parentId} icon={<Layers aria-hidden size={14} className="text-muted-foreground" />} summary={items.find((item) => item.id === parentId)?.displayId ?? t("workItems.addParent")}
              options={[{ id: "", name: t("workItems.noParent") }, ...items.map((item) => ({ id: item.id, name: `${item.displayId} ${item.title}` }))]} onSelect={setParentId} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <label className="grid min-w-0 gap-1 text-13 text-muted-foreground">{t("workItems.startDate")}<DatePicker label={t("workItems.startDate")} value={startDate} max={dueDate || undefined} className="w-full" onChange={setStartDate} /></label>
          <label className="grid min-w-0 gap-1 text-13 text-muted-foreground">{t("workItems.dueDate")}<DatePicker label={t("workItems.dueDate")} value={dueDate} min={startDate || undefined} field="due" className="w-full" onChange={setDueDate} /></label>
        </div>
        {note && <p role="alert" className="m-0 text-destructive">{note}</p>}
        <div className="sticky bottom-0 z-10 flex justify-end gap-2 border-t border-border bg-background -mb-6 pb-6 pt-4 max-sm:-mb-4 max-sm:pb-4">
          <Button type="button" className="secondary" onClick={onClose}>{t("workItems.modal.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{t("workItems.modal.submit")}</Button>
        </div>
      </form>
      </DialogPrimitive.Popup>
    </DialogPortal>
  </DialogPrimitive.Root>;
}
