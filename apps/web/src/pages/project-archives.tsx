import { Button } from "@/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
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
  const selectTab = (next: Tab) => { setTab(next); setNote(null); };
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
  return <section className="grid gap-4">
    <h2 className="m-0 flex items-center gap-2 text-base font-semibold"><Archive aria-hidden size={16} />{t("archives.title")}</h2>
    <Tabs value={active} onValueChange={(value) => selectTab(value as Tab)}>
      <TabsList aria-label={t("archives.tabs")} className="flex h-auto w-fit max-w-full flex-wrap gap-1 rounded-lg bg-muted p-1">
        {tabs.map((id) => <TabsTrigger key={id} value={id} id={`archives-tab-${id}`} className={`rounded-md border-0 px-3 py-2 text-sm font-medium ${id === active ? "bg-card text-foreground shadow-sm" : "bg-transparent text-muted-foreground hover:bg-accent"}`}>{t(tabLabel[id])}</TabsTrigger>)}
      </TabsList>
      {note && <p role="alert" className="m-0 text-destructive">{note}</p>}
      <TabsContent value={active}>
    {active !== "workItems" && <div>
      {structures?.length === 0 && <p className="m-0 rounded-xl bg-muted p-4 text-muted-foreground">{t(active === "cycles" ? "archives.emptyCycles" : "archives.emptyModules")}</p>}
      <ul className="m-0 grid list-none gap-1 rounded-xl border border-border bg-card p-1 empty:hidden">{(structures ?? []).map((row) => <li key={row.id} data-testid={`archived-row-${row.id}`} className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-accent max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-2">
        <Link to={active === "cycles" ? paths.cycle(workspace.slug, project.key, row.id) : paths.module(workspace.slug, project.key, row.id)} className="min-w-0 flex-1 thai-room truncate text-sm font-medium text-foreground max-sm:col-span-2">{row.name}</Link>
        {row.startDate && row.endDate && <span className="text-xs text-muted-foreground">{formatDate(row.startDate)} – {formatDate(row.endDate)}</span>}
        {canRestoreStructure && <Button type="button" className="max-sm:min-h-11 shrink-0" aria-label={t("archives.restoreItem").replace("{name}", row.name)} onClick={() => void restoreStructure(row)}>{t("archives.restore")}</Button>}
    </li>)}</ul>
    </div>}
    {active === "workItems" && <div>
    {items?.length === 0 && <p className="m-0 rounded-xl bg-muted p-4 text-muted-foreground">{t("archives.empty")}</p>}
    <ul className="m-0 grid list-none gap-1 rounded-xl border border-border bg-card p-1 empty:hidden">{(items ?? []).map((item) => <li key={item.id} data-testid={`archived-row-${item.displayId}`} className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-accent max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-2">
      <span className="text-xs text-muted-foreground max-sm:col-span-2">{item.displayId}</span>
      <Link to={paths.workItem(workspace.slug, item.displayId)} className="min-w-0 flex-1 thai-room truncate text-sm font-medium text-foreground max-sm:col-span-2 max-sm:overflow-visible max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere]">{item.title}</Link>
      <span className="text-xs text-muted-foreground">{t("archives.archivedAt").replace("{date}", formatDate(item.archivedAt))}</span>
      {canWrite && <Button type="button" className="max-sm:min-h-11 shrink-0" aria-label={t("archives.restoreItem").replace("{name}", item.displayId)} onClick={() => void restore(item)}>{t("archives.restore")}</Button>}
    </li>)}</ul>
    </div>}
      </TabsContent>
    </Tabs>
  </section>;
}
