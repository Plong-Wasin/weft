import { api, liveUrl } from "./api";
import { SidecarTrigger } from "./sidecar";
import React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { Mention } from "../../../packages/actions/src/wiki-editor-extensions";
import { OutlinksPanel } from "./outlinks-panel";
import { mentionRender } from "./suggest-list";
import { formatDate, translate, translateDynamic, type MessageKey } from "@weft/shared";
import { AttachmentsPanel, useAssetImages } from "./asset-images";
import { AssistMenu } from "./assist-menu";
import { AiAssist } from "./editor-assist";
import { BlockKeyboardShortcuts, CodeBlockCopy, EditorPlaceholder, EmojiSuggestions, ListIndent, MarkdownPaste, SafeLinkClick, SlashMenu, surfaceEditorExtensions, wikiCommands } from "./editor-extensions";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { MoreHorizontal, FileText, Heart, Globe, ChevronRight, Plus, Lock, PanelRight, X, Download, Upload, FileDown, Maximize2, Code, Clock, FilePlus, Archive, Trash2, Pencil, EyeOff } from "lucide-react";
import { paths } from "./routes";
import { markNotificationReadAfterDestinationLoaded } from "./inbox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { pageMarkdown, readableReferenceLabels, splitPageMarkdown, toMarkdown } from "./wiki-export";
import { MenuItem, Popover } from "./shell/popover";
import { Dialog, DialogActions } from "./dialog";
import { TableControls } from "./table-controls";
import { addRowAfter, goToNextCell } from "@tiptap/pm/tables";
import { TextSelection } from "@tiptap/pm/state";
import type { WikiPaperSize } from "./wiki-pdf";
import { WikiBubbleMenu } from "./wiki-bubble-menu";
import { WikiBlockControls } from "./wiki-block-controls";
import { CalloutControls } from "./callout-controls";
import { CodeBlockControls } from "./code-block-controls";
import { EditorSourceMode, editorLimitWarnings } from "./editor-source-mode";
import { ReferencePicker } from "./reference-picker";
import { collectionLabel } from "./type-descriptions";

const heartbeatMs = 20_000;
const autosaveMs = 1_500;
const live = liveUrl(import.meta.env.VITE_LIVE_URL, window.location);
const favoritesKey = (workspaceId: string) => ["favorite-wiki-pages", workspaceId] as const;

export type Summary = { id: string; archived: boolean; locked?: boolean; projectId?: string | null; collectionId?: string | null; parentId: string | null; title: string; access: "public" | "private"; ownerId: string; ownerName?: string | null; createdAt: string; updatedAt: string };
type MarkdownWarning = { code: string; message: string };
type Page = Summary & { published?: boolean; content: unknown; contentMarkdownWarnings?: string[]; contentMarkdownWarningDetails?: MarkdownWarning[]; canEdit: boolean; canLock?: boolean; canArchive?: boolean };
type Member = { userId: string; name: string; isAgent?: boolean; codeCapable?: boolean };
type Version = { id: string; title: string; createdAt: string };

function markdownWarningKey(code: string): MessageKey {
  switch (code) {
    case "unsupported-html": return "wiki.importWarning.html";
    case "external-image": return "wiki.importWarning.image";
    case "unsafe-link": case "link-not-persisted": return "wiki.importWarning.link";
    case "unresolved-reference": return "wiki.importWarning.reference";
    case "irregular-table": return "wiki.importWarning.table";
    case "deep-heading": return "wiki.importWarning.heading";
    case "structure-simplified": return "editor.warning.structureSimplified";
    case "task-state-simplified": return "editor.warning.taskState";
    case "table-header-simplified": return "editor.warning.tableHeader";
    case "code-language-simplified": return "editor.warning.codeLanguage";
    case "list-start-simplified": return "editor.warning.listStart";
    case "callout-type-simplified": return "editor.warning.calloutType";
    case "image-alt-simplified": return "editor.warning.imageAlt";
    case "heading-level-simplified": return "editor.warning.headingLevel";
    case "attribute-not-persisted": return "editor.warning.attributeNotPersisted";
    case "unsupported-callout-metadata": return "editor.warning.unsupportedCallout";
    case "unsupported-code-language": return "editor.warning.unsupportedCodeLanguage";
    case "unsafe-color": return "editor.warning.unsafeColor";
    case "input-too-complex": return "editor.warning.inputTooComplex";
    case "input-too-long": return "editor.warning.inputTooLong";
    case "nesting-too-deep": return "editor.warning.nestingTooDeep";
    default: return "editor.warning.unsupportedContent";
  }
}

function markdownWarningText(code: string, source: string): string {
  const excerpt = code === "unsupported-html" ? source.match(/<[^>]+>/)?.[0]
    : code === "external-image" ? source.match(/!\[[^\]]*\]\([^\)]+\)/)?.[0]
    : code === "unsafe-link" ? source.match(/\[[^\]]+\]\((?:javascript|data):[^\)]+\)/i)?.[0]
    : code === "unresolved-reference" ? source.match(/\[\[[^\]]+\]\]/)?.[0]
    : code === "irregular-table" ? source.split("\n").find((line) => line.includes("|") && line.trim())
    : code === "deep-heading" ? source.split("\n").find((line) => /^\s*#{7,}/.test(line))
    : source.split("\n").find((line) => line.trim());
  return JSON.stringify((excerpt ?? "…").trim().slice(0, 100));
}

async function call<T>(name: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.ok ? await response.json() as T : null;
}


