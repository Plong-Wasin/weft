import { Button } from "@/ui/button";
import React from "react";
import { ChevronDown, ChevronUp, Clock, Copy, CopyCheck, Inbox, MoreHorizontal, Plus, X } from "lucide-react";
import { formatDate, translate, type MessageKey } from "@weft/shared";
import { useLocation, useSearchParams } from "react-router";
import { EmptyState } from "./empty-state";
import { Popover, menuItemClass } from "./shell/popover";
import { MultiSelect, PriorityIcon } from "./property-dropdowns";
import { Avatar } from "./avatar";
import { useWorkspace } from "./layouts/workspace-layout";
import { markdownToDoc } from "../../../packages/actions/src/markdown-doc";
import { DescriptionEditor } from "./description-editor";
import { TimelinePanel } from "./comments-panel";
import { AttachmentsPanel } from "./asset-images";
import { uploadAsset } from "./asset-upload";
import { actionResult, api } from "./api";
import { paths } from "./routes";
import { useInboxNotificationOpen } from "./inbox";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
const outcomes = ["pending", "snoozed", "accepted", "rejected", "duplicate"] as const;
type Outcome = (typeof outcomes)[number];
type Tab = "open" | "closed";
type IntakeItem = {
  id: string; workItemId: string; displayId: string; title: string; descriptionText: string; descriptionMarkdown: string; priority: string; outcome: Outcome; snoozedTill: string | null;
  duplicateToDisplayId: string | null; createdBy: string; createdByName: string; createdAt: string; assigneeIds: string[]; labelIds: string[]; dueDate: string | null;
};
type IntakeDraft = { title: string; description: unknown; priority: string; assigneeIds: string[]; labelIds: string[]; dueDate: string | null };
type IntakePerson = { userId: string; name: string; isAgent?: boolean; hasAccess?: boolean };
type IntakeLabel = { id: string; name: string };
type ActivityRow = { id: string; field: string; oldValue: unknown; newValue: unknown; actorName: string; createdAt: string };
type IntakeState = { id: string; name: string; group: string };
type PendingImages = { files: File[]; assetIds: string[] };
function appendImages(description: unknown, ids: string[]) {
  const base = description && typeof description === "object" ? description as { type?: string; content?: unknown[] } : { type: "doc", content: [] };
  const present = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as { type?: unknown; attrs?: { assetId?: unknown }; content?: unknown };
    if (node.type === "assetImage" && typeof node.attrs?.assetId === "string") present.add(node.attrs.assetId);
    visit(node.content);
  };
  visit(base);
  return { ...base, type: "doc", content: [...(Array.isArray(base.content) ? base.content : []), ...[...new Set(ids)].filter((id) => !present.has(id)).map((assetId) => ({ type: "assetImage", attrs: { assetId } }))] };
}
const titleDraftKey = (id: string) => `intake-title-draft:${id}`;
const draftKey = (id: string) => `intake-draft:${id}`;
function readDraft(id: string): IntakeDraft | undefined {
  try { const value = sessionStorage.getItem(draftKey(id)); return value ? JSON.parse(value) as IntakeDraft : undefined; } catch { return undefined; }
}
const t = (key: string) => translate(key as MessageKey);
// Plane's Open tab holds undecided items (pending and snoozed); Closed holds every decided one.
const tabOutcomes: Record<Tab, Outcome[]> = { open: ["pending", "snoozed"], closed: ["accepted", "rejected", "duplicate"] };
const statusTone: Record<Outcome, string> = {
  pending: "bg-warning-subtle text-warning-primary", snoozed: "bg-layer-2 text-secondary", accepted: "bg-success-subtle text-success-text",
  rejected: "bg-danger-subtle text-danger-text", duplicate: "bg-layer-2 text-secondary",
};
const primaryButton = "min-h-9 rounded-lg bg-accent-primary px-3 py-1.5 text-13 font-medium text-on-color hover:opacity-90 disabled:opacity-50";
const quietButton = "min-h-9 rounded-lg border border-subtle bg-surface-1 px-3 py-1.5 text-13 font-medium text-primary hover:bg-layer-transparent-hover disabled:opacity-50";
const iconButton = "grid size-9 place-items-center rounded-lg border border-subtle bg-surface-1 p-0 text-secondary hover:bg-layer-transparent-hover hover:text-primary disabled:opacity-40";
const field = "w-full rounded-md border border-subtle bg-surface-1 px-2.5 py-1.5 text-14 text-primary";

