import React from "react";
import { ChevronDown, ChevronUp, Clock, Copy, CopyCheck, Inbox, MoreHorizontal, Plus, X } from "lucide-react";
import { formatDate, translate, type MessageKey } from "@weft/shared";
import { useSearchParams } from "react-router";
import { EmptyState } from "./empty-state";
import { Popover, menuItemClass } from "./shell/popover";
import { Avatar, PriorityIcon } from "./property-dropdowns";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
const outcomes = ["pending", "snoozed", "accepted", "rejected", "duplicate"] as const;
type Outcome = (typeof outcomes)[number];
type Tab = "open" | "closed";
type IntakeItem = {
  id: string; displayId: string; title: string; descriptionText: string; priority: string; outcome: Outcome; snoozedTill: string | null;
  duplicateToDisplayId: string | null; createdByName: string; createdAt: string;
};
const t = (key: string) => translate(key as MessageKey);
// Plane's Open tab holds undecided items (pending and snoozed); Closed holds every decided one.
const tabOutcomes: Record<Tab, Outcome[]> = { open: ["pending", "snoozed"], closed: ["accepted", "rejected", "duplicate"] };
const statusTone: Record<Outcome, string> = {
  pending: "bg-warning-subtle text-warning-primary", snoozed: "bg-layer-2 text-secondary", accepted: "bg-success-subtle text-success-text",
  rejected: "bg-danger-subtle text-danger-text", duplicate: "bg-layer-2 text-secondary",
};
const primaryButton = "rounded-md bg-accent-primary px-3 py-1.5 text-13 font-medium text-on-color hover:opacity-90 disabled:opacity-50";
const quietButton = "rounded-md border border-subtle bg-surface-1 px-3 py-1.5 text-13 font-medium text-primary hover:bg-layer-transparent-hover disabled:opacity-50";
const iconButton = "grid size-8 place-items-center rounded-md border border-subtle bg-surface-1 p-0 text-secondary hover:bg-layer-transparent-hover hover:text-primary disabled:opacity-40";
const field = "w-full rounded-md border border-subtle bg-surface-1 px-2.5 py-1.5 text-14 text-primary";

function StatusBadge({ item }: { item: IntakeItem }) {
  return <span data-testid="intake-status" className={`inline-flex items-center rounded px-1.5 py-0.5 text-12 font-medium ${statusTone[item.outcome]}`}>{t(`intake.status.${item.outcome}`)}</span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <>
    <div aria-hidden className="fixed inset-0 z-40 bg-backdrop" onClick={onClose} />
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed left-1/2 top-[10vh] z-50 max-h-[80vh] w-[calc(100vw-1.5rem)] max-w-lg -translate-x-1/2 overflow-auto rounded-lg border border-subtle bg-surface-1 p-5 shadow-xl">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="m-0 flex-1 text-18 font-semibold text-primary">{title}</h2>
        <button type="button" className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover" aria-label={t("intake.cancel")} onClick={onClose}><X aria-hidden size={16} /></button>
      </div>
      {children}
    </div>
  </>;
}

/** The submission form: any project member, Guests included, can send a work item into Intake. */
function SubmitModal({ action, projectId, onClose, onSubmitted }: { action: Call; projectId: string; onClose: () => void; onSubmitted: (item: IntakeItem) => void }) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [priority, setPriority] = React.useState("none");
  const [note, setNote] = React.useState<string | null>(null);
  return <Modal title={t("intake.modalTitle")} onClose={onClose}>
    <form className="my-0 grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      const doc = description.trim() ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: description.trim() }] }] } : undefined;
      const saved = await action<IntakeItem>("submit_intake_item", { projectId, title, priority, ...(doc ? { description: doc } : {}) });
      setNote(saved ? null : t("intake.submitFailed"));
      if (saved) onSubmitted(saved);
    }}>
      <input autoFocus required maxLength={500} aria-label={t("intake.titleField")} placeholder={t("intake.titleField")} value={title} className={`${field} text-16`} onChange={(event) => setTitle(event.target.value)} />
      <textarea aria-label={t("intake.descriptionField")} placeholder={t("intake.descriptionField")} rows={4} value={description} className={field} onChange={(event) => setDescription(event.target.value)} />
      <label className="grid gap-1 text-13 text-secondary">{t("intake.priority")}
        <select value={priority} className={field} onChange={(event) => setPriority(event.target.value)}>
          {["none", "urgent", "high", "medium", "low"].map((value) => <option key={value} value={value}>{t(`workItems.priority.${value}`)}</option>)}
        </select>
      </label>
      {note && <p role="alert" className="m-0 text-13 text-danger-text">{note}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={onClose}>{t("intake.cancel")}</button>
        <button className={primaryButton}>{t("intake.submit")}</button>
      </div>
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
        <button type="button" className={quietButton} onClick={onClose}>{t("intake.cancel")}</button>
        <button className={primaryButton} disabled={!till}>{t("intake.snooze")}</button>
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
        <button type="button" className={quietButton} onClick={onClose}>{t("intake.cancel")}</button>
        <button className={primaryButton} disabled={!value.trim()}>{t("intake.markDuplicate")}</button>
      </div>
    </form>
  </Modal>;
}