function pageMentions(people: React.RefObject<Member[]>) {
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: {
      char: "@",
      items: ({ query }: { query: string }) => (people.current ?? []).filter((person) => person.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => Number(!!a.isAgent) - Number(!!b.isAgent) || a.name.localeCompare(b.name)).slice(0, 8).map(({ userId, name, isAgent, codeCapable }) => ({ id: userId, label: name, isAgent, codeCapable })),
      render: mentionRender("wiki.mentionMembers"),
    },
  });
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
type PaneTab = "info" | "outline" | "links" | "comments" | "activity";
/** Below this width the Details panel is a drawer over the content; at or above it the panel sits beside the editor. */
const wideQuery = "(min-width: 1024px)";
const detailsOpenKey = "wiki-details-panel-open";
// When browser storage is blocked the choice still lasts for the whole visit: Editor remounts on every page, so a module variable carries it across pages.
const memory: Record<string, boolean> = {};
function readFlag(key: string): boolean {
  if (key in memory) return memory[key]!;
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}
function writeFlag(key: string, on: boolean) {
  memory[key] = on;
  try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* kept in memory for this visit */ }
}
function readDetailsOpen(): boolean { return readFlag(detailsOpenKey); }
function writeDetailsOpen(open: boolean) { writeFlag(detailsOpenKey, open); }
const fullWidthKey = "wiki-full-width";
function readFullWidth(): boolean { return readFlag(fullWidthKey); }
function writeFullWidth(on: boolean) { writeFlag(fullWidthKey, on); }
function useWideScreen() {
  const [wide, setWide] = React.useState(() => window.matchMedia(wideQuery).matches);
  React.useEffect(() => {
    const media = window.matchMedia(wideQuery);
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}
/** Page menu actions that the screen owns (lock, archive, child, delete); the editor adds the Export items and Show text with symbols. */
type PageMenuActions = { onLock: () => void; onArchive: () => void; onAddSubpage: () => void; onDelete: () => void };
function Editor({ workspaceId, page, self, onChanged, onResync, info, onImported, actions }: { workspaceId: string; page: Page; self: string; onChanged: () => void; onResync: () => void; info: React.ReactNode; onImported: (pageId: string) => void; actions: PageMenuActions }) {
  const [title, setTitle] = React.useState(page.title);
  const [status, setStatus] = React.useState<"saved" | "saving" | "failed" | "not-saved">("saved");
  const [versions, setVersions] = React.useState<Version[]>([]);
  const queryClient = useQueryClient();
  const [pane, setPane] = React.useState<PaneTab>("info");
  const wide = useWideScreen();
  const [wideOpen, setWideOpen] = React.useState(readDetailsOpen);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [fullWidth, setFullWidth] = React.useState(readFullWidth);
  function toggleFullWidth() {
    setFullWidth((on) => { writeFullWidth(!on); return !on; });
  }
  const panelOpen = wide ? wideOpen : drawerOpen;
  function openPanel() {
    if (wide) { setWideOpen(true); writeDetailsOpen(true); } else setDrawerOpen(true);
  }
  function togglePanel() {
    if (!wide) return setDrawerOpen((open) => !open);
    const next = !wideOpen;
    setWideOpen(next); writeDetailsOpen(next);
  }
  React.useEffect(() => { if (wide) setDrawerOpen(false); }, [wide]);
  // Header Share and Publish open the Details panel and land on their section; the section mounts with the panel, so it is found after render.
  const [focusSection, setFocusSection] = React.useState<string | null>(null);
  function revealPanelSection(sectionId: string) { setPane("info"); openPanel(); setFocusSection(sectionId); }
  React.useEffect(() => {
    if (!focusSection || !panelOpen || pane !== "info") return;
    const target = document.getElementById(focusSection);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.querySelector<HTMLElement>("select, input, button")?.focus();
    setFocusSection(null);
  }, [focusSection, panelOpen, pane]);
  React.useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setDrawerOpen(false); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);
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
  const [exportFeedback, setExportFeedback] = React.useState<{ state: "started" | "failed"; filename: string } | null>(null);
  const [importFailed, setImportFailed] = React.useState(false);
  const [importFeedback, setImportFeedback] = React.useState<{ warnings: MarkdownWarning[]; source: string } | null>(() => {
    const key = `wiki-import-feedback:${page.id}`;
    const saved = sessionStorage.getItem(key);
    if (!saved) return null;
    sessionStorage.removeItem(key);
    try {
      const parsed = JSON.parse(saved) as { warnings: Array<string | MarkdownWarning>; source: string };
      return { ...parsed, warnings: parsed.warnings.map((warning) => typeof warning === "string" ? { code: "unsupported-markdown", message: warning } : warning) };
    } catch { return null; }
  });
  const [sourceActive, setSourceActive] = React.useState(false);
  const sourceToggle = React.useRef<(() => void) | null>(null);
  const [pdfDialog, setPdfDialog] = React.useState(false);
  const [pdfPaperSize, setPdfPaperSize] = React.useState<WikiPaperSize>("a4");
  const [pdfIncludeImages, setPdfIncludeImages] = React.useState(true);
  const [pdfExporting, setPdfExporting] = React.useState(false);
  const [pdfError, setPdfError] = React.useState("");
  const [inlineAssetIds, setInlineAssetIds] = React.useState<string[]>([]);
  const limitWarnings = React.useMemo(() => editorLimitWarnings(page.content), [page.content]);
  const imageInput = React.useRef<HTMLInputElement>(null);
  const dirtyTitle = React.useRef<string | undefined>(undefined);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onResyncRef = React.useRef(onResync);
  onResyncRef.current = onResync;
  const collaboration = React.useMemo(() => {
    const doc = new Y.Doc();
    // Close reason "Page resync" (see resyncReason in apps/live): the server dropped our edits while the page was locked, so this document is ahead of the stored one; remount the editor to start from the stored state.
    const provider = new HocuspocusProvider({ url: live, name: page.id, document: doc, onClose: ({ event }) => { if (event.reason === "Page resync") onResyncRef.current(); } });
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
    extensions: [AiAssist, ...surfaceEditorExtensions({ surface: "full", mention: pageMentions(peopleRef), image: images, collaborative: true }), ListIndent, BlockKeyboardShortcuts, MarkdownPaste, CodeBlockCopy, EmojiSuggestions, ReferencePicker.configure({ workspaceId }), SafeLinkClick, EditorPlaceholder,
      SlashMenu.configure({ commands: wikiCommands, onImage: () => imageInput.current?.click() }),
      Collaboration.configure({ document: collaboration.doc }),
      CollaborationCaret.configure({ provider: collaboration.provider, user: { name: self, color: "#7c3aed" } })],
    editable: page.canEdit,
    editorProps: { handleKeyDown: (view, event) => {
      if (event.key !== "Tab") return false;
      const selection = window.getSelection();
      if (!selection?.anchorNode || !view.dom.contains(selection.anchorNode)) return false;
      const anchorPos = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
      const $from = view.state.doc.resolve(anchorPos);
      let tableDepth = $from.depth;
      while (tableDepth > 0 && $from.node(tableDepth).type.name !== "table") tableDepth -= 1;
      if (tableDepth === 0) return false;
      const resolvedSelection = TextSelection.near($from);
      if (!view.state.selection.eq(resolvedSelection)) view.dispatch(view.state.tr.setSelection(resolvedSelection));
      const table = $from.node(tableDepth), rowIndex = $from.index(tableDepth), cellIndex = $from.index(tableDepth + 1);
      const handled = event.shiftKey
        ? goToNextCell(-1)(view.state, view.dispatch)
        : goToNextCell(1)(view.state, view.dispatch) || (rowIndex === table.childCount - 1 && cellIndex === table.child(rowIndex).childCount - 1 && addRowAfter(view.state, view.dispatch));
      if (handled) event.preventDefault();
      return handled;
    } },
    onUpdate: () => { setStatus("saved"); },
  });
  React.useEffect(() => {
    if (!editor) return;
    const timer = setInterval(() => {
      void call<{ canWrite: boolean; locked: boolean }>("get_wiki_page_access", { pageId: page.id }).then((access) => {
        if (!access) return;
        editor.setEditable(access.canWrite);
        if (access.locked !== Boolean(page.locked)) onChanged();
      });
    }, 5_000);
    return () => clearInterval(timer);
  }, [editor, onChanged, page.id, page.locked]);

  React.useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      const next: Array<{ text: string; level: number; pos: number }> = [];
      const assetIds: string[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading") next.push({ text: node.textContent, level: Number(node.attrs.level), pos });
        if (node.type.name === "assetImage" && typeof node.attrs.assetId === "string") assetIds.push(node.attrs.assetId);
      });
      setHeadings(next);
      setInlineAssetIds((current) => current.length === assetIds.length && current.every((id, index) => id === assetIds[index]) ? current : assetIds);
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
    const filename = `${title.trim() || "page"}.md`;
    setExportFeedback(null);
    setExporting(true);
    try {
      const latest = await call<Page & { contentMarkdown: string }>("get_wiki_page", { pageId: page.id });
      if (!latest) throw new Error("Page could not be loaded");
      const writtenForm = latest.contentMarkdown ?? await toMarkdown(editor.getJSON());
      const outlinks = await call<Array<{ id: string; kind: "work-item" | "page" | "wiki"; title: string; displayId: string | null }>>("list_outlinks", { kind: page.projectId ? "page" : "wiki", id: page.id }) ?? [];
      const portable = await readableReferenceLabels(writtenForm, async (kind, id, label) => {
        const target = outlinks.find((entry) => entry.kind === kind && entry.id === id);
        if (!target) return null;
        return kind === "work-item" && target.displayId ? `${target.title} (${target.displayId})` : target.title || label;
      });
      const markdown = pageMarkdown(title, portable);
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = filename; link.click();
      URL.revokeObjectURL(url);
      setExportFeedback({ state: "started", filename });
    } catch {
      setExportFeedback({ state: "failed", filename });
    } finally { setExporting(false); }
  }

  async function importMarkdown(file: File) {
    setImportFailed(false);
    try {
      const { title: titleFromFile, contentMarkdown } = splitPageMarkdown(file.name, await file.text());
      const created = await call<Page>("create_wiki_page", { workspaceId, title: titleFromFile === "Untitled" ? translate("wiki.untitled") : titleFromFile, contentMarkdown, ...(page.projectId ? { projectId: page.projectId } : {}), ...(!page.projectId && page.collectionId ? { collectionId: page.collectionId } : {}) });
      if (!created) { setImportFailed(true); return; }
      sessionStorage.setItem(`wiki-import-feedback:${created.id}`, JSON.stringify({ warnings: created.contentMarkdownWarningDetails ?? [], source: contentMarkdown }));
      onImported(created.id);
    } catch { setImportFailed(true); }
  }

  async function exportPdf(event: React.FormEvent) {
    event.preventDefault();
    const source = document.querySelector<HTMLElement>(".wiki-print-document .wiki-editor");
    if (!source || pdfExporting) return;
    setPdfExporting(true); setPdfError("");
    try {
      const blob = await (await import("./wiki-pdf")).renderWikiPdf(source, title, pdfPaperSize, pdfIncludeImages);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${title.trim() || "page"}.pdf`; link.click();
      URL.revokeObjectURL(url); setPdfDialog(false);
    } catch (error) {
      console.error("Wiki PDF export failed", error);
      setPdfError(translate("wiki.pdfError"));
    } finally { setPdfExporting(false); }
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
    { key: "info", label: translate("wiki.details") }, { key: "outline", label: translate("wiki.outline") }, { key: "links", label: translate("outlinks.title") },
    { key: "comments", label: translate("wiki.comments.tab"), count: threads.length }, { key: "activity", label: translate("wiki.activity") },
  ];
  const mutedButton = "grid size-7 shrink-0 place-items-center rounded-md !bg-transparent !p-0 text-secondary hover:!bg-layer-transparent-hover hover:text-primary";
  return <div className={wide && panelOpen ? "grid gap-6 grid-cols-[minmax(0,1fr)_minmax(0,20rem)]" : "grid gap-6"}>
    <section aria-label={title} className={`min-w-0 ${fullWidth ? "" : "mx-auto w-full max-w-[760px]"}`}>
    <div className="wiki-print-document">
    <h1 className="wiki-print-title">{title}</h1>
    <div className="flex flex-wrap items-center gap-2">
      <input className="wiki-edit-title min-w-0 flex-1 basis-[12rem] border-0 bg-transparent px-0 text-40 font-semibold text-primary" aria-label={translate("wiki.untitled")} value={title} disabled={!page.canEdit} onChange={(event) => { setTitle(event.target.value); dirtyTitle.current = event.target.value || translate("wiki.untitled"); schedule(); }} onBlur={onChanged} />
      {page.locked && <span data-testid="wiki-locked-badge" className="shrink-0 rounded-md border border-subtle bg-surface-2 px-2 py-0.5 text-12 text-secondary">{translate("wiki.locked")}</span>}
      <div className="wiki-page-actions flex items-center gap-1">
        {!page.projectId && page.ownerId === self && <button type="button" className="secondary" data-testid="wiki-header-share" onClick={() => revealPanelSection("wiki-share-members")}>{translate("wiki.share.action")}</button>}
        {canPublishHere(page) && <button type="button" className="secondary" aria-pressed={Boolean(page.published)} data-testid="wiki-header-publish" onClick={() => revealPanelSection("wiki-published-link")}>{translate(page.published ? "wiki.published" : "wiki.publish")}</button>}
        <div className="flex items-center gap-1 border-l border-subtle pl-2">
        <button type="button" className="icon-button-ghost" data-testid="wiki-details-toggle" aria-pressed={panelOpen} aria-label={translate(panelOpen ? "wiki.details.hide" : "wiki.details.show")} title={translate(panelOpen ? "wiki.details.hide" : "wiki.details.show")} onClick={togglePanel}><PanelRight aria-hidden size={16} /></button>
        <Popover label={translate("wiki.exports")} align="right" className="icon-button-ghost !grid !place-items-center !p-0" panelClassName="w-72" trigger={<MoreHorizontal aria-hidden size={16} />}>
        {(close) => {
          const groups: React.ReactNode[][] = [
            [
              <MenuItem key="export-md" icon={Download} hint={translate("wiki.markdownHint")} disabled={!editor || exporting} onClick={() => { close(); void exportMarkdown(); }}>{translate("wiki.exportMarkdown")}</MenuItem>,
              page.canEdit && <MenuItem key="import-md" icon={Upload} onClick={() => { close(); document.getElementById("wiki-markdown-import")?.click(); }}>{translate("wiki.importMarkdown")}</MenuItem>,
              <MenuItem key="export-pdf" icon={FileDown} onClick={() => { close(); setPdfDialog(true); }}>{translate("wiki.exportPdf")}</MenuItem>,
            ],
            [
              <MenuItem key="full-width" role="menuitemcheckbox" checked={fullWidth} icon={Maximize2} onClick={() => { close(); toggleFullWidth(); }}>{translate("wiki.fullWidth")}</MenuItem>,
              editor?.isEditable && <MenuItem key="source" role="menuitemcheckbox" checked={sourceActive} icon={Code} onClick={() => { close(); sourceToggle.current?.(); }}>{translate("editor.sourceMode")}</MenuItem>,
            ],
            [
              <MenuItem key="history" icon={Clock} onClick={() => { close(); setPane("activity"); openPanel(); }}>{translate("wiki.history")}</MenuItem>,
            ],
            [
              page.canLock && <MenuItem key="lock" role="menuitemcheckbox" checked={page.locked} icon={Lock} data-testid="wiki-page-lock" onClick={() => { close(); actions.onLock(); }}>{translate("wiki.lock")}</MenuItem>,
              !page.archived && <MenuItem key="subpage" icon={FilePlus} onClick={() => { close(); actions.onAddSubpage(); }}>{translate("wiki.newChild")}</MenuItem>,
            ],
            [
              page.canArchive && <MenuItem key="archive" icon={Archive} onClick={() => { close(); actions.onArchive(); }}>{translate(page.archived ? "pages.unarchive" : "pages.archive")}</MenuItem>,
              !page.archived && <MenuItem key="delete" icon={Trash2} danger onClick={() => { close(); actions.onDelete(); }}>{translate("wiki.delete")}</MenuItem>,
            ],
          ];
          // Five groups, a line between the groups that have items; Delete stays last.
          return groups.map((group) => group.filter(Boolean)).filter((group) => group.length > 0).map((group, index) => <React.Fragment key={index}>
            {index > 0 && <div role="separator" className="my-1 h-px bg-subtle" />}
            {group}
          </React.Fragment>);
        }}
      </Popover></div>
        </div>
    </div>
    <input id="wiki-markdown-import" type="file" accept=".md,text/markdown,text/plain" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importMarkdown(file); }} />
    {importFeedback && <section role={importFeedback.warnings.length ? "alert" : "status"} aria-label={translate("wiki.importResult")} className="my-3 rounded-md border border-subtle bg-surface-2 p-3 text-13">
      <button type="button" className="secondary float-right !size-10 !p-0" aria-label={translate("wiki.dismissImportResult")} onClick={() => setImportFeedback(null)}>×</button>
      <p className="m-0 font-medium text-primary">{translate("wiki.importSuccess")}</p>
      <p className="mb-0 mt-1 text-secondary">{translate("wiki.importFileUnchanged")}</p>
      {importFeedback.warnings.length > 0 && <><p className="mb-1 mt-3 font-medium text-primary">{translate("wiki.importWarningsTitle")}</p><ul className="m-0 grid gap-1 pl-5 text-secondary">{importFeedback.warnings.map((warning, index) => <li key={`${warning.code}-${index}`} title={translate(markdownWarningKey(warning.code))}>{translate(markdownWarningKey(warning.code)).replace("{text}", markdownWarningText(warning.code, importFeedback.source))}</li>)}</ul></>}
    </section>}
    {exportFeedback && <div data-testid="wiki-download-toast" role={exportFeedback.state === "failed" ? "alert" : "status"} className={`fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] left-4 right-auto z-50 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-13 shadow-lg sm:bottom-4 sm:left-4 sm:right-auto ${exportFeedback.state === "failed" ? "text-danger-text" : "text-primary"}`}>
      <span className="min-w-0 break-words">{translate(exportFeedback.state === "failed" ? "wiki.downloadFailed" : "wiki.downloadStarted").replace("{filename}", exportFeedback.filename)}</span>
      {exportFeedback.state === "failed" && <button type="button" className="secondary" onClick={() => void exportMarkdown()}>{translate("wiki.retryDownload")}</button>}
      <button type="button" className="secondary !size-8 !p-0" aria-label={translate("wiki.dismissDownload")} onClick={() => setExportFeedback(null)}>×</button>
    </div>}
    {importFailed && <p role="alert" className="my-2 text-13 text-danger">{translate("wiki.importFailed")}</p>}
    {pdfDialog && <Dialog title={translate("wiki.pdfTitle")} onClose={() => { if (!pdfExporting) setPdfDialog(false); }}>
      <form className="grid gap-4" onSubmit={(event) => void exportPdf(event)}>
        <label className="grid gap-1 text-13 text-secondary">{translate("wiki.pdfPaperSize")}
          <select aria-label={translate("wiki.pdfPaperSize")} value={pdfPaperSize} onChange={(event) => setPdfPaperSize(event.target.value as WikiPaperSize)}>
            {(["a4", "a3", "a2", "letter", "legal", "tabloid"] as const).map((size) => <option key={size} value={size}>{translate(`wiki.pdfSize.${size}` as MessageKey)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-13 text-secondary"><input type="checkbox" checked={pdfIncludeImages} onChange={(event) => setPdfIncludeImages(event.target.checked)} />{translate("wiki.pdfIncludeImages")}</label>
        {pdfError && <p role="alert" className="m-0 text-13 text-danger">{pdfError}</p>}
        <DialogActions onClose={() => setPdfDialog(false)} submit={pdfExporting ? translate("wiki.pdfExporting") : translate("wiki.exportPdf")} />
      </form>
    </Dialog>}
    <small role="status" className={`text-12 ${status === "not-saved" ? "text-danger-text" : "text-tertiary"}`}>{translate(status === "saved" ? "wiki.saved" : status === "saving" ? "wiki.saving" : status === "not-saved" ? "wiki.notSaved" : "wiki.saveFailed")}</small>
    <div data-testid="wiki-editor-shell" className="wiki-editor-shell grid gap-3">
    <div className="relative">
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden data-testid="inline-image-input" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const assetId = await uploadFile(file); if (assetId) { const { selection } = editor.state; const at = "node" in selection ? selection.to : selection.from; editor.chain().focus().insertContentAt(at, { type: "assetImage", attrs: { assetId } }).run(); } }} />
    <div className="wiki-editor relative min-h-40" data-testid="wiki-editor"><EditorSourceMode editor={page.canEdit ? editor : null} initialWarnings={limitWarnings} onSourceDraftChange={(hasDraft) => { if (hasDraft) setStatus("not-saved"); }} toggleRef={sourceToggle} onModeChange={setSourceActive} /><CalloutControls editor={editor} editable={page.canEdit} /><CodeBlockControls editor={editor} editable={page.canEdit} /><TableControls editor={editor} editable={page.canEdit} /><EditorContent editor={editor} /><WikiBlockControls editor={editor} editable={page.canEdit} /><WikiBubbleMenu editor={page.canEdit ? editor : null} />{page.canEdit && <AssistMenu editor={editor} workspaceId={workspaceId} />}</div>
    </div>
    </div>
    <section aria-label={translate("assets.title")} className="mt-5 border-t border-subtle pt-4">
      <h2 className="mb-2 mt-0 text-16 font-semibold text-primary">{translate("assets.title")}</h2>
      <AttachmentsPanel workItemId={page.id} ownerType="wiki_page" canWrite={page.canEdit} action={call} showForm={page.canEdit} onCount={() => {}} testId="wiki-attachments" excludeAssetIds={inlineAssetIds} />
    </section>
    {imageError && <p role="alert">{imageError}</p>}
    </div>
    </section>
    {panelOpen && <DetailsPanelFrame wide={wide} onDismiss={() => setDrawerOpen(false)}>
    <aside aria-label={translate("wiki.details")} className={wide
      ? "grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] [&_select]:min-w-0 [&_select]:max-w-full [&_.grid]:min-w-0 h-fit content-start gap-4 self-start overflow-x-hidden rounded-lg border border-subtle bg-surface-1 p-3 text-13 sticky top-0 max-h-[calc(100vh-8rem)] overflow-y-auto"
      : "absolute inset-y-0 right-0 grid w-[min(20rem,calc(100vw-2rem))] min-w-0 content-start gap-4 overflow-y-auto overflow-x-hidden border-l border-subtle bg-surface-1 p-3 text-13 shadow-xl [&_select]:min-w-0 [&_select]:max-w-full [&_.grid]:min-w-0"}>
      {!wide && <div className="flex justify-end"><button type="button" autoFocus data-drawer-close className="secondary !size-8 !p-0" aria-label={translate("wiki.details.close")} title={translate("wiki.details.close")} onClick={() => setDrawerOpen(false)}><X aria-hidden size={16} /></button></div>}
      <div role="tablist" aria-label={translate("wiki.breadcrumb")} className="-mx-1 flex flex-nowrap gap-x-1 overflow-x-auto border-b border-subtle">
        {tabs.map((tab) => <button key={tab.key} type="button" role="tab" aria-selected={pane === tab.key} onClick={() => setPane(tab.key)}
          className={`-mb-px shrink-0 whitespace-nowrap rounded-none border-0 border-b-2 !bg-transparent px-0.5 py-2 text-13 font-medium ${pane === tab.key ? "border-b-[var(--bg-accent-primary)] !text-accent-text" : "border-b-transparent !text-secondary hover:!text-primary"}`}>{tab.label}{tab.count ? <span className="ml-1 font-normal text-tertiary">{tab.count}</span> : null}</button>)}
      </div>
      {pane === "info" && <div className="grid gap-3">{info}</div>}
      {pane === "outline" && <nav aria-label={translate("wiki.outline")} data-testid="wiki-outline">
        {headings.length === 0 ? <p className="m-0 text-secondary">{translate("wiki.outlineEmpty")}</p> : <ul className="m-0 grid list-none gap-0.5 p-0">{headings.map((heading, index) => <li key={`${heading.pos}-${index}`} style={{ paddingLeft: `${(heading.level - 1) * 12}px` }}><button type="button" className="w-full truncate rounded-md !bg-transparent !px-2 !py-1 text-left text-13 !font-normal !text-secondary hover:!bg-layer-transparent-hover hover:!text-primary" onClick={() => { editor?.chain().focus().setTextSelection(heading.pos + 1).run(); editor?.view.domAtPos(heading.pos).node.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>{heading.text || translate("wiki.outlineUntitled")}</button></li>)}</ul>}
      </nav>}
      {pane === "links" && <OutlinksPanel kind={page.projectId ? "page" : "wiki"} id={page.id} run={call} />}
      {pane === "comments" && <section aria-label={translate("wiki.comments")} className="grid gap-3">
        <label className="flex items-center gap-2 text-secondary"><input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} /> {translate("wiki.comments.showResolved")}</label>
        {threads.length === 0 && <p className="m-0 text-secondary">{translate("wiki.comments.empty")}</p>}
        <ul className="m-0 grid list-none gap-2 p-0">{threads.map((thread) => <li key={thread.id} className={`grid gap-1.5 rounded-lg border p-2.5 ${replyTo === thread.id ? "border-[var(--bg-accent-primary)]" : "border-subtle"} ${thread.resolved ? "opacity-60" : ""}`} data-comment-anchor={thread.anchor ?? ""}>
          {editingComment?.id === thread.id
            ? <form className="grid gap-1.5" onSubmit={async (event) => { event.preventDefault(); const text = editingComment.text.trim(); if (!text) return; await call("update_wiki_page_comment", { commentId: thread.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } }); setEditingComment(null); await loadThreads(); }}>
              <input aria-label={translate("wiki.comments.edit")} autoFocus value={editingComment.text} onChange={(event) => setEditingComment({ id: thread.id, text: event.target.value })} />
              <div className="flex gap-1 [&_button]:!px-2 [&_button]:!py-0.5 [&_button]:!text-12"><button type="submit">{translate("webLinks.save")}</button><button type="button" className="secondary" onClick={() => setEditingComment(null)}>{translate("comments.cancel")}</button></div>
            </form>
            : <div><strong className="text-primary">{thread.authorName}</strong>: {thread.bodyText}</div>}
          {thread.replies.map((reply) => <p key={reply.id} className="m-0 border-l-2 border-subtle pl-2 text-secondary">{reply.authorName}: {reply.bodyText}</p>)}
          <div className="flex flex-wrap gap-1 [&_button]:!px-2 [&_button]:!py-0.5 [&_button]:!text-12">
            <button type="button" className="secondary" onClick={() => setReplyTo(thread.id)}>{translate("wiki.comments.reply")}</button>
            <button type="button" className="secondary" onClick={() => void call("resolve_wiki_page_comment", { commentId: thread.id, resolved: !thread.resolved }).then(() => loadThreads())}>{translate(thread.resolved ? "wiki.comments.reopen" : "wiki.comments.resolve")}</button>
            {thread.authorId === self && <button type="button" className="secondary" onClick={() => setEditingComment({ id: thread.id, text: thread.bodyText })}>{translate("wiki.comments.edit")}</button>}
          </div>
        </li>)}</ul>
        <div className="grid gap-2 border-t border-subtle pt-3">
          {!replyTo && <button type="button" className="secondary w-fit" disabled={!editor || editor.state.selection.empty} onClick={() => setReplyTo(null)}>{translate("wiki.comments.selected")}</button>}
          {replyTo && <button type="button" className="w-fit !bg-transparent !p-0 text-12 !text-secondary hover:!text-primary" onClick={() => setReplyTo(null)}>{translate("comments.cancel")}</button>}
          <div className="flex gap-2"><input className="min-w-0 flex-1" aria-label={translate("wiki.comments.text")} value={commentText} onChange={(event) => setCommentText(event.target.value)} /><button type="button" className="secondary" disabled={!commentText.trim()} onClick={() => replyTo ? void reply(replyTo) : void addComment()}>{translate(replyTo ? "wiki.comments.reply" : "wiki.comments.add")}</button></div>
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
    </DetailsPanelFrame>}
  </div>;
}

/** Publish is offered for a public Wiki page (the owner or an Admin acts). A Lock or an archive does not stop it: only editing is locked. */
function canPublishHere(page: Page) {
  return !page.projectId && page.access === "public" && page.canArchive === true;
}

/** Beside the editor on a wide screen; a drawer over the content below 1024px, dismissed by an outside tap. */
function DetailsPanelFrame({ wide, onDismiss, children }: { wide: boolean; onDismiss: () => void; children: React.ReactNode }) {
  const frame = React.useRef<HTMLDivElement>(null);
  // Read during the first render, before the drawer moves focus into itself.
  const openerRef = React.useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  // As a drawer it behaves as a modal dialog: focus enters it, Tab stays inside it, and focus returns to the control that opened it.
  React.useEffect(() => {
    if (wide) return;
    const opener = openerRef.current instanceof HTMLElement ? openerRef.current : null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !frame.current) return;
      const focusable = Array.from(frame.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")).filter((node) => node.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (!frame.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", trap); opener?.focus(); };
  }, [wide]);
  if (wide) return <>{children}</>;
  return <div ref={frame} role="dialog" aria-modal="true" aria-label={translate("wiki.details")} className="fixed inset-0 z-50">
    <div aria-hidden className="absolute inset-0 bg-black/40" onClick={onDismiss} />
    {children}
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
        <tr className="border-b border-subtle bg-surface-1"><th colSpan={5} className="py-2 pr-2 text-left font-semibold text-primary"><div className="flex items-center gap-2"><span>{collection.icon} {collectionLabel(collection)}{collection.visibility === "private" ? ` · ${translate("wiki.access.private")}` : ""}</span><Popover label={`${translate("wiki.collection.actions")}: ${collection.name}`} align="right" trigger={<MoreHorizontal aria-hidden size={16} />} panelClassName="w-72">
          {(close) => <>
            <MenuItem icon={Pencil} onClick={() => { close(); setCollectionDialog({ kind: "rename", collection }); }}>{translate("wiki.collection.rename")}</MenuItem>
            {!collection.isDefault && <MenuItem icon={collection.visibility === "public" ? EyeOff : Globe} onClick={async () => { close(); await call("set_collection_visibility", { collectionId: collection.id, visibility: collection.visibility === "public" ? "private" : "public" }); await refreshCollections(); }}>{translate(collection.visibility === "public" ? "wiki.collection.makePrivate" : "wiki.collection.makePublic")}</MenuItem>}
            {!collection.isDefault && <MenuItem icon={Trash2} danger onClick={() => { close(); setCollectionDialog({ kind: "delete", collection }); }}>{translate("wiki.collection.delete")}</MenuItem>}
          </>}
        </Popover></div></th></tr>
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
  const location = useLocation();
  const navigate = useNavigate();
  const inboxNotificationId = (location.state as { inboxNotificationId?: unknown } | null)?.inboxNotificationId;
  const markedInboxNotification = React.useRef<string | null>(null);
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
  const [editorGeneration, setEditorGeneration] = React.useState(0);
  const refreshPage = React.useCallback(async () => {
    await reload();
    const fresh = await call<Page>("get_wiki_page", { pageId });
    if (fresh) setPage(fresh);
  }, [pageId, reload]);
  React.useEffect(() => { void reload(); }, [reload]);
  React.useEffect(() => { setPage(undefined); void call<Page>("get_wiki_page", { pageId }).then(async (loaded) => {
    // Another workspace's page is missing here; under a project route the page must be linked to that project.
    if (loaded && (loaded as Page & { workspaceId?: string }).workspaceId !== undefined && (loaded as Page & { workspaceId?: string }).workspaceId !== workspace.id) return setPage(null);
    if (loaded && projectKey) {
      const projects = await call<ProjectOption[]>("list_projects", { workspaceId: workspace.id, archived: false }) ?? [];
      if (!projects.some((project) => project.key === projectKey && project.id === loaded.projectId)) return setPage(null);
    }
    if (loaded && typeof inboxNotificationId === "string" && markedInboxNotification.current !== inboxNotificationId) {
      markedInboxNotification.current = inboxNotificationId;
      void markNotificationReadAfterDestinationLoaded(inboxNotificationId);
    }
    setPage(loaded);
  }); }, [pageId, workspace.id, projectKey, inboxNotificationId]);
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
    if (result) { setPublishedUrl(`${window.location.origin}/p/${result.token}`); await refreshPage(); } else setFailed(true);
  }

  async function revokePublishedLink() {
    if (await call("revoke_wiki_page_published_link", { pageId })) { setPublishedUrl(null); await refreshPage(); }
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
    // Archive and lock change the header's banner and badge, so the page is read again rather than patched.
    if (result && ["archive_wiki_page", "unarchive_wiki_page", "lock_wiki_page", "unlock_wiki_page"].includes(name)) await refreshPage();
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
      <span className="ml-auto flex items-center gap-2"><button type="button" className="secondary" aria-pressed={isFavorite} aria-label={translate(isFavorite ? "wiki.unfavorite" : "wiki.favorite")} title={translate(isFavorite ? "wiki.unfavorite" : "wiki.favorite")} onClick={() => void toggleFavorite()}><Heart aria-hidden size={14} fill={isFavorite ? "currentColor" : "none"} /></button><SidecarTrigger context={{ type: "wiki_page", id: page.id, title: page.title }} /></span>
    </nav>
    {failed && <p role="alert">{translate("wiki.failed")}</p>}
    {page.archived && <p role="status" className="text-secondary">{translate("pages.archivedReadOnly")}</p>}
    {page.locked && <p role="status" data-testid="wiki-page-locked" className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-secondary">{translate("wiki.lockedBanner")}</p>}
    <Editor key={`${page.id}:${editorGeneration}`} onResync={() => setEditorGeneration((generation) => generation + 1)} onImported={(id) => navigate(projectKey ? paths.page(workspace.slug, projectKey, id) : paths.wikiPage(workspace.slug, id))} workspaceId={workspace.id} page={page} self={self} onChanged={refreshPage} actions={{
      onLock: () => void change(page.locked ? "unlock_wiki_page" : "lock_wiki_page", {}),
      onArchive: () => void change(page.archived ? "unarchive_wiki_page" : "archive_wiki_page", {}),
      onAddSubpage: () => void create(page.id),
      onDelete: () => { if (window.confirm(translate("wiki.deleteConfirm"))) void change("delete_wiki_page", {}); },
    }} info={<>
        <label className="grid gap-1 text-secondary">{translate("wiki.access")}
          <select value={page.access} disabled={page.archived || page.ownerId !== self} onChange={(event) => void change("set_wiki_page_access", { access: event.target.value })}>
            <option value="public">{translate("wiki.access.public")}</option><option value="private">{translate("wiki.access.private")}</option>
          </select></label>
        <label className="grid gap-1 text-secondary">{translate("wiki.parent")}
          <select value={page.parentId ?? ""} disabled={page.archived} onChange={(event) => void change("move_wiki_page", { parentId: event.target.value || null })}>
            <option value="">{translate("wiki.noParent")}</option>
            {pages.filter((other) => other.id !== page.id).map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}
          </select></label>
        <div role="group" aria-label={translate("wiki.location")} className="grid gap-1.5">
          <span className="text-secondary">{translate("wiki.location")}</span>
          <select aria-label={translate("wiki.linkProject")} value={page.projectId ? `project:${page.projectId}` : `collection:${page.collectionId ?? ""}`} disabled={page.archived} onChange={(event) => {
            const [kind, id] = event.target.value.split(":", 2);
            void change("move_page_scope", kind === "project" ? { projectId: id, collectionId: null } : { projectId: null, collectionId: id || null });
          }}>
            <option value="collection:">{translate("wiki.location.default")}</option>
            {collections.filter((collection) => !collection.isDefault).map((collection) => <option key={collection.id} value={`collection:${collection.id}`}>{collection.name}</option>)}
            {projects.filter((project) => project.role === "Admin" || project.role === "Member").map((project) => <option key={project.id} value={`project:${project.id}`}>{project.key} · {project.name}</option>)}
          </select>
          <small className="text-12 text-tertiary">{translate("wiki.location.help")}</small>
        </div>
        {canPublishHere(page) && <section id="wiki-published-link" aria-label={translate("wiki.publishedLink")} className="grid gap-2 border-t border-subtle pt-3">
          <span className="font-medium text-primary">{translate("wiki.publishedLink")}</span>
          {publishedUrl ? <><a className="break-all text-secondary underline" href={publishedUrl} target="_blank" rel="noreferrer">{publishedUrl}</a><button type="button" className="secondary" onClick={() => void revokePublishedLink()}>{translate("wiki.revokePublishedLink")}</button></>
            : page.published ? <><span className="text-secondary">{translate("wiki.published")}</span><button type="button" className="secondary" onClick={() => void revokePublishedLink()}>{translate("wiki.revokePublishedLink")}</button></>
            : <button type="button" className="secondary" onClick={() => void publishPage()}>{translate("wiki.publishLink")}</button>}
        </section>}
        {!page.projectId && page.ownerId === self && <section id="wiki-share-members" aria-label={translate("wiki.shareMembers")} className="grid gap-2 border-t border-subtle pt-3">
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
