import { accessReasonText } from "./access-reason";
import React from "react";
import { Bot, Code2 } from "lucide-react";
import { formatDate, translate, translateDynamic } from "@weft/shared";
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import type { SuggestionProps } from "@tiptap/suggestion";
import { Avatar, avatarElement } from "./avatar";
import { readOnlyImages, useAssetImages } from "./asset-images";
import { AssistMenu } from "./assist-menu";
import { AiAssist } from "./editor-assist";
import { EditorPlaceholder, EmojiSuggestions, ListIndent, MarkdownPaste, SafeLinkClick, SlashMenu, blockCommands, suggestionOpen, surfaceEditorExtensions, wikiCommands } from "./editor-extensions";
import { TableControls } from "./table-controls";
import { copyText } from "./toast";
import { normalizeAssetImages } from "../../../packages/actions/src/wiki-yjs";
import { autoRuleReasonText, undoableAutoRuleIds } from "./auto-rule-reason";
import { richTextActionError } from "./api";
import { groupActivities, readableActivityValue } from "./activity-groups";
import { EditorSourceMode, editorLimitWarnings } from "./editor-source-mode";
import { EditorToolbar } from "./editor-toolbar";
import { withShortcut } from "./shortcuts";

type Props = SuggestionProps<{ id: string; label: string; isAgent?: boolean; codeCapable?: boolean }, { id: string; label: string; isAgent?: boolean; codeCapable?: boolean }>;

type Person = { userId: string; name: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null; accessAsk?: "owner" | "admin" | null; accessOwnerName?: string | null };
type CommentRow = {
  id: string; authorId: string; authorName: string; authorIsAgent?: boolean; authorCodeCapable?: boolean; runId?: string | null; body: unknown; createdAt: string; editedAt: string | null;
  parentId: string | null; replyCount: number; participants: Array<{ userId: string; name: string }>;
};
type Version = { id: string; bodyText: string; body: unknown; writtenAt: string };
type ActivityRow = { id: string; field: string; actorId: string; actorName: string; actorIsAgent?: boolean; actorCodeCapable?: boolean; source: string; originatorName?: string | null; runId?: string | null; reason?: string | null; wokenBy?: { runId: string | null; agentName: string; depth: number } | null; createdAt: string; oldValue: unknown; newValue: unknown };
type Entry = { kind: "comment" | "activity"; createdAt: string; comment: (CommentRow & { replies: CommentRow[] }) | null; activity: ActivityRow | null };
type Filter = "all" | "comments" | "updates";
type Sort = "newest" | "oldest";
type Action = <T>(name: string, body: unknown) => Promise<T | null>;
type ActionResult = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string; code?: string }>;

