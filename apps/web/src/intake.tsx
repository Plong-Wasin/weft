import React from "react";
import { formatDate, translate, type MessageKey } from "@weft/shared";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
const outcomes = ["pending", "snoozed", "accepted", "rejected", "duplicate"] as const;
type Outcome = (typeof outcomes)[number];
type IntakeItem = {
  id: string; displayId: string; title: string; descriptionText: string; outcome: Outcome; snoozedTill: string | null;
  duplicateToDisplayId: string | null; createdByName: string;
};
const t = (key: string) => translate(key as MessageKey);

function SubmitForm({ action, projectId, onSubmitted }: { action: Call; projectId: string; onSubmitted: () => void }) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  return <form onSubmit={async (event) => {
    event.preventDefault();
    const doc = description.trim() ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: description.trim() }] }] } : undefined;
    const saved = await action("submit_intake_item", { projectId, title, ...(doc ? { description: doc } : {}) });
    setNote(saved ? null : t("intake.submitFailed"));
    if (saved) { setTitle(""); setDescription(""); onSubmitted(); }
  }}>
    <h4>{t("intake.submitTitle")}</h4>
    <label>{t("intake.titleField")}<input required maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>{t("intake.descriptionField")}<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <button>{t("intake.submit")}</button>
    {note && <p role="alert">{note}</p>}
  </form>;
}

function Decisions({ action, workspaceId, item, onDecided }: { action: Call; workspaceId: string; item: IntakeItem; onDecided: () => void }) {
  const [till, setTill] = React.useState("");
  const [original, setOriginal] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const run = async (name: string, body: Record<string, unknown>) => {
    const done = await action(name, { intakeItemId: item.id, ...body });
    setNote(done ? null : t("intake.failed"));
    if (done) onDecided();
  };
  return <div>
    <button onClick={() => void run("accept_intake_item", {})}>{t("intake.accept")}</button>{" "}
    <button className="secondary" onClick={() => void run("reject_intake_item", {})}>{t("intake.reject")}</button>{" "}
    <label>{t("intake.snoozeTill")}<input type="datetime-local" value={till} onChange={(event) => setTill(event.target.value)} /></label>{" "}
    <button className="secondary" disabled={!till} onClick={() => void run("snooze_intake_item", { snoozedTill: new Date(till).toISOString() })}>{t("intake.snooze")}</button>{" "}
    <DuplicatePicker action={action} workspaceId={workspaceId} value={original} onChange={setOriginal} onSubmit={(workItemId) => void run("duplicate_intake_item", { duplicateTo: workItemId })} item={item} />
    {note && <p role="alert">{note}</p>}
  </div>;
}

/** Picks the original by display id (for example MOB-1) and resolves it through search. */
function DuplicatePicker({ action, workspaceId, value, onChange, onSubmit, item }: { action: Call; workspaceId: string; value: string; onChange: (value: string) => void; onSubmit: (workItemId: string) => void; item: IntakeItem }) {
  const [failed, setFailed] = React.useState(false);
  return <span>
    <label>{t("intake.duplicateTo")}<input value={value} onChange={(event) => onChange(event.target.value)} /></label>{" "}
    <button className="secondary" disabled={!value.trim()} onClick={async () => {
      const key = item.displayId.split("-")[0]!;
      const found = await action<Array<{ id: string; displayId: string }>>("search_work_items", { workspaceId: workspaceId, query: value.trim() });
      const match = found?.find((row) => row.displayId.toLowerCase() === value.trim().toLowerCase() && row.displayId.startsWith(`${key}-`));
      setFailed(!match);
      if (match) onSubmit(match.id);
    }}>{t("intake.markDuplicate")}</button>
    {failed && <small role="alert">{t("intake.failed")}</small>}
  </span>;
}

export function IntakePage({ workspaceId, workspaceSlug, projectKey, projectId, canDecide, enabled, action }: { workspaceId: string; workspaceSlug: string; projectKey: string; projectId: string; canDecide: boolean; enabled: boolean; action: Call }) {
  const [tab, setTab] = React.useState<Outcome>("pending");
  const [items, setItems] = React.useState<IntakeItem[] | null>(null);
  const load = React.useCallback(async () => setItems(enabled ? await action<IntakeItem[]>("list_intake_items", { projectId, outcome: tab }) : null), [action, projectId, enabled, tab]);
  React.useEffect(() => { void load(); }, [load]);
  if (!enabled) return <section><p role="status">{t("intake.off")}</p></section>;
  return <section>
    <a href={`/${workspaceSlug}/projects/${projectKey}`}>{t("intake.back")}</a>
    <h3>{t("intake.title")}</h3>
    <div role="tablist">{outcomes.map((outcome) => <button key={outcome} role="tab" aria-selected={tab === outcome} className={tab === outcome ? undefined : "secondary"} onClick={() => setTab(outcome)}>{t(`intake.tab.${outcome}`)}</button>)}</div>
    {items?.length === 0 && <p>{t("intake.empty")}</p>}
    <ul>{(items ?? []).map((item) => <li key={item.id} data-testid={`intake-${item.displayId}`}>
      <strong>{item.displayId} {item.title}</strong> <small>{t("intake.by").replace("{name}", item.createdByName)}</small>
      {item.descriptionText && <p>{item.descriptionText}</p>}
      {item.outcome === "snoozed" && item.snoozedTill && <small>{t("intake.snoozedTill").replace("{date}", formatDate(item.snoozedTill))}</small>}
      {item.outcome === "duplicate" && item.duplicateToDisplayId && <small>{t("intake.duplicateOf").replace("{id}", item.duplicateToDisplayId)}</small>}
      {canDecide && (item.outcome === "pending" || item.outcome === "snoozed") && <Decisions action={action} workspaceId={workspaceId} item={item} onDecided={() => void load()} />}
    </li>)}</ul>
    <SubmitForm action={action} projectId={projectId} onSubmitted={() => void load()} />
  </section>;
}
