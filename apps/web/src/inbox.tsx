import { Button } from "@/ui/button";
import { api } from "./api";
import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDate, formatNumber, translate } from "@weft/shared";
import { Link, useLocation, useNavigate } from "react-router";
import { Bell } from "lucide-react";
import { paths } from "./routes";
import { inboxNotificationIdFromSearch, notificationTarget, notificationTargetWithInboxId, withoutInboxNotificationId } from "./notification-target";
import { autoRuleReasonText } from "./auto-rule-reason";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { PageHeader } from "./shell/page-header";
import { EmptyState } from "./empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";


type Workspace = { id: string; slug: string; name: string };
type Notification = {
  id: string; kind: "mention" | "assignment" | "reply" | "intake_accepted" | "intake_rejected" | "intake_duplicate" | "run_confirmation" | "run_skipped" | "wake_skipped" | "recurrence_paused" | "auto_rule" | "secret_output_blocked"; workItemId: string | null; runId: string | null; wikiPageId: string | null; pageTitle: string | null; projectId: string | null; projectKey: string | null; commentId: string | null; recurrenceId: string | null; detail: string | null; displayId: string; workItemTitle: string;
  actorName: string; readAt: string | null; createdAt: string; intakeId: string | null; intakeOutcome: string | null;
};
const inboxMessage = {
  mention: "inbox.mention", reply: "inbox.reply", assignment: "inbox.assignment",
  intake_accepted: "inbox.intakeAccepted", intake_rejected: "inbox.intakeRejected", intake_duplicate: "inbox.intakeDuplicate", run_confirmation: "inbox.runConfirmation", run_skipped: "inbox.runSkipped", wake_skipped: "inbox.wakeSkipped", recurrence_paused: "inbox.recurrencePaused", auto_rule: "inbox.autoRule", secret_output_blocked: "inbox.secretOutputBlocked",
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
  const label = translate("topbar.notifications");
  return <Tooltip><TooltipTrigger render={<Link to={paths.notifications(workspace.slug)} aria-label={label}
    className="relative inline-flex items-center justify-center rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"><Bell aria-hidden size={18} />
    {unread > 0 && <span aria-label={translate("inbox.unread").replace("{count}", formatNumber(unread))} className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-[var(--primary)] px-1 text-[12px] font-semibold text-primary-foreground">{formatNumber(unread)}</span>}
  </Link>} /><TooltipContent>{label}</TooltipContent></Tooltip>;
}

/** A named destination in workspace navigation; the bell remains available as a shortcut. */
export function InboxNavLink({ workspace }: { workspace: Workspace }) {
  const { data } = useQuery({ queryKey: inboxKey(workspace.id), queryFn: () => fetchInbox(workspace.id) });
  const unread = data?.unreadCount ?? 0;
  return <Link to={paths.notifications(workspace.slug)} aria-label={`${translate("inbox.navLabel")}${unread ? `, ${translate("inbox.unread").replace("{count}", formatNumber(unread))}` : ""}`}
    className="flex items-center justify-between gap-2 transition-colors min-h-9 max-md:min-h-11 rounded-lg px-3 py-1.5 text-[14px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
    <span>{translate("inbox.navLabel")}</span>{unread > 0 && <span className="rounded-full bg-[var(--primary)] px-1.5 text-[12px] font-semibold text-primary-foreground">{formatNumber(unread)}</span>}
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
  return <section aria-labelledby="inbox-title" className="w-full max-w-5xl">
    <PageHeader title={<span id="inbox-title">{translate("inbox.title")}</span>} actions={data ? <span className="text-sm text-muted-foreground">{translate("inbox.unread").replace("{count}", formatNumber(data.unreadCount))}</span> : undefined} className="mb-5" />
    {isError && <p role="alert">{translate("inbox.failed")}</p>}
    <Tabs value={unreadOnly ? "unread" : "all"} onValueChange={(value) => setUnreadOnly(value === "unread")}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TabsList aria-label={translate("inbox.title")}>
          <TabsTrigger value="unread">{translate("inbox.unreadTab")}{data ? ` (${formatNumber(data.unreadCount)})` : ""}</TabsTrigger>
          <TabsTrigger value="all">{translate("inbox.all")}</TabsTrigger>
        </TabsList>
        <Button type="button" variant="ghost" className="pointer-coarse:min-h-11" disabled={!data || data.unreadCount === 0 || markAll.isPending} onClick={() => markAll.mutate()}>{translate("inbox.markAllRead")}</Button>
      </div>
      <TabsContent value={unreadOnly ? "unread" : "all"} className="mt-0">
      {data && shown.length === 0 && <EmptyState title={translate("inbox.empty")} icon={<Bell aria-hidden size={18} />} className="mx-0 max-w-none rounded-xl border border-border bg-card" />}
      <ul className="m-0 grid list-none gap-2 p-0">
      {shown.map((item) => {
        const descriptionId = `notification-description-${item.id}`;
        const actionLabelId = `notification-action-${item.id}`;
        const actionLabel = translate(item.readAt ? "inbox.markUnread" : "inbox.markRead");
        return <li key={item.id} className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 rounded-xl p-4 transition-colors sm:grid-cols-[auto_minmax(0,1fr)_auto] ${item.readAt ? "bg-muted" : "bg-popover"}`}>
        <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${item.readAt ? "bg-muted-foreground" : "bg-[var(--primary)]"}`} />
        <div id={descriptionId} className={`min-w-0 ${item.readAt ? "" : "font-medium"}`}>
        {item.kind === "recurrence_paused" ? `${translate(inboxMessage[item.kind])}: ${item.detail ?? ""}` : <>{translate(item.kind === "wake_skipped" ? `inbox.wakeSkipped.${item.detail ?? "no_agent_access"}` as never : item.kind === "run_skipped" && item.detail ? `inbox.runSkipped.${item.detail}` as never : inboxMessage[item.kind]).replace("{actor}", item.actorName)}{" "}
        {item.workItemId || item.wikiPageId || item.runId ? <Link className="hover:underline" to={item.readAt ? notificationTarget(workspace.slug, item) : notificationTargetWithInboxId(workspace.slug, item, item.id)}>{item.wikiPageId ? item.pageTitle : item.runId ? translate("inbox.openScheduledRun") : `${item.displayId} ${item.workItemTitle}`}</Link> : <span>{item.kind === "secret_output_blocked" ? translate("inbox.secretOutputBlockedDetail") : item.detail}</span>}{item.kind === "auto_rule" && item.detail && <>{": "}{autoRuleReasonText(item.detail, translate)}</>}</>}{" "}
        <small className="block font-normal text-muted-foreground">{formatDate(item.createdAt)}</small>
        </div>
        <Button type="button" aria-labelledby={`${actionLabelId} ${descriptionId}`} className="col-start-2 min-h-11 justify-self-start sm:col-start-auto sm:min-h-9 sm:justify-self-end" disabled={markRead.isPending || markUnread.isPending} onClick={() => item.readAt ? markUnread.mutate(item.id) : markRead.mutate(item.id)}><span id={actionLabelId}>{actionLabel}</span></Button>
      </li>;
      })}
      </ul>
      </TabsContent>
    </Tabs>
  </section>;
}