function ListRow({ item, selected, onSelect }: { item: IntakeItem; selected: boolean; onSelect: () => void }) {
  return <li>
    <button type="button" data-testid={`intake-${item.displayId}`} aria-current={selected ? "true" : undefined} onClick={onSelect}
      className={`grid w-full gap-1.5 border-0 border-b border-subtle bg-transparent px-4 py-3 text-left hover:bg-layer-transparent-hover ${selected ? "bg-layer-transparent-hover outline outline-1 -outline-offset-1 outline-accent-primary" : ""}`}>
      <span className="text-12 text-tertiary">{item.displayId}</span>
      <span className="truncate text-14 font-medium text-primary">{item.title}</span>
      <span className="flex items-center gap-2 text-12 text-secondary">
        <span>{formatDate(item.createdAt)}</span>
        <PriorityIcon priority={item.priority} />
        <span className="flex-1" />
        <StatusBadge item={item} />
        <Avatar name={item.createdByName} />
      </span>
    </button>
  </li>;
}

type Dialog = "snooze" | "duplicate" | null;

function Detail({ action, workspaceId, item, index, count, canDecide, onMove, onDecided }: {
  action: Call; workspaceId: string; item: IntakeItem; index: number; count: number; canDecide: boolean; onMove: (delta: number) => void; onDecided: () => void;
}) {
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const undecided = item.outcome === "pending" || item.outcome === "snoozed";
  const run = async (name: string, body: Record<string, unknown>) => {
    const done = await action(name, { intakeItemId: item.id, ...body });
    setNote(done ? null : t("intake.failed"));
    if (done) { setDialog(null); onDecided(); }
  };
  return <section aria-label={t("intake.detail")} className="flex min-w-0 flex-1 flex-col">
    <header className="flex flex-wrap items-center gap-2 border-b border-subtle px-5 py-3">
      <span className="text-16 font-medium text-secondary">{item.displayId}</span>
      <StatusBadge item={item} />
      <span className="flex-1" />
      <button type="button" className={iconButton} aria-label={t("intake.previous")} disabled={index <= 0} onClick={() => onMove(-1)}><ChevronUp aria-hidden size={16} /></button>
      <button type="button" className={iconButton} aria-label={t("intake.next")} disabled={index >= count - 1} onClick={() => onMove(1)}><ChevronDown aria-hidden size={16} /></button>
      {canDecide && undecided && <>
        <button type="button" className={quietButton} onClick={() => void run("accept_intake_item", {})}>{t("intake.accept")}</button>
        <button type="button" className={quietButton} onClick={() => void run("reject_intake_item", {})}>{t("intake.reject")}</button>
      </>}
      <Popover label={t("intake.more")} align="right" className="size-8 justify-center border border-subtle bg-surface-1" trigger={<MoreHorizontal aria-hidden size={16} />}>
        {(close) => <>
          {canDecide && undecided && <>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); setDialog("snooze"); }}><Clock aria-hidden size={14} />{t("intake.snooze")}</button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); setDialog("duplicate"); }}><Copy aria-hidden size={14} />{t("intake.markDuplicate")}</button>
          </>}
          <button type="button" role="menuitem" className={menuItemClass} onClick={() => {
            close();
            void navigator.clipboard?.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
          }}>{copied ? <CopyCheck aria-hidden size={14} /> : <Copy aria-hidden size={14} />}{t("intake.copyLink")}</button>
        </>}
      </Popover>
    </header>
    <div className="grid gap-5 overflow-auto px-5 py-5">
      <h2 className="m-0 text-24 font-semibold text-primary">{item.title}</h2>
      <p className="m-0 whitespace-pre-wrap text-14 text-primary">{item.descriptionText || <span className="text-tertiary">{t("intake.noDescription")}</span>}</p>
      <dl className="m-0 grid max-w-md grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-3 text-13">
        <dt className="text-secondary">{t("intake.priority")}</dt>
        <dd className="m-0 flex items-center gap-1.5 text-primary"><PriorityIcon priority={item.priority} />{t(`workItems.priority.${item.priority}`)}</dd>
        <dt className="text-secondary">{t("intake.submittedBy")}</dt>
        <dd className="m-0 flex items-center gap-1.5 text-primary"><Avatar name={item.createdByName} />{item.createdByName}</dd>
        <dt className="text-secondary">{t("intake.submittedOn")}</dt>
        <dd className="m-0 text-primary">{formatDate(item.createdAt)}</dd>
        {item.outcome === "snoozed" && item.snoozedTill && <><dt className="text-secondary">{t("intake.status.snoozed")}</dt><dd className="m-0 text-primary">{t("intake.snoozedTill").replace("{date}", formatDate(item.snoozedTill))}</dd></>}
        {item.outcome === "duplicate" && item.duplicateToDisplayId && <><dt className="text-secondary">{t("intake.status.duplicate")}</dt><dd className="m-0 text-primary">{t("intake.duplicateOf").replace("{id}", item.duplicateToDisplayId)}</dd></>}
      </dl>
      {note && <p role="alert" className="m-0 text-13 text-danger-text">{note}</p>}
    </div>
    {dialog === "snooze" && <SnoozeModal onClose={() => setDialog(null)} onSnooze={(till) => void run("snooze_intake_item", { snoozedTill: till })} />}
    {dialog === "duplicate" && <DuplicateModal action={action} workspaceId={workspaceId} item={item} onClose={() => setDialog(null)} onPick={(workItemId) => void run("duplicate_intake_item", { duplicateTo: workItemId })} />}
  </section>;
}

