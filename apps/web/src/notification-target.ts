import { paths } from "./routes";

export const inboxNotificationParam = "inboxNotificationId";

type Target = { wikiPageId: string | null; runId?: string | null; projectId: string | null; projectKey: string | null; intakeId: string | null; intakeOutcome: string | null; displayId: string; kind: string; commentId: string | null };

export function notificationTarget(workspace: string, item: Target): string {
  if (item.wikiPageId) return item.projectId && item.projectKey ? paths.page(workspace, item.projectKey, item.wikiPageId) : paths.wikiPage(workspace, item.wikiPageId);
  if (item.runId) return paths.scheduledRun(workspace, item.runId);
  if (item.intakeId && item.intakeOutcome !== "accepted" && item.projectKey) {
    const tab = item.intakeOutcome === "pending" || item.intakeOutcome === "snoozed" ? "open" : "closed";
    return `${paths.intake(workspace, item.projectKey)}?currentTab=${tab}&inboxIssueId=${encodeURIComponent(item.intakeId)}${item.commentId ? `#comment-${item.commentId}` : ""}`;
  }
  return `${paths.workItem(workspace, item.displayId)}${item.kind !== "assignment" && item.commentId ? `#comment-${item.commentId}` : ""}`;
}

/** A URL parameter survives normal and new-tab navigation; the destination removes it after its first load attempt. */
export function notificationTargetWithInboxId(workspace: string, item: Target, notificationId: string): string {
  const target = new URL(notificationTarget(workspace, item), "https://weft.invalid");
  target.searchParams.set(inboxNotificationParam, notificationId);
  return `${target.pathname}${target.search}${target.hash}`;
}

export function inboxNotificationIdFromSearch(search: string): string | null {
  return new URLSearchParams(search).get(inboxNotificationParam);
}

export function withoutInboxNotificationId(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(inboxNotificationParam)) return search;
  params.delete(inboxNotificationParam);
  const remaining = params.toString();
  return remaining ? `?${remaining}` : "";
}
