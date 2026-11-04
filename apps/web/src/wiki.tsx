import { api, liveUrl } from "./api";
import { SidecarTrigger } from "./sidecar";
import React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { Mention, wikiEditorExtensions } from "../../../packages/actions/src/wiki-editor-extensions";
import type { SuggestionProps } from "@tiptap/suggestion";
import { formatDate, translate, translateDynamic, type MessageKey } from "@weft/shared";
import { useAssetImages } from "./asset-images";
import { AssistMenu } from "./assist-menu";
import { AiAssist } from "./editor-assist";
import { EditorPlaceholder, SafeLinkClick, SlashMenu, wikiCommands } from "./editor-extensions";
import { Link } from "react-router";
import { MoreHorizontal, Bold, Code, SquareCode, FileText, Heart, Italic, List, ListOrdered, Lock, Quote, Strikethrough, Globe, ChevronRight, Plus, Archive, ArchiveRestore } from "lucide-react";
import { paths } from "./routes";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toMarkdown } from "./wiki-export";
import { Popover, menuItemClass } from "./shell/popover";
import { Dialog, DialogActions } from "./dialog";

const heartbeatMs = 20_000;
const autosaveMs = 1_500;
const live = liveUrl(import.meta.env.VITE_LIVE_URL, window.location);
const favoritesKey = (workspaceId: string) => ["favorite-wiki-pages", workspaceId] as const;

export type Summary = { id: string; archived: boolean; projectId?: string | null; collectionId?: string | null; parentId: string | null; title: string; access: "public" | "private"; ownerId: string; ownerName?: string | null; createdAt: string; updatedAt: string };
type Page = Summary & { content: unknown; canEdit: boolean; canArchive?: boolean };
type Member = { userId: string; name: string };
type Version = { id: string; title: string; createdAt: string };

async function call<T>(name: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.ok ? await response.json() as T : null;
}


type Tools = ReturnType<typeof useEditor>;
type MentionProps = SuggestionProps<{ id: string; label: string }, { id: string; label: string }>;

function pageMentions(people: React.RefObject<Member[]>) {
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: {
      char: "@",
      items: ({ query }: { query: string }) => (people.current ?? []).filter((person) => person.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 8).map(({ userId, name }) => ({ id: userId, label: name })),
      render: () => {
        let box: HTMLUListElement | null = null;
        let selected = 0;
        let current: { items: Array<{ id: string; label: string }>; command: (item: { id: string; label: string }) => void } | null = null;
        const paint = () => {
          if (!box || !current) return;
          box.replaceChildren(...current.items.map((item, index) => {
            const option = document.createElement("li"); option.textContent = item.label; option.setAttribute("role", "option");
            option.style.fontWeight = index === selected ? "bold" : "normal";
            option.onmousedown = (event) => { event.preventDefault(); current?.command(item); };
            return option;
          }));
        };
        const place = (rect?: (() => DOMRect | null) | null) => { const bounds = rect?.(); if (box && bounds) { box.style.left = `${bounds.left + window.scrollX}px`; box.style.top = `${bounds.bottom + window.scrollY}px`; } };
        return {
          onStart: (props: MentionProps) => { current = props; selected = 0; box = document.createElement("ul"); box.setAttribute("role", "listbox"); box.setAttribute("aria-label", translate("wiki.mentionMembers")); box.style.cssText = "position:absolute;background:var(--bg-surface-1);color:var(--txt-primary);border:1px solid var(--border-strong);border-radius:.375rem;box-shadow:0 4px 12px rgb(0 0 0/.12);margin:0;padding:4px;list-style:none;z-index:50"; document.body.append(box); paint(); place(props.clientRect); },
          onUpdate: (props: MentionProps) => { current = props; selected = 0; paint(); place(props.clientRect); },
          onKeyDown: ({ event }: { event: KeyboardEvent }) => { if (!current || current.items.length === 0) return false; if (event.key === "ArrowDown") { selected = (selected + 1) % current.items.length; paint(); return true; } if (event.key === "ArrowUp") { selected = (selected + current.items.length - 1) % current.items.length; paint(); return true; } if (event.key === "Enter") { current.command(current.items[selected]!); return true; } return false; },
          onExit: () => { box?.remove(); box = null; current = null; },
        };
      },
    },
  });
}
const toolbarButtons = [
  { key: "bold", icon: Bold, label: "wiki.tool.bold", run: (e: NonNullable<Tools>) => e.chain().focus().toggleBold().run() },
  { key: "italic", icon: Italic, label: "wiki.tool.italic", run: (e: NonNullable<Tools>) => e.chain().focus().toggleItalic().run() },
  { key: "strike", icon: Strikethrough, label: "wiki.tool.strike", run: (e: NonNullable<Tools>) => e.chain().focus().toggleStrike().run() },
  { key: "code", icon: Code, label: "wiki.tool.code", run: (e: NonNullable<Tools>) => e.chain().focus().toggleCode().run() },
  { key: "bulletList", icon: List, label: "wiki.tool.bulletList", run: (e: NonNullable<Tools>) => e.chain().focus().toggleBulletList().run() },
  { key: "orderedList", icon: ListOrdered, label: "wiki.tool.orderedList", run: (e: NonNullable<Tools>) => e.chain().focus().toggleOrderedList().run() },
  { key: "blockquote", icon: Quote, label: "wiki.tool.quote", run: (e: NonNullable<Tools>) => e.chain().focus().toggleBlockquote().run() },
  { key: "codeBlock", icon: SquareCode, label: "wiki.tool.codeBlock", run: (e: NonNullable<Tools>) => e.chain().focus().toggleCodeBlock().run() },
] as const;

/** Rich-text toolbar above the editor: block type, marks and lists. */
function Toolbar({ editor, disabled }: { editor: Tools; disabled: boolean }) {
  const [, rerender] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => { editor?.on("transaction", rerender); return () => { editor?.off("transaction", rerender); }; }, [editor]);
  if (!editor) return null;
  const block = editor.isActive("heading", { level: 1 }) ? "1" : editor.isActive("heading", { level: 2 }) ? "2" : editor.isActive("heading", { level: 3 }) ? "3" : "0";
  return <div role="toolbar" aria-label={translate("wiki.toolbar")} className="sticky top-0 z-[1] flex flex-wrap items-center gap-0.5 rounded-md border border-subtle bg-surface-1 p-1">
    <select aria-label={translate("wiki.tool.blockType")} disabled={disabled} value={block} className="h-7 rounded-md border-0 bg-transparent px-1 text-13 text-secondary"
      onChange={(event) => { const level = Number(event.target.value); const chain = editor.chain().focus(); if (level === 0) chain.setParagraph().run(); else chain.setHeading({ level: level as 1 | 2 | 3 }).run(); }}>
      <option value="0">{translate("wiki.tool.text")}</option>
      {[1, 2, 3].map((level) => <option key={level} value={level}>{translate(`wiki.tool.h${level}` as MessageKey)}</option>)}
    </select>
    {toolbarButtons.map((tool) => <button key={tool.key} type="button" disabled={disabled} aria-label={translate(tool.label)} title={translate(tool.label)} aria-pressed={editor.isActive(tool.key)}
      onClick={() => tool.run(editor)} className={`grid size-7 place-items-center rounded-md border-0 p-0 text-secondary hover:bg-layer-transparent-hover ${editor.isActive(tool.key) ? "bg-layer-1-selected text-primary" : "bg-transparent"}`}><tool.icon aria-hidden size={14} /></button>)}
  </div>;
}

