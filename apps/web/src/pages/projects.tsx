import React from "react";
import { sanitizeProjectKey, translate } from "@weft/shared";
import { action, actionResult } from "../api";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { projectsKey } from "../shell/sidebar";
import { paths } from "../routes";
import { useWorkspace } from "../layouts/workspace-layout";
import type { Project } from "../types";

type Visibility = Project["visibility"];

export function ProjectsPanel() {
  const { workspace } = useWorkspace();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [showArchived, setShowArchived] = React.useState(false);
  const [name, setName] = React.useState("");
  const [key, setKey] = React.useState("");
  const [suggestKey, setSuggestKey] = React.useState(true);
  const [visibility, setVisibility] = React.useState<Visibility>("public");
  const [note, setNote] = React.useState<string | null>(null);
  const client = useQueryClient();
  const load = React.useCallback(async () => {
    setProjects(await action<Project[]>("list_projects", { workspaceId: workspace.id, archived: showArchived }) ?? []);
    await client.invalidateQueries({ queryKey: projectsKey(workspace.id) });
  }, [workspace.id, showArchived, client]);
  React.useEffect(() => { void load(); }, [load]);
  return <section>
    <h2>{translate("projects.title")}</h2>
    <label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />{translate("projects.showArchived")}</label>
    {projects.length === 0 && <p>{translate("projects.empty")}</p>}
    <ul>{projects.map((project) => <li key={project.id}>
      <Link to={paths.workItems(workspace.slug, project.key)}>{project.key} · {project.name}</Link>{" "}
      <small>{translate(`projects.visibility.${project.visibility}`)}{project.archived ? ` · ${translate("projects.archivedBadge")}` : ""}</small>{" "}
      {project.role === null && !project.archived && project.visibility === "public" && <button className="secondary" onClick={async () => { await action("join_project", { projectId: project.id }); await load(); }}>{translate("projects.join")}</button>}
    </li>)}</ul>
    <form onSubmit={async (event) => {
      event.preventDefault();
      const result = await actionResult<Project>("create_project", { workspaceId: workspace.id, name, key, visibility });
      setNote("error" in result ? result.error : null);
      if ("data" in result) { setName(""); setKey(""); setSuggestKey(true); await load(); }
    }}>
      <label>{translate("projects.name")}<input required value={name} onChange={(event) => {
        const value = event.target.value;
        setName(value);
        if (suggestKey) setKey(sanitizeProjectKey(value));
      }} /></label>
      <label>{translate("projects.key")}<input required pattern="[A-Z][A-Z0-9]{1,11}" title={translate("projects.keyHint")} value={key} onChange={(event) => {
        setSuggestKey(false);
        setKey(event.target.value.toUpperCase());
      }} /></label>
      <label>{translate("projects.visibility")}<select value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)}>
        <option value="public">{translate("projects.visibility.public")}</option>
        <option value="private">{translate("projects.visibility.private")}</option>
      </select></label>
      <button>{translate("projects.create")}</button>
    </form>
    {note && <p role="alert">{note}</p>}
  </section>;
}
