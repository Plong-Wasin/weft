import React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { translate } from "@weft/shared";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type Workspace = { id: string; slug: string };
type Recent = { id: string; title: string; updatedAt: string };

async function post<T>(path: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${api}${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.ok ? await response.json() as T : null;
}

type Card = { id: string; action: string; input: Record<string, unknown>; status: "pending" | "confirmed" | "rejected" | "failed" | "expired"; expiresAt: string; error?: string };
type Diff = Array<{ field: string; before: unknown; after: unknown }>;

/** The Confirmation card for one proposed Write action: shows the exact input and runs nothing until the user confirms. */
function ConfirmationCard({ id }: { id: string }) {
  const [card, setCard] = React.useState<Card | null>(null);
  const [diff, setDiff] = React.useState<Diff | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { void post<Card>("/api/ai/confirmations/get", { id }).then(setCard); }, [id]);
  if (!card) return <small role="status">{translate("ai.loading")}</small>;
  async function confirm(acknowledgeChanges: boolean) {
    setBusy(true);
    const outcome = await post<{ status: string; diff?: Diff; error?: string }>("/api/ai/confirmations/confirm", { id, acknowledgeChanges });
    if (outcome?.status === "changed") setDiff(outcome.diff ?? []);
    else { setDiff(null); setCard(await post<Card>("/api/ai/confirmations/get", { id })); }
    setBusy(false);
  }
  async function reject() { setBusy(true); setCard(await post<Card>("/api/ai/confirmations/reject", { id })); setBusy(false); }
  return <aside aria-label={translate("ai.confirm.card")} data-status={card.status} style={{ border: "1px solid currentColor", padding: "0.5rem", margin: "0.5rem 0" }}>
    <strong>{translate("ai.confirm.title")}: {card.action}</strong>
    <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(card.input, null, 2)}</pre>
    {diff && <div role="alert">
      <p>{translate("ai.confirm.changed")}</p>
      <ul>{diff.map((entry) => <li key={entry.field}>{entry.field}: {JSON.stringify(entry.before)} → {JSON.stringify(entry.after)}</li>)}</ul>
    </div>}
    {card.status === "pending"
      ? <div>
        <button type="button" disabled={busy} onClick={() => void confirm(diff !== null)}>{translate(diff ? "ai.confirm.anyway" : "ai.confirm.confirm")}</button>
        <button type="button" disabled={busy} onClick={() => void reject()}>{translate("ai.confirm.reject")}</button>
        <small> {translate("ai.confirm.expires")} {new Date(card.expiresAt).toLocaleString()}</small>
      </div>
      : <p role="status">{translate(`ai.confirm.${card.status}`)}{card.error ? `: ${card.error}` : ""}</p>}
  </aside>;
}

function proposalId(part: { output?: unknown }) {
  try { const value = JSON.parse(String(part.output)) as { confirmationId?: string }; return value.confirmationId ?? null; } catch { return null; }
}

export type SidecarContext = { type: "work_item" | "wiki_page"; id: string; title: string };

export function Conversation({ workspace, chatId, initial, onSent, context }: { workspace: Workspace; chatId: string; initial: UIMessage[]; onSent: () => void; context?: SidecarContext }) {
  const [input, setInput] = React.useState("");
  const transport = React.useMemo(() => new DefaultChatTransport({
    api: `${api}/api/ai/chat`,
    credentials: "include",
    // The server keeps the history; only the newest message and the chat id travel.
    prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, workspaceId: workspace.id, messages: messages.slice(-1), ...(context ? { context } : {}) } }),
  }), [workspace.id, context?.type, context?.id, context?.title]);
  const { messages, sendMessage, status, error } = useChat({ id: chatId, messages: initial, transport, onFinish: onSent });
  const busy = status === "submitted" || status === "streaming";
  return <section aria-label={translate("ai.chat")}>
    <ol aria-live="polite" style={{ listStyle: "none", padding: 0 }}>
      {messages.map((message) => <li key={message.id} data-role={message.role}>
        <strong>{translate(message.role === "user" ? "ai.you" : "ai.assistant")}</strong>
        {message.parts.map((part, index) => part.type === "text" ? <p key={index} style={{ whiteSpace: "pre-wrap" }}>{part.text}</p>
          : part.type.startsWith("tool-") && proposalId(part as { output?: unknown }) ? <ConfirmationCard key={index} id={proposalId(part as { output?: unknown })!} />
          : part.type.startsWith("tool-") ? <small key={index} role="status">{translate("ai.lookedUp")} {part.type.slice(5)}</small> : null)}
      </li>)}
    </ol>
    {error && <p role="alert">{translate("ai.failed")}</p>}
    <form onSubmit={(event) => { event.preventDefault(); const text = input.trim(); if (!text || busy) return; setInput(""); void sendMessage({ text }); }}>
      <label>{translate("ai.message")}<textarea value={input} onChange={(event) => setInput(event.target.value)} rows={3} /></label>
      <button type="submit" disabled={busy || input.trim() === ""}>{translate("ai.send")}</button>
    </form>
  </section>;
}

/** The AI chat page: recents on the left, the open conversation on the right. Chats are private to the signed-in user. */
export function AiChatPage({ workspace, chatId }: { workspace: Workspace; chatId: string }) {
  const [recents, setRecents] = React.useState<Recent[]>([]);
  const [initial, setInitial] = React.useState<UIMessage[] | null>(chatId ? null : []);
  const [draftId] = React.useState(() => crypto.randomUUID());
  const loadRecents = React.useCallback(async () => setRecents(await post<Recent[]>("/api/ai/chats", { workspaceId: workspace.id }) ?? []), [workspace.id]);
  React.useEffect(() => { void loadRecents(); }, [loadRecents]);
  React.useEffect(() => {
    if (!chatId) { setInitial([]); return; }
    setInitial(null);
    void post<{ messages: UIMessage[] }>("/api/ai/chats/get", { chatId }).then((chat) => setInitial(chat?.messages ?? []));
  }, [chatId]);
  const activeId = chatId || draftId;
  return <section style={{ display: "grid", gridTemplateColumns: "16rem 1fr", gap: "1rem" }}>
    <nav aria-label={translate("ai.recents")}>
      <h2>{translate("ai.title")}</h2>
      <a href={`/${workspace.slug}/ai`}>{translate("ai.new")}</a>
      {recents.length === 0 ? <p>{translate("ai.noRecents")}</p> : <ul>{recents.map((chat) => <li key={chat.id}>
        <a href={`/${workspace.slug}/ai/${chat.id}`} aria-current={chat.id === chatId ? "page" : undefined}>{chat.title}</a></li>)}</ul>}
    </nav>
    {initial === null ? <p role="status">{translate("ai.loading")}</p>
      : <Conversation key={activeId} workspace={workspace} chatId={activeId} initial={initial} onSent={() => void loadRecents()} />}
  </section>;
}