type ActivityRow = { id: string; field: string; actorName: string; source: string; createdAt: string; newValue: unknown; oldValue: unknown };
/** Page activity: the append-only log of changes to this page. */
function Activity({ pageId, refresh }: { pageId: string; refresh: string }) {
  const [rows, setRows] = React.useState<ActivityRow[]>([]);
  React.useEffect(() => { void call<ActivityRow[]>("list_wiki_page_activities", { pageId }).then((result) => setRows(result ?? [])); }, [pageId, refresh]);
  return <section aria-label={translate("wiki.activity")}>
    <ul className="m-0 grid list-none gap-2 p-0 text-13 text-secondary">{rows.map((row) => <li key={row.id} className="grid gap-0.5"><span><strong className="font-medium text-primary">{row.actorName}</strong> {translateDynamic(`wiki.activity.${row.field}`) ?? row.field}</span><small className="text-12 text-tertiary">{row.source ? `${translate("workItems.via").replace("{source}", translateDynamic(`activity.source.${row.source}`) ?? row.source)} · ` : ""}{formatDate(row.createdAt)}</small></li>)}</ul>
  </section>;
}
type PaneTab = "info" | "outline" | "comments" | "activity";
function Editor({ workspaceId, page, self, onChanged, info, insideProject = false }: { workspaceId: string; page: Page; self: string; onChanged: () => void; info: React.ReactNode; insideProject?: boolean }) {
  const [title, setTitle] = React.useState(page.title);
  const [status, setStatus] = React.useState<"saved" | "saving" | "failed">("saved");
  const [versions, setVersions] = React.useState<Version[]>([]);
  const queryClient = useQueryClient();
  const [pane, setPane] = React.useState<PaneTab>("info");
  const [headings, setHeadings] = React.useState<Array<{ text: string; level: number; pos: number }>>([]);
  const [people, setPeople] = React.useState<Member[]>([]);
  const [threads, setThreads] = React.useState<Array<{ id: string; bodyText: string; authorId: string; authorName: string; anchor: string | null; resolved: boolean; replies: Array<{ id: string; bodyText: string; authorName: string }> }>>([]);
  const [commentText, setCommentText] = React.useState("");
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const [editingComment, setEditingComment] = React.useState<{ id: string; text: string } | null>(null);
  const [showResolved, setShowResolved] = React.useState(false);
  const peopleRef = React.useRef(people);
  peopleRef.current = people;
  const [exporting, setExporting] = React.useState(false);
  const imageInput = React.useRef<HTMLInputElement>(null);
  const dirtyTitle = React.useRef<string | undefined>(undefined);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const collaboration = React.useMemo(() => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: live, name: page.id, document: doc });
    provider.setAwarenessField("user", { name: self, color: "#7c3aed", colorLight: "#7c3aed33" });
    void fetch(`${api}/api/me`, { credentials: "include" }).then((response) => response.json()).then((data: { user?: { name?: string } }) => {
      if (data.user?.name) provider.setAwarenessField("user", { name: data.user.name, color: "#7c3aed", colorLight: "#7c3aed33" });
    });
    return { doc, provider };
  }, [page.id, self]);
  const { extension: images, error: imageError, uploadFile } = useAssetImages({ ownerType: "wiki_page", ownerId: page.id });
  React.useEffect(() => { void call<Member[]>("list_wiki_page_mentionable_members", { pageId: page.id }).then((result) => setPeople(result ?? [])); }, [page.id]);
  const loadThreads = React.useCallback(async (includeResolved = showResolved) => { setThreads(await call<typeof threads>("list_wiki_page_comments", { pageId: page.id, includeResolved }) ?? []); }, [page.id, showResolved]);
  React.useEffect(() => { void loadThreads(); }, [loadThreads]);
  const editor = useEditor({
    // The shared schema carries a display-less assetImage for server-side conversion; the browser registers its own (upload + rendering) via `images`, so drop the duplicate.
    extensions: [AiAssist, ...wikiEditorExtensions.filter((extension) => extension.name !== "mention" && extension.name !== "assetImage"), pageMentions(peopleRef), images, SafeLinkClick, EditorPlaceholder,
      SlashMenu.configure({ commands: wikiCommands, onImage: () => imageInput.current?.click() }),
      Collaboration.configure({ document: collaboration.doc }),
      CollaborationCaret.configure({ provider: collaboration.provider, user: { name: self, color: "#7c3aed" } })],
    editable: page.canEdit,
    onUpdate: () => { setStatus("saved"); },
  });

  React.useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      const next: Array<{ text: string; level: number; pos: number }> = [];
      editor.state.doc.descendants((node, pos) => { if (node.type.name === "heading") next.push({ text: node.textContent, level: Number(node.attrs.level), pos }); });
      setHeadings(next);
    };
    refresh(); editor.on("transaction", refresh);
    return () => { editor.off("transaction", refresh); };
  }, [editor]);

  function schedule() {
    setStatus("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), autosaveMs);
  }
  async function flush() {
    const pending = dirtyTitle.current;
    dirtyTitle.current = undefined;
    if (pending === undefined) return;
    const saved = await call<Page>("update_wiki_page", { pageId: page.id, title: pending });
    if (saved) { setStatus("saved"); void queryClient.invalidateQueries({ queryKey: ["wiki-pages", workspaceId] }); } else { dirtyTitle.current = pending; setStatus("failed"); }
  }
  async function loadVersions() { setVersions(await call<Version[]>("list_wiki_page_versions", { pageId: page.id }) ?? []); }

  function relativeAnchor(from: number, to: number) {
    const fragment = collaboration.doc.getXmlFragment("default");
    const start = Y.createRelativePositionFromTypeIndex(fragment, from);
    const end = Y.createRelativePositionFromTypeIndex(fragment, to);
    return btoa(JSON.stringify([Array.from(Y.encodeRelativePosition(start)), Array.from(Y.encodeRelativePosition(end))]));
  }
  async function addComment() {
    if (!editor || !commentText.trim()) return;
    const selection = editor.state.selection;
    if (selection.empty) return;
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: commentText.trim() }] }] };
    const result = await call("create_wiki_page_comment", { pageId: page.id, body, anchor: relativeAnchor(selection.from, selection.to) });
    if (result) { setCommentText(""); await loadThreads(); } else setStatus("failed");
  }
  async function reply(threadId: string) {
    if (!commentText.trim()) return;
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: commentText.trim() }] }] };
    if (await call("reply_wiki_page_comment", { commentId: threadId, body })) { setCommentText(""); setReplyTo(null); await loadThreads(); }
    else setStatus("failed");
  }

  async function exportMarkdown() {
    if (!editor || exporting) return;
    setExporting(true);
    try {
      const markdown = `# ${title}\n\n${await toMarkdown(editor.getJSON(), async (assetId) => {
        const result = await call<{ url: string; inline: boolean }>("get_asset_download_url", { assetId });
        if (!result?.url || !result.inline) throw new Error("Image link unavailable");
        return result.url;
      })}`;
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = `${title.trim() || "page"}.md`; link.click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  }

  React.useEffect(() => {
    void loadVersions();
    return () => { clearTimeout(timer.current); void flush(); collaboration.provider.destroy(); collaboration.doc.destroy(); };
  }, [page.id]);

  async function restore(versionId: string) {
    const restored = await call<Page & { contentText: string }>("restore_wiki_page_version", { pageId: page.id, versionId });
    if (restored) { setTitle(restored.title); editor?.commands.setContent((restored.content as object | null) ?? ""); await loadVersions(); onChanged(); }
  }

  const tabs: Array<{ key: PaneTab; label: string; count?: number }> = [
    { key: "info", label: translate("wiki.details") }, { key: "outline", label: translate("wiki.outline") },
    { key: "comments", label: translate("wiki.comments.tab" as MessageKey), count: threads.length }, { key: "activity", label: translate("wiki.activity") },
  ];
  const mutedButton = "grid size-7 shrink-0 place-items-center rounded-md !bg-transparent !p-0 text-secondary hover:!bg-layer-transparent-hover hover:text-primary";
  return <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
    <section aria-label={title} className="min-w-0">
    <div className="wiki-print-document">
    {insideProject ? <h2 className="wiki-print-title">{title}</h2> : <h1 className="wiki-print-title">{title}</h1>}
    <div className="flex items-center gap-2">
      <input className="wiki-edit-title min-w-0 flex-1 border-0 bg-transparent px-0 text-28 font-semibold text-primary" aria-label={translate("wiki.untitled")} value={title} disabled={!page.canEdit} onChange={(event) => { setTitle(event.target.value); dirtyTitle.current = event.target.value || translate("wiki.untitled"); schedule(); }} onBlur={onChanged} />
      <div className="wiki-page-actions"><Popover label={translate("wiki.exports")} align="right" className="!p-1.5" trigger={<MoreHorizontal aria-hidden size={16} />}>
        {(close) => <>
          <button type="button" role="menuitem" className={menuItemClass} disabled={!editor || exporting} onClick={() => { close(); void exportMarkdown(); }}>{translate("wiki.exportMarkdown")}</button>
          <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); window.print(); }}>{translate("wiki.exportPdf")}</button>
          <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); setPane("activity"); }}>{translate("wiki.history")}</button>
        </>}
      </Popover></div>
    </div>
    <small role="status" className="text-12 text-tertiary">{translate(status === "saved" ? "wiki.saved" : status === "saving" ? "wiki.saving" : "wiki.saveFailed")}</small>
    <div className="mt-2"><Toolbar editor={editor} disabled={!page.canEdit} /></div>
    <div className="relative mt-3">
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden data-testid="inline-image-input" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const assetId = await uploadFile(file); if (assetId) editor.chain().focus().insertContent({ type: "assetImage", attrs: { assetId } }).run(); }} />
    <div className="wiki-editor relative min-h-40 rounded-md border border-subtle bg-surface-1 p-3" data-testid="wiki-editor"><EditorContent editor={editor} />{page.canEdit && <AssistMenu editor={editor} workspaceId={workspaceId} />}</div>
    </div>
    {imageError && <p role="alert">{imageError}</p>}
    </div>
    </section>
    <aside aria-label={translate("wiki.details")} className="grid min-w-0 max-w-full h-fit content-start gap-4 self-start overflow-x-hidden rounded-lg border border-subtle bg-surface-1 p-3 text-13 lg:sticky lg:top-0 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
      <div role="tablist" aria-label={translate("wiki.breadcrumb")} className="-mx-1 flex flex-wrap gap-x-3 border-b border-subtle">
        {tabs.map((tab) => <button key={tab.key} type="button" role="tab" aria-selected={pane === tab.key} onClick={() => setPane(tab.key)}
          className={`-mb-px rounded-none border-0 border-b-2 !bg-transparent px-1 py-2 text-13 font-medium ${pane === tab.key ? "border-b-[var(--bg-accent-primary)] !text-accent-text" : "border-b-transparent !text-secondary hover:!text-primary"}`}>{tab.label}{tab.count ? <span className="ml-1 font-normal text-tertiary">{tab.count}</span> : null}</button>)}
      </div>
      {pane === "info" && <div className="grid gap-3">{info}</div>}
      {pane === "outline" && <nav aria-label={translate("wiki.outline")} data-testid="wiki-outline">
        {headings.length === 0 ? <p className="m-0 text-secondary">{translate("wiki.outlineEmpty")}</p> : <ul className="m-0 grid list-none gap-0.5 p-0">{headings.map((heading, index) => <li key={`${heading.pos}-${index}`} style={{ paddingLeft: `${(heading.level - 1) * 12}px` }}><button type="button" className="w-full truncate rounded-md !bg-transparent !px-2 !py-1 text-left text-13 !font-normal !text-secondary hover:!bg-layer-transparent-hover hover:!text-primary" onClick={() => { editor?.chain().focus().setTextSelection(heading.pos + 1).run(); editor?.view.domAtPos(heading.pos).node.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>{heading.text || translate("wiki.outlineUntitled")}</button></li>)}</ul>}
      </nav>}
      {pane === "comments" && <section aria-label={translate("wiki.comments" as MessageKey)} className="grid gap-3">
        <label className="flex items-center gap-2 text-secondary"><input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} /> {translate("wiki.comments.showResolved" as MessageKey)}</label>
        {threads.length === 0 && <p className="m-0 text-secondary">{translate("wiki.comments.empty" as MessageKey)}</p>}
        <ul className="m-0 grid list-none gap-2 p-0">{threads.map((thread) => <li key={thread.id} className={`grid gap-1.5 rounded-lg border p-2.5 ${replyTo === thread.id ? "border-[var(--bg-accent-primary)]" : "border-subtle"} ${thread.resolved ? "opacity-60" : ""}`} data-comment-anchor={thread.anchor ?? ""}>
          {editingComment?.id === thread.id
            ? <form className="grid gap-1.5" onSubmit={async (event) => { event.preventDefault(); const text = editingComment.text.trim(); if (!text) return; await call("update_wiki_page_comment", { commentId: thread.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } }); setEditingComment(null); await loadThreads(); }}>
              <input aria-label={translate("wiki.comments.edit" as MessageKey)} autoFocus value={editingComment.text} onChange={(event) => setEditingComment({ id: thread.id, text: event.target.value })} />
              <div className="flex gap-1 [&_button]:!px-2 [&_button]:!py-0.5 [&_button]:!text-12"><button type="submit">{translate("webLinks.save")}</button><button type="button" className="secondary" onClick={() => setEditingComment(null)}>{translate("comments.cancel")}</button></div>
            </form>
            : <div><strong className="text-primary">{thread.authorName}</strong>: {thread.bodyText}</div>}
          {thread.replies.map((reply) => <p key={reply.id} className="m-0 border-l-2 border-subtle pl-2 text-secondary">{reply.authorName}: {reply.bodyText}</p>)}
          <div className="flex flex-wrap gap-1 [&_button]:!px-2 [&_button]:!py-0.5 [&_button]:!text-12">
            <button type="button" className="secondary" onClick={() => setReplyTo(thread.id)}>{translate("wiki.comments.reply" as MessageKey)}</button>
            <button type="button" className="secondary" onClick={() => void call("resolve_wiki_page_comment", { commentId: thread.id, resolved: !thread.resolved }).then(() => loadThreads())}>{translate(thread.resolved ? "wiki.comments.reopen" as MessageKey : "wiki.comments.resolve" as MessageKey)}</button>
            {thread.authorId === self && <button type="button" className="secondary" onClick={() => setEditingComment({ id: thread.id, text: thread.bodyText })}>{translate("wiki.comments.edit" as MessageKey)}</button>}
          </div>
        </li>)}</ul>
        <div className="grid gap-2 border-t border-subtle pt-3">
          {!replyTo && <button type="button" className="secondary w-fit" disabled={!editor || editor.state.selection.empty} onClick={() => setReplyTo(null)}>{translate("wiki.comments.selected" as MessageKey)}</button>}
          {replyTo && <button type="button" className="w-fit !bg-transparent !p-0 text-12 !text-secondary hover:!text-primary" onClick={() => setReplyTo(null)}>{translate("comments.cancel")}</button>}
          <div className="flex gap-2"><input className="min-w-0 flex-1" aria-label={translate("wiki.comments.text" as MessageKey)} value={commentText} onChange={(event) => setCommentText(event.target.value)} /><button type="button" className="secondary" disabled={!commentText.trim()} onClick={() => replyTo ? void reply(replyTo) : void addComment()}>{translate(replyTo ? "wiki.comments.reply" as MessageKey : "wiki.comments.add" as MessageKey)}</button></div>
        </div>
      </section>}
      {pane === "activity" && <div className="grid gap-4">
        <Activity pageId={page.id} refresh={status} />
        <section aria-label={translate("wiki.history")} className="grid gap-2 border-t border-subtle pt-3">
          <h3 className="m-0 text-13 font-semibold text-primary">{translate("wiki.history")}</h3>
          <ul className="m-0 grid list-none gap-2 p-0">{versions.map((version) => <li key={version.id} className="flex items-center justify-between gap-2 text-secondary"><span className="min-w-0 truncate">{formatDate(version.createdAt)} — {version.title}</span><button className="secondary !px-2 !py-0.5 !text-12" disabled={!page.canEdit} onClick={() => void restore(version.id)}>{translate("wiki.restore")}</button></li>)}</ul>
        </section>
      </div>}
    </aside>
  </div>;
}

