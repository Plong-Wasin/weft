import { api } from "./api";
import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDate, formatNumber, translate } from "@weft/shared";
import { Link, useLocation, useNavigate } from "react-router";
import { Bell } from "lucide-react";
import { paths } from "./routes";
import { inboxNotificationIdFromSearch, notificationTarget, notificationTargetWithInboxId, withoutInboxNotificationId } from "./notification-target";
import { autoRuleReasonText } from "./auto-rule-reason";


type Workspace = { id: string; slug: string; name: string };
type Notification = {
  id: string; kind: "mention" | "assignment" | "reply" | "intake_accepted" | "intake_rejected" | "intake_duplicate" | "run_confirmation" | "run_skipped" | "wake_skipped" | "recurrence_paused" | "auto_rule"; workItemId: string | null; wikiPageId: string | null; pageTitle: string | null; projectId: string | null; projectKey: string | null; commentId: string | null; recurrenceId: string | null; detail: string | null; displayId: string; workItemTitle: string;
  actorName: string; readAt: string | null; createdAt: string; intakeId: string | null; intakeOutcome: string | null;
};
const inboxMessage = {
  mention: "inbox.mention", reply: "inbox.reply", assignment: "inbox.assignment",
  intake_accepted: "inbox.intakeAccepted", intake_rejected: "inbox.intakeRejected", intake_duplicate: "inbox.intakeDuplicate", run_confirmation: "inbox.runConfirmation", run_skipped: "inbox.runSkipped", wake_skipped: "inbox.wakeSkipped", recurrence_paused: "inbox.recurrencePaused", auto_rule: "inbox.autoRule",
} as const;
type Inbox = { unreadCount: number; notifications: Notification[] };

async function call<T>(name: string, body: unknown): Promise<T> {
  const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(name);
  return await response.json() as T;
}

/** Called by a destination after its primary content loads successfully. */
export async function markNotificationReadAfterDestinationLoaded(notificationId: string) {
  try { await call("mark_notification_read", { notificationId }); } catch { /* Keep it unread when the read update cannot be saved. */ }
}

/** Each destination consumes the URL token once, after success or a definitive failed load. */
export function useInboxNotificationOpen() {
  const location = useLocation();
  const navigate = useNavigate();
  const notificationId = inboxNotificationIdFromSearch(location.search);
  const handledLocation = React.useRef<string | null>(null);
  const finish = React.useCallback((loaded: boolean) => {
    if (!notificationId || handledLocation.current === location.key) return;
    handledLocation.current = location.key;
    if (loaded && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(notificationId)) {
      void markNotificationReadAfterDestinationLoaded(notificationId);
    }
    navigate({ pathname: location.pathname, search: withoutInboxNotificationId(location.search), hash: location.hash }, { replace: true, state: null });
  }, [location.hash, location.key, location.pathname, location.search, navigate, notificationId]);
  return {
    notificationId,
    markLoaded: React.useCallback(() => finish(true), [finish]),
    markUnavailable: React.useCallback(() => finish(false), [finish]),
  };
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

/** A named destination in workspace navigation; the bell remains available as a shortcut. */
export function InboxNavLink({ workspace }: { workspace: Workspace }) {
  const { data } = useQuery({ queryKey: inboxKey(workspace.id), queryFn: () => fetchInbox(workspace.id) });
  const unread = data?.unreadCount ?? 0;
  return <Link to={paths.notifications(workspace.slug)} aria-label={`${translate("inbox.navLabel")}${unread ? `, ${translate("inbox.unread").replace("{count}", formatNumber(unread))}` : ""}`}
    className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-14 font-medium text-secondary hover:bg-layer-transparent-hover hover:text-primary">
    <span>{translate("inbox.navLabel")}</span>{unread > 0 && <span className="rounded-full bg-accent-primary px-1.5 text-11 font-semibold text-on-color">{formatNumber(unread)}</span>}
  </Link>;
}

export function InboxPanel({ workspace }: { workspace: Workspace }) {
  const client = useQueryClient();
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const { data, isError } = useQuery({ queryKey: inboxKey(workspace.id), queryFn: () => fetchInbox(workspace.id) });
  const changed = { onSuccess: () => client.invalidateQueries({ queryKey: inboxKey(workspace.id) }) };
  const markRead = useMutation({ mutationFn: (notificationId: string) => call("mark_notification_read", { notificationId }), ...changed });
  const markUnread = useMutation({ mutationFn: (notificationId: string) => call("mark_notification_unread", { notificationId }), ...changed });
  const markAll = useMutation({ mutationFn: () => call("mark_all_notifications_read", { workspaceId: workspace.id }), ...changed });
  const shown = (data?.notifications ?? []).filter((item) => !unreadOnly || item.readAt === null);
  return <section aria-labelledby="inbox-title">
    <h1 id="inbox-title">{translate("inbox.title")}{data ? ` — ${translate("inbox.unread").replace("{count}", formatNumber(data.unreadCount))}` : ""}</h1>
    {isError && <p role="alert">{translate("inbox.failed")}</p>}
    <div className="my-3 flex flex-wrap items-center gap-2">
      <div role="group" aria-label={translate("inbox.title")} className="inline-flex rounded-md border border-subtle p-0.5">
        <button type="button" aria-pressed={unreadOnly} className={unreadOnly ? "primary" : "secondary"} onClick={() => setUnreadOnly(true)}>{translate("inbox.unreadTab")}{data ? ` (${formatNumber(data.unreadCount)})` : ""}</button>
        <button type="button" aria-pressed={!unreadOnly} className={!unreadOnly ? "primary" : "secondary"} onClick={() => setUnreadOnly(false)}>{translate("inbox.all")}</button>
      </div>
      <button className="secondary" disabled={!data || data.unreadCount === 0 || markAll.isPending} onClick={() => markAll.mutate()}>{translate("inbox.markAllRead")}</button>
    </div>
    {data && shown.length === 0 && <p>{translate("inbox.empty")}</p>}
    <ul style={{ listStyle: "none", paddingLeft: 0 }}>
      {shown.map((item) => <li key={item.id} className={`mb-2 grid min-w-0 gap-2 rounded-md border border-subtle p-3 sm:grid-cols-[minmax(0,1fr)_auto] ${item.readAt ? "" : "bg-layer-1"}`}>
        {item.kind === "recurrence_paused" ? `${translate(inboxMessage[item.kind])}: ${item.detail ?? ""}` : <>{translate(item.kind === "wake_skipped" ? `inbox.wakeSkipped.${item.detail ?? "no_agent_access"}` as never : inboxMessage[item.kind]).replace("{actor}", item.actorName)}{" "}
        {item.workItemId || item.wikiPageId ? <Link to={item.readAt ? notificationTarget(workspace.slug, item) : notificationTargetWithInboxId(workspace.slug, item, item.id)}>{item.wikiPageId ? item.pageTitle : `${item.displayId} ${item.workItemTitle}`}</Link> : <span>{item.detail}</span>}{item.kind === "auto_rule" && item.detail && <>{": "}{autoRuleReasonText(item.detail, translate)}</>}</>}{" "}
        <small>{formatDate(item.createdAt)}</small>{" "}
        <button type="button" className="secondary justify-self-start sm:justify-self-end" disabled={markRead.isPending || markUnread.isPending} onClick={() => item.readAt ? markUnread.mutate(item.id) : markRead.mutate(item.id)}>{translate(item.readAt ? "inbox.markUnread" : "inbox.markRead")}</button>
      </li>)}
    </ul>
  </section>;
}
