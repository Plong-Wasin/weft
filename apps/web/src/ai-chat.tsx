import { api } from "./api";
import React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronRight, Copy, FilePlus, FileText, Globe, Pencil, RefreshCw, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { formatDate, translate } from "@weft/shared";
import { Link, useNavigate } from "react-router";
import { paths } from "./routes";
import { Markdown } from "./markdown";
import { DocPreview } from "./doc-preview";
import { chosenCards } from "./proposal-selection";
import { markdownTitle, markdownToDoc } from "../../../packages/actions/src/markdown-doc";
import { aiStatusKey, requestAiStatus } from "./ai-status";


export type Workspace = { id: string; slug: string; name?: string };
export type Recent = { id: string; title: string; updatedAt: string };

export async function post<T>(path: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${api}${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.ok ? await response.json() as T : null;
}

export const chatsKey = (workspaceId: string) => ["ai-chats", workspaceId] as const;
type SkillSummary = { id: string; name: string; description: string; scope: "personal" | "workspace" };

type Card = { id: string; action: string; input: Record<string, unknown>; status: "pending" | "confirmed" | "rejected" | "failed" | "expired" | "superseded"; expiresAt: string; error?: string };
type Diff = Array<{ field: string; before: unknown; after: unknown }>;

function proposalId(part: { output?: unknown }) {
  try { const value = JSON.parse(String(part.output)) as { confirmationId?: string }; return value.confirmationId ?? null; } catch { return null; }
}

const iconButton = "inline-flex size-7 items-center justify-center rounded-md border-0 bg-transparent p-0 text-tertiary hover:bg-layer-transparent-hover hover:text-primary";

type Decision = "confirm" | "reject";

/** One proposed Write action as a result card: its title, a preview of page content, and on request the exact input the Confirmation will run. A pending card can be selected and decided on its own. */
function ResultCard({ card, diff, selectable, selected, onSelect, onDecide, busy }: { card: Card; diff?: Diff; selectable?: boolean; selected?: boolean; onSelect?: (value: boolean) => void; onDecide?: (decision: Decision) => void; busy?: boolean }) {
  const input = card.input;
  const title = String(input.title ?? input.name ?? input.displayId ?? card.action);
  const pending = card.status === "pending";
  return <div data-status={card.status} className="rounded-lg border border-subtle bg-surface-1 px-4 py-3">
    <div className="flex items-center gap-3 text-14 text-primary">
      {pending && selectable && <input type="checkbox" checked={selected} onChange={(event) => onSelect?.(event.target.checked)} aria-label={`${translate("ai.selectCard")}: ${title}`} />}
      <FileText aria-hidden size={16} className="shrink-0 text-secondary" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="shrink-0 text-12 text-tertiary">{card.action}</span>
      {pending && onDecide && <span className="flex shrink-0 gap-1">
        <button type="button" disabled={busy} onClick={() => onDecide("confirm")} className="rounded-md bg-accent-primary px-2 py-0.5 text-13 font-medium text-white hover:bg-accent-primary-hover disabled:opacity-60">{translate("ai.confirm.confirm")}</button>
        <button type="button" disabled={busy} onClick={() => onDecide("reject")} className="secondary rounded-md border border-subtle bg-transparent px-2 py-0.5 text-13 text-secondary hover:bg-layer-transparent-hover disabled:opacity-60">{translate("ai.confirm.reject")}</button>
      </span>}
    </div>
    {diff && diff.length > 0 && <div role="alert" className="mt-2 text-13 text-danger-primary">
      <p>{translate("ai.confirm.changed")}</p>
      <ul>{diff.map((entry) => <li key={entry.field}>{entry.field}: {JSON.stringify(entry.before)} → {JSON.stringify(entry.after)}</li>)}</ul>
    </div>}
    {card.status !== "pending" && <p role="status" className="mt-2 text-13 text-secondary">{translate(`ai.confirm.${card.status}`)}{card.error ? `: ${card.error}` : ""}</p>}
    {input.content !== undefined && input.content !== null && typeof input.content === "object" && <details className="mt-1 text-13"><summary className="cursor-pointer text-tertiary">{translate("ai.preview")}</summary>
      <div className="mt-2 max-h-80 overflow-auto rounded-md border border-subtle p-3"><DocPreview doc={input.content} /></div></details>}
    <details className="mt-1 text-12 text-tertiary"><summary className="cursor-pointer">{translate("ai.details")}</summary>
      <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(card.input, null, 2)}</pre></details>
  </div>;
}

