import { paths } from "./routes";

type Target = { wikiPageId: string | null; projectId: string | null; projectKey: string | null; intakeId: string | null; intakeOutcome: string | null; displayId: string; kind: string; commentId: string | null };

export function notificationTarget(workspace: string, item: Target): string {
  if (item.wikiPageId) return item.projectId && item.projectKey ? paths.page(workspace, item.projectKey, item.wikiPageId) : paths.wikiPage(workspace, item.wikiPageId);
  if (item.intakeId && item.intakeOutcome !== "accepted" && item.projectKey) {
    const tab = item.intakeOutcome === "pending" || item.intakeOutcome === "snoozed" ? "open" : "closed";
    return `${paths.intake(workspace, item.projectKey)}?currentTab=${tab}&inboxIssueId=${encodeURIComponent(item.intakeId)}${item.commentId ? `#comment-${item.commentId}` : ""}`;
  }
  return `${paths.workItem(workspace, item.displayId)}${item.kind !== "assignment" && item.commentId ? `#comment-${item.commentId}` : ""}`;
}
