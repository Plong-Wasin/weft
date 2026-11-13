import React from "react";
import { Bold, Bot, Code, Code2, ImagePlus, Italic, Link2, List, ListOrdered, Quote, Strikethrough } from "lucide-react";
import { formatDate, translate, translateDynamic } from "@weft/shared";
import { EditorContent, useEditor } from "@tiptap/react";
import Mention from "@tiptap/extension-mention";
import type { SuggestionProps } from "@tiptap/suggestion";
import { readOnlyImages, useAssetImages } from "./asset-images";
import { AssistMenu } from "./assist-menu";
import { AiAssist } from "./editor-assist";
import { EditorPlaceholder, EmojiSuggestions, ListIndent, MarkdownPaste, SafeLinkClick, SlashMenu, blockCommands, surfaceEditorExtensions, wikiCommands } from "./editor-extensions";
import { TableControls } from "./table-controls";
import { copyText } from "./toast";
import { normalizeAssetImages } from "../../../packages/actions/src/wiki-yjs";
import { groupActivities, readableActivityValue } from "./activity-groups";

type Props = SuggestionProps<{ id: string; label: string; isAgent?: boolean; codeCapable?: boolean }, { id: string; label: string; isAgent?: boolean; codeCapable?: boolean }>;

type Person = { userId: string; name: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null };
type CommentRow = {
  id: string; authorId: string; authorName: string; authorIsAgent?: boolean; authorCodeCapable?: boolean; runId?: string | null; body: unknown; createdAt: string; editedAt: string | null;
  parentId: string | null; replyCount: number; participants: Array<{ userId: string; name: string }>;
};
type Version = { id: string; bodyText: string; body: unknown; writtenAt: string };
type ActivityRow = { id: string; field: string; actorId: string; actorName: string; actorIsAgent?: boolean; actorCodeCapable?: boolean; source: string; originatorName?: string | null; runId?: string | null; createdAt: string; oldValue: unknown; newValue: unknown };
type Entry = { kind: "comment" | "activity"; createdAt: string; comment: (CommentRow & { replies: CommentRow[] }) | null; activity: ActivityRow | null };
type Filter = "all" | "comments" | "updates";
type Sort = "newest" | "oldest";
type Action = <T>(name: string, body: unknown) => Promise<T | null>;

