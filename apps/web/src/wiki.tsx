import { SidecarTrigger } from "./sidecar";
import React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { SuggestionProps } from "@tiptap/suggestion";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Color } from "@tiptap/extension-color";
import { TextStyle } from "@tiptap/extension-text-style";
import { Node } from "@tiptap/core";
import { formatDate, translate, translateDynamic, type MessageKey } from "@weft/shared";
import { useAssetImages } from "./asset-images";
import { Link } from "react-router";
import { Bold, Code, FileText, Italic, List, ListOrdered, Lock, Quote, Strikethrough, Globe, ChevronRight, Plus } from "lucide-react";
import { paths } from "./routes";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toMarkdown } from "./wiki-export";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const autosaveMs = 1_500;
const live = import.meta.env.VITE_LIVE_URL ?? "ws://localhost:3001";

const Callout = Node.create({
  name: "callout", group: "block", content: "block+", defining: true,
  parseHTML() { return [{ tag: "aside[data-callout]" }]; },
  renderHTML() { return ["aside", { "data-callout": "true", class: "wiki-callout" }, 0]; },
});

const slashItems = ["Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6", "Bulleted list", "Numbered list", "To-do list", "Table", "Quote", "Code block", "Callout", "Divider", "Emoji", "Text color", "Image"] as const;
const slashLabel = (item: typeof slashItems[number]) => {
  if (item.startsWith("Heading ")) return translate(`wiki.tool.h${item.slice(-1)}` as MessageKey);
  if (item === "Bulleted list") return translate("wiki.tool.bulletList");
  if (item === "Numbered list") return translate("wiki.tool.orderedList");
  if (item === "Quote") return translate("wiki.tool.quote");
  if (item === "Code block") return translate("wiki.tool.codeBlock");
  const key = { "To-do list": "wiki.insert.todo", Table: "wiki.insert.table", Callout: "wiki.insert.callout", Divider: "wiki.insert.divider", Emoji: "wiki.insert.emoji", "Text color": "wiki.insert.color", Image: "wiki.insert.image" } as const;
  return translate(key[item as keyof typeof key] as MessageKey);
};

