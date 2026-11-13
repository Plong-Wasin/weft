import React from "react";
import { translate, type MessageKey } from "@weft/shared";

/** A pull or merge request linked to this work item by the repository webhook. */
type PullRequest = { id: string; provider: string; repository: string; number: number; title: string; url: string; state: string; checks: string; updatedAt: string };

const t = (key: string) => translate(key as MessageKey);

/** Read-only list: links are made by the repository webhook, so the panel only shows them. */
export function PullRequestsPanel({ workItemId, action, onCount }: { workItemId: string; action: <T = unknown>(name: string, input: Record<string, unknown>) => Promise<T | null>; onCount: (count: number) => void }) {
  const [rows, setRows] = React.useState<PullRequest[]>([]);
  const load = React.useCallback(async () => setRows(await action<PullRequest[]>("list_work_item_pull_requests", { workItemId }) ?? []), [action, workItemId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { onCount(rows.length); }, [onCount, rows.length]);
  // GitHub numbers pull requests with #, GitLab numbers merge requests with !.
  const reference = (row: PullRequest) => row.provider === "gitlab" ? `!${row.number}` : `#${row.number}`;
  return <section>
    <p className="m-0 mb-2 text-13 text-secondary">{t("pullRequests.help")}</p>
    {rows.length > 0 && <ul className="m-0 grid list-none gap-1.5 !pl-0">{rows.map((row) => <li key={row.id} className="grid gap-0.5 rounded-md bg-layer-1 px-2.5 py-1.5 text-13">
      <span className="min-w-0 truncate">
        <span className="text-secondary">{t(`pullRequests.kind.${row.provider}`)} {reference(row)} · </span>
        <a href={row.url} target="_blank" rel="noreferrer" className="text-primary hover:underline" title={row.url}>{row.title}</a>
      </span>
      <span className="flex flex-wrap gap-x-3 text-12 text-tertiary">
        <span>{row.repository}</span>
        <span>{t(`pullRequests.state.${row.state}`)}</span>
        <span>{t(`pullRequests.checks.${row.checks}`)}</span>
      </span>
    </li>)}</ul>}
  </section>;
}
