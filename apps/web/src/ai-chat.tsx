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

function Conversation({ workspace, chatId, initial, onSent }: { workspace: Workspace; chatId: string; initial: UIMessage[]; onSent: () => void }) {
  const [input, setInput] = React.useState("");
  const transport = React.useMemo(() => new DefaultChatTransport({
    api: `${api}/api/ai/chat`,
    credentials: "include",
    // The server keeps the history; only the newest message and the chat id travel.
    prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, workspaceId: workspace.id, messages: messages.slice(-1) } }),
  }), [workspace.id]);
  const { messages, sendMessage, status, error } = useChat({ id: chatId, messages: initial, transport, onFinish: onSent });
  const busy = status === "submitted" || status === "streaming";
  return <section aria-label={translate("ai.chat")}>
    <ol aria-live="polite" style={{ listStyle: "none", padding: 0 }}>
      {messages.map((message) => <li key={message.id} data-role={message.role}>
        <strong>{translate(message.role === "user" ? "ai.you" : "ai.assistant")}</strong>
        {message.parts.map((part, index) => part.type === "text" ? <p key={index} style={{ whiteSpace: "pre-wrap" }}>{part.text}</p>
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
