import { Button, buttonVariants } from "@/ui/button";
import { api } from "./api";
import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDate, formatNumber, translate } from "@weft/shared";
import { Link, useLocation, useNavigate } from "react-router";
import { Bell, Mail, MailOpen } from "lucide-react";
import { paths } from "./routes";
import { notificationTarget, notificationTargetWithInboxId } from "./notification-target";
import { autoRuleReasonText } from "./auto-rule-reason";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { PageHeader } from "./shell/page-header";
import { EmptyState } from "./empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "./lib/utils";
import { WorkItemDetail } from "./work-item-detail";


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

function hasIntakeTarget(item: Notification) {
  return Boolean(item.intakeId && item.intakeOutcome !== "accepted" && item.projectKey);
}

function targetFor(workspace: string, item: Notification) {
  if (!item.wikiPageId && !item.runId && !hasIntakeTarget(item) && !item.displayId) return null;
  return item.readAt ? notificationTarget(workspace, item) : notificationTargetWithInboxId(workspace, item, item.id);
}

function notificationCopy(item: Notification) {
  if (item.kind === "recurrence_paused") return { message: `${translate(inboxMessage[item.kind])}: ${item.detail ?? ""}`, title: "", reason: "" };
  const key = item.kind === "wake_skipped" ? `inbox.wakeSkipped.${item.detail ?? "no_agent_access"}` as const
    : item.kind === "run_skipped" && item.detail ? `inbox.runSkipped.${item.detail}` as const
    : inboxMessage[item.kind];
  const message = translate(key as Parameters<typeof translate>[0]).replace("{actor}", item.actorName);
  const title = item.wikiPageId ? item.pageTitle ?? "" : item.runId ? translate("inbox.openScheduledRun")
    : item.displayId ? `${item.displayId} ${item.workItemTitle}`
    : item.kind === "secret_output_blocked" ? translate("inbox.secretOutputBlockedDetail") : item.detail ?? "";
  const reason = item.kind === "auto_rule" && item.detail ? autoRuleReasonText(item.detail, translate) : "";
  return { message, title, reason };
}

const selectionParam = "notification";
const minimumReadingWidth = 720;
const openDestination = cn(buttonVariants({ variant: "primary" }), "pointer-coarse:min-h-11");
// Focus here means the keys belong to a text field, a menu or a dialog, not to the list.
const keyOwners = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='listbox'], [role='menu'], [role='dialog'], [role='alertdialog'], dialog";
type InboxReturn = { notificationId: string; scrollTop: number; unreadOnly: boolean };
// The shell scrolls <main> instead of the document. Associate its position with the Inbox history entry.
const inboxReturns = new Map<string, InboxReturn>();