const roleIcon = (page: Summary) => page.access === "private" ? <Lock aria-hidden size={14} className="text-tertiary" /> : <Globe aria-hidden size={14} className="text-tertiary" />;
const rowLink = "flex items-center gap-2 text-14 text-primary hover:underline";
type ListTab = "all" | "public" | "private" | "archived" | "shared";
type ListOrder = "name" | "created" | "updated";
type ListFilters = { tab: ListTab; owner: string; createdAfter: string; updatedAfter: string; order: ListOrder };
function readListFilters(params: URLSearchParams): ListFilters {
  const tab = params.get("tab"); const order = params.get("order");
  return { tab: tab === "public" || tab === "private" || tab === "archived" || tab === "shared" ? tab : "all", owner: params.get("owner") ?? "", createdAfter: params.get("createdAfter") ?? "", updatedAfter: params.get("updatedAfter") ?? "", order: order === "created" || order === "updated" ? order : "name" };
}
function writeListFilter(params: URLSearchParams, key: keyof ListFilters, value: string) {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value); else next.delete(key);
  return next;
}
function ListControls({ pages, filters, update, shared = false }: { pages: Summary[]; filters: ListFilters; update: (key: keyof ListFilters, value: string) => void; shared?: boolean }) {
  const owners = Array.from(new Map(pages.map((page) => [page.ownerId, page.ownerName ?? page.ownerId])).entries());
  return <div className="grid gap-3">
    <div role="tablist" className="flex gap-4 border-b border-subtle">
      {(["all", "public", "private", "archived", ...(shared ? ["shared" as const] : [])] as const).map((name) => <button key={name} role="tab" type="button" aria-selected={filters.tab === name} onClick={() => update("tab", name)}
        className={`-mb-px border-0 border-b-2 bg-transparent px-1 py-2 text-13 font-medium ${filters.tab === name ? "border-b-[var(--bg-accent-primary)] text-accent-text" : "border-b-transparent text-secondary"}`}>{translate(`pages.tab.${name}` as MessageKey)}</button>)}
    </div>
    <div className="flex flex-wrap items-end gap-3 text-13">
      <label className="grid gap-1 text-secondary">{translate("pages.filter.owner")}<select aria-label={translate("pages.filter.owner")} value={filters.owner} onChange={(event) => update("owner", event.target.value)}>
        <option value="">{translate("pages.filter.anyOwner")}</option>{owners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label className="grid gap-1 text-secondary">{translate("pages.filter.createdAfter")}<input aria-label={translate("pages.filter.createdAfter")} type="date" value={filters.createdAfter} onChange={(event) => update("createdAfter", event.target.value)} /></label>
      <label className="grid gap-1 text-secondary">{translate("pages.filter.updatedAfter")}<input aria-label={translate("pages.filter.updatedAfter")} type="date" value={filters.updatedAfter} onChange={(event) => update("updatedAfter", event.target.value)} /></label>
      <label className="grid gap-1 text-secondary">{translate("pages.order")}<select aria-label={translate("pages.order")} value={filters.order} onChange={(event) => update("order", event.target.value)}>
        <option value="name">{translate("pages.order.name")}</option><option value="created">{translate("pages.order.created")}</option><option value="updated">{translate("pages.order.updated")}</option>
      </select></label>
    </div>
  </div>;
}
function filterAndOrder(pages: Summary[], filters: ListFilters) {
  return pages.filter((page) => (filters.tab === "archived" ? page.archived : !page.archived && (filters.tab === "all" || filters.tab === "shared" || page.access === filters.tab))
    && (!filters.owner || page.ownerId === filters.owner)
    && (!filters.createdAfter || page.createdAt.slice(0, 10) >= filters.createdAfter)
    && (!filters.updatedAfter || page.updatedAt.slice(0, 10) >= filters.updatedAfter))
    .sort((a, b) => filters.order === "name" ? a.title.localeCompare(b.title) : filters.order === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt));
}