function mentionExtension(people: React.RefObject<Person[]>) {
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: {
      char: "@",
      items: ({ query }: { query: string }) => (people.current ?? []).filter((person) => person.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(!!a.isAgent) - Number(!!b.isAgent) || a.name.localeCompare(b.name)).slice(0, 8).map((person) => ({ id: person.userId, label: person.name, isAgent: person.isAgent, codeCapable: person.codeCapable, hasAccess: person.hasAccess, accessReason: accessReasonText(person) })),
      render: () => {
        let box: HTMLUListElement | null = null;
        let selected = 0;
        let current: { items: Array<{ id: string; label: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null; accessAsk?: "owner" | "admin" | null; accessOwnerName?: string | null }>; command: (item: { id: string; label: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null }) => void } | null = null;
        const paint = () => {
          if (!box || !current) return;
          const grouped = current.items.some((item) => item.isAgent);
          box.replaceChildren(...current.items.flatMap((item, index) => {
            const nodes: HTMLLIElement[] = [];
            if (grouped && (index === 0 || current!.items[index - 1]!.isAgent !== item.isAgent)) { const heading = document.createElement("li"); heading.textContent = translate(item.isAgent ? "agents.group" : "members.group"); heading.style.cssText = "padding:4px 8px;color:var(--txt-tertiary);font-size:11px;font-weight:600;text-transform:uppercase"; heading.setAttribute("role", "presentation"); nodes.push(heading); }
            const li = document.createElement("li");
            const unavailable = item.isAgent && item.hasAccess === false;
            li.append(avatarElement(item.label, item.id, !!item.isAgent));
            li.append(document.createTextNode(item.label));
            if (item.isAgent) {
              const badge = document.createElement("span"); badge.textContent = translate("comments.agent"); badge.style.cssText = "margin-left:6px;font-size:10px;font-weight:500;color:var(--txt-tertiary);"; badge.title = translate("avatar.agentHint"); li.append(badge);
              if (item.codeCapable) { const code = document.createElement("span"); code.textContent = " · Code"; code.style.color = "var(--txt-secondary)"; li.append(code); }
            }
            li.setAttribute("role", "option");
            li.setAttribute("aria-disabled", String(!!unavailable));
            li.style.cssText += `;display:flex;align-items:center;${unavailable ? "opacity:.45;cursor:not-allowed;" : "cursor:pointer;"}${index === selected ? "font-weight:bold;" : ""}`;
            if (unavailable && item.accessReason) { const reason = document.createElement("small"); reason.textContent = item.accessReason; reason.style.cssText = "display:block;color:var(--txt-tertiary);margin-left:22px"; li.append(reason); }
            li.onmousedown = (event) => { event.preventDefault(); if (!unavailable) current?.command(item); };
            nodes.push(li); return nodes;
          }));
        };
        const place = (rect?: (() => DOMRect | null) | null) => {
          const bounds = rect?.();
          if (!box || !bounds) return;
          // Below the caret when it fits, otherwise above it; kept inside the viewport width.
          const height = box.offsetHeight;
          const below = bounds.bottom + height <= window.innerHeight || bounds.top < height;
          const left = Math.max(8, Math.min(bounds.left, window.innerWidth - box.offsetWidth - 8));
          box.style.left = `${left + window.scrollX}px`;
          box.style.top = `${(below ? bounds.bottom : bounds.top - height) + window.scrollY}px`;
        };
        // The popup is absolute to the page, so a resize (rotation, window size) moves the caret but not the popup until it is placed again.
        let current_rect: (() => DOMRect | null) | null = null;
        const reflow = () => place(current_rect);
        return {
          onStart: (props: Props) => {
            current = props; selected = 0;
            box = document.createElement("ul");
            box.setAttribute("role", "listbox");
            box.style.cssText = "position:absolute;background:var(--bg-surface-1);color:var(--txt-primary);border:1px solid var(--border-strong);border-radius:.375rem;box-shadow:0 4px 12px rgb(0 0 0/.12);margin:0;padding:4px;list-style:none;z-index:50";
            document.body.append(box); paint(); current_rect = props.clientRect ?? null; place(props.clientRect);
            window.addEventListener("resize", reflow);
          },
          onUpdate: (props: Props) => { current = props; selected = 0; paint(); current_rect = props.clientRect ?? null; place(props.clientRect); },
          onKeyDown: ({ event }: { event: KeyboardEvent }) => {
            if (!current || current.items.length === 0) return false;
            if (event.key === "ArrowDown") { selected = (selected + 1) % current.items.length; paint(); return true; }
            if (event.key === "ArrowUp") { selected = (selected + current.items.length - 1) % current.items.length; paint(); return true; }
            if (event.key === "Enter") { const item = current.items[selected]!; if (item.isAgent && item.hasAccess === false) return true; current.command(item); return true; }
            return false;
          },
          onExit: () => { window.removeEventListener("resize", reflow); box?.remove(); box = null; current = null; current_rect = null; },
        };
      },
    },
  });
}

/** Ctrl/⌘+Enter submits (a new comment, an edited comment or a reply); Escape cancels an edit or a reply. Priority beats the editor's own Mod-Enter, which would insert a line break. */
const CommentKeys = Extension.create<{ submit: React.RefObject<() => Promise<void>>; cancel: React.RefObject<(() => void) | undefined> }>({
  name: "commentKeys",
  priority: 1200,
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => { void this.options.submit.current(); return true; },
      Escape: () => { const cancel = this.options.cancel.current; if (!cancel || suggestionOpen(this.editor)) return false; cancel(); return true; },
    };
  },
});

