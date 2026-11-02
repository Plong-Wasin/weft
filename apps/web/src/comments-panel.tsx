import React from "react";
import { formatDate, translate, translateDynamic } from "@weft/shared";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { SuggestionProps } from "@tiptap/suggestion";
import { readOnlyImages, useAssetImages } from "./asset-images";
import { AssistMenu } from "./assist-menu";
import { AiAssist } from "./editor-assist";

type Props = SuggestionProps<{ id: string; label: string }, { id: string; label: string }>;

type Person = { userId: string; name: string };
type CommentRow = {
  id: string; authorId: string; authorName: string; authorIsAgent?: boolean; runId?: string | null; body: unknown; createdAt: string; editedAt: string | null;
  parentId: string | null; replyCount: number; participants: Array<{ userId: string; name: string }>;
};
type Version = { id: string; bodyText: string; body: unknown; writtenAt: string };
type ActivityRow = { id: string; field: string; actorName: string; source: string; originatorName?: string | null; runId?: string | null; createdAt: string };
type Entry = { kind: "comment" | "activity"; createdAt: string; comment: (CommentRow & { replies: CommentRow[] }) | null; activity: ActivityRow | null };
type Filter = "all" | "comments" | "updates";
type Sort = "newest" | "oldest";
type Action = <T>(name: string, body: unknown) => Promise<T | null>;