function StatusBadge({ item }: { item: IntakeItem }) {
  return <span data-testid="intake-status" className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-12 font-medium ${statusTone[item.outcome]}`}>{t(`intake.status.${item.outcome}`)}</span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const pressedOutside = React.useRef(false);
  const titleId = React.useId();
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      opener?.focus();
    };
  }, []);
  const outside = (event: React.PointerEvent<HTMLDialogElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  return <dialog ref={dialogRef} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onPointerDown={(event) => { pressedOutside.current = outside(event); }} onPointerUp={(event) => {
    if (pressedOutside.current && outside(event)) onClose();
    pressedOutside.current = false;
  }} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) { event.preventDefault(); dialog.focus(); }
    else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }} className="fixed left-0 right-0 top-[10dvh] z-50 mx-auto max-h-[80dvh] w-[calc(100vw-1.5rem)] max-w-lg overflow-auto rounded-2xl border border-subtle bg-surface-1 p-6 text-primary shadow-xl backdrop:bg-backdrop">
      <div className="mb-4 flex items-center gap-2">
        <h2 id={titleId} className="m-0 flex-1 text-18 font-semibold text-primary">{title}</h2>
        <Button type="button" className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover" aria-label={t("intake.cancel")} onClick={onClose}><X aria-hidden size={16} /></Button>
      </div>
      {children}
  </dialog>;
}

/** The submission form: any project member, Guests included, can send a work item into Intake. */
function SubmitModal({ action, workspaceId, projectId, onClose, onSubmitted }: { action: Call; workspaceId: string; projectId: string; onClose: () => void; onSubmitted: (item: IntakeItem, failedFiles: File[], pendingImages: PendingImages) => void }) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState<unknown>(markdownToDoc(""));
  const [priority, setPriority] = React.useState("none");
  const [people, setPeople] = React.useState<IntakePerson[]>([]);
  const [labels, setLabels] = React.useState<IntakeLabel[]>([]);
  const [assigneeIds, setAssigneeIds] = React.useState<string[]>([]);
  const [labelIds, setLabelIds] = React.useState<string[]>([]);
  const [dueDate, setDueDate] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);
  const [files, setFiles] = React.useState<File[]>([]);
  const [inlineImages, setInlineImages] = React.useState<File[]>([]);
  const picker = React.useRef<HTMLInputElement>(null);
  const imagePicker = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { void Promise.all([action<IntakePerson[]>("list_project_members", { projectId }), action<IntakeLabel[]>("list_labels", { projectId })]).then(([members, projectLabels]) => { if (members) setPeople(members); if (projectLabels) setLabels(projectLabels); }); }, [action, projectId]);
  return <Modal title={t("intake.modalTitle")} onClose={() => { if (!submittingRef.current) onClose(); }}>
    <form className="my-0 grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      if (submittingRef.current) return;
      submittingRef.current = true; setSubmitting(true);
      try {
      const saved = await action<IntakeItem>("submit_intake_item", { projectId, title, priority, description, assigneeIds, labelIds, dueDate: dueDate || null });
      setNote(saved ? null : t("intake.submitFailed"));
      if (saved) {
        const failed: File[] = [];
        for (const file of files) {
          try { await uploadAsset({ api }, { ownerType: "work_item", ownerId: saved.workItemId }, file); }
          catch { failed.push(file); }
        }
        const imageIds: string[] = [];
        const failedImages: File[] = [];
        for (const file of inlineImages) {
          try { imageIds.push((await uploadAsset({ api }, { ownerType: "work_item", ownerId: saved.workItemId }, file)).id); }
          catch { failedImages.push(file); }
        }
        let pendingIds = imageIds;
        if (imageIds.length) {
          try { if (await action("update_intake_item", { intakeItemId: saved.id, description: appendImages(description, imageIds) })) pendingIds = []; } catch { /* Retry from the saved item. */ }
        }
        onSubmitted(saved, failed, { files: failedImages, assetIds: pendingIds });
      }
      } finally { submittingRef.current = false; setSubmitting(false); }
    }}>
      <fieldset disabled={submitting} className="m-0 grid min-w-0 gap-3 border-0 p-0">
      <input autoFocus required maxLength={500} aria-label={t("intake.titleField")} placeholder={t("intake.titleField")} value={title} className={`${field} text-16`} onChange={(event) => setTitle(event.target.value)} />
      <div aria-label={t("intake.descriptionField")}><DescriptionEditor workspaceId={workspaceId} workItemId={null} initial={description} editable={!submitting} imageUploads={false} onChange={setDescription} /></div>
      <label className="grid gap-1 text-13 text-secondary">{t("intake.priority")}
        <select value={priority} className="w-full text-14 text-primary" onChange={(event) => setPriority(event.target.value)}>
          {["none", "urgent", "high", "medium", "low"].map((value) => <option key={value} value={value}>{t(`workItems.priority.${value}`)}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-13 text-secondary">{t("workItems.assignees")}<select multiple value={assigneeIds} className={`${field} min-h-20`} onChange={(event) => setAssigneeIds([...event.currentTarget.selectedOptions].map((option) => option.value))}>{people.map((person) => <option key={person.userId} value={person.userId} disabled={person.isAgent && person.hasAccess === false}>{person.name}{person.isAgent && person.hasAccess === false ? " (no access)" : ""}</option>)}</select></label>
      <div className="grid gap-1 text-13 text-secondary"><span>{t("workItems.labels")}</span><MultiSelect label={t("workItems.labels")} searchAlways selected={labelIds} summary={<span>{labelIds.length ? labelIds.map((id) => labels.find((label) => label.id === id)?.name).filter(Boolean).join(", ") : t("workItems.noLabels")}</span>} options={labels.map((label) => ({ id: label.id, name: label.name }))} onToggle={(id, on) => setLabelIds(on ? [...labelIds, id] : labelIds.filter((value) => value !== id))} /></div>
      <label className="grid gap-1 text-13 text-secondary">{t("workItems.dueDate")}<input type="date" value={dueDate} className={field} onChange={(event) => setDueDate(event.target.value)} /></label>
      <input ref={picker} hidden type="file" multiple data-testid="intake-attach-input" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); setFiles((current) => [...current, ...selected]); event.currentTarget.value = ""; }} />
      <div className="grid gap-1"><Button type="button" className={quietButton} onClick={() => picker.current?.click()}>{t("assets.attach")}</Button>{files.map((file, index) => <span key={`${file.name}-${index}`} className="text-13 text-secondary">{file.name}</span>)}</div>
      <input ref={imagePicker} hidden type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" data-testid="intake-inline-image-input" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); setInlineImages((current) => [...current, ...selected]); event.currentTarget.value = ""; }} />
      <div className="grid gap-1"><Button type="button" className={quietButton} onClick={() => imagePicker.current?.click()}>{t("assets.inlineImage")}</Button>{inlineImages.map((file, index) => <span key={`${file.name}-${index}`} className="text-13 text-secondary">{file.name}</span>)}</div>
      {note && <p role="alert" className="m-0 text-13 text-danger-text">{note}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" className={quietButton} disabled={submitting} onClick={onClose}>{t("intake.cancel")}</Button>
        <Button className={primaryButton} disabled={submitting}>{t("intake.submit")}</Button>
      </div>
      </fieldset>
    </form>
  </Modal>;
}

function SnoozeModal({ onClose, onSnooze }: { onClose: () => void; onSnooze: (till: string) => void }) {
  const [till, setTill] = React.useState("");
  return <Modal title={t("intake.snoozeTitle")} onClose={onClose}>
    <form className="my-0 grid gap-3" onSubmit={(event) => { event.preventDefault(); onSnooze(new Date(till).toISOString()); }}>
      <label className="grid gap-1 text-13 text-secondary">{t("intake.snoozeTill")}
        <input autoFocus required type="datetime-local" value={till} className={field} onChange={(event) => setTill(event.target.value)} />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" className={quietButton} onClick={onClose}>{t("intake.cancel")}</Button>
        <Button className={primaryButton} disabled={!till}>{t("intake.snooze")}</Button>
      </div>
    </form>
  </Modal>;
}

function AcceptModal({ action, projectId, onClose, onAccept }: { action: Call; projectId: string; onClose: () => void; onAccept: (stateId: string) => void }) {
  const [states, setStates] = React.useState<IntakeState[]>([]);
  const [stateId, setStateId] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void action<IntakeState[]>("list_states", { projectId }).then((rows) => {
      if (!active) return;
      setFailed(!rows);
      const normal = (rows ?? []).filter((state) => state.group !== "triage");
      setStates(normal);
      setStateId((current) => current || normal.find((state) => state.group === "backlog")?.id || "");
    });
    return () => { active = false; };
  }, [action, projectId]);
  return <Modal title={t("intake.acceptIntoState")} onClose={onClose}>
    <form className="my-0 grid gap-3" onSubmit={(event) => { event.preventDefault(); if (stateId) onAccept(stateId); }}>
      {failed && <p role="alert" className="m-0 text-13 text-danger-text">{t("intake.loadFailed")}</p>}
      <label className="grid gap-1 text-13 text-secondary">{t("workItems.state")}
        <select autoFocus required aria-label={t("workItems.state")} value={stateId} className={field} onChange={(event) => setStateId(event.target.value)}>
          {states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" className={quietButton} onClick={onClose}>{t("intake.cancel")}</Button>
        <Button className={primaryButton} disabled={!stateId}>{t("intake.accept")}</Button>
      </div>
    </form>
  </Modal>;
}

/** Picks the original by display id (for example MOB-1) and resolves it through search. */
function DuplicateModal({ action, workspaceId, item, onClose, onPick }: { action: Call; workspaceId: string; item: IntakeItem; onClose: () => void; onPick: (workItemId: string) => void }) {
  const [value, setValue] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  return <Modal title={t("intake.duplicateTitle")} onClose={onClose}>
    <form className="my-0 grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      const key = item.displayId.split("-")[0]!;
      const found = await action<Array<{ id: string; displayId: string }>>("search_work_items", { workspaceId, query: value.trim() });
      const match = found?.find((row) => row.displayId.toLowerCase() === value.trim().toLowerCase() && row.displayId.startsWith(`${key}-`));
      setFailed(!match);
      if (match) onPick(match.id);
    }}>
      <label className="grid gap-1 text-13 text-secondary">{t("intake.duplicateTo")}
        <input autoFocus value={value} placeholder={t("intake.duplicateHint")} className={field} onChange={(event) => setValue(event.target.value)} />
      </label>
      {failed && <p role="alert" className="m-0 text-13 text-danger-text">{t("intake.failed")}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" className={quietButton} onClick={onClose}>{t("intake.cancel")}</Button>
        <Button className={primaryButton} disabled={!value.trim()}>{t("intake.markDuplicate")}</Button>
      </div>
    </form>
  </Modal>;
}

function ListRow({ item, selected, onSelect }: { item: IntakeItem; selected: boolean; onSelect: () => void }) {
  return <li>
    <Button type="button" data-testid={`intake-${item.displayId}`} aria-current={selected ? "true" : undefined} onClick={onSelect}
      className={`grid w-full gap-2 rounded-lg border-0 bg-transparent px-4 py-3 text-left hover:bg-layer-transparent-hover ${selected ? "bg-layer-transparent-hover outline outline-1 -outline-offset-1 outline-accent-primary" : ""}`}>
      <span className="text-12 text-tertiary">{item.displayId}</span>
      <span className="truncate text-14 font-medium text-primary">{item.title}</span>
      <span className="flex items-center gap-2 text-12 text-secondary">
        <span>{formatDate(item.createdAt)}</span>
        <PriorityIcon priority={item.priority} />
        <span className="flex-1" />
        <StatusBadge item={item} />
        <Avatar name={item.createdByName} id={item.createdBy} />
      </span>
    </Button>
  </li>;
}

type Dialog = "accept" | "snooze" | "duplicate" | null;

function Detail({ action, workspaceId, workspaceSlug, projectKey, projectId, selfId, item, index, count, canDecide, canEdit, draft, failedFiles, onFailedFilesChange, pendingImages, onPendingImagesChange, onDraftChange, onMove, onDecided, onChanged, onUpdated }: {
  action: Call; workspaceId: string; workspaceSlug: string; projectKey: string; projectId: string; selfId: string; item: IntakeItem; index: number; count: number; canDecide: boolean; canEdit: boolean; draft?: IntakeDraft; failedFiles: File[]; onFailedFilesChange: (files: File[]) => void; pendingImages: PendingImages; onPendingImagesChange: (value: PendingImages) => void; onDraftChange: (patch: Partial<IntakeDraft>) => void; onMove: (delta: number) => void; onDecided: () => void; onChanged: () => void; onUpdated: () => void;
}) {
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [activity, setActivity] = React.useState<ActivityRow[]>([]);
  const activeDraft = readDraft(item.id) ?? draft;
  const [title, setTitle] = React.useState(sessionStorage.getItem(titleDraftKey(item.id)) ?? activeDraft?.title ?? item.title);
  const titleValueRef = React.useRef(title);
  const titleInputRef = React.useRef<HTMLInputElement | null>(null);
  const description = activeDraft?.description ?? markdownToDoc(item.descriptionMarkdown);
  React.useEffect(() => {
    const cached = sessionStorage.getItem(titleDraftKey(item.id));
    if (cached !== null && cached !== titleValueRef.current) { titleValueRef.current = cached; setTitle(cached); }
  }, [description, item.id]);
  const priority = activeDraft?.priority ?? item.priority;
  const [people, setPeople] = React.useState<IntakePerson[]>([]);
  const [labels, setLabels] = React.useState<IntakeLabel[]>([]);
  React.useEffect(() => { void Promise.all([action<IntakePerson[]>("list_project_members", { projectId }), action<IntakeLabel[]>("list_labels", { projectId })]).then(([members, projectLabels]) => { if (members) setPeople(members); if (projectLabels) setLabels(projectLabels); }); }, [action, projectId]);
  const assigneeIds = activeDraft?.assigneeIds ?? item.assigneeIds;
  const labelIds = activeDraft?.labelIds ?? item.labelIds;
  const dueDate = activeDraft && "dueDate" in activeDraft ? activeDraft.dueDate ?? "" : item.dueDate ?? "";
  const editable = canEdit && (item.outcome === "pending" || item.outcome === "snoozed");
  const changeDraft = (patch: Partial<IntakeDraft>) => onDraftChange(patch);
  const [saving, setSaving] = React.useState(false);
  const [retryingImages, setRetryingImages] = React.useState(false);
  const [editorRevision, setEditorRevision] = React.useState(0);
  const retryImages = async () => {
    setRetryingImages(true);
    const failures: File[] = [];
    const ids = [...pendingImages.assetIds];
    for (const file of pendingImages.files) {
      try { ids.push((await uploadAsset({ api }, { ownerType: "work_item", ownerId: item.workItemId }, file)).id); }
      catch { failures.push(file); }
    }
    let remaining = ids;
    if (ids.length) {
      try {
        const currentDescription = readDraft(item.id)?.description ?? description;
        const updated = appendImages(currentDescription, ids);
        if (await action("update_intake_item", { intakeItemId: item.id, description: updated })) {
          remaining = [];
          const latestDescription = readDraft(item.id)?.description ?? currentDescription;
          onDraftChange({ description: latestDescription === currentDescription ? updated : appendImages(latestDescription, ids) });
          setEditorRevision((revision) => revision + 1);
          onChanged();
        }
      } catch { /* Keep the uploaded IDs for another retry. */ }
    }
    onPendingImagesChange({ files: failures, assetIds: remaining });
    setRetryingImages(false);
  };
  const undecided = item.outcome === "pending" || item.outcome === "snoozed";
  const unsnoozed = item.outcome === "snoozed";
  const loadActivity = React.useCallback(async () => setActivity(await action<ActivityRow[]>("list_work_item_activities", { workItemId: item.workItemId }) ?? []), [action, item.workItemId]);
  React.useEffect(() => { void loadActivity(); }, [loadActivity]);
  const run = async (name: string, body: Record<string, unknown>) => {
    const done = await action(name, { intakeItemId: item.id, ...body });
    setNote(done ? null : t("intake.failed"));
    if (done) { setDialog(null); if (name === "unsnooze_intake_item") onChanged(); else onDecided(); }
  };
  const save = async () => {
    setSaving(true);
    const draftSnapshot = sessionStorage.getItem(draftKey(item.id));
    const titleSnapshot = sessionStorage.getItem(titleDraftKey(item.id));
    const savedDraft = readDraft(item.id);
    const attempted = { title: titleInputRef.current?.value ?? sessionStorage.getItem(titleDraftKey(item.id)) ?? titleValueRef.current, description: savedDraft?.description ?? description, priority: savedDraft?.priority ?? priority, assigneeIds: savedDraft?.assigneeIds ?? assigneeIds, labelIds: savedDraft?.labelIds ?? labelIds, dueDate: savedDraft ? savedDraft.dueDate : (dueDate || null) };
    try {
      const saved = await action<IntakeItem>("update_intake_item", { intakeItemId: item.id, ...attempted });
      if (!saved) {
        if (sessionStorage.getItem(draftKey(item.id)) === draftSnapshot && sessionStorage.getItem(titleDraftKey(item.id)) === titleSnapshot) onDraftChange(attempted);
        setNote(t("intake.failed")); return;
      }
      if (sessionStorage.getItem(draftKey(item.id)) === draftSnapshot && sessionStorage.getItem(titleDraftKey(item.id)) === titleSnapshot) {
        titleValueRef.current = attempted.title; setTitle(attempted.title); sessionStorage.removeItem(titleDraftKey(item.id)); sessionStorage.removeItem(draftKey(item.id)); onUpdated();
      } else onChanged();
      setNote(null);
    } catch { setNote(t("intake.failed")); }
    finally { setSaving(false); }
  };
  return <section aria-label={t("intake.detail")} className="flex min-w-0 flex-1 flex-col">
    <header className="flex flex-wrap items-center gap-2 border-b border-subtle px-6 py-4">
      <span className="text-16 font-medium text-secondary">{item.displayId}</span>
      <StatusBadge item={item} />
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <Button type="button" className={iconButton} aria-label={t("intake.previous")} disabled={index <= 0} onClick={() => onMove(-1)}><ChevronUp aria-hidden size={16} /></Button>
        <Button type="button" className={iconButton} aria-label={t("intake.next")} disabled={index >= count - 1} onClick={() => onMove(1)}><ChevronDown aria-hidden size={16} /></Button>
        {canDecide && undecided && <>
          <Button type="button" className={quietButton} onClick={() => setDialog("accept")}>{t("intake.accept")}</Button>
          <Button type="button" className={quietButton} onClick={() => void run("reject_intake_item", {})}>{t("intake.reject")}</Button>
        </>}
        {canDecide && unsnoozed && <Button type="button" className={quietButton} onClick={() => void run("unsnooze_intake_item", {})}>{t("intake.unsnooze")}</Button>}
        <Popover label={t("intake.more")} align="right" className="size-9 justify-center border border-subtle bg-surface-1" trigger={<MoreHorizontal aria-hidden size={16} />}>
          {(close) => <>
            {canDecide && undecided && <>
              <Button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); setDialog("snooze"); }}><Clock aria-hidden size={14} />{t("intake.snooze")}</Button>
              <Button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); setDialog("duplicate"); }}><Copy aria-hidden size={14} />{t("intake.markDuplicate")}</Button>
            </>}
            <Button type="button" role="menuitem" className={menuItemClass} onClick={() => {
              close();
              void navigator.clipboard?.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
            }}>{copied ? <CopyCheck aria-hidden size={14} /> : <Copy aria-hidden size={14} />}{t("intake.copyLink")}</Button>
          </>}
        </Popover>
      </span>
    </header>
    <div className="grid gap-6 overflow-auto px-6 py-6">
      {editable ? <div className="grid gap-3">
        <label className="grid gap-1 text-13 text-secondary">{t("intake.titleField")}<input ref={titleInputRef} name="title" aria-label={t("intake.titleField")} required maxLength={500} value={title} className={`${field} text-18 font-semibold sm:text-24`} onInput={(event) => { titleValueRef.current = event.currentTarget.value; setTitle(event.currentTarget.value); sessionStorage.setItem(titleDraftKey(item.id), event.currentTarget.value); changeDraft({ title: event.currentTarget.value }); }} /></label>
        <div><p className="mb-1 text-13 text-secondary">{t("intake.descriptionField")}</p><DescriptionEditor key={editorRevision} workspaceId={workspaceId} workItemId={item.workItemId} initial={description} editable onChange={(doc) => changeDraft({ description: doc })} /></div>
        <label className="grid gap-1 text-13 text-secondary">{t("intake.priority")}<select name="priority" aria-label={t("intake.priority")} value={priority} className={field} onChange={(event) => changeDraft({ priority: event.target.value })}>{["none", "urgent", "high", "medium", "low"].map((value) => <option key={value} value={value}>{t(`workItems.priority.${value}`)}</option>)}</select></label>
        <label className="grid gap-1 text-13 text-secondary">{t("workItems.assignees")}<select multiple aria-label={t("workItems.assignees")} value={assigneeIds} className={`${field} min-h-20`} onChange={(event) => changeDraft({ assigneeIds: [...event.currentTarget.selectedOptions].map((option) => option.value) })}>{people.map((person) => <option key={person.userId} value={person.userId} disabled={person.isAgent && person.hasAccess === false}>{person.name}{person.isAgent && person.hasAccess === false ? " (no access)" : ""}</option>)}</select></label>
        <div className="grid gap-1 text-13 text-secondary"><span>{t("workItems.labels")}</span><MultiSelect label={t("workItems.labels")} searchAlways selected={labelIds} summary={<span>{labelIds.length ? labelIds.map((id) => labels.find((label) => label.id === id)?.name).filter(Boolean).join(", ") : t("workItems.noLabels")}</span>} options={labels.map((label) => ({ id: label.id, name: label.name }))} onToggle={(id, on) => changeDraft({ labelIds: on ? [...labelIds, id] : labelIds.filter((value) => value !== id) })} /></div>
        <label className="grid gap-1 text-13 text-secondary">{t("workItems.dueDate")}<input type="date" aria-label={t("workItems.dueDate")} value={dueDate} className={field} onChange={(event) => changeDraft({ dueDate: event.target.value || null })} /></label>
        <div className="flex gap-2"><Button type="button" className={primaryButton} disabled={saving || retryingImages || !title.trim()} onClick={() => void save()}>{saving ? t("intake.saving") : t("intake.save")}</Button></div>
      </div> : <><h2 className="m-0 text-24 font-semibold text-primary">{item.title}</h2>
      {item.descriptionMarkdown ? <DescriptionEditor workspaceId={workspaceId} workItemId={item.workItemId} initial={markdownToDoc(item.descriptionMarkdown)} editable={false} onChange={() => undefined} /> : <p className="m-0 text-14 text-tertiary">{t("intake.noDescription")}</p>}</>}
      <dl className="m-0 grid max-w-md grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-3 text-13">
        <dt className="text-secondary">{t("intake.priority")}</dt>
        <dd className="m-0 flex items-center gap-1.5 text-primary"><PriorityIcon priority={item.priority} />{t(`workItems.priority.${item.priority}`)}</dd>
        <dt className="text-secondary">{t("workItems.assignees")}</dt><dd className="m-0 text-primary">{item.assigneeIds.map((id) => people.find((person) => person.userId === id)?.name ?? id).join(", ") || t("workItems.noAssignee")}</dd>
        <dt className="text-secondary">{t("workItems.labels")}</dt><dd className="m-0 text-primary">{item.labelIds.map((id) => labels.find((label) => label.id === id)?.name ?? id).join(", ") || "—"}</dd>
        <dt className="text-secondary">{t("workItems.dueDate")}</dt><dd className="m-0 text-primary">{item.dueDate ?? "—"}</dd>
        <dt className="text-secondary">{t("intake.submittedBy")}</dt>
        <dd className="m-0 flex items-center gap-1.5 text-primary"><Avatar name={item.createdByName} id={item.createdBy} />{item.createdByName}</dd>
        <dt className="text-secondary">{t("intake.submittedOn")}</dt>
        <dd className="m-0 text-primary">{formatDate(item.createdAt)}</dd>
        {item.outcome === "snoozed" && item.snoozedTill && <><dt className="text-secondary">{t("intake.status.snoozed")}</dt><dd className="m-0 text-primary">{t("intake.snoozedTill").replace("{date}", formatDate(item.snoozedTill))}</dd></>}
        {item.outcome === "duplicate" && item.duplicateToDisplayId && <><dt className="text-secondary">{t("intake.status.duplicate")}</dt><dd className="m-0 text-primary">{t("intake.duplicateOf").replace("{id}", item.duplicateToDisplayId)}</dd></>}
      </dl>
      <TimelinePanel workspaceId={workspaceId} workItemId={item.workItemId} projectId={projectId} selfId={selfId} canComment={item.outcome === "accepted" ? canDecide : true} linkBase={item.outcome === "accepted" ? paths.workItem(workspaceSlug, item.displayId) : paths.intake(workspaceSlug, projectKey)} action={action as never} actionResult={actionResult} onChange={onChanged} />
      {note && <p role="alert" className="m-0 text-13 text-danger-text">{note}</p>}
      <AttachmentsPanel workItemId={item.workItemId} canWrite={editable || (item.outcome === "accepted" && canDecide)} action={action} onChange={() => { void loadActivity(); onChanged(); }} showForm={editable} onCount={() => undefined} failedFiles={failedFiles} onFailedFilesChange={onFailedFilesChange} />
      {editable && (pendingImages.files.length > 0 || pendingImages.assetIds.length > 0) && <div role="alert" className="grid gap-1 text-13 text-danger-text"><p className="m-0">{t("assets.uploadFailed")}</p><ul>{pendingImages.files.map((file, index) => <li key={`${file.name}-${index}`}>{file.name}</li>)}</ul><Button type="button" className={quietButton} disabled={saving || retryingImages} onClick={() => void retryImages()}>{t("assets.retryFailed")}</Button></div>}
      <section aria-label={t("intake.activity")} className="grid gap-2 border-t border-subtle pt-3">
        <h3 className="m-0 text-14 font-medium text-primary">{t("intake.activity")}</h3>
        <ul className="m-0 grid list-none gap-2 !pl-0 text-13 text-secondary">{activity.filter((row) => row.field === "attachment_added" || row.field === "attachment_removed").map((row) => {
          const values = row.field === "attachment_added" ? row.newValue : row.oldValue;
          const filename = values && typeof values === "object" ? String((values as { filename?: unknown }).filename ?? "") : "";
          const message = row.field === "attachment_added" ? t("intake.attachmentAdded") : t("intake.attachmentRemoved");
          return <li key={row.id}>{row.actorName} {message}{filename ? `: ${filename}` : ""}</li>;
        })}</ul>
      </section>
    </div>
    {dialog === "snooze" && <SnoozeModal onClose={() => setDialog(null)} onSnooze={(till) => void run("snooze_intake_item", { snoozedTill: till })} />}
    {dialog === "duplicate" && <DuplicateModal action={action} workspaceId={workspaceId} item={item} onClose={() => setDialog(null)} onPick={(workItemId) => void run("duplicate_intake_item", { duplicateTo: workItemId })} />}
    {dialog === "accept" && <AcceptModal action={action} projectId={projectId} onClose={() => setDialog(null)} onAccept={(stateId) => void run("accept_intake_item", { stateId })} />}
  </section>;
}

export function IntakePage({ workspaceId, workspaceSlug, projectKey, projectId, canDecide, canAdmin, enabled, action }: { workspaceId: string; workspaceSlug?: string; projectKey?: string; projectId: string; canDecide: boolean; canAdmin: boolean; enabled: boolean; action: Call }) {
  const { selfId } = useWorkspace();
  const location = useLocation();
  const [workspaceAdmin, setWorkspaceAdmin] = React.useState(false);
  const [params, setParams] = useSearchParams();
  const inboxOpen = useInboxNotificationOpen();
  const initialInboxTargetId = React.useRef(new URLSearchParams(location.search).get("inboxIssueId"));
  const tab: Tab = params.get("currentTab") === "closed" ? "closed" : "open";
  const selectedId = params.get("inboxIssueId");
  const [items, setItems] = React.useState<IntakeItem[] | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Record<string, IntakeDraft>>({});
  const [failedUploads, setFailedUploads] = React.useState<Record<string, File[]>>({});
  const [pendingImages, setPendingImages] = React.useState<Record<string, PendingImages>>({});
  const draftsRef = React.useRef<Record<string, IntakeDraft>>({});
  // A freshly submitted item is selected before the list has reloaded to include it.
  const justAdded = React.useRef<string | null>(null);
  React.useEffect(() => {
    let active = true;
    void action<Array<{ userId: string; role: string }>>("list_members", { workspaceId }).then((members) => {
      if (active) setWorkspaceAdmin(members?.some((member) => member.userId === selfId && member.role === "Admin") ?? false);
    });
    return () => { active = false; };
  }, [action, selfId, workspaceId]);
  const load = React.useCallback(async () => {
    if (!enabled) { setItems(null); return; }
    const lists = await Promise.all(tabOutcomes[tab].map((outcome) => action<IntakeItem[]>("list_intake_items", { projectId, outcome })));
    // A failed list is not an empty Intake: show the retry prompt, and keep any items loaded before so a failed reload does not blank a healthy list.
    const failed = lists.some((list) => list === null);
    setLoadFailed(failed);
    if (!failed) setItems(lists.flatMap((list) => list ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, [action, projectId, enabled, tab]);
  React.useEffect(() => { setItems(null); void load(); }, [load]);
  const select = React.useCallback((id: string | null, nextTab: Tab = tab) => {
    const next = new URLSearchParams();
    next.set("currentTab", nextTab);
    if (id) next.set("inboxIssueId", id);
    setParams(next, { replace: true });
  }, [setParams, tab]);
  // Like Plane: when nothing valid is selected, open the first item of the list.
  React.useEffect(() => {
    if (!items) return;
    if (justAdded.current && selectedId === justAdded.current) {
      if (!items.some((item) => item.id === selectedId)) return;
      justAdded.current = null;
    }
    const first = items[0]?.id ?? null;
    if (!items.some((item) => item.id === selectedId) && first !== selectedId) select(first);
  }, [items, selectedId, select]);
  React.useEffect(() => {
    const targetId = initialInboxTargetId.current;
    if (!inboxOpen.notificationId) return;
    if (!enabled) { inboxOpen.markUnavailable(); return; }
    if (!items) return;
    if (targetId && selectedId === targetId && items.some((item) => item.id === targetId)) inboxOpen.markLoaded();
    else inboxOpen.markUnavailable();
  }, [items, selectedId, enabled, inboxOpen.notificationId, inboxOpen.markLoaded, inboxOpen.markUnavailable]);
  if (!enabled) return <section><p role="status">{t("intake.off")}</p></section>;
  /** The Open tab has nothing in it: the empty state carries the one Submit action, so the header button steps aside. */
  const emptyOpen = tab === "open" && items?.length === 0;
  const index = items?.findIndex((item) => item.id === selectedId) ?? -1;
  const current = index >= 0 ? items![index]! : null;
  const afterDecision = () => {
    // The decided item leaves the Open tab: move on to its neighbour.
    const neighbour = items?.[index + 1] ?? items?.[index - 1] ?? null;
    if (tab === "open") select(neighbour?.id ?? null);
    void load();
  };
  const updateDraft = (item: IntakeItem, patch: Partial<IntakeDraft>) => {
    const previous = draftsRef.current[item.id] ?? readDraft(item.id);
    const next: IntakeDraft = { title: previous?.title ?? item.title, description: previous?.description ?? markdownToDoc(item.descriptionMarkdown), priority: previous?.priority ?? item.priority, assigneeIds: previous?.assigneeIds ?? item.assigneeIds, labelIds: previous?.labelIds ?? item.labelIds, dueDate: previous ? previous.dueDate : item.dueDate, ...patch };
    sessionStorage.setItem(draftKey(item.id), JSON.stringify(next));
    draftsRef.current = { ...draftsRef.current, [item.id]: next };
    setDrafts(draftsRef.current);
  };
  const afterChange = () => { void load(); };
  return <section className="flex min-w-0 flex-col gap-4" aria-label={t("intake.title")}>
    <div className="flex items-center gap-2">
      <Inbox aria-hidden size={18} className="text-secondary" />
      <h2 className="m-0 flex-1 text-16 font-semibold text-primary">{t("intake.title")}</h2>
      {!emptyOpen && <Button type="button" className={`${primaryButton} flex items-center gap-1.5`} onClick={() => setAdding(true)}><Plus aria-hidden size={14} />{t("intake.add")}</Button>}
    </div>
    <div className="flex min-h-[28rem] min-w-0 flex-col rounded-xl border border-subtle bg-surface-1 xl:h-[calc(100dvh-14rem)] xl:flex-row">
      <div className="flex w-full shrink-0 flex-col border-b border-subtle p-2 xl:w-[26rem] xl:border-b-0 xl:border-r">
        <div role="tablist" className="flex gap-2 border-b border-subtle px-2">
          {(["open", "closed"] as const).map((value) => <Button key={value} role="tab" type="button" aria-selected={tab === value} onClick={() => { if (value !== tab) select(null, value); }}
            className={`flex items-center gap-1.5 rounded-md border-0 px-3 py-2.5 text-14 font-medium ${tab === value ? "bg-layer-1 text-accent-primary" : "bg-transparent text-secondary hover:bg-layer-transparent-hover hover:text-primary"}`}>
            {t(`intake.tab.${value}`)}
            {value === "open" && tab === "open" && items && <span data-testid="intake-open-count" className="rounded-full bg-accent-primary/20 px-1.5 py-0.5 text-11 font-semibold text-accent-primary">{items.length}</span>}
          </Button>)}
        </div>
        {loadFailed && <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-3 text-13 text-danger-text"><span>{t("intake.loadFailed")}</span><Button type="button" className={quietButton} onClick={() => void load()}>{t("intake.retry")}</Button></div>}
        <ul aria-label={t("intake.list")} className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
          {(items ?? []).map((item) => <ListRow key={item.id} item={item} selected={item.id === selectedId} onSelect={() => select(item.id)} />)}
        </ul>
      </div>
      {current ? <Detail key={current.id} action={action} workspaceId={workspaceId} workspaceSlug={workspaceSlug ?? ""} projectKey={projectKey ?? ""} projectId={projectId} selfId={selfId} item={current} index={index} count={items!.length} canDecide={canDecide} canEdit={canAdmin || workspaceAdmin || current.createdBy === selfId} draft={draftsRef.current[current.id] ?? drafts[current.id]} onDraftChange={(patch) => updateDraft(current, patch)} failedFiles={failedUploads[current.id] ?? []} onFailedFilesChange={(files) => setFailedUploads((previous) => ({ ...previous, [current.id]: files }))} pendingImages={pendingImages[current.id] ?? { files: [], assetIds: [] }} onPendingImagesChange={(value) => setPendingImages((previous) => ({ ...previous, [current.id]: value }))}
        onMove={(delta) => select(items![index + delta]!.id)} onDecided={afterDecision} onChanged={afterChange} onUpdated={() => { const { [current.id]: _removed, ...rest } = draftsRef.current; draftsRef.current = rest; setDrafts(rest); void load(); }} />
        : items?.length === 0
          ? <div className="grid min-w-0 flex-1 place-items-center">{tab === "open"
            ? <EmptyState title={t("intake.empty")} description={t("intake.emptyHint")} action={<Button type="button" className={`${primaryButton} flex items-center gap-1.5`} onClick={() => setAdding(true)}><Plus aria-hidden size={14} />{t("intake.add")}</Button>} />
            : <EmptyState title={t("intake.emptyClosed")} description={t("intake.emptyClosedHint")} />}</div>
          : <div className="grid min-w-0 flex-1 place-items-center p-6 text-14 text-secondary">{t("intake.pick")}</div>}
    </div>
    {adding && <SubmitModal action={action} workspaceId={workspaceId} projectId={projectId} onClose={() => setAdding(false)} onSubmitted={(item, failedFiles, images) => { if (failedFiles.length) setFailedUploads((previous) => ({ ...previous, [item.id]: failedFiles })); if (images.files.length || images.assetIds.length) setPendingImages((previous) => ({ ...previous, [item.id]: images })); setAdding(false); justAdded.current = item.id; select(item.id, "open"); void load(); }} />}
  </section>;
}