/**
 * All Write actions the assistant proposed in one answer. Each pending card can be approved or rejected on its own, or the user ticks several
 * and decides them together (for example 2 of 3). Cards left undecided stay pending until the user writes again, which supersedes them.
 * Each card still expires and re-validates on its own (ADR-0002).
 */
export function ProposalSet({ ids, refreshKey, onResolved }: { ids: string[]; refreshKey: number; onResolved?: () => void }) {
  const [cards, setCards] = React.useState<Record<string, Card>>({});
  const [diffs, setDiffs] = React.useState<Record<string, Diff>>({});
  const [unselected, setUnselected] = React.useState<Record<string, true>>({});
  const [busy, setBusy] = React.useState(false);
  const idsKey = ids.join(",");
  const reload = React.useCallback(async () => {
    const loaded = await Promise.all(ids.map((id) => post<Card>("/api/ai/confirmations/get", { id })));
    setCards(Object.fromEntries(loaded.filter((card): card is Card => card !== null).map((card) => [card.id, card])));
  }, [idsKey]);
  // A new user message supersedes older pending cards on the server, so reload whenever the conversation grows.
  React.useEffect(() => { void reload(); }, [reload, refreshKey]);
  const loaded = ids.map((id) => cards[id]).filter((card): card is Card => card !== undefined);
  if (loaded.length < ids.length) return <small role="status" className="text-tertiary">{translate("ai.loading")}</small>;
  const pending = loaded.filter((card) => card.status === "pending");
  const chosen = chosenCards(pending, unselected);
  async function decide(targets: Card[], decision: Decision) {
    setBusy(true);
    const changed: Record<string, Diff> = {};
    for (const card of targets) {
      if (decision === "reject") { await post<Card>("/api/ai/confirmations/reject", { id: card.id }); continue; }
      const outcome = await post<{ status: string; diff?: Diff }>("/api/ai/confirmations/confirm", { id: card.id, acknowledgeChanges: diffs[card.id] !== undefined });
      if (outcome?.status === "changed") changed[card.id] = outcome.diff ?? [];
    }
    setDiffs((previous) => { const next = { ...previous }; for (const card of targets) delete next[card.id]; return { ...next, ...changed }; });
    await reload();
    setBusy(false);
    onResolved?.();
  }
  const soonest = pending.map((card) => card.expiresAt).sort()[0];
  const acknowledged = chosen.some((card) => diffs[card.id] !== undefined);
  const several = pending.length > 1;
  return <div aria-label={translate("ai.confirm.card")} className="grid gap-2">
    {loaded.map((card) => <ResultCard key={card.id} card={card} diff={diffs[card.id]} selectable={several} selected={!unselected[card.id]} busy={busy}
      onSelect={(value) => setUnselected((previous) => { const next = { ...previous }; if (value) delete next[card.id]; else next[card.id] = true; return next; })}
      onDecide={several ? (decision) => void decide([card], decision) : undefined} />)}
    {pending.length > 0 && <div className="rounded-lg bg-layer-1 px-4 py-3">
      <p className="text-14 font-semibold text-primary">{translate("ai.awaiting")}</p>
      <p className="mb-2 text-14 text-secondary">{translate("ai.confirmPrompt")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || chosen.length === 0} onClick={() => void decide(chosen, "confirm")} className="rounded-md bg-accent-primary px-3 py-1 text-14 font-medium text-white hover:bg-accent-primary-hover disabled:opacity-60">{translate(acknowledged ? "ai.confirm.anyway" : several ? "ai.confirmSelected" : "ai.confirmAll")}{several && !acknowledged ? ` (${chosen.length}/${pending.length})` : ""}</button>
        <button type="button" disabled={busy || chosen.length === 0} onClick={() => void decide(chosen, "reject")} className="secondary rounded-md border border-subtle bg-transparent px-3 py-1 text-14 text-secondary hover:bg-layer-transparent-hover disabled:opacity-60">{translate(several ? "ai.rejectSelected" : "ai.rejectAll")}</button>
        <small className="text-tertiary">{translate("ai.confirm.expires")} {formatDate(soonest!)}</small>
      </div>
    </div>}
  </div>;
}