function mentionExtension(people: React.RefObject<Person[]>) {
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: {
      char: "@",
      items: ({ query }: { query: string }) => (people.current ?? []).filter((person) => person.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map((person) => ({ id: person.userId, label: person.name })),
      render: () => {
        let box: HTMLUListElement | null = null;
        let selected = 0;
        let current: { items: Array<{ id: string; label: string }>; command: (item: { id: string; label: string }) => void } | null = null;
        const paint = () => {
          if (!box || !current) return;
          box.replaceChildren(...current.items.map((item, index) => {
            const li = document.createElement("li");
            li.textContent = item.label;
            li.setAttribute("role", "option");
            li.style.fontWeight = index === selected ? "bold" : "normal";
            li.onmousedown = (event) => { event.preventDefault(); current?.command(item); };
            return li;
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
            if (event.key === "Enter") { current.command(current.items[selected]!); return true; }
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
  const { extension: images, error } = useAssetImages({ ownerType: "work_item", ownerId: workItemId });
  const editor = useEditor({ extensions: [StarterKit, AiAssist, mentionExtension(peopleRef), images], content: (initial as object | undefined) ?? "" });
  return <div>
    <div className="comment-editor relative" data-testid="comment-editor"><EditorContent editor={editor} aria-label={translate("comments.placeholder")} /><AssistMenu editor={editor} workspaceId={workspaceId} /></div>
    {error && <p role="alert">{error}</p>}
    <button onClick={async () => { if (!editor || editor.isEmpty) return; await onSubmit(editor.getJSON()); if (!initial) editor.commands.clearContent(); }}>{submitLabel}</button>
    {onCancel && <button className="secondary" onClick={onCancel}>{translate("comments.cancel")}</button>}
  </div>;
}

function CommentBody({ body }: { body: unknown }) {
  const editor = useEditor({ extensions: [StarterKit, Mention.configure({ HTMLAttributes: { class: "mention" } }), readOnlyImages], content: body as object, editable: false });
  return <EditorContent editor={editor} />;
}

export function TimelinePanel({ workspaceId, workItemId, projectId, selfId, canComment, linkBase, action, onChange, refreshKey = 0 }: { workspaceId: string; workItemId: string; projectId: string; selfId: string; canComment: boolean; linkBase: string; action: Action; onChange: () => void; refreshKey?: number }) {
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sort, setSort] = React.useState<Sort>("oldest");
  const [versions, setVersions] = React.useState<{ commentId: string; rows: Version[] } | null>(null);
  const rows = React.useMemo(() => entries.flatMap((entry) => entry.comment ? [entry.comment, ...entry.comment.replies] : []), [entries]);
  const [people, setPeople] = React.useState<Person[]>([]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [replying, setReplying] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const scrolled = React.useRef(false);
  const load = React.useCallback(async () => {
    setEntries(await action<Entry[]>("list_timeline", { workItemId, filter, sort }) ?? []);
    setPeople(await action<Person[]>("list_mentionable_members", { projectId }) ?? []);
  }, [action, workItemId, projectId, filter, sort, refreshKey]);
  React.useEffect(() => { void load(); }, [load]);
  // A link ends in #comment-<id>; an unknown or deleted id matches nothing and the work item shows as usual.
  React.useEffect(() => {
    if (scrolled.current || rows.length === 0) return;
    const target = decodeURIComponent(window.location.hash.slice(1));
    if (!target.startsWith("comment-")) return;
    const element = document.getElementById(target);
    if (element) { scrolled.current = true; element.scrollIntoView({ block: "center" }); }
  }, [rows]);
  const guard = async (result: unknown) => { setNote(result === null ? translate("comments.failed") : null); await load(); onChange(); };
  const copy = async (id: string) => {
    try { await navigator.clipboard.writeText(`${window.location.origin}${linkBase}#comment-${id}`); setCopied(id); } catch { setNote(translate("comments.copyFailed")); }
  };
  const showVersions = async (commentId: string) => {
    if (versions?.commentId === commentId) { setVersions(null); return; }
    const result = await action<Version[]>("list_comment_versions", { commentId });
    if (result === null) { setNote(translate("comments.historyDenied")); return; }
    setNote(null); setVersions({ commentId, rows: result });
  };
  const item = (row: CommentRow, replies: CommentRow[]) => <li key={row.id} id={`comment-${row.id}`}>
    <strong>{row.authorName}</strong>{row.authorIsAgent && <> <mark data-agent-marker>{translate("comments.agent")}</mark></>} <small>{formatDate(row.createdAt)}{row.editedAt ? ` · ${translate("comments.edited")}` : ""}</small>
    {row.runId && <small> <a href={`?run=${row.runId}`}>{translate("comments.viewRun")}</a></small>}
    {editing === row.id
      ? <CommentEditor workspaceId={workspaceId} workItemId={workItemId} people={people} initial={row.body} submitLabel={translate("comments.save")} onCancel={() => setEditing(null)} onSubmit={async (body) => { await guard(await action("update_comment", { commentId: row.id, body })); setEditing(null); }} />
      : <CommentBody body={row.body} />}
    <p>
      {row.parentId === null && canComment && <button className="secondary" onClick={() => setReplying(row.id)}>{translate("comments.reply")}</button>}
      <button className="secondary" onClick={() => void copy(row.id)}>{copied === row.id ? translate("comments.linkCopied") : translate("comments.copyLink")}</button>
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
    {replies.length > 0 && <ul>{replies.map((reply) => item(reply, []))}</ul>}
    {replying === row.id && <CommentEditor workspaceId={workspaceId} workItemId={workItemId} people={people} submitLabel={translate("comments.reply")} onCancel={() => setReplying(null)} onSubmit={async (body) => { await guard(await action("create_comment", { workItemId, body, parentId: row.id })); setReplying(null); }} />}
  </li>;
  const activityText = (row: ActivityRow) => row.field === "created" ? translate("workItems.activity.created") : row.field === "deleted" ? translate("workItems.activity.deleted") : row.field === "attachment_added" ? translate("workItems.activity.attachment_added") : row.field.startsWith("web_link_") || row.field === "relation_added" || row.field === "relation_removed" ? translate(`workItems.activity.${row.field}` as never) : translate("workItems.activity.changed").replace("{field}", translateDynamic(`activity.field.${row.field}`) ?? row.field);
  return <section>
    <h3>{translate("timeline.title")}</h3>
    <p>
      <select aria-label={translate("timeline.filter")} value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
        <option value="all">{translate("timeline.all")}</option><option value="comments">{translate("timeline.comments")}</option><option value="updates">{translate("timeline.updates")}</option>
      </select>
      <select aria-label={translate("timeline.sort")} value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
        <option value="oldest">{translate("timeline.oldest")}</option><option value="newest">{translate("timeline.newest")}</option>
      </select>
    </p>
    {entries.length === 0 && <p>{translate("timeline.empty")}</p>}
    <ul>{entries.map((entry) => entry.comment
      ? item(entry.comment, entry.comment.replies)
      : <li key={entry.activity!.id}>
        <strong>{entry.activity!.actorName}</strong> {activityText(entry.activity!)}{" "}
        <small>{entry.activity!.source === "agent" && entry.activity!.originatorName ? translate("activity.byAgent").replace("{originator}", entry.activity!.originatorName) : translate("workItems.via").replace("{source}", translateDynamic(`activity.source.${entry.activity!.source}`) ?? entry.activity!.source)} · {formatDate(entry.activity!.createdAt)}</small>
      </li>)}</ul>
    {canComment && <CommentEditor workspaceId={workspaceId} workItemId={workItemId} people={people} submitLabel={translate("comments.add")} onSubmit={async (body) => guard(await action("create_comment", { workItemId, body }))} />}
    {note && <p role="alert">{note}</p>}
  </section>;
}