export function IntakePage({ workspaceId, projectId, canDecide, enabled, action }: { workspaceId: string; workspaceSlug?: string; projectKey?: string; projectId: string; canDecide: boolean; enabled: boolean; action: Call }) {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("currentTab") === "closed" ? "closed" : "open";
  const selectedId = params.get("inboxIssueId");
  const [items, setItems] = React.useState<IntakeItem[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  // A freshly submitted item is selected before the list has reloaded to include it.
  const justAdded = React.useRef<string | null>(null);
  const load = React.useCallback(async () => {
    if (!enabled) { setItems(null); return; }
    const lists = await Promise.all(tabOutcomes[tab].map((outcome) => action<IntakeItem[]>("list_intake_items", { projectId, outcome })));
    setItems(lists.flatMap((list) => list ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
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
  return <section className="flex flex-col gap-3" aria-label={t("intake.title")}>
    <div className="flex items-center gap-2">
      <Inbox aria-hidden size={18} className="text-secondary" />
      <h2 className="m-0 flex-1 text-16 font-semibold text-primary">{t("intake.title")}</h2>
      {!emptyOpen && <button type="button" className={`${primaryButton} flex items-center gap-1.5`} onClick={() => setAdding(true)}><Plus aria-hidden size={14} />{t("intake.add")}</button>}
    </div>
    <div className="flex min-h-[28rem] flex-col overflow-hidden rounded-lg border border-subtle bg-surface-1 md:h-[calc(100vh-14rem)] md:flex-row">
      <div className="flex w-full shrink-0 flex-col border-b border-subtle md:w-[26rem] md:border-b-0 md:border-r">
        <div role="tablist" className="flex gap-4 border-b border-subtle px-4">
          {(["open", "closed"] as const).map((value) => <button key={value} role="tab" type="button" aria-selected={tab === value} onClick={() => { if (value !== tab) select(null, value); }}
            className={`flex items-center gap-1.5 rounded-none border-0 border-b-2 bg-transparent px-1 py-3 text-14 font-medium ${tab === value ? "border-accent-primary text-accent-primary" : "border-transparent text-primary"}`}>
            {t(`intake.tab.${value}`)}
            {value === "open" && tab === "open" && items && <span data-testid="intake-open-count" className="rounded-full bg-accent-primary/20 px-1.5 py-0.5 text-11 font-semibold text-accent-primary">{items.length}</span>}
          </button>)}
        </div>
        <ul aria-label={t("intake.list")} className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
          {(items ?? []).map((item) => <ListRow key={item.id} item={item} selected={item.id === selectedId} onSelect={() => select(item.id)} />)}
        </ul>
      </div>
      {current ? <Detail key={current.id} action={action} workspaceId={workspaceId} item={current} index={index} count={items!.length} canDecide={canDecide}
        onMove={(delta) => select(items![index + delta]!.id)} onDecided={afterDecision} />
        : items?.length === 0
          ? <div className="grid min-w-0 flex-1 place-items-center">{tab === "open"
            ? <EmptyState title={t("intake.empty")} description={t("intake.emptyHint")} action={<button type="button" className={`${primaryButton} flex items-center gap-1.5`} onClick={() => setAdding(true)}><Plus aria-hidden size={14} />{t("intake.add")}</button>} />
            : <EmptyState title={t("intake.emptyClosed")} description={t("intake.emptyClosedHint")} />}</div>
          : <div className="grid min-w-0 flex-1 place-items-center p-6 text-14 text-secondary">{t("intake.pick")}</div>}
    </div>
    {adding && <SubmitModal action={action} projectId={projectId} onClose={() => setAdding(false)} onSubmitted={(item) => { setAdding(false); justAdded.current = item.id; select(item.id, "open"); void load(); }} />}
  </section>;
}