async function convertToPage(workspaceId: string, text: string): Promise<{ id: string } | null> {
  const title = markdownTitle(text) || translate("ai.untitledPage");
  const response = await fetch(`${api}/actions/create_wiki_page`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, title, content: markdownToDoc(text) }) });
  return response.ok ? await response.json() as { id: string } : null;
}

type Rating = "up" | "down" | null;

function AnswerActions({ text, workspace, onRegenerate }: { text: string; workspace: Workspace; onRegenerate?: () => void }) {
  const [copied, setCopied] = React.useState(false);
  const [rating, setRating] = React.useState<Rating>(null);
  const [converted, setConverted] = React.useState<"idle" | "busy" | "failed">("idle");
  const navigate = useNavigate();
  async function convert() {
    setConverted("busy");
    const page = await convertToPage(workspace.id, text);
    if (!page) { setConverted("failed"); return; }
    setConverted("idle");
    navigate(paths.wikiPage(workspace.slug, page.id));
  }
  return <div className="flex items-center gap-0.5">
    <button type="button" className={iconButton} aria-label={translate("ai.copy")} title={translate("ai.copy")} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}</button>
    <button type="button" className={iconButton} aria-pressed={rating === "up"} aria-label={translate("ai.thumbUp")} title={translate("ai.thumbUp")} onClick={() => setRating(rating === "up" ? null : "up")}><ThumbsUp aria-hidden size={14} className={rating === "up" ? "text-accent-primary" : ""} /></button>
    <button type="button" className={iconButton} aria-pressed={rating === "down"} aria-label={translate("ai.thumbDown")} title={translate("ai.thumbDown")} onClick={() => setRating(rating === "down" ? null : "down")}><ThumbsDown aria-hidden size={14} className={rating === "down" ? "text-accent-primary" : ""} /></button>
    {onRegenerate && <button type="button" className={iconButton} aria-label={translate("ai.regenerate")} title={translate("ai.regenerate")} onClick={onRegenerate}><RefreshCw aria-hidden size={14} /></button>}
    <button type="button" disabled={converted === "busy"} className={iconButton} aria-label={translate("ai.convert")} title={translate("ai.convert")} onClick={() => void convert()}><FilePlus aria-hidden size={14} /></button>
    {converted === "failed" && <span role="alert" className="ml-2 text-12 text-danger-primary">{translate("ai.convertFailed")}</span>}
  </div>;
}

export type SidecarContext = { type: "work_item" | "wiki_page"; id: string; title: string };

function Thoughts({ steps }: { steps: string[] }) {
  return <details className="group text-14 text-tertiary">
    <summary className="flex cursor-pointer list-none items-center gap-1"><span>{translate("ai.thoughts")}</span><ChevronRight aria-hidden size={12} className="transition-transform group-open:rotate-90" /></summary>
    <ul className="mt-1 grid gap-0.5 pl-1">{steps.map((step, index) => <li key={index} role="status">{translate("ai.thoughtsLookedUp")} {step}</li>)}</ul>
  </details>;
}