/** Pages of the list as an indented tree: a page whose parent is not in the list (hidden or gone) is shown at the top rather than dropped. */
function flatten(pages: Summary[]) {
  const known = new Set(pages.map((page) => page.id));
  const out: Array<{ page: Summary; depth: number; nested: number }> = [];
  const count = (id: string): number => pages.filter((page) => page.parentId === id).reduce((sum, child) => sum + 1 + count(child.id), 0);
  const walk = (parentId: string | null, depth: number) => {
    for (const page of pages.filter((candidate) => parentId === null ? candidate.parentId === null || !known.has(candidate.parentId) : candidate.parentId === parentId)) {
      out.push({ page, depth, nested: count(page.id) }); walk(page.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Wiki section: every wiki page of the workspace, as a table like Plane's Wiki. */
export function WikiListPage({ workspace }: { workspace: { id: string; slug: string } }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const paramsRef = React.useRef(params); paramsRef.current = params;
  const update = React.useCallback((key: keyof ListFilters, value: string) => {
    const next = writeListFilter(paramsRef.current, key, value); paramsRef.current = next; setParams(next, { replace: true });
  }, [setParams]);
  const filters = readListFilters(params);
  const { data: pages = [], isLoading, isError } = useQuery({ queryKey: ["wiki-pages", workspace.id, filters.tab], queryFn: async () => filters.tab === "shared"
    ? await call<Summary[]>("list_shared_wiki_pages", { workspaceId: workspace.id }) ?? []
    : await call<Summary[]>("list_wiki_pages", { workspaceId: workspace.id, archived: filters.tab === "archived" }) ?? [] });
  const { data: collections = [] } = useQuery({ queryKey: ["wiki-collections", workspace.id], queryFn: async () => await call<Array<{ id: string; name: string; icon: string; visibility: "public" | "private"; isDefault: boolean }>>("list_collections", { workspaceId: workspace.id }) ?? [] });
  const [failed, setFailed] = React.useState(false);
  const shown = filterAndOrder(pages, filters);
  async function create() {
    const created = await call<Page>("create_wiki_page", { workspaceId: workspace.id, title: translate("wiki.untitled") });
    if (created) navigate(paths.wikiPage(workspace.slug, created.id)); else setFailed(true);
  }
  type CollectionRow = (typeof collections)[number];
  const [collectionDialog, setCollectionDialog] = React.useState<{ kind: "create" } | { kind: "rename" | "delete"; collection: CollectionRow } | null>(null);
  const refreshCollections = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["wiki-collections", workspace.id] }), queryClient.invalidateQueries({ queryKey: ["wiki-pages", workspace.id] })]);
  async function saveCollection(name: string) {
    const dialog = collectionDialog;
    if (!dialog || dialog.kind === "delete" || !name.trim()) return;
    const result = dialog.kind === "create" ? await call("create_collection", { workspaceId: workspace.id, name: name.trim() }) : await call("rename_collection", { collectionId: dialog.collection.id, name: name.trim() });
    if (result) { setCollectionDialog(null); await refreshCollections(); } else setFailed(true);
  }
  async function removeCollection(collection: CollectionRow) {
    if (await call("delete_collection", { collectionId: collection.id }) !== null) { setCollectionDialog(null); await refreshCollections(); } else setFailed(true);
  }
  return <section aria-label={translate("wiki.title")} className="grid gap-4">
    <header className="flex items-center justify-between gap-3">
      <h1 className="text-20 font-semibold text-primary">{translate("wiki.title")}</h1>
      <div className="flex gap-2"><button type="button" onClick={() => setCollectionDialog({ kind: "create" })} className="secondary">{translate("wiki.collection.new")}</button><button type="button" onClick={() => void create()} className="inline-flex items-center gap-1.5"><Plus aria-hidden size={14} />{translate("wiki.new")}</button></div>
    </header>
    {failed && <p role="alert">{translate("wiki.failed")}</p>}
    <ListControls pages={pages} filters={filters} update={update} shared />
    {isError && <p role="alert">{translate("wiki.failed")}</p>}
    {isLoading && <p role="status">{translate("wiki.loading")}</p>}
    {!isLoading && shown.length === 0 && <p className="text-secondary">{translate("wiki.empty")}</p>}
    {(shown.length > 0 || collections.length > 0) && <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-13">
      <thead><tr className="border-b border-subtle text-12 text-tertiary"><th className="py-2 font-medium">{translate("wiki.col.name")}</th><th className="py-2 font-medium">{translate("wiki.access")}</th><th className="hidden py-2 font-medium md:table-cell">{translate("pages.created")}</th><th className="py-2 font-medium">{translate("pages.updated")}</th><th className="hidden py-2 font-medium md:table-cell">{translate("wiki.col.nested")}</th></tr></thead>
      <tbody>{collections.map((collection) => <React.Fragment key={collection.id}>
        <tr className="border-b border-subtle bg-surface-1"><th colSpan={4} className="py-2 pr-2 text-left font-semibold text-primary">{collection.icon} {collection.name}{collection.visibility === "private" ? ` · ${translate("wiki.access.private")}` : ""}</th><td className="py-1 text-right"><Popover label={`${translate("sortable.actions")}: ${collection.name}`} align="right" trigger={<MoreHorizontal aria-hidden size={16} />} panelClassName="w-48">
          {(close) => <>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); setCollectionDialog({ kind: "rename", collection }); }}>{translate("wiki.collection.rename")}</button>
            {!collection.isDefault && <button type="button" role="menuitem" className={menuItemClass} onClick={async () => { close(); await call("set_collection_visibility", { collectionId: collection.id, visibility: collection.visibility === "public" ? "private" : "public" }); await refreshCollections(); }}>{translate(collection.visibility === "public" ? "wiki.collection.makePrivate" : "wiki.collection.makePublic")}</button>}
            {!collection.isDefault && <button type="button" role="menuitem" className={`${menuItemClass} text-danger-text`} onClick={() => { close(); setCollectionDialog({ kind: "delete", collection }); }}>{translate("wiki.collection.delete")}</button>}
          </>}
        </Popover></td></tr>
        {flatten(shown.filter((page) => page.collectionId === collection.id)).map(({ page, depth, nested }) => <tr key={page.id} className="border-b border-subtle hover:bg-layer-transparent-hover">
        <td className="py-2" style={{ paddingLeft: `${depth * 1.25}rem` }}><Link className={rowLink} to={paths.wikiPage(workspace.slug, page.id)}><FileText aria-hidden size={14} className="text-secondary" />{page.title}</Link></td>
        <td className="py-2 text-secondary"><span className="inline-flex items-center gap-1.5">{roleIcon(page)}{translate(`wiki.access.${page.access}` as MessageKey)}</span></td>
        <td className="hidden py-2 text-secondary md:table-cell">{formatDate(page.createdAt)}</td><td className="py-2 text-secondary">{formatDate(page.updatedAt)}</td>
        <td className="hidden py-2 text-secondary md:table-cell">{nested}</td>
      </tr>)}
      </React.Fragment>)}</tbody>
    </table></div>}
    {collectionDialog && (collectionDialog.kind === "delete"
      ? <Dialog title={translate("wiki.collection.delete")} onClose={() => setCollectionDialog(null)}>
        <p className="m-0 text-14 text-secondary">{translate("wiki.collection.deleteConfirm").replace("{name}", collectionDialog.collection.name)}</p>
        <div className="flex justify-end gap-2"><button type="button" className="secondary" onClick={() => setCollectionDialog(null)}>{translate("comments.cancel")}</button><button type="button" className="!bg-danger-primary hover:!bg-danger-primary-hover" onClick={() => void removeCollection(collectionDialog.collection)}>{translate("wiki.collection.delete")}</button></div>
      </Dialog>
      : <CollectionNameDialog initial={collectionDialog.kind === "rename" ? collectionDialog.collection.name : ""} title={translate(collectionDialog.kind === "create" ? "wiki.collection.new" : "wiki.collection.rename")} onSubmit={saveCollection} onClose={() => setCollectionDialog(null)} />)}
  </section>;
}