function CommentEditor({ workspaceId, workItemId, people, initial, submitLabel, onSubmit, onCancel }: { workspaceId: string; workItemId: string; people: Person[]; initial?: unknown; submitLabel: string; onSubmit: (body: unknown) => Promise<void>; onCancel?: () => void }) {
  const peopleRef = React.useRef(people);
  peopleRef.current = people;
  // The editor is created once, so its keys reach the latest submit and cancel through these refs.
  const submitRef = React.useRef<() => Promise<void>>(async () => undefined);
  const cancelRef = React.useRef(onCancel);
  cancelRef.current = onCancel;
  // Comment images are owned by the work item: the comment row does not exist yet while its text is being written.
  const { extension: images, error, uploadFile } = useAssetImages({ ownerType: "work_item", ownerId: workItemId });
  const picker = React.useRef<HTMLInputElement>(null);
  const limitWarnings = React.useMemo(() => editorLimitWarnings(initial), [initial]);
  const editor = useEditor({ extensions: [...surfaceEditorExtensions({ surface: "full", mention: mentionExtension(peopleRef), image: images }), ListIndent, MarkdownPaste, EmojiSuggestions, AiAssist, SlashMenu.configure({ commands: [...blockCommands, ...wikiCommands.filter((command) => ["todo", "table", "callout", "emoji", "color", "image"].includes(command.id))], onImage: () => picker.current?.click() }), SafeLinkClick, EditorPlaceholder, CommentKeys.configure({ submit: submitRef, cancel: cancelRef })], content: normalizeAssetImages((initial as object | undefined) ?? "") });
  const submit = async () => { if (!editor || editor.isEmpty) return; await onSubmit(editor.getJSON()); if (!initial) editor.commands.clearContent(); };
  submitRef.current = submit;
  const sourceToggle = React.useRef<(() => void) | null>(null);
  const [sourceActive, setSourceActive] = React.useState(false);
  return <div className="min-w-0 max-w-full">
    <EditorToolbar editor={editor} label={translate("comments.toolbar")} testId="comment-toolbar" onImage={() => picker.current?.click()} source={editor?.isEditable ? { active: sourceActive, onToggle: () => sourceToggle.current?.() } : undefined} />
    <div className="comment-editor relative" data-testid="comment-editor"><EditorSourceMode editor={editor} initialWarnings={limitWarnings} toggleRef={sourceToggle} onModeChange={setSourceActive} /><TableControls editor={editor} editable /><EditorContent editor={editor} aria-label={translate("comments.placeholder")} /><AssistMenu editor={editor} workspaceId={workspaceId} /></div>
    {error && <p role="alert">{error}</p>}
    <input ref={picker} data-testid="comment-image-input" hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const assetId = await uploadFile(file); if (assetId) editor.commands.insertContentAt(editor.state.doc.content.size, { type: "assetImage", attrs: { assetId } }); }} />
    <div className="editor-footer mt-2 flex flex-wrap items-center justify-end gap-2">
      <button className="primary" title={withShortcut(submitLabel, "Enter")} onClick={() => void submit()}>{submitLabel}</button>
      {onCancel && <button type="button" className="secondary" onClick={onCancel}>{translate("comments.cancel")}</button>}
    </div>
  </div>;
}

function CommentBody({ body }: { body: unknown }) {
  const editor = useEditor({ extensions: [...surfaceEditorExtensions({ surface: "full", mention: Mention.configure({ HTMLAttributes: { class: "mention" } }), image: readOnlyImages }), SafeLinkClick], content: normalizeAssetImages(body), editable: false });
  return <div className="comment-body"><EditorContent editor={editor} /></div>;
}

