import { accessReasonText } from "./access-reason";
import React from "react";
import { Archive, Bot, Code2, Package, RefreshCw, Sigma, Tag, Trash2, Users, X } from "lucide-react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";
import { Dialog } from "./dialog";
import { DatesMenu, PriorityIcon, SingleSelect, StateIcon, type Option } from "./property-dropdowns";
import { Avatar } from "./avatar";
import { Popover } from "./shell/popover";
import { showToast } from "./toast";
import type { Estimate, StateGroup } from "./types";

type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
type BulkItem = { id: string; stateId: string; assigneeIds: string[]; labelIds: string[] };
type Named = { id: string; name: string; status?: string };

const t = (key: string) => translate(key as MessageKey);
const fill = (key: string, count: number) => t(key).replace("{count}", formatNumber(count));
const chip = "flex items-center gap-1.5 rounded-md border border-subtle bg-surface-1 px-2 py-1 text-12 font-medium text-primary hover:bg-layer-transparent-hover";
const optionClass = "flex w-full items-center gap-2 rounded-md bg-transparent px-2.5 py-1.5 text-left text-13 text-primary hover:bg-layer-transparent-hover";

/** Add or remove values of a set-valued property (assignees, labels, modules) on every selected work item; each pick applies at once. */
function SetMenu({ label, icon, options, present, onApply }: { label: string; icon: React.ReactNode; options: Option[]; present: Set<string>; onApply: (mode: "add" | "remove", id: string) => Promise<boolean> }) {
  const [mode, setMode] = React.useState<"add" | "remove">("add");
  const shown = mode === "add" ? options : options.filter((option) => present.has(option.id));
  return <Popover label={label} className={chip} panelRole="dialog" panelClassName="grid w-60 max-h-80 gap-1 overflow-auto p-2" trigger={<span className="flex items-center gap-1.5">{icon}<span>{label}</span></span>}>
    {(close) => <>
      <div role="group" aria-label={label} className="grid grid-cols-2 gap-1 pb-1">
        {(["add", "remove"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} className={`rounded-md px-2 py-1 text-13 ${mode === value ? "bg-layer-1 font-medium text-primary" : "bg-transparent text-secondary hover:bg-layer-transparent-hover"}`} onClick={() => setMode(value)}>{t(`bulk.${value}`)}</button>)}
      </div>
      {shown.length === 0 ? <p className="px-2.5 py-1.5 text-13 text-tertiary">{mode === "remove" ? t("bulk.nothingToRemove") : "—"}</p> : <>{[false, true].map((agents) => {
        const group = shown.filter((option) => !!option.isAgent === agents);
        if (!group.length) return null;
        return <React.Fragment key={String(agents)}>{shown.some((option) => option.isAgent) && <p className="px-2.5 pb-1 pt-2 text-11 font-semibold uppercase tracking-wide text-tertiary">{agents ? t("agents.group") : t("members.group")}</p>}{group.map((option) => { const unavailable = option.isAgent && option.hasAccess === false; return <button key={option.id} type="button" aria-disabled={unavailable || undefined} title={unavailable ? option.accessReason ?? undefined : undefined} className={`${optionClass} ${option.codeCapable ? "flex-wrap" : ""} ${unavailable ? "cursor-not-allowed opacity-45" : ""}`} onClick={() => !unavailable && void onApply(mode, option.id).then((ok) => ok && close())}>
          {option.isAgent ? <span title={t("comments.agent")}><Bot aria-hidden size={14} className="text-secondary" /></span> : option.icon}<span className={option.codeCapable ? "min-w-0" : "flex-1 truncate"}>{option.name}{option.isAgent && <> <span className="ml-1.5 text-11 text-tertiary">{t("comments.agent")}</span></>}</span>{option.codeCapable && <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-layer-1 px-1.5 py-0.5 text-10 text-secondary" title={t("agents.codeCapable")}><Code2 aria-hidden size={13} className="text-warning-primary" />{t("agents.canEditCode")}</span>}
        {unavailable && <span className="w-full pl-5 text-11 text-tertiary">{option.accessReason}</span>}</button>; })}</React.Fragment>;
      })}</>}
    </>}
  </Popover>;
}

/** The bar that appears under the work items once some are selected: every control is one Action over the whole selection. */
export function BulkBar({ projectId, selected, states, people, labels, estimate, cycleOptions, moduleOptions, run, onClear, onApplied }: {
  projectId: string; selected: BulkItem[]; states: Array<{ id: string; name: string; group: StateGroup }>; people: Array<{ userId: string; name: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null; accessAsk?: "owner" | "admin" | null; accessOwnerName?: string | null }>; labels: Array<{ id: string; name: string; color: string }>;
  estimate: Estimate | null; cycleOptions: Named[] | null; moduleOptions: Named[] | null; run: Run; onClear: () => void; onApplied: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const ids = selected.map((item) => item.id);
  const count = ids.length;
  const archivable = selected.every((item) => ["completed", "cancelled"].includes(states.find((state) => state.id === item.stateId)?.group ?? ""));
  const assigned = new Set(selected.flatMap((item) => item.assigneeIds));
  const labelled = new Set(selected.flatMap((item) => item.labelIds));

  /** Runs one Action over the selection; a refusal keeps the selection and says which work item stopped it. */
  const apply = async (name: string, body: Record<string, unknown>, done: string, after?: (data: unknown) => string | null) => {
    if (busy) return false;
    setBusy(true);
    const result = await run<unknown>(name, body);
    setBusy(false);
    if ("error" in result) { setError(result.error || t("workItems.failed")); return false; }
    setError(null);
    const extra = after?.(result.data);
    showToast(fill(done, count) + (extra ? ` ${extra}` : ""));
    onApplied();
    return true;
  };
  const update = (patch: Record<string, unknown>) => apply("bulk_update_work_items", { projectId, workItemIds: ids, ...patch }, "bulk.updated");
  const setCycle = async (target: string) => {
    if (busy) return;
    // A work item has one Cycle: leave every other Cycle first, then join the target (the same two steps as a single change).
    for (const cycle of cycleOptions ?? []) if (cycle.id !== target) {
      const removed = await run("remove_cycle_items", { cycleId: cycle.id, workItemIds: ids });
      if ("error" in removed) return setError(removed.error || t("workItems.failed"));
    }
    if (!target) { setError(null); showToast(fill("bulk.updated", count)); return onApplied(); }
    await apply("add_cycle_items", { cycleId: target, workItemIds: ids }, "bulk.updated", (data) => { const skipped = (data as { skipped: unknown[] }).skipped.length; return skipped ? fill("bulk.skippedCycle", skipped) : null; });
  };

  const priorities = ["urgent", "high", "medium", "low", "none"];
  return <div role="toolbar" aria-label={t("bulk.label")} data-testid="bulk-bar" className="fixed inset-x-0 bottom-4 z-30 mx-auto grid w-fit max-w-[calc(100vw-2rem)] gap-2 rounded-lg border border-subtle bg-surface-1 p-2 shadow-xl">
    <div className="flex flex-wrap items-center gap-2">
      <span className="px-1 text-13 font-medium text-primary" aria-live="polite">{fill("bulk.selected", count)}</span>
      <SingleSelect label={t("workItems.state")} summary={t("workItems.state")} value="" icon={<StateIcon group="started" />} options={states.map((state) => ({ id: state.id, name: state.name, icon: <StateIcon group={state.group} /> }))} onSelect={(stateId) => void update({ stateId })} />
      <SingleSelect label={t("workItems.priority")} summary={t("workItems.priority")} value="" icon={<PriorityIcon priority="high" />} options={priorities.map((id) => ({ id, name: t(`workItems.priority.${id}`), icon: <PriorityIcon priority={id} /> }))} onSelect={(priority) => void update({ priority })} />
      <SetMenu label={t("workItems.assignees")} icon={<Users aria-hidden size={14} className="text-secondary" />} options={people.map((person) => ({ id: person.userId, name: person.name, icon: <Avatar name={person.name} id={person.userId} agent={person.isAgent} />, isAgent: person.isAgent, codeCapable: person.codeCapable, hasAccess: person.hasAccess, accessReason: accessReasonText(person) }))} present={assigned}
        onApply={(mode, id) => update(mode === "add" ? { addAssigneeIds: [id] } : { removeAssigneeIds: [id] })} />
      <SetMenu label={t("workItems.labels")} icon={<Tag aria-hidden size={14} className="text-secondary" />} options={labels.map((label) => ({ id: label.id, name: label.name, icon: <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} /> }))} present={labelled}
        onApply={(mode, id) => update(mode === "add" ? { addLabelIds: [id] } : { removeLabelIds: [id] })} />
      {estimate?.enabled && <SingleSelect label={t("workItems.estimate")} summary={t("workItems.estimate")} value="" icon={<Sigma aria-hidden size={14} className="text-secondary" />}
        options={[{ id: "", name: t("workItems.noEstimate") }, ...estimate.points.map((point) => ({ id: point.id, name: point.value }))]} onSelect={(id) => void update({ estimatePointId: id || null })} />}
      <DatesMenu startDate={null} dueDate={null} onChange={(dates) => void update(dates)} />
      {cycleOptions && <SingleSelect label={t("workItems.cycle")} summary={t("workItems.cycle")} value="" icon={<RefreshCw aria-hidden size={14} className="text-secondary" />}
        options={[{ id: "", name: t("workItems.noCycle") }, ...cycleOptions.filter((cycle) => cycle.status !== "completed").map((cycle) => ({ id: cycle.id, name: cycle.name }))]} onSelect={(id) => void setCycle(id)} />}
      {moduleOptions && <SetMenu label={t("workItems.modules")} icon={<Package aria-hidden size={14} className="text-secondary" />} options={moduleOptions.map((module) => ({ id: module.id, name: module.name }))} present={new Set(moduleOptions.map((module) => module.id))}
        onApply={(mode, id) => apply(mode === "add" ? "add_module_items" : "remove_module_items", { moduleId: id, workItemIds: ids }, "bulk.updated")} />}
      <button type="button" className={`${chip} disabled:opacity-50`} disabled={!archivable} title={archivable ? undefined : t("bulk.archiveBlocked")} onClick={() => void apply("bulk_archive_work_items", { projectId, workItemIds: ids }, "bulk.archived").then((ok) => ok && onClear())}><Archive aria-hidden size={14} className="text-secondary" />{t("bulk.archive")}</button>
      <button type="button" className={`${chip} text-danger-text`} onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden size={14} />{t("bulk.delete")}</button>
      <button type="button" aria-label={t("bulk.clear")} title={t("bulk.clear")} className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={onClear}><X aria-hidden size={16} /></button>
    </div>
    {error && <p role="alert" className="m-0 px-1 text-13 text-danger-text">{error}</p>}
    {confirmDelete && <Dialog title={fill("bulk.deleteTitle", count)} onClose={() => setConfirmDelete(false)}>
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void apply("delete_work_items", { projectId, workItemIds: ids }, "bulk.deleted").then((ok) => { setConfirmDelete(false); if (ok) onClear(); }); }}>
        <p className="m-0 text-14 text-secondary">{t("bulk.deleteBody")}</p>
        <div className="flex justify-end gap-2"><button type="button" className="secondary" onClick={() => setConfirmDelete(false)}>{t("comments.cancel")}</button><button type="submit">{t("bulk.delete")}</button></div>
      </form>
    </Dialog>}
  </div>;
}