function CollectionNameDialog({ initial, title, onSubmit, onClose }: { initial: string; title: string; onSubmit: (name: string) => void; onClose: () => void }) {
  const [name, setName] = React.useState(initial);
  return <Dialog title={title} onClose={onClose}>
    <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(name); }}>
      <label className="grid gap-1 text-13 text-secondary">{translate("wiki.collection.name")}<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <DialogActions onClose={onClose} submit={translate("webLinks.save")} />
    </form>
  </Dialog>;
}

type ProjectOption = { id: string; key: string; name: string; role?: string | null };

/** The wiki page screen: breadcrumb, editor with toolbar, and the page's settings (access, parent, scope). `projectKey` means it was opened from that project's Pages. */
export function WikiPageScreen({ workspace, self, pageId, projectKey }: { workspace: { id: string; slug: string }; self: string; pageId: string; projectKey?: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [pages, setPages] = React.useState<Summary[]>([]);
  const [page, setPage] = React.useState<Page | null | undefined>(undefined);
  const [projects, setProjects] = React.useState<ProjectOption[]>([]);
  const [shareMembers, setShareMembers] = React.useState<Member[]>([]);
  const [shares, setShares] = React.useState<Array<Member & { role: "view" | "comment" | "edit" }>>([]);
  const [shareTarget, setShareTarget] = React.useState("");
  const [shareRole, setShareRole] = React.useState<"view" | "comment" | "edit">("view");
  const [collections, setCollections] = React.useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [failed, setFailed] = React.useState(false);
  const [publishedUrl, setPublishedUrl] = React.useState<string | null>(null);
  const back = projectKey ? paths.pages(workspace.slug, projectKey) : paths.wiki(workspace.slug);
  const reload = React.useCallback(async () => {
    if (!projectKey) return setPages(await call<Summary[]>("list_wiki_pages", { workspaceId: workspace.id }) ?? []);
    const projects = await call<ProjectOption[]>("list_projects", { workspaceId: workspace.id, archived: false }) ?? [];
    const project = projects.find((candidate) => candidate.key === projectKey);
    setPages(project ? await call<Summary[]>("list_project_wiki_pages", { projectId: project.id }) ?? [] : []);
  }, [workspace.id, projectKey]);
  React.useEffect(() => { void reload(); }, [reload]);
  React.useEffect(() => { setPage(undefined); void call<Page>("get_wiki_page", { pageId }).then(async (loaded) => {
    // Another workspace's page is missing here; under a project route the page must be linked to that project.
    if (loaded && (loaded as Page & { workspaceId?: string }).workspaceId !== undefined && (loaded as Page & { workspaceId?: string }).workspaceId !== workspace.id) return setPage(null);
    if (loaded && projectKey) {
      const projects = await call<ProjectOption[]>("list_projects", { workspaceId: workspace.id, archived: false }) ?? [];
      if (!projects.some((project) => project.key === projectKey && project.id === loaded.projectId)) return setPage(null);
    }
    setPage(loaded);
  }); }, [pageId, workspace.id, projectKey]);
  React.useEffect(() => {
    setShares([]); setShareMembers([]); setShareTarget("");
    if (!page || page.ownerId !== self || page.projectId) return;
    void Promise.all([
      call<Array<Member & { role: "view" | "comment" | "edit" }>>("list_wiki_page_shares", { pageId }),
      call<Array<Member & { email?: string }>>("list_members", { workspaceId: workspace.id }),
    ]).then(([listedShares, members]) => { setShares(listedShares ?? []); setShareMembers(members ?? []); });
  }, [page?.id, page?.ownerId, page?.projectId, self, pageId, workspace.id]);
  React.useEffect(() => { void call<ProjectOption[]>("list_projects", { workspaceId: workspace.id, archived: false }).then((result) => setProjects(result ?? [])); }, [workspace.id]);
  React.useEffect(() => { void call<Array<{ id: string; name: string; isDefault: boolean }>>("list_collections", { workspaceId: workspace.id }).then((result) => setCollections(result ?? [])); }, [workspace.id]);
  const { data: favorites = [] } = useQuery({ queryKey: favoritesKey(workspace.id), queryFn: async () => await call<Summary[]>("list_favorite_wiki_pages", { workspaceId: workspace.id }) ?? [] });
  const isFavorite = favorites.some((favorite) => favorite.id === pageId);

  async function toggleFavorite() {
    if (await call("favorite_wiki_page", { pageId, favorite: !isFavorite }) !== null) {
      await client.invalidateQueries({ queryKey: favoritesKey(workspace.id) });
    } else setFailed(true);
  }

  async function shareWithMember() {
    if (!shareTarget) return;
    const result = await call("share_wiki_page", { pageId, userId: shareTarget, role: shareRole });
    setFailed(result === null);
    if (result) {
      const [listed] = await Promise.all([
        call<Array<Member & { role: "view" | "comment" | "edit" }>>("list_wiki_page_shares", { pageId }),
        client.invalidateQueries({ queryKey: ["wiki-pages", workspace.id] }),
      ]);
      setShares(listed ?? []); setShareTarget("");
    }
  }

  async function changeShareRole(userId: string, role: "view" | "comment" | "edit") {
    if (await call("share_wiki_page", { pageId, userId, role })) {
      setShares(await call<Array<Member & { role: "view" | "comment" | "edit" }>>("list_wiki_page_shares", { pageId }) ?? []);
      await client.invalidateQueries({ queryKey: ["wiki-pages", workspace.id] });
    } else setFailed(true);
  }

  async function revokeShare(userId: string) {
    if (await call("revoke_wiki_page_share", { pageId, userId })) {
      setShares(await call<Array<Member & { role: "view" | "comment" | "edit" }>>("list_wiki_page_shares", { pageId }) ?? []);
      await client.invalidateQueries({ queryKey: ["wiki-pages", workspace.id] });
    } else setFailed(true);
  }

  async function publishPage() {
    const result = await call<{ token: string }>("publish_wiki_page", { pageId });
    if (result) setPublishedUrl(`${window.location.origin}/p/${result.token}`); else setFailed(true);
  }

  async function revokePublishedLink() {
    if (await call("revoke_wiki_page_published_link", { pageId })) setPublishedUrl(null);
    else setFailed(true);
  }

  async function create(parentId: string | null) {
    const projectId = projectKey ? projects.find((project) => project.key === projectKey)?.id : undefined;
    const created = await call<Page>("create_wiki_page", { workspaceId: workspace.id, title: translate("wiki.untitled"), parentId, ...(projectId ? { projectId } : {}) });
    if (created) navigate(projectKey ? paths.page(workspace.slug, projectKey, created.id) : paths.wikiPage(workspace.slug, created.id)); else setFailed(true);
  }
  async function change(name: string, body: Record<string, unknown>) {
    if (name === "move_page_scope") {
      const impact = await call<{ pageCount: number; shareCount: number; publishedLink: boolean; workItemLinkCount: number }>("get_page_move_impact", { pageId, ...body });
      if (!impact) return setFailed(true);
      const warning = `Move ${impact.pageCount} page${impact.pageCount === 1 ? "" : "s"}? This removes ${impact.shareCount} page share${impact.shareCount === 1 ? "" : "s"}, ${impact.publishedLink ? "the published link" : "no published link"}, and ${impact.workItemLinkCount} work-item link${impact.workItemLinkCount === 1 ? "" : "s"}. Continue?`;
      if (!window.confirm(warning)) return;
    }
    const result = await call(name, { pageId, ...body });
    setFailed(result === null);
    await reload();
    if (name === "move_page_scope" && result) setPage((current) => current ? { ...current, projectId: (result as { projectId: string | null }).projectId } : current);
    if (name === "set_wiki_page_access" && page && result) setPage({ ...page, access: body.access as Summary["access"] });
    if (name === "move_wiki_page" && page && result) setPage({ ...page, parentId: body.parentId as string | null });
    if (name === "move_page_scope" && result) {
      const scope = result as { projectId: string | null; key: string | null };
      if (scope.projectId === null && projectKey) navigate(paths.wikiPage(workspace.slug, pageId));
      else if (scope.projectId && scope.key && projectKey !== scope.key) navigate(paths.page(workspace.slug, scope.key, pageId));
    }
    if (name === "delete_wiki_page" && result) { await client.invalidateQueries({ queryKey: ["wiki-pages", workspace.id] }); navigate(back); }
  }

  if (page === undefined) return null;
  if (page === null) return <section><p role="alert">{translate("wiki.notFound")}</p><Link to={back}>{translate(projectKey ? "projectNav.pages" : "wiki.title")}</Link></section>;
  return <section aria-label={translate("wiki.title")} className="grid gap-4">
    <nav aria-label={translate("wiki.breadcrumb")} className="flex items-center gap-1 text-13 text-secondary">
      <Link to={back} className="hover:underline">{translate(projectKey ? "projectNav.pages" : "wiki.title")}</Link><ChevronRight aria-hidden size={12} /><span className="text-primary">{page.title}</span>
      <span className="ml-auto flex items-center gap-2"><button type="button" className="secondary" aria-pressed={isFavorite} aria-label={translate(isFavorite ? "wiki.unfavorite" : "wiki.favorite")} onClick={() => void toggleFavorite()}><Heart aria-hidden size={14} fill={isFavorite ? "currentColor" : "none"} /></button><SidecarTrigger context={{ type: "wiki_page", id: page.id, title: page.title }} /></span>
    </nav>
    {failed && <p role="alert">{translate("wiki.failed")}</p>}
    {page.archived && <p role="status" className="text-secondary">{translate("pages.archivedReadOnly")}</p>}
    <Editor key={page.id} insideProject={Boolean(projectKey)} workspaceId={workspace.id} page={page} self={self} onChanged={() => void reload()} info={<>
        <label className="grid gap-1 text-secondary">{translate("wiki.access")}
          <select value={page.access} disabled={page.archived || page.ownerId !== self} onChange={(event) => void change("set_wiki_page_access", { access: event.target.value })}>
            <option value="public">{translate("wiki.access.public")}</option><option value="private">{translate("wiki.access.private")}</option>
          </select></label>
        <label className="grid gap-1 text-secondary">{translate("wiki.parent")}
          <select value={page.parentId ?? ""} disabled={page.archived} onChange={(event) => void change("move_wiki_page", { parentId: event.target.value || null })}>
            <option value="">{translate("wiki.noParent")}</option>
            {pages.filter((other) => other.id !== page.id).map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}
          </select></label>
        <div role="group" aria-label={translate("wiki.projects")} className="grid gap-1.5">
          <span className="text-secondary">{translate("wiki.projects")}</span>
          <select aria-label={translate("wiki.linkProject")} value={page.projectId ? `project:${page.projectId}` : `collection:${page.collectionId ?? ""}`} disabled={page.archived} onChange={(event) => {
            const [kind, id] = event.target.value.split(":", 2);
            void change("move_page_scope", kind === "project" ? { projectId: id, collectionId: null } : { projectId: null, collectionId: id || null });
          }}>
            <option value="collection:">{translate("wiki.title")}</option>
            {collections.filter((collection) => !collection.isDefault).map((collection) => <option key={collection.id} value={`collection:${collection.id}`}>{collection.name}</option>)}
            {projects.filter((project) => project.role === "Admin" || project.role === "Member").map((project) => <option key={project.id} value={`project:${project.id}`}>{project.key} · {project.name}</option>)}
          </select>
        </div>
        {!page.projectId && page.access === "public" && page.canArchive && <section aria-label={translate("wiki.publishedLink")} className="grid gap-2 border-t border-subtle pt-3">
          <span className="font-medium text-primary">{translate("wiki.publishedLink")}</span>
          {publishedUrl ? <><a className="break-all text-secondary underline" href={publishedUrl} target="_blank" rel="noreferrer">{publishedUrl}</a><button type="button" className="secondary" onClick={() => void revokePublishedLink()}>{translate("wiki.revokePublishedLink")}</button></> : <button type="button" className="secondary" onClick={() => void publishPage()}>{translate("wiki.publishLink")}</button>}
        </section>}
        {!page.projectId && page.ownerId === self && <section aria-label={translate("wiki.shareMembers")} className="grid gap-2 border-t border-subtle pt-3">
          <span className="font-medium text-primary">{translate("wiki.shareMembers")}</span>
          <div className="grid gap-2">
            <select aria-label={translate("wiki.share.member")} value={shareTarget} onChange={(event) => setShareTarget(event.target.value)}>
              <option value="">{translate("wiki.share.chooseMember")}</option>{shareMembers.filter((member) => member.userId !== self).map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}
            </select>
            <select aria-label={translate("wiki.share.role")} value={shareRole} onChange={(event) => setShareRole(event.target.value as typeof shareRole)}>
              <option value="view">{translate("wiki.share.view")}</option><option value="comment">{translate("wiki.share.comment")}</option><option value="edit">{translate("wiki.share.edit")}</option>
            </select>
            <button type="button" className="secondary" disabled={!shareTarget} onClick={() => void shareWithMember()}>{translate("wiki.share.action")}</button>
          </div>
          <ul className="grid gap-2">{shares.map((share) => <li key={share.userId} className="grid grid-cols-[1fr_auto] items-center gap-2">
            <span className="min-w-0 break-words">{share.name}</span><div className="flex min-w-0 flex-wrap gap-1">
              <select aria-label={`${share.name} ${translate("wiki.share.role")}`} value={share.role} onChange={(event) => void changeShareRole(share.userId, event.target.value as typeof share.role)}>
                <option value="view">{translate("wiki.share.view")}</option><option value="comment">{translate("wiki.share.comment")}</option><option value="edit">{translate("wiki.share.edit")}</option>
              </select>
              <button type="button" className="secondary" aria-label={`${translate("wiki.share.revoke")} ${share.name}`} onClick={() => void revokeShare(share.userId)}>{translate("wiki.share.revoke")}</button>
            </div>
          </li>)}</ul>
        </section>}
        <div className="flex flex-wrap gap-2">
          {page.canArchive && <button type="button" className="secondary" onClick={() => void change(page.archived ? "unarchive_wiki_page" : "archive_wiki_page", {})}>{page.archived ? <ArchiveRestore aria-hidden size={14} /> : <Archive aria-hidden size={14} />}{translate(page.archived ? "pages.unarchive" : "pages.archive")}</button>}
          {!page.archived && <button type="button" className="secondary" onClick={() => void create(page.id)}>{translate("wiki.newChild")}</button>}
          {!page.archived && <button type="button" className="secondary text-danger-text" onClick={() => { if (window.confirm(translate("wiki.deleteConfirm"))) void change("delete_wiki_page", {}); }}>{translate("wiki.delete")}</button>}
        </div>
    </>} />
  </section>;
}

/** A project's Pages: the pages assigned to the project, in Public and Private tabs. Wiki pages can be moved here from the Wiki list. */
export function ProjectPagesPage({ workspace, project, canWrite }: { workspace: { id: string; slug: string }; project: { id: string; key: string }; canWrite: boolean }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const paramsRef = React.useRef(params); paramsRef.current = params;
  const update = React.useCallback((key: keyof ListFilters, value: string) => {
    const next = writeListFilter(paramsRef.current, key, value); paramsRef.current = next; setParams(next, { replace: true });
  }, [setParams]);
  const filters = readListFilters(params);
  const client = useQueryClient();
  const { data: pages = [], isLoading, isError } = useQuery({ queryKey: ["project-pages", project.id, filters.tab === "archived"], queryFn: async () => await call<Summary[]>("list_project_wiki_pages", { projectId: project.id, archived: filters.tab === "archived" }) ?? [] });
  const { data: all = [] } = useQuery({ queryKey: ["wiki-pages", workspace.id], queryFn: async () => await call<Summary[]>("list_wiki_pages", { workspaceId: workspace.id }) ?? [] });
  const [failed, setFailed] = React.useState(false);
  const shown = filterAndOrder(pages, filters);
  async function add() {
    const created = await call<Page>("create_wiki_page", { workspaceId: workspace.id, projectId: project.id, title: translate("wiki.untitled") });
    if (created) navigate(paths.page(workspace.slug, project.key, created.id)); else setFailed(true);
  }
  async function move(pageId: string, projectId: string | null) {
    setFailed(await call("move_page_scope", { pageId, projectId }) === null);
    await Promise.all([client.invalidateQueries({ queryKey: ["project-pages", project.id] }), client.invalidateQueries({ queryKey: ["wiki-pages", workspace.id] })]);
  }
  const linkable = all.filter((page) => !(pages ?? []).some((linked) => linked.id === page.id));
  return <section aria-label={translate("projectNav.pages")} className="grid gap-3">
    <header className="flex items-center justify-between gap-3">
      <h2 className="text-18 font-semibold text-primary">{translate("projectNav.pages")}</h2>
      {canWrite && <button type="button" onClick={() => void add()} className="inline-flex items-center gap-1.5"><Plus aria-hidden size={14} />{translate("pages.add")}</button>}
    </header>
    <ListControls pages={pages} filters={filters} update={update} />
    {failed && <p role="alert">{translate("wiki.failed")}</p>}
    {isError && <p role="alert">{translate("wiki.failed")}</p>}
    {isLoading && <p role="status">{translate("wiki.loading")}</p>}
    {!isLoading && shown.length === 0 && <p className="text-secondary">{translate("pages.empty")}</p>}
    <ul className="grid">{shown.map((page) => <li key={page.id} className="flex items-center justify-between gap-2 border-b border-subtle py-2 hover:bg-layer-transparent-hover">
      <Link className={rowLink} to={paths.page(workspace.slug, project.key, page.id)}><FileText aria-hidden size={14} className="text-secondary" />{page.title}</Link>
      <span className="flex items-center gap-2">{roleIcon(page)}{canWrite && <button type="button" className="secondary" aria-label={`${translate("wiki.unlink")}: ${page.title}`} onClick={() => void move(page.id, null)}>{translate("wiki.unlink")}</button>}</span>
    </li>)}</ul>
    {canWrite && linkable.length > 0 && <label className="grid max-w-xs gap-1 text-13 text-secondary">{translate("pages.linkExisting")}
      <select value="" onChange={(event) => { if (event.target.value) void move(event.target.value, project.id); }}>
        <option value="">{translate("pages.choose")}</option>
        {linkable.map((page) => <option key={page.id} value={page.id}>{page.title}</option>)}
      </select></label>}
  </section>;
}
