import { api } from "./api";
import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDate, formatNumber, translate } from "@weft/shared";
import { Link } from "react-router";
import { Bell } from "lucide-react";
import { paths } from "./routes";
import { autoRuleReasonText } from "./auto-rule-reason";


type Workspace = { id: string; slug: string; name: string };
type Notification = {
  id: string; kind: "mention" | "assignment" | "reply" | "intake_accepted" | "intake_rejected" | "intake_duplicate" | "run_confirmation" | "run_skipped" | "recurrence_paused" | "auto_rule"; workItemId: string | null; wikiPageId: string | null; pageTitle: string | null; projectId: string | null; projectKey: string | null; commentId: string | null; recurrenceId: string | null; detail: string | null; displayId: string; workItemTitle: string;
  actorName: string; readAt: string | null; createdAt: string;
};
const inboxMessage = {
  mention: "inbox.mention", reply: "inbox.reply", assignment: "inbox.assignment",
  intake_accepted: "inbox.intakeAccepted", intake_rejected: "inbox.intakeRejected", intake_duplicate: "inbox.intakeDuplicate", run_confirmation: "inbox.runConfirmation", run_skipped: "inbox.runSkipped", recurrence_paused: "inbox.recurrencePaused", auto_rule: "inbox.autoRule",
} as const;
type Inbox = { unreadCount: number; notifications: Notification[] };

async function call<T>(name: string, body: unknown): Promise<T> {
  const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(name);
  return await response.json() as T;
}

const inboxKey = (workspaceId: string) => ["inbox", workspaceId] as const;
const fetchInbox = (workspaceId: string) => call<Inbox>("list_notifications", { workspaceId });

/** Bell icon in the top bar linking to the inbox, with the unread count; live updates (SSE) refresh it when a new mention arrives. */
export function InboxLink({ workspace }: { workspace: Workspace }) {
  const { data } = useQuery({ queryKey: inboxKey(workspace.id), queryFn: () => fetchInbox(workspace.id) });
  const unread = data?.unreadCount ?? 0;
  return <Link to={paths.notifications(workspace.slug)} aria-label={translate("topbar.notifications")} title={translate("topbar.notifications")}
    className="relative rounded-md p-1.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary">
    <Bell aria-hidden size={18} />
    {unread > 0 && <span aria-label={translate("inbox.unread").replace("{count}", formatNumber(unread))} className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-accent-primary px-1 text-10 font-semibold text-on-color">{formatNumber(unread)}</span>}
  </Link>;
}

export function InboxPanel({ workspace }: { workspace: Workspace }) {
  const client = useQueryClient();
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const { data, isError } = useQuery({ queryKey: inboxKey(workspace.id), queryFn: () => fetchInbox(workspace.id) });
  const changed = { onSuccess: () => client.invalidateQueries({ queryKey: inboxKey(workspace.id) }) };
  const markRead = useMutation({ mutationFn: (notificationId: string) => call("mark_notification_read", { notificationId }), ...changed });
  const markAll = useMutation({ mutationFn: () => call("mark_all_notifications_read", { workspaceId: workspace.id }), ...changed });
  const shown = (data?.notifications ?? []).filter((item) => !unreadOnly || item.readAt === null);
  return <section aria-labelledby="inbox-title">
    <h1 id="inbox-title">{translate("inbox.title")}{data ? ` — ${translate("inbox.unread").replace("{count}", formatNumber(data.unreadCount))}` : ""}</h1>
    {isError && <p role="alert">{translate("inbox.failed")}</p>}
    <label><input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} /> {translate("inbox.unreadOnly")}</label>{" "}
    <button className="secondary" disabled={!data || data.unreadCount === 0 || markAll.isPending} onClick={() => markAll.mutate()}>{translate("inbox.markAllRead")}</button>
    {data && shown.length === 0 && <p>{translate("inbox.empty")}</p>}
    <ul style={{ listStyle: "none", paddingLeft: 0 }}>
      {shown.map((item) => <li key={item.id} style={{ fontWeight: item.readAt ? "normal" : "bold" }}>
        {item.kind === "recurrence_paused" ? `${translate(inboxMessage[item.kind])}: ${item.detail ?? ""}` : <>{translate(inboxMessage[item.kind]).replace("{actor}", item.actorName)}{" "}
        <Link to={item.wikiPageId ? (item.projectId && item.projectKey ? paths.page(workspace.slug, item.projectKey, item.wikiPageId) : paths.wikiPage(workspace.slug, item.wikiPageId)) : item.kind === "intake_rejected" || item.kind === "intake_duplicate" ? paths.intake(workspace.slug, item.displayId.split("-")[0]!) : `${paths.workItem(workspace.slug, item.displayId)}${item.kind !== "assignment" && item.commentId ? `#comment-${item.commentId}` : ""}`}>{item.wikiPageId ? item.pageTitle : `${item.displayId} ${item.workItemTitle}`}</Link>{item.kind === "auto_rule" && item.detail && <>{": "}{autoRuleReasonText(item.detail, translate)}</>}</>}{" "}
        <small>{formatDate(item.createdAt)}</small>{" "}
        {!item.readAt && <button className="secondary" disabled={markRead.isPending} onClick={() => markRead.mutate(item.id)}>{translate("inbox.markRead")}</button>}
      </li>)}
    </ul>
  </section>;
}
