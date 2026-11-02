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
type ArchivedStructure = { id: string; name: string; startDate: string | null; endDate: string | null };
type Tab = "workItems" | "cycles" | "modules";
const tabLabel = { workItems: "archives.workItems", cycles: "archives.cycles", modules: "archives.modules" } as const;

const canWriteIn = (project: { role: string | null; archived: boolean }) => project.role !== null && project.role !== "Guest" && !project.archived;

/** The project Archives page. Tab Work items lists archived work items, newest archive first; tabs Cycles and Modules follow the project's feature toggles. Each row has a Restore button. */
export function ProjectArchivesRoute() {
  const { workspace } = useWorkspace();
  const { project } = useProject();
  const [items, setItems] = React.useState<ArchivedItem[] | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("workItems");
  const [structures, setStructures] = React.useState<ArchivedStructure[] | null>(null);
  const tabs: Tab[] = ["workItems", ...(project.features.cycles ? ["cycles" as const] : []), ...(project.features.modules ? ["modules" as const] : [])];
  const active: Tab = tabs.includes(tab) ? tab : "workItems";
  // Restoring a Cycle or a Module is an Admin action, as archiving them is.
  const canRestoreStructure = project.role === "Admin" && !project.archived;
  const canWrite = canWriteIn(project);
  const load = React.useCallback(async () => {
    const rows = (await action<ArchivedItem[]>("list_work_items", { projectId: project.id, archived: true })) ?? [];
    setItems([...rows].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)));
  }, [project.id]);
  React.useEffect(() => { void load(); }, [load]);
  const loadStructures = React.useCallback(async () => {
    if (active === "workItems") return;
    setStructures(null);
    const rows = (await action<ArchivedStructure[]>(active === "cycles" ? "list_cycles" : "list_modules", { projectId: project.id, archived: true })) ?? [];
    setStructures(rows);
  }, [active, project.id]);
  React.useEffect(() => { void loadStructures(); }, [loadStructures]);
  const restoreStructure = async (row: ArchivedStructure) => {
    const result = await actionResult(active === "cycles" ? "unarchive_cycle" : "unarchive_module", active === "cycles" ? { cycleId: row.id } : { moduleId: row.id });
    setNote("error" in result ? t("archives.failed") : null);
    await loadStructures();
  };
  const restore = async (item: ArchivedItem) => {
    const result = await actionResult("restore_work_item", { workItemId: item.id });
    setNote("error" in result ? t("archives.failed") : null);
    await load();
  };
  return <section className="grid gap-3">
    <h1 className="m-0 flex items-center gap-2 text-16 font-semibold"><Archive aria-hidden size={16} />{t("archives.title")}</h1>
    <div role="tablist" aria-label={t("archives.tabs")} className="flex gap-1 border-b border-subtle">
      {tabs.map((id) => <button key={id} type="button" role="tab" aria-selected={id === active} onClick={() => { setTab(id); setNote(null); }}
        className={`-mb-px rounded-none border-b-2 bg-transparent px-3 py-2 text-14 font-medium ${id === active ? "border-accent-strong text-primary" : "border-transparent text-secondary"}`}>{t(tabLabel[id])}</button>)}
    </div>
    {note && <p role="alert" className="m-0 text-danger-text">{note}</p>}
    {active !== "workItems" && <>
      {structures?.length === 0 && <p className="m-0 text-secondary">{t(active === "cycles" ? "archives.emptyCycles" : "archives.emptyModules")}</p>}
      <ul role="tabpanel" aria-label={t(tabLabel[active])} className="m-0 list-none p-0">{(structures ?? []).map((row) => <li key={row.id} data-testid={`archived-row-${row.id}`} className="flex flex-wrap items-center gap-3 border-b border-subtle px-2 py-3">
        <Link to={active === "cycles" ? paths.cycle(workspace.slug, project.key, row.id) : paths.module(workspace.slug, project.key, row.id)} className="min-w-0 flex-1 truncate text-14 font-medium text-primary">{row.name}</Link>
        {row.startDate && row.endDate && <span className="text-12 text-secondary">{formatDate(row.startDate)} – {formatDate(row.endDate)}</span>}
        {canRestoreStructure && <button type="button" aria-label={t("archives.restoreItem").replace("{name}", row.name)} onClick={() => void restoreStructure(row)}>{t("archives.restore")}</button>}
      </li>)}</ul>
    </>}
    {active === "workItems" && items?.length === 0 && <p className="m-0 text-secondary">{t("archives.empty")}</p>}
    {active === "workItems" && <ul role="tabpanel" aria-label={t("archives.workItems")} className="m-0 list-none p-0">{(items ?? []).map((item) => <li key={item.id} data-testid={`archived-row-${item.displayId}`} className="flex flex-wrap items-center gap-3 border-b border-subtle px-2 py-3">
      <span className="text-12 text-secondary">{item.displayId}</span>
      <Link to={paths.workItem(workspace.slug, item.displayId)} className="min-w-0 flex-1 truncate text-14 font-medium text-primary">{item.title}</Link>
      <span className="text-12 text-secondary">{t("archives.archivedAt").replace("{date}", formatDate(item.archivedAt))}</span>
      {canWrite && <button type="button" aria-label={t("archives.restoreItem").replace("{name}", item.displayId)} onClick={() => void restore(item)}>{t("archives.restore")}</button>}
    </li>)}</ul>}
  </section>;
}
