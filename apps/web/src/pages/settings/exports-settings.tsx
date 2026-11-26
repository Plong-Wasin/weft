import { Button } from "@/ui/button";
import React from "react";
import { formatDate, translate, type MessageKey } from "@weft/shared";
import { action, actionResult } from "../../api";
import { useWorkspace } from "../../layouts/workspace-layout";
import type { Project } from "../../types";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

import { Checkbox } from "@/ui/checkbox";
type ExportItem = {
  id: string; projects: Array<{ id: string; key: string; name: string }>; format: "csv" | "json";
  status: "queued" | "processing" | "completed" | "failed"; failureReason: string | null; createdAt: string; completedAt: string | null; expired: boolean;
};
const isOpen = (item: ExportItem) => item.status === "queued" || item.status === "processing";

/** Workspace Exports: ask for a file of work items of chosen projects (none chosen means all of them) and download it from the list while it lasts. */
export function WorkspaceExports() {
  const { workspace } = useWorkspace();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [format, setFormat] = React.useState<"csv" | "json">("csv");
  const [items, setItems] = React.useState<ExportItem[] | null>(null);
  const [listFailed, setListFailed] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);
  const [denied, setDenied] = React.useState(false);
  const say = (text: string, failed = false) => { setNote(text); setError(failed); };
  const load = React.useCallback(async () => {
    const result = await actionResult<ExportItem[]>("list_exports", { workspaceId: workspace.id });
    if ("error" in result) {
      // A Guest is refused; a transient failure should stay recoverable instead of looking like a permission denial.
      setDenied(result.error === "403" || result.error === "Forbidden");
      setListFailed(result.error !== "403" && result.error !== "Forbidden");
      return;
    }
    setDenied(false);
    setListFailed(false);
    setItems(result.data);
  }, [workspace.id]);
  React.useEffect(() => {
    void load();
    void action<Project[]>("list_projects", { workspaceId: workspace.id }).then((rows) => {
      const mine = (rows ?? []).filter((project) => project.role !== null);
      setProjects(mine);
    });
  }, [workspace.id, load]);
  // While an Export is queued or processing the list refreshes itself.
  const open = (items ?? []).some(isOpen);
  React.useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [open, load]);

  const request = async () => {
    // No project picked means every project the caller belongs to.
    const result = await actionResult("request_export", { workspaceId: workspace.id, projectIds: picked, format });
    if ("error" in result) { say(translate("exports.requestFailed"), true); return; }
    say(translate("exports.requested")); await load();
  };
  const download = async (item: ExportItem) => {
    const result = await actionResult<{ url: string }>("get_export_download_url", { exportId: item.id });
    if ("error" in result) { say(translate("exports.downloadFailed"), true); return; }
    const link = document.createElement("a");
    link.href = result.data.url;
    link.rel = "noopener";
    link.click();
  };
  // The server decides (7 days from completion, or the cleanup job already ran); the page never recomputes it.
  const expired = (item: ExportItem) => item.expired;

  return <section>
    <SettingsHeader title={translate("exports.title")} description={translate("exports.description")} />
    {denied ? <p className="text-muted-foreground">{translate("exports.notAllowed")}</p> : <>
    <SettingsBlock>
      {projects.length === 0 ? <p className="text-muted-foreground">{translate("exports.noProjects")}</p> : <form className="grid max-w-xl gap-4" onSubmit={(event) => { event.preventDefault(); void request(); }}>
        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-foreground">{translate("exports.project")}</legend>
          <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-[var(--border)]">
            {projects.map((project) => <label key={project.id} className="flex min-w-0 items-center gap-3 bg-card px-3 py-2 text-sm hover:bg-accent">
              <Checkbox checked={picked.includes(project.id)} onChange={(event) => setPicked(event.target.checked ? [...picked, project.id] : picked.filter((id) => id !== project.id))} />
              <span className="min-w-0 thai-room truncate"><span className="text-muted-foreground">{project.key}</span> · {project.name}</span>
            </label>)}
          </div>
          <p className="m-0 text-sm text-muted-foreground">{picked.length === 0 ? translate("exports.allProjects") : translate("exports.choiceNote")}</p>
        </fieldset>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm font-medium text-foreground">{translate("exports.format")}
            <select className="font-normal" value={format} onChange={(event) => setFormat(event.target.value as "csv" | "json")}>
              <option value="csv">{translate("exports.formatCsv")}</option><option value="json">{translate("exports.formatJson")}</option>
            </select>
          </label>
          <Button type="submit">{translate("exports.request")}</Button>
        </div>
      </form>}
      <p className="m-0 max-w-xl text-sm text-muted-foreground">{translate("exports.csvNote")}</p>
      <Note note={note} error={error} />
    </SettingsBlock>
    <SettingsBlock title={translate("exports.previous")}>
      {listFailed ? <div className="flex flex-wrap items-center gap-3" role="alert"><p className="m-0 text-sm text-destructive">{translate("exports.listFailed")}</p><Button type="button" onClick={() => void load()}>{translate("exports.retry")}</Button></div> : items === null ? <p role="status" className="text-muted-foreground">{translate("exports.loading")}</p> : items.length === 0 ? <p className="text-muted-foreground">{translate("exports.none")}</p> : <RowList>{items.map((item) => <Row key={item.id}>
        <div className="grid min-w-0 flex-1 gap-1">
          <span className="font-medium">{item.projects.map((project) => `${project.key} · ${project.name}`).join(", ")} · {item.format.toUpperCase()}</span>
          <span className="text-sm text-muted-foreground">{translate("exports.requestedAt")}: {formatDate(item.createdAt)}</span>
          {item.status === "failed" && item.failureReason && <span className="text-sm text-destructive">{translate("exports.reason")}: {item.failureReason}</span>}
        </div>
        <span className="text-sm" data-status={item.status}>{expired(item) ? translate("exports.expired") : translate(`exports.status.${item.status}` as MessageKey)}</span>
        {item.status === "completed" && !expired(item) && <Button type="button" onClick={() => void download(item)}>{translate("exports.download")}</Button>}
      </Row>)}</RowList>}
    </SettingsBlock>
    </>}
  </section>;
}