export type Summary = { id: string; projectId?: string | null; parentId: string | null; title: string; access: "public" | "private"; ownerId: string; ownerName?: string | null; createdAt: string; updatedAt: string };
type Page = Summary & { content: unknown; canEdit: boolean };
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
  { key: "codeBlock", icon: Code, label: "wiki.tool.codeBlock", run: (e: NonNullable<Tools>) => e.chain().focus().toggleCodeBlock().run() },
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
  return <section aria-label={translate("wiki.activity")} className="mt-6">
    <h3 className="text-14 font-semibold text-primary">{translate("wiki.activity")}</h3>
    <ul className="mt-2 grid gap-1 text-13 text-secondary">{rows.map((row) => <li key={row.id}>{row.actorName} · {translateDynamic(`wiki.activity.${row.field}`) ?? row.field} · {formatDate(row.createdAt)}</li>)}</ul>
  </section>;
}
function Editor({ page, self, onChanged }: { page: Page; self: string; onChanged: () => void }) {
  const [title, setTitle] = React.useState(page.title);
  const [status, setStatus] = React.useState<"saved" | "saving" | "failed">("saved");
  const [versions, setVersions] = React.useState<Version[]>([]);
  const [slashOpen, setSlashOpen] = React.useState(false);
  const [outlineOpen, setOutlineOpen] = React.useState(false);
  const [headings, setHeadings] = React.useState<Array<{ text: string; level: number; pos: number }>>([]);
  const [people, setPeople] = React.useState<Member[]>([]);
  const peopleRef = React.useRef(people);
  peopleRef.current = people;
  const [exporting, setExporting] = React.useState(false);
  const imageInput = React.useRef<HTMLInputElement>(null);
  const slashPosition = React.useRef<number | null>(null);
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
  const editor = useEditor({
    extensions: [StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3, 4, 5, 6] } }), pageMentions(peopleRef), images,
      Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
      TaskList, TaskItem.configure({ nested: true }), TextStyle, Color, Callout,
      Collaboration.configure({ document: collaboration.doc }),
      CollaborationCaret.configure({ provider: collaboration.provider, user: { name: self, color: "#7c3aed" } })],
    editable: page.canEdit,
    onUpdate: () => { setStatus("saved"); },
    editorProps: { handleTextInput: (_view, from, _to, text) => { if (text === "/" && page.canEdit) { slashPosition.current = from; setSlashOpen(true); return true; } return false; } },
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

  function insertSlashItem(item: typeof slashItems[number]) {
    if (!editor) return;
    const at = slashPosition.current;
    const chain = editor.chain().focus();
    if (at !== null) chain.deleteRange({ from: at, to: editor.state.selection.from });
    switch (item) {
      case "Heading 1": case "Heading 2": case "Heading 3": case "Heading 4": case "Heading 5": case "Heading 6":
        chain.setHeading({ level: Number(item.slice(-1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run(); break;
      case "Bulleted list": chain.toggleBulletList().run(); break;
      case "Numbered list": chain.toggleOrderedList().run(); break;
      case "To-do list": chain.toggleTaskList().run(); break;
      case "Table": chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
      case "Quote": chain.toggleBlockquote().run(); break;
      case "Code block": chain.toggleCodeBlock().run(); break;
      case "Callout": chain.insertContent({ type: "callout", content: [{ type: "paragraph" }] }).run(); break;
      case "Divider": chain.setHorizontalRule().run(); break;
      case "Emoji": chain.insertContent("😀").run(); break;
      case "Text color": chain.setColor("#7c3aed").run(); break;
      case "Image": imageInput.current?.click(); break;
    }
    setSlashOpen(false); slashPosition.current = null;
  }

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
    if (saved) setStatus("saved"); else { dirtyTitle.current = pending; setStatus("failed"); }
  }
  async function loadVersions() { setVersions(await call<Version[]>("list_wiki_page_versions", { pageId: page.id }) ?? []); }

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

  return <section aria-label={title}>
    <div className="mb-3 flex justify-end gap-2" aria-label={translate("wiki.exports")}>
      <button type="button" className="secondary" disabled={!editor || exporting} onClick={() => void exportMarkdown()}>{translate("wiki.exportMarkdown")}</button>
      <button type="button" className="secondary" onClick={() => window.print()}>{translate("wiki.exportPdf")}</button>
    </div>
    <div className="wiki-print-document">
    <h1 className="wiki-print-title">{title}</h1>
    <input className="wiki-edit-title w-full border-0 bg-transparent px-0 text-28 font-semibold text-primary outline-none" aria-label={translate("wiki.untitled")} value={title} disabled={!page.canEdit} onChange={(event) => { setTitle(event.target.value); dirtyTitle.current = event.target.value || translate("wiki.untitled"); schedule(); }} onBlur={onChanged} />
    <small role="status" className="text-12 text-tertiary">{translate(status === "saved" ? "wiki.saved" : status === "saving" ? "wiki.saving" : "wiki.saveFailed")}</small>
    <Toolbar editor={editor} disabled={!page.canEdit} />
    <div role="tablist" aria-label={translate("wiki.breadcrumb")} className="flex gap-2">
      <button type="button" role="tab" aria-selected={!outlineOpen} onClick={() => setOutlineOpen(false)}>{translate("wiki.editorTab")}</button>
      <button type="button" role="tab" aria-selected={outlineOpen} onClick={() => setOutlineOpen(true)}>{translate("wiki.outline")}</button>
    </div>
    <>{outlineOpen && <nav aria-label={translate("wiki.outline")} data-testid="wiki-outline"><ul>{headings.map((heading, index) => <li key={`${heading.pos}-${index}`} style={{ paddingLeft: `${(heading.level - 1) * 12}px` }}><button type="button" onClick={() => { editor?.chain().focus().setTextSelection(heading.pos + 1).run(); editor?.view.domAtPos(heading.pos).node.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>{heading.text || translate("wiki.outlineUntitled")}</button></li>)}</ul>{headings.length === 0 && <p>{translate("wiki.outlineEmpty")}</p>}</nav>}
    <div className="relative">
      {slashOpen && <div role="menu" aria-label={translate("wiki.insert")} data-testid="slash-menu" className="absolute left-3 top-3 z-10 grid max-h-72 overflow-auto rounded-md border border-subtle bg-surface-1 p-1 shadow-lg">{slashItems.map((item) => <button key={item} role="menuitem" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSlashItem(item)} className="px-3 py-1.5 text-left hover:bg-layer-transparent-hover">{slashLabel(item)}</button>)}</div>}
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden data-testid="inline-image-input" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const assetId = await uploadFile(file); if (assetId) editor.chain().focus().insertContent({ type: "assetImage", attrs: { assetId } }).run(); }} />
    <div className="wiki-editor min-h-40 rounded-md border border-subtle bg-surface-1 p-3" data-testid="wiki-editor"><EditorContent editor={editor} /></div>
    </div></>
    {imageError && <p role="alert">{imageError}</p>}
    <Activity pageId={page.id} refresh={status} />
    <details onToggle={() => void loadVersions()}><summary>{translate("wiki.history")}</summary>
      <ul>{versions.map((version) => <li key={version.id}>{formatDate(version.createdAt)} — {version.title} <button className="secondary" disabled={!page.canEdit} onClick={() => void restore(version.id)}>{translate("wiki.restore")}</button></li>)}</ul>
    </details>
    </div>
  </section>;
}

const roleIcon = (page: Summary) => page.access === "private" ? <Lock aria-hidden size={14} className="text-tertiary" /> : <Globe aria-hidden size={14} className="text-tertiary" />;
const rowLink = "flex items-center gap-2 text-14 text-primary hover:underline";
type ListTab = "all" | "public" | "private";
type ListOrder = "name" | "created" | "updated";
type ListFilters = { tab: ListTab; owner: string; createdAfter: string; updatedAfter: string; order: ListOrder };
function readListFilters(params: URLSearchParams): ListFilters {
  const tab = params.get("tab"); const order = params.get("order");
  return { tab: tab === "public" || tab === "private" ? tab : "all", owner: params.get("owner") ?? "", createdAfter: params.get("createdAfter") ?? "", updatedAfter: params.get("updatedAfter") ?? "", order: order === "created" || order === "updated" ? order : "name" };
}
function writeListFilter(params: URLSearchParams, key: keyof ListFilters, value: string) {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value); else next.delete(key);
  return next;
}
function ListControls({ pages, filters, update }: { pages: Summary[]; filters: ListFilters; update: (key: keyof ListFilters, value: string) => void }) {
  const owners = Array.from(new Map(pages.map((page) => [page.ownerId, page.ownerName ?? page.ownerId])).entries());
  return <div className="grid gap-3">
    <div role="tablist" className="flex gap-4 border-b border-subtle">
      {(["all", "public", "private"] as const).map((name) => <button key={name} role="tab" type="button" aria-selected={filters.tab === name} onClick={() => update("tab", name)}
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
  return pages.filter((page) => (filters.tab === "all" || page.access === filters.tab)
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
  const [params, setParams] = useSearchParams();
  const paramsRef = React.useRef(params); paramsRef.current = params;
  const update = React.useCallback((key: keyof ListFilters, value: string) => {
    const next = writeListFilter(paramsRef.current, key, value); paramsRef.current = next; setParams(next, { replace: true });
  }, [setParams]);
  const filters = readListFilters(params);
  const { data: pages = [], isLoading, isError } = useQuery({ queryKey: ["wiki-pages", workspace.id], queryFn: async () => await call<Summary[]>("list_wiki_pages", { workspaceId: workspace.id }) ?? [] });
  const [failed, setFailed] = React.useState(false);
  const shown = filterAndOrder(pages, filters);
  async function create() {
    const created = await call<Page>("create_wiki_page", { workspaceId: workspace.id, title: translate("wiki.untitled") });
    if (created) navigate(paths.wikiPage(workspace.slug, created.id)); else setFailed(true);
  }
  return <section aria-label={translate("wiki.title")} className="grid gap-4">
    <header className="flex items-center justify-between gap-3">
      <h2 className="text-20 font-semibold text-primary">{translate("wiki.title")}</h2>
      <button type="button" onClick={() => void create()} className="inline-flex items-center gap-1.5"><Plus aria-hidden size={14} />{translate("wiki.new")}</button>
    </header>
    {failed && <p role="alert">{translate("wiki.failed")}</p>}
    <ListControls pages={pages} filters={filters} update={update} />
    {isError && <p role="alert">{translate("wiki.failed")}</p>}
    {isLoading && <p role="status">{translate("wiki.loading")}</p>}
    {!isLoading && shown.length === 0 && <p className="text-secondary">{translate("wiki.empty")}</p>}
    {shown.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[32rem] border-collapse text-left text-13">
      <thead><tr className="border-b border-subtle text-12 text-tertiary"><th className="py-2 font-medium">{translate("wiki.col.name")}</th><th className="py-2 font-medium">{translate("wiki.access")}</th><th className="py-2 font-medium">{translate("pages.created")}</th><th className="py-2 font-medium">{translate("pages.updated")}</th><th className="py-2 font-medium">{translate("wiki.col.nested")}</th></tr></thead>
      <tbody>{flatten(shown).map(({ page, depth, nested }) => <tr key={page.id} className="border-b border-subtle hover:bg-layer-transparent-hover">
        <td className="py-2" style={{ paddingLeft: `${depth * 1.25}rem` }}><Link className={rowLink} to={paths.wikiPage(workspace.slug, page.id)}><FileText aria-hidden size={14} className="text-secondary" />{page.title}</Link></td>
        <td className="py-2 text-secondary"><span className="inline-flex items-center gap-1.5">{roleIcon(page)}{translate(`wiki.access.${page.access}` as MessageKey)}</span></td>
        <td className="py-2 text-secondary">{formatDate(page.createdAt)}</td><td className="py-2 text-secondary">{formatDate(page.updatedAt)}</td>
        <td className="py-2 text-secondary">{nested}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

type ProjectOption = { id: string; key: string; name: string; role?: string | null };

/** The wiki page screen: breadcrumb, editor with toolbar, and the page's settings (access, parent, scope). `projectKey` means it was opened from that project's Pages. */
export function WikiPageScreen({ workspace, self, pageId, projectKey }: { workspace: { id: string; slug: string }; self: string; pageId: string; projectKey?: string }) {
  const navigate = useNavigate();
  const [pages, setPages] = React.useState<Summary[]>([]);
  const [page, setPage] = React.useState<Page | null | undefined>(undefined);
  const [projects, setProjects] = React.useState<ProjectOption[]>([]);
  const [failed, setFailed] = React.useState(false);
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
  React.useEffect(() => { void call<ProjectOption[]>("list_projects", { workspaceId: workspace.id, archived: false }).then((result) => setProjects(result ?? [])); }, [workspace.id]);

  async function create(parentId: string | null) {
    const projectId = projectKey ? projects.find((project) => project.key === projectKey)?.id : undefined;
    const created = await call<Page>("create_wiki_page", { workspaceId: workspace.id, title: translate("wiki.untitled"), parentId, ...(projectId ? { projectId } : {}) });
    if (created) navigate(projectKey ? paths.page(workspace.slug, projectKey, created.id) : paths.wikiPage(workspace.slug, created.id)); else setFailed(true);
  }
  async function change(name: string, body: Record<string, unknown>) {
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
    if (name === "delete_wiki_page" && result) navigate(back);
  }

  if (page === undefined) return null;
  if (page === null) return <section><p role="alert">{translate("wiki.notFound")}</p><Link to={back}>{translate(projectKey ? "projectNav.pages" : "wiki.title")}</Link></section>;
  return <section aria-label={translate("wiki.title")} className="grid gap-4">
    <nav aria-label={translate("wiki.breadcrumb")} className="flex items-center gap-1 text-13 text-secondary">
      <Link to={back} className="hover:underline">{translate(projectKey ? "projectNav.pages" : "wiki.title")}</Link><ChevronRight aria-hidden size={12} /><span className="text-primary">{page.title}</span>
      <span className="ml-auto"><SidecarTrigger context={{ type: "wiki_page", id: page.id, title: page.title }} /></span>
    </nav>
    {failed && <p role="alert">{translate("wiki.failed")}</p>}
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <Editor key={page.id} page={page} self={self} onChanged={() => void reload()} />
      <aside aria-label={translate("wiki.details")} className="grid h-fit gap-3 rounded-lg border border-subtle bg-surface-1 p-3 text-13">
        <label className="grid gap-1 text-secondary">{translate("wiki.access")}
          <select value={page.access} disabled={page.ownerId !== self} onChange={(event) => void change("set_wiki_page_access", { access: event.target.value })}>
            <option value="public">{translate("wiki.access.public")}</option><option value="private">{translate("wiki.access.private")}</option>
          </select></label>
        <label className="grid gap-1 text-secondary">{translate("wiki.parent")}
          <select value={page.parentId ?? ""} onChange={(event) => void change("move_wiki_page", { parentId: event.target.value || null })}>
            <option value="">{translate("wiki.noParent")}</option>
            {pages.filter((other) => other.id !== page.id).map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}
          </select></label>
        <div role="group" aria-label={translate("wiki.projects")} className="grid gap-1.5">
          <span className="text-secondary">{translate("wiki.projects")}</span>
          <select aria-label={translate("wiki.linkProject")} value={page.projectId ?? ""} onChange={(event) => void change("move_page_scope", { projectId: event.target.value || null })}>
            <option value="">{translate("wiki.title")}</option>
            {projects.filter((project) => project.role === "Admin" || project.role === "Member").map((project) => <option key={project.id} value={project.id}>{project.key} · {project.name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="secondary" onClick={() => void create(page.id)}>{translate("wiki.newChild")}</button>
          <button type="button" className="secondary" onClick={() => void change("delete_wiki_page", {})}>{translate("wiki.delete")}</button>
        </div>
      </aside>
    </div>
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
  const { data: pages = [], isLoading, isError } = useQuery({ queryKey: ["project-pages", project.id], queryFn: async () => await call<Summary[]>("list_project_wiki_pages", { projectId: project.id }) ?? [] });
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
      <h3 className="text-18 font-semibold text-primary">{translate("projectNav.pages")}</h3>
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