function mentionExtension(people: React.RefObject<Person[]>) {
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: {
      char: "@",
      items: ({ query }: { query: string }) => (people.current ?? []).filter((person) => person.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(!!a.isAgent) - Number(!!b.isAgent) || a.name.localeCompare(b.name)).slice(0, 8).map((person) => ({ id: person.userId, label: person.name, isAgent: person.isAgent, codeCapable: person.codeCapable, hasAccess: person.hasAccess, accessReason: person.accessReason })),
      render: () => {
        let box: HTMLUListElement | null = null;
        let selected = 0;
        let current: { items: Array<{ id: string; label: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null }>; command: (item: { id: string; label: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null }) => void } | null = null;
        const paint = () => {
          if (!box || !current) return;
          const grouped = current.items.some((item) => item.isAgent);
          box.replaceChildren(...current.items.flatMap((item, index) => {
            const nodes: HTMLLIElement[] = [];
            if (grouped && (index === 0 || current!.items[index - 1]!.isAgent !== item.isAgent)) { const heading = document.createElement("li"); heading.textContent = translate(item.isAgent ? "agents.group" : "members.group"); heading.style.cssText = "padding:4px 8px;color:var(--txt-tertiary);font-size:11px;font-weight:600;text-transform:uppercase"; heading.setAttribute("role", "presentation"); nodes.push(heading); }
            const li = document.createElement("li");
            const unavailable = item.isAgent && item.hasAccess === false;
            if (item.isAgent) {
              const icon = document.createElement("span"); icon.setAttribute("aria-hidden", "true"); icon.textContent = "◉"; icon.style.marginRight = "6px"; li.append(icon);
              li.append(document.createTextNode(item.label));
              const badge = document.createElement("span"); badge.textContent = " Agent"; badge.style.color = "var(--txt-tertiary)"; li.append(badge);
              if (item.codeCapable) { const code = document.createElement("span"); code.textContent = " · Code"; code.style.color = "var(--txt-secondary)"; li.append(code); }
            } else li.textContent = item.label;
            li.setAttribute("role", "option");
            li.setAttribute("aria-disabled", String(!!unavailable));
            li.style.cssText += `;${unavailable ? "opacity:.45;cursor:not-allowed;" : "cursor:pointer;"}${index === selected ? "font-weight:bold;" : ""}`;
            if (unavailable && item.accessReason) { const reason = document.createElement("small"); reason.textContent = item.accessReason; reason.style.cssText = "display:block;color:var(--txt-tertiary);margin-left:22px"; li.append(reason); }
            li.onmousedown = (event) => { event.preventDefault(); if (!unavailable) current?.command(item); };
            nodes.push(li); return nodes;
          }));
        };
        const place = (rect?: (() => DOMRect | null) | null) => {
          const bounds = rect?.();
          if (box && bounds) { box.style.left = `${bounds.left + window.scrollX}px`; box.style.top = `${bounds.bottom + window.scrollY}px`; }
        };
        return {
          onStart: (props: Props) => {
            current = props; selected = 0;
            box = document.createElement("ul");
            box.setAttribute("role", "listbox");
            box.style.cssText = "position:absolute;background:var(--bg-surface-1);color:var(--txt-primary);border:1px solid var(--border-strong);border-radius:.375rem;box-shadow:0 4px 12px rgb(0 0 0/.12);margin:0;padding:4px;list-style:none;z-index:50";
            document.body.append(box); paint(); place(props.clientRect);
          },
          onUpdate: (props: Props) => { current = props; selected = 0; paint(); place(props.clientRect); },
          onKeyDown: ({ event }: { event: KeyboardEvent }) => {
            if (!current || current.items.length === 0) return false;
            if (event.key === "ArrowDown") { selected = (selected + 1) % current.items.length; paint(); return true; }
            if (event.key === "ArrowUp") { selected = (selected + current.items.length - 1) % current.items.length; paint(); return true; }
            if (event.key === "Enter") { const item = current.items[selected]!; if (item.isAgent && item.hasAccess === false) return true; current.command(item); return true; }
            return false;
          },
          onExit: () => { box?.remove(); box = null; current = null; },
        };
      },
    },
  });
}

function CommentEditor({ workspaceId, workItemId, people, initial, submitLabel, onSubmit, onCancel }: { workspaceId: string; workItemId: string; people: Person[]; initial?: unknown; submitLabel: string; onSubmit: (body: unknown) => Promise<void>; onCancel?: () => void }) {
  const peopleRef = React.useRef(people);
  peopleRef.current = people;
  // Comment images are owned by the work item: the comment row does not exist yet while its text is being written.
  const { extension: images, error, uploadFile } = useAssetImages({ ownerType: "work_item", ownerId: workItemId });
  const picker = React.useRef<HTMLInputElement>(null);
  const editor = useEditor({ extensions: [...surfaceEditorExtensions({ surface: "full", mention: mentionExtension(peopleRef), image: images }), ListIndent, MarkdownPaste, EmojiSuggestions, AiAssist, SlashMenu.configure({ commands: [...blockCommands, ...wikiCommands.filter((command) => ["todo", "table", "callout", "emoji", "color"].includes(command.id))] }), SafeLinkClick, EditorPlaceholder], content: normalizeAssetImages((initial as object | undefined) ?? "") });
  const [, refreshToolbar] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => { if (!editor) return; editor.on("transaction", refreshToolbar); return () => { editor.off("transaction", refreshToolbar); }; }, [editor]);
  return <div>
    <div className="comment-editor relative" data-testid="comment-editor"><TableControls editor={editor} editable compact /><div role="toolbar" aria-label={translate("comments.toolbar")} data-testid="comment-toolbar" className="flex flex-wrap gap-1">{[
      ["wiki.tool.bold", Bold, () => editor?.chain().focus().toggleBold().run()], ["wiki.tool.italic", Italic, () => editor?.chain().focus().toggleItalic().run()], ["wiki.tool.strike", Strikethrough, () => editor?.chain().focus().toggleStrike().run()], ["wiki.tool.bulletList", List, () => editor?.chain().focus().toggleBulletList().run()], ["wiki.tool.orderedList", ListOrdered, () => editor?.chain().focus().toggleOrderedList().run()], ["wiki.tool.quote", Quote, () => editor?.chain().focus().toggleBlockquote().run()], ["wiki.tool.codeBlock", Code, () => editor?.chain().focus().toggleCodeBlock().run()],
    ].map(([label, Icon, run]) => { const name = translate(label as never); const ToolIcon = Icon as typeof Bold; return <button key={label as string} className="editor-tool" type="button" aria-label={name} title={name} onMouseDown={(event) => event.preventDefault()} onClick={run as () => void}><ToolIcon size={14} /></button>; })}<button className="editor-tool" type="button" aria-label={translate("wiki.tool.link")} title={translate("wiki.tool.link")} onMouseDown={(event) => event.preventDefault()} onClick={() => { const url = window.prompt(translate("wiki.linkUrl")); if (url) editor?.chain().focus().setLink({ href: url }).run(); }}><Link2 aria-hidden size={14} /></button></div><EditorContent editor={editor} aria-label={translate("comments.placeholder")} /><AssistMenu editor={editor} workspaceId={workspaceId} /></div>
    {error && <p role="alert">{error}</p>}
    <button className="editor-tool" type="button" aria-label={translate("wiki.insert.image")} title={translate("wiki.insert.image")} onClick={() => picker.current?.click()}><ImagePlus size={14} /></button>
    <input ref={picker} data-testid="comment-image-input" hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const assetId = await uploadFile(file); if (assetId) editor.commands.insertContentAt(editor.state.doc.content.size, { type: "assetImage", attrs: { assetId } }); }} />
    <button className="primary" onClick={async () => { if (!editor || editor.isEmpty) return; await onSubmit(editor.getJSON()); if (!initial) editor.commands.clearContent(); }}>{submitLabel}</button>
    {onCancel && <button className="secondary" onClick={onCancel}>{translate("comments.cancel")}</button>}
  </div>;
}