const VERSIONS_PAGE = 20;
// The filter is remembered per viewer in this browser; a stored value that is not a known filter falls back to Comments.
const filterKey = (userId: string) => `weft:timeline-filter:${userId}`;
function storedFilter(userId: string): Filter {
  try { const stored = localStorage.getItem(filterKey(userId)); if (stored === "comments" || stored === "updates" || stored === "all") return stored; } catch { /* storage unavailable: Comments */ }
  return "comments";
}
export function TimelinePanel({ workspaceId, workItemId, projectId, selfId, canComment, linkBase, action, actionResult, onChange, refreshKey = 0 }: { workspaceId: string; workItemId: string; projectId: string; selfId: string; canComment: boolean; linkBase: string; action: Action; actionResult: ActionResult; onChange: () => void; refreshKey?: number }) {
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [filter, setFilterState] = React.useState<Filter>(() => storedFilter(selfId));
  const setFilter = (next: Filter) => { setFilterState(next); try { localStorage.setItem(filterKey(selfId), next); } catch { /* storage unavailable: the choice lasts for this visit */ } };
  const [sort, setSort] = React.useState<Sort>("oldest");
  const [showAllChanges, setShowAllChanges] = React.useState(false);
  const [versions, setVersions] = React.useState<{ commentId: string; rows: Version[]; more: boolean; failed: boolean; loading: boolean } | null>(null);
  const rows = React.useMemo(() => entries.flatMap((entry) => entry.comment ? [entry.comment, ...entry.comment.replies] : []), [entries]);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [replying, setReplying] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [expandedActivityId, setExpandedActivityId] = React.useState<string | null>(null);
  const scrolled = React.useRef(false);
  const load = React.useCallback(async () => {
    setEntries(await action<Entry[]>("list_timeline", { workItemId, filter, sort }) ?? []);
    setPeople(await action<Person[]>("list_mentionable_members", { projectId }) ?? []);
  }, [action, workItemId, projectId, filter, sort, refreshKey]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { const refresh = () => { void load(); }; window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, [load]);
  // A link ends in #comment-<id>; an unknown or deleted id matches nothing and the work item shows as usual.
  React.useEffect(() => {
    if (scrolled.current || rows.length === 0) return;
    const target = decodeURIComponent(window.location.hash.slice(1));
    if (!target.startsWith("comment-")) return;
    const element = document.getElementById(target);
    if (element) { scrolled.current = true; element.scrollIntoView({ block: "center" }); }
  }, [rows]);
  const guard = async (result: unknown) => {
    const failure = result && typeof result === "object" && "error" in result ? result as { code?: string } : null;
    setNote(failure ? richTextActionError(failure.code) : result === null ? translate("comments.failed") : null);
    await load(); onChange();
  };
  const copy = (id: string) => copyText(`${window.location.origin}${linkBase}#comment-${id}`, translate("comments.linkCopied"), translate("comments.copyFailed"));
  const showVersions = async (commentId: string) => {
    if (versions?.commentId === commentId) { setVersions(null); return; }
    const result = await action<Version[]>("list_comment_versions", { commentId, limit: VERSIONS_PAGE });
    if (result === null) { setNote(translate("comments.historyDenied")); return; }
    setNote(null); setVersions({ commentId, rows: result, more: result.length >= VERSIONS_PAGE, failed: false, loading: false });
  };
  // Older versions follow the cursor: the id of the last version shown. A failed request keeps the button and shows an error with a retry.
  const showOlderVersions = async () => {
    const current = versions;
    const last = current?.rows.at(-1);
    if (!current || !last || current.loading) return;
    setVersions({ ...current, loading: true, failed: false });
    const result = await action<Version[]>("list_comment_versions", { commentId: current.commentId, limit: VERSIONS_PAGE, after: last.id });
    setVersions((now) => now && now.commentId === current.commentId ? (result === null ? { ...now, loading: false, failed: true } : { ...now, rows: [...now.rows, ...result], more: result.length >= VERSIONS_PAGE, loading: false, failed: false }) : now);
  };
  const item = (row: CommentRow, replies: CommentRow[]) => <li key={row.id} id={`comment-${row.id}`} className={`grid min-w-0 list-none gap-2 rounded-lg border border-subtle p-3 ${row.parentId === null ? "bg-surface-1" : "bg-layer-1"}`}>
    <div className="flex flex-wrap items-center gap-x-2"><Avatar name={row.authorName} id={row.authorId} agent={row.authorIsAgent} /><strong className="text-13 text-primary">{row.authorName}</strong>{row.authorIsAgent && <> <mark data-agent-marker title={translate("avatar.agentHint")} className="inline-flex items-center gap-1 rounded bg-layer-1 px-1.5 py-0.5 text-10 font-medium text-secondary"><span title={translate("comments.agent")}><Bot aria-hidden size={12} className="inline" /></span> {translate("comments.agent")}</mark>{row.authorCodeCapable && <span className="inline-flex items-center gap-1 rounded bg-layer-1 px-1.5 py-0.5 text-10 text-secondary" title={translate("agents.codeCapable")}><Code2 aria-hidden size={13} className="text-warning-primary" />{translate("agents.canEditCode")}</span>}</>} <small className="text-12 text-tertiary">{formatDate(row.createdAt)}{row.editedAt ? ` · ${translate("comments.edited")}` : ""}</small>
    {row.runId && <small> <a href={`?run=${row.runId}`}>{translate("comments.viewRun")}</a></small>}</div>
    {editing === row.id
      ? <CommentEditor workspaceId={workspaceId} workItemId={workItemId} people={people} initial={row.body} submitLabel={translate("comments.save")} onCancel={() => setEditing(null)} onSubmit={async (body) => { await guard(await actionResult("update_comment", { commentId: row.id, body })); setEditing(null); }} />
      : <CommentBody body={row.body} />}
    <p className="flex flex-wrap gap-1">
      {editing !== row.id && row.parentId === null && canComment && <button className="secondary" onClick={() => setReplying(row.id)}>{translate("comments.reply")}</button>}
      {editing !== row.id && <button className="secondary" onClick={() => void copy(row.id)}>{translate("comments.copyLink")}</button>}
      {row.editedAt && <button className="secondary" onClick={() => void showVersions(row.id)}>{translate("comments.history")}</button>}
      {row.authorId === selfId && editing !== row.id && <>
        <button className="secondary" onClick={() => setEditing(row.id)}>{translate("comments.edit")}</button>
        <button className="secondary" onClick={async () => guard(await action("delete_comment", { commentId: row.id }))}>{translate("comments.delete")}</button>
      </>}
    </p>
    {versions?.commentId === row.id && <ol aria-label={translate("comments.history")}>
      {versions.rows.length === 0 && <li>{translate("comments.historyEmpty")}</li>}
      {versions.rows.map((version) => <li key={version.id}><small>{formatDate(version.writtenAt)}</small> {version.bodyText}</li>)}
      {versions.failed && <li role="alert" data-testid="older-comment-versions-error">{translate("workItems.olderVersionsFailed")}</li>}
      {versions.more && <li><button type="button" className="secondary" data-testid="show-older-comment-versions" disabled={versions.loading} aria-busy={versions.loading} onClick={() => void showOlderVersions()}>{versions.loading ? translate("workItems.loadingOlderVersions") : versions.failed ? translate("workItems.retryOlderVersions") : translate("workItems.showOlderVersions")}</button></li>}
    </ol>}
    {row.parentId === null && row.replyCount > 0 && <small>{translate(row.replyCount === 1 ? "comments.repliesOne" : "comments.repliesMany").replace("{count}", String(row.replyCount))} · {row.participants.map((person) => person.name).join(", ")}</small>}
    {replies.length > 0 && <ul className="m-0 grid list-none gap-2 border-l-2 border-subtle !pl-3">{replies.map((reply) => item(reply, []))}</ul>}
    {replying === row.id && <CommentEditor workspaceId={workspaceId} workItemId={workItemId} people={people} submitLabel={translate("comments.reply")} onCancel={() => setReplying(null)} onSubmit={async (body) => { await guard(await actionResult("create_comment", { workItemId, body, parentId: row.id })); setReplying(null); }} />}
  </li>;
  const activityText = (row: ActivityRow) => row.field === "created" ? translate("workItems.activity.created") : row.field === "deleted" ? translate("workItems.activity.deleted") : row.field === "attachment_added" ? translate("workItems.activity.attachment_added") : row.field === "wake_skipped" ? translate(`workItems.activity.wake_skipped.${String((row.newValue as { reason?: unknown } | null)?.reason)}` as never) : row.field === "archived" || row.field === "restored" || row.field === "run_waiting" || row.field === "run_started" || row.field === "run_steered" ? translate(`workItems.activity.${row.field}` as never) : row.field.startsWith("web_link_") || row.field.startsWith("pull_request_") || row.field === "relation_added" || row.field === "relation_removed" ? translate(`workItems.activity.${row.field}` as never) : translate("workItems.activity.changed").replace("{field}", translateDynamic(`activity.field.${row.field}`) ?? (row.field.startsWith("property:") ? row.field.slice("property:".length) : row.field));
  const activityRows = groupActivities(entries.flatMap((entry) => entry.activity ? [entry.activity] : []), showAllChanges);
  const displayByActivityId = new Map<string, { kind: "activity"; activity: ActivityRow } | { kind: "group"; group: Extract<(typeof activityRows)[number], { kind: "group" }> }>();
  for (const row of activityRows) {
    if (row.kind === "activity") displayByActivityId.set(row.id, { kind: "activity", activity: row.activity });
    else if (showAllChanges) for (const activity of row.activities) displayByActivityId.set(activity.id, { kind: "activity", activity });
    else displayByActivityId.set(row.id, { kind: "group", group: row });
  }
  const actor = (row: ActivityRow) => <><Avatar name={row.actorName} id={row.actorId} agent={row.actorIsAgent} /><strong className="font-medium text-primary">{row.actorName}</strong>{row.actorIsAgent && <> <mark data-agent-marker title={translate("avatar.agentHint")} className="inline-flex items-center gap-1 rounded bg-layer-1 px-1.5 py-0.5 text-10 font-medium text-secondary"><span title={translate("comments.agent")}><Bot aria-hidden size={12} className="inline" /></span> {translate("comments.agent")}</mark>{row.actorCodeCapable && <span className="inline-flex items-center gap-1 rounded bg-layer-1 px-1.5 py-0.5 text-10 text-secondary" title={translate("agents.codeCapable")}><Code2 aria-hidden size={13} className="text-warning-primary" />{translate("agents.canEditCode")}</span>}</>}</>;
  // An automatic rule is shown as the system, with its reason and an undo while the change is still the item's latest.
  const undoAutoRule = async (row: ActivityRow) => {
    const result = await action("undo_auto_rule_change", { activityId: row.id });
    if (result === null) setNote(translate("autoRules.undoFailed")); else { setNote(null); await load(); onChange(); }
  };
  // "old → new" for a property change, with the labels the server resolved; a value that is still an id shows nothing.
  const transition = (row: ActivityRow) => {
    if (!row.field.startsWith("property:")) return null;
    const oldText = readableActivityValue(row.oldValue); const newText = readableActivityValue(row.newValue);
    return oldText !== null && newText !== null ? <span className="ml-1 inline-flex flex-wrap gap-x-1"><span>{oldText} →</span><span>{translate("timeline.valueNewLabel")} {newText}</span></span> : null;
  };
  const undoable = undoableAutoRuleIds((sort === "oldest" ? entries : [...entries].reverse()).flatMap((entry) => entry.activity ? [entry.activity] : []));
  // A started Run that a wake started names the Run that woke it: a link when the viewer may open it, otherwise the name alone, and its depth.
  const wokenByText = (row: ActivityRow) => row.wokenBy ? <span className="inline-flex flex-wrap items-baseline gap-x-1" data-testid="activity-woken-by">
    <span aria-hidden>·</span>{row.wokenBy.runId ? <a href={`?run=${row.wokenBy.runId}`}>{translate("runs.wokenBy").replace("{agent}", row.wokenBy.agentName)}</a> : <span>{translate("runs.wokenBy").replace("{agent}", row.wokenBy.agentName)}</span>}
    <span>· {translate("runs.wokenByDepth").replace("{depth}", String(row.wokenBy.depth))}</span>
  </span> : null;
  const renderActivity = (row: ActivityRow) => row.source === "auto_rule" ? <>
    <strong className="font-medium text-primary">{translate("autoRules.systemActor")}</strong> {autoRuleReasonText(row.reason ?? null, translate) ?? activityText(row)}{transition(row)}{" "}
    {canComment && undoable.has(row.id) && <button type="button" className="secondary ml-1 !px-2 !py-0.5 text-12" onClick={() => void undoAutoRule(row)}>{translate("autoRules.undo")}</button>}{" "}
    <small className="text-12 text-tertiary">{formatDate(row.createdAt)}</small></> : <>{actor(row)} {row.field === "recurrence_created" ? translate("workItems.activity.fromRecurrence").replace("{name}", String((row.newValue as { name?: string } | null)?.name ?? "")) : activityText(row)}{transition(row)}{wokenByText(row)}{" "}
    <small className="text-12 text-tertiary">{["agent", "agent_autopilot"].includes(row.source) && row.originatorName ? translate(row.source === "agent_autopilot" ? "activity.byAutopilotAgent" : "activity.byAgent").replace("{originator}", row.originatorName) : translate("workItems.via").replace("{source}", translateDynamic(`activity.source.${row.source}`) ?? row.source)} · {formatDate(row.createdAt)}</small></>;
  return <section className="min-w-0 max-w-full">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
    <h3>{translate("timeline.title")}</h3>
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-11 text-secondary"><span>{translate("timeline.filter")}</span><select aria-label={translate("timeline.filter")} value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
        <option value="comments">{translate("timeline.comments")}</option><option value="updates">{translate("timeline.activity")}</option><option value="all">{translate("timeline.all")}</option>
      </select></label>
      <label className="flex items-center gap-1 text-11 text-secondary"><span>{translate("timeline.sort")}</span><select aria-label={translate("timeline.sort")} value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
        <option value="oldest">{translate("timeline.oldest")}</option><option value="newest">{translate("timeline.newest")}</option>
      </select></label>
    </div>
    </div>
    {entries.some((entry) => entry.activity) && <button type="button" className="secondary mb-3" aria-pressed={showAllChanges} onClick={() => setShowAllChanges((value) => !value)}>{translate(showAllChanges ? "timeline.showGrouped" : "timeline.showAllChanges")}</button>}
    {entries.length === 0 && <p>{translate("timeline.empty")}</p>}
    <ul className="m-0 grid min-w-0 max-w-full list-none gap-2 !pl-0">{entries.map((entry) => entry.comment
      ? item(entry.comment, entry.comment.replies)
      : (() => {
        const display = displayByActivityId.get(entry.activity!.id);
        if (!display) return null;
        const listClass = "flex list-none flex-wrap items-baseline gap-x-1.5 px-1 py-0.5 text-13 text-secondary before:mr-1 before:size-1.5 before:self-center before:rounded-full before:bg-[var(--border-strong)] before:content-['']";
        if (display.kind === "activity") return <li key={entry.activity!.id} className={listClass}>{renderActivity(display.activity)}</li>;
        const group = display.group;
        const oldText = readableActivityValue(group.oldValue); const newText = readableActivityValue(group.newValue);
        const latest = group.activities.reduce((a, b) => Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a);
        const expanded = expandedActivityId === group.id;
        return <li key={group.id} className="list-none min-w-0 max-w-full rounded-md bg-surface-1 px-2 py-1 text-13 text-secondary">
          <button type="button" aria-expanded={expanded} aria-controls={`activity-group-${group.id}`} className="grid w-full min-w-0 max-w-full box-border grid-cols-[0.75rem_minmax(0,1fr)] items-start gap-x-1.5 gap-y-1 whitespace-normal border-0 bg-transparent p-1 text-left text-secondary">
            <span aria-hidden className="inline-block w-3 shrink-0">{expanded ? "▾" : "▸"}</span><span className="flex min-w-0 flex-wrap items-center gap-x-1.5">{actor(latest)}<span className="activity-group-summary min-w-0">{activityText(group.activities[0]!)} · {translate("timeline.changeCount").replace("{count}", String(group.count))}</span></span>
            {oldText !== null && newText !== null && <span className="activity-group-summary col-span-2 min-w-0 pl-4">{oldText}<br />{translate("timeline.valueNewLabel")} {newText}</span>}
            <small className="activity-group-summary col-span-2 min-w-0 pl-4 text-12 text-tertiary">{latest.source === "agent" && latest.originatorName ? translate("activity.byAgent").replace("{originator}", latest.originatorName) : translate("workItems.via").replace("{source}", translateDynamic(`activity.source.${latest.source}`) ?? latest.source)} · {formatDate(latest.createdAt)}</small>
          </button>
          {expanded && <ol id={`activity-group-${group.id}`} className="ml-4 mt-2 grid gap-1">{group.activities.map((activity) => <li key={activity.id}>{renderActivity(activity)}</li>)}</ol>}
        </li>;
      })())}</ul>
    {canComment && <div className="sticky bottom-0 z-10 mt-4 border-t border-subtle bg-surface-1 pt-4"><CommentEditor workspaceId={workspaceId} workItemId={workItemId} people={people} submitLabel={translate("comments.add")} onSubmit={async (body) => guard(await actionResult("create_comment", { workItemId, body }))} /></div>}
    {note && <p role="alert">{note}</p>}
  </section>;
}