export type ChatMode = "ask" | "build";

/** The web pages a Web search answer cites, once per URL. Only http(s) links are shown. */
export function sourcesOf(message: UIMessage): { url: string; title: string }[] {
  const seen = new Set<string>();
  return message.parts.flatMap((part) => {
    if (part.type !== "source-url" || !/^https?:\/\//i.test(part.url) || seen.has(part.url)) return [];
    seen.add(part.url);
    return [{ url: part.url, title: part.title?.trim() || part.url }];
  });
}

function Sources({ sources }: { sources: { url: string; title: string }[] }) {
  return <div className="grid gap-1 text-13 text-secondary">
    <p className="m-0 font-medium">{translate("ai.sources")}</p>
    <ul className="m-0 grid list-none gap-0.5 p-0">
      {sources.map((source) => <li key={source.url} className="truncate"><a href={source.url} target="_blank" rel="noreferrer noopener" className="text-accent-primary hover:underline">{source.title}</a></li>)}
    </ul>
  </div>;
}

export function Conversation({ workspace, chatId, initial, initialMode = "build", onSent, context }: { workspace: Workspace; chatId: string; initial: UIMessage[]; initialMode?: ChatMode; onSent: () => void; context?: SidecarContext }) {
  const [input, setInput] = React.useState("");
  const [selectedSkill, setSelectedSkill] = React.useState<SkillSummary | null>(null);
  const [skills, setSkills] = React.useState<SkillSummary[]>([]);
  const [mode, setMode] = React.useState<ChatMode>(initialMode);
  // Web search is off in every new chat; the switch only appears when the server offers it (ADR 0008).
  const [webSearch, setWebSearch] = React.useState(false);
  const { data: aiStatus } = useQuery({ queryKey: aiStatusKey(workspace.id), queryFn: () => requestAiStatus(workspace.id), staleTime: 60_000 });
  const canSearchWeb = aiStatus?.webSearch === true;
  const queryClient = useQueryClient();
  const transport = React.useMemo(() => new DefaultChatTransport({
    api: `${api}/api/ai/chat`,
    credentials: "include",
    // The server keeps the history; only the newest message and the chat id travel.
    prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, workspaceId: workspace.id, messages: messages.slice(-1), mode, ...(canSearchWeb && webSearch ? { webSearch: true } : {}), ...(selectedSkill ? { skillId: selectedSkill.id } : {}), ...(context ? { context } : {}) } }),
  }), [workspace.id, mode, canSearchWeb, webSearch, selectedSkill?.id, context?.type, context?.id, context?.title]);
  const { messages, sendMessage, status, error } = useChat({ id: chatId, messages: initial, transport, onFinish: () => { setSelectedSkill(null); void queryClient.invalidateQueries({ queryKey: chatsKey(workspace.id) }); onSent(); } });
  const busy = status === "submitted" || status === "streaming";
  React.useEffect(() => { let active = true; void post<SkillSummary[]>("/actions/list_skills", { workspaceId: workspace.id }).then((items) => { if (active) setSkills(items ?? []); }); return () => { active = false; }; }, [workspace.id]);
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }); }, [messages]);
  const textOf = (message: UIMessage) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n");
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const slash = input.match(/(?:^|\s)\/([^\s/]*)$/);
  const matchingSkills = slash ? skills.filter((skill) => skill.name.includes(slash[1]!.toLowerCase())) : [];
  function pickSkill(skill: SkillSummary) { setSelectedSkill(skill); setInput((value) => value.replace(/(?:^|\s)\/[^\s/]*$/, " ").trimStart()); }
  function send(text: string) { if (!text.trim() || busy) return; void sendMessage({ text }); }
  const pill = context ? context.title : workspace.name ?? workspace.slug;
  return <section aria-label={translate("ai.chat")} className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <ol aria-live="polite" className="mx-auto flex max-w-3xl list-none flex-col gap-6 p-0">
        {messages.map((message, index) => {
          if (message.role === "user") return <li key={message.id} data-role="user" className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl bg-layer-2 px-4 py-3 text-16 text-primary"><p className="whitespace-pre-wrap">{textOf(message)}</p>{message.parts.filter((part) => part.type === "data-skill").map((part, i) => { const data = (part as { data?: { name?: string } }).data; return <span key={i} className="mt-2 inline-flex rounded-md border border-subtle px-2 py-0.5 text-12">/{data?.name}</span>; })}</div>
          </li>;
          const steps = message.parts.flatMap((part) => part.type.startsWith("tool-") && !proposalId(part as { output?: unknown }) ? [part.type.slice(5)] : []);
          const ids = message.parts.flatMap((part) => { const id = part.type.startsWith("tool-") ? proposalId(part as { output?: unknown }) : null; return id ? [id] : []; });
          const sources = sourcesOf(message);
          const text = textOf(message);
          const last = index === messages.length - 1;
          return <li key={message.id} data-role="assistant" className="grid gap-3">
            {steps.length > 0 && <Thoughts steps={steps} />}
            {message.parts.map((part, partIndex) => part.type === "text" ? <Markdown key={partIndex} text={part.text} /> : null)}
            {sources.length > 0 && <Sources sources={sources} />}
            {ids.length > 0 && <ProposalSet ids={ids} refreshKey={messages.length} />}
            {text && !(last && busy) && <AnswerActions text={text} workspace={workspace} onRegenerate={last && lastUser ? () => send(textOf(lastUser)) : undefined} />}
          </li>;
        })}
        <div ref={endRef} />
      </ol>
    </div>
    {error && <p role="alert" className="px-4 text-14 text-danger-primary">{translate(error.message.includes("rate_limited") ? "ai.rateLimited" : "ai.failed")}</p>}
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <form onSubmit={(event) => { event.preventDefault(); const text = input.trim(); if (!text || busy) return; setInput(""); send(text); }} className="rounded-xl border border-subtle bg-surface-1 p-3 shadow-sm">
        <span title={translate("ai.contextPill")} className="mb-2 flex w-fit max-w-full items-center gap-1.5 truncate rounded-md border border-subtle px-2 py-1 text-14 text-primary">{pill}</span>
        <label className="sr-only" htmlFor={`composer-${chatId}`}>{translate("ai.message")}</label>
        {selectedSkill && <button type="button" onClick={() => setSelectedSkill(null)} className="mb-2 inline-flex rounded-md border border-subtle px-2 py-1 text-13 text-primary">/{selectedSkill.name} · {translate(selectedSkill.scope === "personal" ? "skills.personal" : "skills.workspace")} ×</button>}
        {slash && <div role="listbox" aria-label={translate("skills.picker")} className="mb-2 max-h-44 overflow-auto rounded-md border border-subtle bg-surface-1">{matchingSkills.map((skill) => <button key={skill.id} type="button" role="option" onClick={() => pickSkill(skill)} className="flex w-full items-center justify-between px-3 py-2 text-left text-14 hover:bg-layer-1"><span>/{skill.name}</span><span className="text-12 text-tertiary">{translate(skill.scope === "personal" ? "skills.personal" : "skills.workspace")}</span></button>)}{matchingSkills.length === 0 && <p className="px-3 py-2 text-13 text-tertiary">{translate("skills.empty")}</p>}</div>}
        <textarea id={`composer-${chatId}`} value={input} placeholder={translate("ai.placeholder")} rows={2} onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          className="block w-full resize-none border-0 bg-transparent p-0 text-16 text-primary outline-none placeholder:text-placeholder" />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <select value={mode} onChange={(event) => setMode(event.target.value as ChatMode)} aria-label={translate("ai.mode")} title={translate("ai.mode")} className="rounded-md border border-subtle bg-surface-1 px-2 py-1 text-14 text-primary">
              <option value="ask">{translate("ai.mode.ask")}</option>
              <option value="build">{translate("ai.mode.build")}</option>
            </select>
            {canSearchWeb && <button type="button" aria-pressed={webSearch} aria-label={translate("ai.webSearch")} title={translate(webSearch ? "ai.webSearch.on" : "ai.webSearch.off")} onClick={() => setWebSearch(!webSearch)} className={`inline-flex size-8 items-center justify-center rounded-lg border p-0 ${webSearch ? "border-accent-primary bg-accent-primary/10 text-accent-primary" : "border-subtle bg-surface-1 text-secondary"}`}><Globe aria-hidden size={16} /></button>}
          </div>
          <button type="submit" aria-label={translate("ai.send")} title={translate("ai.send")} disabled={busy || input.trim() === ""} className="inline-flex size-8 items-center justify-center rounded-lg border-0 bg-accent-primary p-0 text-white hover:bg-accent-primary-hover disabled:opacity-50"><ArrowUp aria-hidden size={16} /></button>
        </div>
      </form>
      <p className="py-2 text-center text-12 text-tertiary">{translate("ai.disclaimer")}</p>
    </div>
  </section>;
}