function CommentBody({ body }: { body: unknown }) {
  const editor = useEditor({ extensions: [...surfaceEditorExtensions({ surface: "full", mention: Mention.configure({ HTMLAttributes: { class: "mention" } }), image: readOnlyImages }), SafeLinkClick], content: normalizeAssetImages(body), editable: false });
  return <div className="comment-body"><EditorContent editor={editor} /></div>;
}

export function TimelinePanel({ workspaceId, workItemId, projectId, selfId, canComment, linkBase, action, onChange, refreshKey = 0 }: { workspaceId: string; workItemId: string; projectId: string; selfId: string; canComment: boolean; linkBase: string; action: Action; onChange: () => void; refreshKey?: number }) {
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sort, setSort] = React.useState<Sort>("oldest");
  const [showAllChanges, setShowAllChanges] = React.useState(false);
  const [versions, setVersions] = React.useState<{ commentId: string; rows: Version[] } | null>(null);
  const rows = React.useMemo(() => entries.flatMap((entry) => entry.comment ? [entry.comment, ...entry.comment.replies] : []), [entries]);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [replying, setReplying] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
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
  const guard = async (result: unknown) => { setNote(result === null ? translate("comments.failed") : null); await load(); onChange(); };
  const copy = (id: string) => copyText(`${window.location.origin}${linkBase}#comment-${id}`, translate("comments.linkCopied"), translate("comments.copyFailed"));
  const showVersions = async (commentId: string) => {
    if (versions?.commentId === commentId) { setVersions(null); return; }
    const result = await action<Version[]>("list_comment_versions", { commentId });
    if (result === null) { setNote(translate("comments.historyDenied")); return; }
    setNote(null); setVersions({ commentId, rows: result });
  };
  const item = (row: CommentRow, replies: CommentRow[]) => <li key={row.id} id={`comment-${row.id}`} className={`grid list-none gap-2 rounded-lg border border-subtle p-3 ${row.parentId === null ? "bg-surface-1" : "bg-layer-1"}`}>
    <div className="flex flex-wrap items-baseline gap-x-2"><strong className="text-13 text-primary">{row.authorName}</strong>{row.authorIsAgent && <> <mark data-agent-marker><span title={translate("comments.agent")}><Bot aria-hidden size={12} className="inline" /></span> {translate("comments.agent")}</mark>{row.authorCodeCapable && <span className="inline-flex items-center gap-1 rounded bg-layer-1 px-1.5 py-0.5 text-10 text-secondary" title={translate("agents.codeCapable")}><Code2 aria-hidden size={13} className="text-warning-primary" />{translate("agents.canEditCode")}</span>}</>} <small className="text-12 text-tertiary">{formatDate(row.createdAt)}{row.editedAt ? ` · ${translate("comments.edited")}` : ""}</small>
    {row.runId && <small> <a href={`?run=${row.runId}`}>{translate("comments.viewRun")}</a></small>}</div>
    {editing === row.id
      ? <CommentEditor workspaceId={workspaceId} workItemId={workItemId} people={people} initial={row.body} submitLabel={translate("comments.save")} onCancel={() => setEditing(null)} onSubmit={async (body) => { await guard(await action("update_comment", { commentId: row.id, body })); setEditing(null); }} />
      : <CommentBody body={row.body} />}
    <p className="flex flex-wrap gap-1">
      {row.parentId === null && canComment && <button className="secondary" onClick={() => setReplying(row.id)}>{translate("comments.reply")}</button>}
      <button className="secondary" onClick={() => void copy(row.id)}>{translate("comments.copyLink")}</button>
      {row.editedAt && <button className="secondary" onClick={() => void showVersions(row.id)}>{translate("comments.history")}</button>}
      {row.authorId === selfId && editing !== row.id && <>
        <button className="secondary" onClick={() => setEditing(row.id)}>{translate("comments.edit")}</button>
        <button className="secondary" onClick={async () => guard(await action("delete_comment", { commentId: row.id }))}>{translate("comments.delete")}</button>
      </>}
    </p>
    {versions?.commentId === row.id && <ol aria-label={translate("comments.history")}>
      {versions.rows.length === 0 && <li>{translate("comments.historyEmpty")}</li>}
      {versions.rows.map((version) => <li key={version.id}><small>{formatDate(version.writtenAt)}</small> {version.bodyText}</li>)}
    </ol>}
    {row.parentId === null && row.replyCount > 0 && <small>{translate(row.replyCount === 1 ? "comments.repliesOne" : "comments.repliesMany").replace("{count}", String(row.replyCount))} · {row.participants.map((person) => person.name).join(", ")}</small>}
    {replies.length > 0 && <ul className="m-0 grid list-none gap-2 border-l-2 border-subtle !pl-3">{replies.map((reply) => item(reply, []))}</ul>}
    {replying === row.id && <CommentEditor workspaceId={workspaceId} workItemId={workItemId} people={people} submitLabel={translate("comments.reply")} onCancel={() => setReplying(null)} onSubmit={async (body) => { await guard(await action("create_comment", { workItemId, body, parentId: row.id })); setReplying(null); }} />}
  </li>;
  const activityText = (row: ActivityRow) => row.field === "created" ? translate("workItems.activity.created") : row.field === "deleted" ? translate("workItems.activity.deleted") : row.field === "attachment_added" ? translate("workItems.activity.attachment_added") : row.field === "archived" || row.field === "restored" ? translate(`workItems.activity.${row.field}` as never) : row.field.startsWith("web_link_") || row.field === "relation_added" || row.field === "relation_removed" ? translate(`workItems.activity.${row.field}` as never) : translate("workItems.activity.changed").replace("{field}", translateDynamic(`activity.field.${row.field}`) ?? row.field);
  const activityRows = groupActivities(entries.flatMap((entry) => entry.activity ? [entry.activity] : []), showAllChanges);
  const displayByActivityId = new Map<string, { kind: "activity"; activity: ActivityRow } | { kind: "group"; group: Extract<(typeof activityRows)[number], { kind: "group" }> }>();
  for (const row of activityRows) {
    if (row.kind === "activity") displayByActivityId.set(row.id, { kind: "activity", activity: row.activity });
    else if (showAllChanges) for (const activity of row.activities) displayByActivityId.set(activity.id, { kind: "activity", activity });
    else displayByActivityId.set(row.id, { kind: "group", group: row });
  }
  const actor = (row: ActivityRow) => <><strong className="font-medium text-primary">{row.actorName}</strong>{row.actorIsAgent && <> <mark data-agent-marker><span title={translate("comments.agent")}><Bot aria-hidden size={12} className="inline" /></span> {translate("comments.agent")}</mark>{row.actorCodeCapable && <span className="inline-flex items-center gap-1 rounded bg-layer-1 px-1.5 py-0.5 text-10 text-secondary" title={translate("agents.codeCapable")}><Code2 aria-hidden size={13} className="text-warning-primary" />{translate("agents.canEditCode")}</span>}</>}</>;
  const renderActivity = (row: ActivityRow) => <>{actor(row)} {row.field === "recurrence_created" ? translate("workItems.activity.fromRecurrence").replace("{name}", String((row.newValue as { name?: string } | null)?.name ?? "")) : activityText(row)}{" "}
    <small className="text-12 text-tertiary">{["agent", "agent_autopilot"].includes(row.source) && row.originatorName ? translate(row.source === "agent_autopilot" ? "activity.byAutopilotAgent" : "activity.byAgent").replace("{originator}", row.originatorName) : translate("workItems.via").replace("{source}", translateDynamic(`activity.source.${row.source}`) ?? row.source)} · {formatDate(row.createdAt)}</small></>;
  return <section>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
    <h3>{translate("timeline.title")}</h3>
    <p className="flex gap-2">
      <select aria-label={translate("timeline.filter")} value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
        <option value="all">{translate("timeline.all")}</option><option value="comments">{translate("timeline.comments")}</option><option value="updates">{translate("timeline.updates")}</option>
      </select>
      <select aria-label={translate("timeline.sort")} value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
        <option value="oldest">{translate("timeline.oldest")}</option><option value="newest">{translate("timeline.newest")}</option>
      </select>
    </p>
    </div>
    {entries.some((entry) => entry.activity) && <button type="button" className="secondary mb-3" aria-pressed={showAllChanges} onClick={() => setShowAllChanges((value) => !value)}>{translate(showAllChanges ? "timeline.showGrouped" : "timeline.showAllChanges")}</button>}
    {entries.length === 0 && <p>{translate("timeline.empty")}</p>}
    <ul className="m-0 grid list-none gap-2 !pl-0">{entries.map((entry) => entry.comment
      ? item(entry.comment, entry.comment.replies)
      : (() => {
        const display = displayByActivityId.get(entry.activity!.id);
        if (!display) return null;
        const listClass = "flex list-none flex-wrap items-baseline gap-x-1.5 px-1 py-0.5 text-13 text-secondary before:mr-1 before:size-1.5 before:self-center before:rounded-full before:bg-[var(--border-strong)] before:content-['']";
        if (display.kind === "activity") return <li key={entry.activity!.id} className={listClass}>{renderActivity(display.activity)}</li>;
        const group = display.group;
        const oldText = readableActivityValue(group.oldValue); const newText = readableActivityValue(group.newValue);
        const latest = group.activities.reduce((a, b) => Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a);
        return <li key={group.id} className="list-none rounded-md bg-surface-1 px-2 py-1 text-13 text-secondary">
          <details><summary className="cursor-pointer">{actor(latest)} {activityText(group.activities[0]!)} · {translate("timeline.changeCount").replace("{count}", String(group.count))}{oldText !== null && newText !== null && <span className="ml-1">{translate("timeline.valueTransition").replace("{old}", oldText).replace("{new}", newText)}</span>} <small className="text-12 text-tertiary">{latest.source === "agent" && latest.originatorName ? translate("activity.byAgent").replace("{originator}", latest.originatorName) : translate("workItems.via").replace("{source}", translateDynamic(`activity.source.${latest.source}`) ?? latest.source)} · {formatDate(latest.createdAt)}</small></summary>
            <ol className="ml-4 mt-2 grid gap-1">{group.activities.map((activity) => <li key={activity.id}>{renderActivity(activity)}</li>)}</ol>
          </details>
        </li>;
      })())}</ul>
    {canComment && <div className="mt-4 border-t border-subtle pt-4"><CommentEditor workspaceId={workspaceId} workItemId={workItemId} people={people} submitLabel={translate("comments.add")} onSubmit={async (body) => guard(await action("create_comment", { workItemId, body }))} /></div>}
    {note && <p role="alert">{note}</p>}
  </section>;
}