export function InboxPanel({ workspace }: { workspace: Workspace }) {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const section = React.useRef<HTMLElement>(null);
  const list = React.useRef<HTMLUListElement>(null);
  const [wide, setWide] = React.useState(false);
  const restored = inboxReturns.get(location.key);
  const [unreadOnly, setUnreadOnly] = React.useState(restored?.unreadOnly ?? false);
  const selectedId = new URLSearchParams(location.search).get(selectionParam);
  // Selecting the row whose pane failed to load remounts the pane, which loads again.
  const failedId = React.useRef<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const currentId = (!wide && restored?.notificationId) || selectedId;
  const { data, isError } = useQuery({ queryKey: inboxKey(workspace.id), queryFn: () => fetchInbox(workspace.id) });
  const changed = { onSuccess: () => client.invalidateQueries({ queryKey: inboxKey(workspace.id) }) };
  const markRead = useMutation({ mutationFn: (notificationId: string) => call("mark_notification_read", { notificationId }), ...changed });
  const markUnread = useMutation({ mutationFn: (notificationId: string) => call("mark_notification_unread", { notificationId }), ...changed });
  const markAll = useMutation({ mutationFn: () => call("mark_all_notifications_read", { workspaceId: workspace.id }), ...changed });
  const shown = (data?.notifications ?? []).filter((item) => !unreadOnly || item.readAt === null || item.id === currentId);
  const selected = shown.find((item) => item.id === selectedId);
  const selectedTarget = selected && targetFor(workspace.slug, selected);
  const selectedCopy = selected && notificationCopy(selected);
  const rowLink = (id: string) => list.current?.querySelector<HTMLAnchorElement>(`a[data-notification="${CSS.escape(id)}"]`);
  const hasRows = Boolean(data);

  React.useLayoutEffect(() => {
    const element = section.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth >= minimumReadingWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    if (!hasRows || !restored) return;
    rowLink(restored.notificationId)?.focus({ preventScroll: true });
    const main = section.current?.closest("main");
    if (main) main.scrollTop = restored.scrollTop;
  // Restore on entry once rows are available. Live updates should leave the user's scroll alone.
  }, [hasRows, restored]);

  const select = (id: string | null, target?: string, replace = false) => {
    const params = new URLSearchParams(location.search);
    if (id) params.set(selectionParam, id);
    else params.delete(selectionParam);
    const hash = target ? new URL(target, window.location.origin).hash : "";
    const retry = id !== null && id === selectedId && failedId.current === id;
    failedId.current = null;
    if (retry) setAttempt((value) => value + 1);
    if (id === selectedId && hash === location.hash) return;
    navigate({ pathname: location.pathname, search: params.toString(), hash }, { replace });
  };
  const leave = (id: string) => {
    const main = section.current?.closest("main");
    if (!main) return;
    inboxReturns.set(location.key, { notificationId: id, scrollTop: main.scrollTop, unreadOnly });
    main.scrollTop = 0;
  };
  const moveSelection = (event: KeyboardEvent) => {
    if (!wide || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    const row = target && list.current?.contains(target) ? target.closest<HTMLAnchorElement>("a[data-notification]") : null;
    const key = event.key.toLowerCase();
    // J/K work from anywhere on the page. Arrows scroll the page, so they only move the selection from a row.
    const offset = key === "j" || (row && key === "arrowdown") ? 1 : key === "k" || (row && key === "arrowup") ? -1 : 0;
    if (!offset) return;
    if (!row && (target?.closest(keyOwners) || document.querySelector('[aria-modal="true"], dialog[open]'))) return;
    event.preventDefault();
    // A held key would mark every row that finishes loading as read.
    if (event.repeat) return;
    const links = Array.from(list.current?.querySelectorAll<HTMLAnchorElement>("a[data-notification]") ?? []);
    const from = row ?? (selectedId ? rowLink(selectedId) : null);
    const next = from ? links[links.indexOf(from) + offset] : links[0];
    if (!next?.dataset.notification) return;
    select(next.dataset.notification, next.href, true);
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
  };
  React.useEffect(() => {
    document.addEventListener("keydown", moveSelection);
    return () => document.removeEventListener("keydown", moveSelection);
  });
  const changeFilter = (value: string) => {
    setUnreadOnly(value === "unread");
    inboxReturns.delete(location.key);
    if (selectedId) select(null, undefined, true);
  };
  const close = () => {
    if (selectedId) rowLink(selectedId)?.focus();
    select(null, undefined, true);
  };

  return <section ref={section} aria-labelledby="inbox-title" className={cn("w-full", wide && "flex h-[calc(100dvh-var(--height-header)-2*var(--padding-page-x))] min-h-48 flex-col")}>
    <PageHeader title={<span id="inbox-title">{translate("inbox.title")}</span>} actions={data ? <span className="text-sm text-muted-foreground">{translate("inbox.unread").replace("{count}", formatNumber(data.unreadCount))}</span> : undefined} className="mb-5 shrink-0" />
    {isError && <p role="alert">{translate("inbox.failed")}</p>}
    <Tabs value={unreadOnly ? "unread" : "all"} onValueChange={changeFilter} className={cn(wide && "flex min-h-0 flex-1 flex-col")}>
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2">
        <TabsList aria-label={translate("inbox.title")}>
          <TabsTrigger value="unread">{translate("inbox.unreadTab")}{data ? ` (${formatNumber(data.unreadCount)})` : ""}</TabsTrigger>
          <TabsTrigger value="all">{translate("inbox.all")}</TabsTrigger>
        </TabsList>
        <Button type="button" variant="ghost" disabled={!data || data.unreadCount === 0 || markAll.isPending} onClick={() => markAll.mutate()}>{translate("inbox.markAllRead")}</Button>
      </div>
      <TabsContent value={unreadOnly ? "unread" : "all"} className={cn("mt-0", wide && "grid min-h-0 flex-1 grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)] divide-x divide-border rounded-xl border border-border")}>
        <div className={cn("min-w-0", wide && "overflow-y-auto overscroll-contain rounded-l-xl")}>
          {data && shown.length === 0 && <EmptyState title={translate("inbox.empty")} icon={<Bell aria-hidden size={18} />} className="mx-0 max-w-none" />}
          <ul ref={list} className={cn("m-0 list-none divide-y divide-border p-0", !wide && "rounded-xl border border-border empty:hidden")}>
            {shown.map((item) => {
              const { message, title, reason } = notificationCopy(item);
              const href = targetFor(workspace.slug, item);
              const isCurrent = item.id === currentId;
              const descriptionId = `notification-description-${item.id}`;
              const actionLabelId = `notification-action-${item.id}`;
              const actionLabel = translate(item.readAt ? "inbox.markUnread" : "inbox.markRead");
              const rowClass = cn("grid min-h-[5rem] grid-cols-[0.5rem_minmax(0,1fr)] items-start gap-x-2.5 border-l-2 border-transparent px-3 py-2.5 pr-14 text-sm",
                item.readAt ? "text-muted-foreground" : "font-semibold text-foreground",
                isCurrent && "border-l-primary bg-accent");
              const text = <span className="min-w-0">
                {/* Only a linked row can be opened to read the rest, so only a linked row clamps; its title matches the text. */}
                <span id={descriptionId} title={href ? `${message}${title && ` ${title}`}${reason && `: ${reason}`}` : undefined} className={cn("block min-h-10 leading-5 [overflow-wrap:anywhere]", href && "line-clamp-2")}>
                  {message}{title && " "}{href && title ? <span className="underline decoration-current/50 underline-offset-2">{title}</span> : title}{reason && `: ${reason}`}
                </span>
                <small className="block text-xs font-normal text-muted-foreground">{formatDate(item.createdAt)}</small>
              </span>;
              const content = <><span aria-hidden="true" className={cn("mt-1.5 size-2 rounded-full", !item.readAt && "bg-primary")} />{text}</>;
              return <li key={item.id} className="relative">
                {href ? <Link to={href} data-notification={item.id} aria-current={isCurrent ? "true" : undefined}
                  aria-keyshortcuts={wide ? "J K ArrowDown ArrowUp Space" : "Space"}
                  className={cn(rowClass, "outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", !isCurrent && "hover:bg-accent/60")}
                  onKeyDown={(event) => {
                    if (event.key !== " " || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    if (!event.repeat) event.currentTarget.click();
                  }}
                  onClick={(event) => {
                    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
                    if (wide) { event.preventDefault(); select(item.id, href); }
                    else leave(item.id);
                  }}>{content}</Link> : <div className={rowClass}>{content}</div>}
                <Tooltip>
                  <TooltipTrigger render={<Button type="button" variant="ghost" size="icon" aria-labelledby={`${actionLabelId} ${descriptionId}`}
                    className="absolute right-2 top-1/2 min-h-11 min-w-11 -translate-y-1/2 text-muted-foreground hover:bg-background hover:text-foreground"
                    disabled={markRead.isPending || markUnread.isPending}
                    onClick={() => item.readAt ? markUnread.mutate(item.id) : markRead.mutate(item.id)}>
                    <span id={actionLabelId} className="sr-only">{actionLabel}</span>
                    {item.readAt ? <Mail aria-hidden /> : <MailOpen aria-hidden />}
                  </Button>} />
                  <TooltipContent>{actionLabel}</TooltipContent>
                </Tooltip>
              </li>;
            })}
          </ul>
        </div>
        {wide && <div className="@container min-h-0 min-w-0 overflow-y-auto rounded-r-xl" key={`${selectedId}:${attempt}`}>
          {selected && selectedTarget && selectedCopy
            ? selected.displayId && !selected.wikiPageId && !selected.runId && !hasIntakeTarget(selected)
              ? <WorkItemDetail displayId={selected.displayId} mode="peek" onClose={close} onUnavailable={() => { failedId.current = selected.id; }} onLoaded={() => {
                failedId.current = null;
                if (!selected.readAt) markRead.mutate(selected.id);
              }} />
              : <div className="grid justify-items-start gap-3 p-6">
                <h2 className="m-0 text-lg font-semibold [overflow-wrap:anywhere]">{selectedCopy.title || selectedCopy.message}</h2>
                {selectedCopy.title && <p className="m-0 text-muted-foreground [overflow-wrap:anywhere]">{selectedCopy.message}{selectedCopy.reason && `: ${selectedCopy.reason}`}</p>}
                <Link to={selectedTarget} className={openDestination}>{translate("inbox.open")}</Link>
              </div>
            : <p className="m-0 p-6 text-sm text-muted-foreground">{translate("inbox.selectNotification")}</p>}
        </div>}
      </TabsContent>
    </Tabs>
  </section>;
}
