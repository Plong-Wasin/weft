import React from "react";
import { Link } from "react-router";
import { Archive } from "lucide-react";
import { formatDate, translate as t } from "@weft/shared";
import { action, actionResult } from "../api";
import { useProject } from "../layouts/project-layout";
import { useWorkspace } from "../layouts/workspace-layout";
import { paths } from "../routes";
import type { WorkItem } from "../types";

type ArchivedItem = WorkItem & { archivedAt: string };

/** The project Archives page. Tab Work items lists archived work items, newest archive first, each with a Restore button. */
export function ProjectArchivesRoute() {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  const [items, setItems] = React.useState<ArchivedItem[] | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const canWrite = project.role !== "Guest" && !project.archived;
  const load = React.useCallback(async () => {
    const rows = (await action<ArchivedItem[]>("list_work_items", { projectId: project.id, archived: true })) ?? [];
    setItems([...rows].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)));
  }, [project.id]);
  React.useEffect(() => { void load(); }, [load]);
  const restore = async (item: ArchivedItem) => {
    const result = await actionResult("restore_work_item", { workItemId: item.id });
    setNote("error" in result ? t("archives.failed") : null);
    await load();
  };
  return <section className="grid gap-3">
    <h1 className="m-0 flex items-center gap-2 text-16 font-semibold"><Archive aria-hidden size={16} />{t("archives.title")}</h1>
    <div role="tablist" aria-label={t("archives.tabs")} className="flex gap-1 border-b border-subtle">
      <button type="button" role="tab" aria-selected className="-mb-px rounded-none border-b-2 border-accent-strong bg-transparent px-3 py-2 text-14 font-medium text-primary">{t("archives.workItems")}</button>
    </div>
    {note && <p role="alert" className="m-0 text-danger-text">{note}</p>}
    {items?.length === 0 && <p className="m-0 text-secondary">{t("archives.empty")}</p>}
    <ul role="tabpanel" aria-label={t("archives.workItems")} className="m-0 list-none p-0">{(items ?? []).map((item) => <li key={item.id} data-testid={`archived-row-${item.displayId}`} className="flex flex-wrap items-center gap-3 border-b border-subtle px-2 py-3">
      <span className="text-12 text-secondary">{item.displayId}</span>
      <Link to={paths.workItem(workspace.slug, item.displayId)} className="min-w-0 flex-1 truncate text-14 font-medium text-primary">{item.title}</Link>
      <span className="text-12 text-secondary">{t("archives.archivedAt").replace("{date}", formatDate(item.archivedAt))}</span>
      {canWrite && <button type="button" aria-label={t("archives.restoreItem").replace("{name}", item.displayId)} onClick={() => void restore(item)}>{t("archives.restore")}</button>}
    </li>)}</ul>
  </section>;
}