/** The AI sidebar: New chat, search and Recents with rename and delete. Chats are private to the signed-in user. */
export function AiSidebar({ workspace, activeId }: { workspace: Workspace; activeId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [renaming, setRenaming] = React.useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const { data: recents = [] } = useQuery({ queryKey: chatsKey(workspace.id), queryFn: async () => await post<Recent[]>("/api/ai/chats", { workspaceId: workspace.id }) ?? [] });
  const refresh = () => queryClient.invalidateQueries({ queryKey: chatsKey(workspace.id) });
  const shown = recents.filter((chat) => chat.title.toLowerCase().includes(query.trim().toLowerCase()));
  async function saveRename() {
    if (!renaming || !renaming.title.trim()) return;
    await post("/api/ai/chats/rename", { chatId: renaming.id, title: renaming.title });
    setRenaming(null);
    await refresh();
  }
  async function remove(id: string) {
    await post("/api/ai/chats/delete", { chatId: id });
    setDeleting(null);
    await refresh();
    if (id === activeId) navigate(paths.ai(workspace.slug));
  }
  return <div className="flex min-h-0 flex-col gap-2">
    <div className="flex items-center gap-2">
      <Link to={paths.ai(workspace.slug)} className="flex flex-1 items-center gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-1.5 text-14 text-primary hover:bg-layer-transparent-hover"><Pencil aria-hidden size={14} />{translate("ai.new")}</Link>
      <button type="button" aria-label={translate("ai.search")} title={translate("ai.search")} aria-pressed={searching} onClick={() => { setSearching(!searching); setQuery(""); }} className="inline-flex size-8 items-center justify-center rounded-md border border-subtle bg-surface-1 p-0 text-secondary hover:bg-layer-transparent-hover"><SearchIcon /></button>
    </div>
    {searching && <input type="search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={translate("ai.searchPlaceholder")} aria-label={translate("ai.search")} className="rounded-md border border-subtle bg-surface-1 px-2.5 py-1.5 text-14 text-primary" />}
    <nav aria-label={translate("ai.recents")} className="min-h-0 overflow-y-auto">
      <p className="px-2.5 pb-1 pt-2 text-14 text-tertiary">{translate("ai.recentsHeading")}</p>
      {recents.length === 0 ? <p className="px-2.5 text-14 text-tertiary">{translate("ai.noRecents")}</p>
        : shown.length === 0 ? <p className="px-2.5 text-14 text-tertiary">{translate("ai.noMatches")}</p>
        : <ul className="grid gap-0.5">{shown.map((chat) => <li key={chat.id} className={`group rounded-md ${chat.id === activeId ? "bg-layer-1-selected" : "hover:bg-layer-transparent-hover"}`}>
          {renaming?.id === chat.id
            ? <form className="flex items-center gap-1 p-1" onSubmit={(event) => { event.preventDefault(); void saveRename(); }}>
              <input autoFocus value={renaming.title} onChange={(event) => setRenaming({ id: chat.id, title: event.target.value })} aria-label={translate("ai.rename")} className="min-w-0 flex-1 rounded border border-subtle bg-surface-1 px-1.5 py-0.5 text-14" />
              <button type="submit" className="rounded px-1.5 py-0.5 text-13 text-accent-primary">{translate("ai.renameSave")}</button>
              <button type="button" onClick={() => setRenaming(null)} className="secondary rounded px-1.5 py-0.5 text-13">{translate("ai.cancel")}</button>
            </form>
            : deleting === chat.id
              ? <div className="flex items-center gap-1 px-2 py-1.5 text-13"><span className="flex-1 truncate">{translate("ai.deleteConfirm")}</span>
                <button type="button" onClick={() => void remove(chat.id)} className="rounded bg-danger-primary px-1.5 py-0.5 text-13 text-white">{translate("ai.deleteYes")}</button>
                <button type="button" onClick={() => setDeleting(null)} className="secondary rounded px-1.5 py-0.5 text-13">{translate("ai.cancel")}</button></div>
              : <div className="flex items-center">
                <Link to={paths.aiChat(workspace.slug, chat.id)} aria-current={chat.id === activeId ? "page" : undefined} className="min-w-0 flex-1 truncate px-2.5 py-1.5 text-14 text-primary">{chat.title}</Link>
                <span className="flex pr-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
                  <button type="button" className={iconButton} aria-label={`${translate("ai.rename")}: ${chat.title}`} onClick={() => setRenaming({ id: chat.id, title: chat.title })}><Pencil aria-hidden size={13} /></button>
                  <button type="button" className={iconButton} aria-label={`${translate("ai.delete")}: ${chat.title}`} onClick={() => setDeleting(chat.id)}><Trash2 aria-hidden size={13} /></button>
                </span></div>}
        </li>)}</ul>}
    </nav>
  </div>;
}

function SearchIcon() {
  return <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
}

/** The AI chat page: the open conversation. The sidebar (AiSidebar) lists the chats. */
export function AiChatPage({ workspace, chatId }: { workspace: Workspace; chatId: string }) {
  const [initial, setInitial] = React.useState<UIMessage[] | null>(chatId ? null : []);
  const [initialMode, setInitialMode] = React.useState<ChatMode>("build");
  const [draftId, setDraftId] = React.useState(() => crypto.randomUUID());
  const [found, setFound] = React.useState(true);
  React.useEffect(() => {
    if (!chatId) { setInitial([]); setInitialMode("build"); setDraftId(crypto.randomUUID()); return; }
    setInitial(null);
    setFound(true);
    void post<{ messages: UIMessage[]; mode?: ChatMode }>("/api/ai/chats/get", { chatId }).then((chat) => { setFound(chat !== null); setInitialMode(chat?.mode ?? "build"); setInitial(chat?.messages ?? []); });
  }, [chatId]);
  const activeId = chatId || draftId;
  return <section className="-m-[var(--padding-page-x)] flex h-[calc(100%+2*var(--padding-page-x))] flex-col">
    <header className="border-b border-subtle px-4 py-3"><h1 className="m-0 text-16 font-medium text-primary">{translate("ai.heading")}</h1></header>
    {initial === null ? <p role="status" className="p-4 text-secondary">{translate("ai.loading")}</p>
      : !found ? <p role="alert" className="p-4 text-secondary">{translate("ai.noMatches")}</p>
      : <Conversation key={activeId} workspace={workspace} chatId={activeId} initial={initial} initialMode={initialMode} onSent={() => undefined} />}
  </section>;
}
