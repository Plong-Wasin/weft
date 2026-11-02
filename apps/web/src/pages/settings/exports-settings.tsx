import React from "react";
import { formatDate, translate, type MessageKey } from "@weft/shared";
import { action, actionResult } from "../../api";
import { useWorkspace } from "../../layouts/workspace-layout";
import type { Project } from "../../types";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

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
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);
  const [denied, setDenied] = React.useState(false);
  const say = (text: string, failed = false) => { setNote(text); setError(failed); };
  const load = React.useCallback(async () => {
    const rows = await action<ExportItem[]>("list_exports", { workspaceId: workspace.id });
    // A Guest is refused; Exports are for Admins and Members.
    setDenied(rows === null);
    setItems(rows ?? []);
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
    {denied ? <p className="text-secondary">{translate("exports.notAllowed")}</p> : <>
    <SettingsBlock>
      {projects.length === 0 ? <p className="text-secondary">{translate("exports.noProjects")}</p> : <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void request(); }}>
        <fieldset className="grid min-w-0 gap-1">
          <legend>{translate("exports.project")}</legend>
          {projects.map((project) => <label key={project.id} className="flex min-w-0 items-center gap-2">
            <input type="checkbox" checked={picked.includes(project.id)} onChange={(event) => setPicked(event.target.checked ? [...picked, project.id] : picked.filter((id) => id !== project.id))} />
            <span className="min-w-0 truncate">{project.key} · {project.name}</span>
          </label>)}
        </fieldset>
        <label className="grid gap-1">{translate("exports.format")}
          <select value={format} onChange={(event) => setFormat(event.target.value as "csv" | "json")}>
            <option value="csv">{translate("exports.formatCsv")}</option><option value="json">{translate("exports.formatJson")}</option>
          </select>
        </label>
        <button type="submit">{translate("exports.request")}</button>
      </form>}
      <p className="text-13 text-secondary">{translate("exports.choiceNote")}</p>
      <p className="text-13 text-secondary">{translate("exports.csvNote")}</p>
      <Note note={note} error={error} />
    </SettingsBlock>
    <SettingsBlock title={translate("exports.previous")}>
      {items === null ? null : items.length === 0 ? <p className="text-secondary">{translate("exports.none")}</p> : <RowList>{items.map((item) => <Row key={item.id}>
        <div className="grid min-w-0 flex-1 gap-1">
          <span className="font-medium">{item.projects.map((project) => `${project.key} · ${project.name}`).join(", ")} · {item.format.toUpperCase()}</span>
          <span className="text-13 text-secondary">{translate("exports.requestedAt")}: {formatDate(item.createdAt)}</span>
          {item.status === "failed" && item.failureReason && <span className="text-13 text-danger-text">{translate("exports.reason")}: {item.failureReason}</span>}
        </div>
        <span className="text-13" data-status={item.status}>{expired(item) ? translate("exports.expired") : translate(`exports.status.${item.status}` as MessageKey)}</span>
        {item.status === "completed" && !expired(item) && <button type="button" className="secondary" onClick={() => void download(item)}>{translate("exports.download")}</button>}
      </Row>)}</RowList>}
    </SettingsBlock>
    </>}
  </section>;
}
