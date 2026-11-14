import React from "react";
import { Globe, Lock, Plus, Star } from "lucide-react";
import { sanitizeProjectKey, translate, type MessageKey } from "@weft/shared";
import { action, actionResult } from "../api";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { projectsKey } from "../shell/sidebar";
import { preferenceOf, useProjectPreferences } from "../shell/project-preferences";
import { paths } from "../routes";
import { useWorkspace } from "../layouts/workspace-layout";
import { EmptyState } from "../empty-state";
import type { Project } from "../types";

type Visibility = Project["visibility"];
type Shape = "simple" | "full";

export function ProjectsPanel() {
  const { workspace } = useWorkspace();
  const [projects, setProjects] = React.useState<Project[] | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [showArchived, setShowArchived] = React.useState(false);
  const [name, setName] = React.useState("");
  const [key, setKey] = React.useState("");
  const [suggestKey, setSuggestKey] = React.useState(true);
  const [visibility, setVisibility] = React.useState<Visibility>("public");
  const [shape, setShape] = React.useState<Shape>("simple");
  const [note, setNote] = React.useState<string | null>(null);
  const client = useQueryClient();
const { prefs, setPreference } = useProjectPreferences(workspace.id);
  const load = React.useCallback(async () => {
    setProjects(await action<Project[]>("list_projects", { workspaceId: workspace.id, archived: showArchived }) ?? []);
    await client.invalidateQueries({ queryKey: projectsKey(workspace.id) });
  }, [workspace.id, showArchived, client]);
  React.useEffect(() => { void load(); }, [load]);
  const form = creating && <form className="my-0 grid max-w-2xl gap-4 rounded-lg border border-subtle bg-surface-1 p-4" aria-label={translate("projects.createTitle")} onSubmit={async (event) => {
      event.preventDefault();
      const result = await actionResult<Project>("create_project", { workspaceId: workspace.id, name, key, visibility, shape });
      setNote("error" in result ? (/^\d+$/.test(result.error) ? translate("projects.failed") : result.error) : null);
      if ("data" in result) { setName(""); setKey(""); setSuggestKey(true); setShape("simple"); setCreating(false); await load(); }
    }}>
      <h2 className="m-0 text-16 font-semibold text-primary">{translate("projects.createTitle")}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-13 font-medium text-secondary">{translate("projects.name")}<input autoFocus required value={name} onChange={(event) => {
          const value = event.target.value;
          setName(value);
          if (suggestKey) setKey(sanitizeProjectKey(value));
        }} /></label>
        <label className="text-13 font-medium text-secondary">{translate("projects.key")}<input required pattern="[A-Z][A-Z0-9]{1,11}" title={translate("projects.keyHint")} aria-describedby="project-key-help" value={key} onChange={(event) => {
          setSuggestKey(false);
          setKey(event.target.value.toUpperCase());
        }} /></label>
      </div>
      <p id="project-key-help" className="m-0 text-13 text-secondary">{translate("projects.keyHelp")}</p>
      <label className="w-full max-w-xs text-13 font-medium text-secondary">{translate("projects.visibility")}<select value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)}>
        <option value="public">{translate("projects.visibility.public")}</option>
        <option value="private">{translate("projects.visibility.private")}</option>
      </select></label>
      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-13 font-medium text-secondary">{translate("projects.shape")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["simple", "full"] as const).map((option) => <label key={option} className={`grid cursor-pointer gap-1 rounded-lg border p-3 text-13 ${shape === option ? "border-accent-primary bg-layer-1" : "border-subtle"}`}>
            <span className="flex items-center gap-2 font-medium text-primary"><input type="radio" name="project-shape" value={option} checked={shape === option} onChange={() => setShape(option)} />{translate(`projects.shape${option === "simple" ? "Simple" : "Full"}` as MessageKey)}</span>
            <span className="pl-6 text-secondary">{translate(`projects.shape${option === "simple" ? "Simple" : "Full"}Desc` as MessageKey)}</span>
          </label>)}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button>{translate("projects.create")}</button>
        <button type="button" className="secondary" onClick={() => { setCreating(false); setNote(null); }}>{translate("projects.cancel")}</button>
      </div>
      {note && <p role="alert" className="m-0 text-13 text-danger-text">{note}</p>}
    </form>;
  return <section className="grid gap-4">
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="m-0 flex-1 text-20 font-semibold text-primary">{translate("projects.title")}</h1>
      <label className="secondary flex items-center gap-2 text-13"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />{translate("projects.showArchived")}</label>
      {!creating && <button type="button" className="flex items-center gap-1.5" onClick={() => setCreating(true)}><Plus aria-hidden size={14} />{translate("projects.new")}</button>}
    </header>
    {form}
    {projects !== null && projects.length === 0 && <EmptyState title={translate(showArchived ? "projects.noArchived" : "projects.empty")} description={showArchived ? undefined : translate("projects.emptyHint")}
      action={showArchived || creating ? undefined : <button type="button" onClick={() => setCreating(true)}>{translate("projects.createFirst")}</button>} />}
    {projects !== null && projects.length > 0 && <ul aria-label={translate("projects.title")} className="m-0 list-none overflow-hidden rounded-lg border border-subtle p-0">{projects.map((project) => <li key={project.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-subtle px-4 py-3 last:border-b-0 hover:bg-layer-transparent-hover">
      <Link to={paths.workItems(workspace.slug, project.key)} aria-label={`${project.key} · ${project.name}`} className="flex min-w-40 flex-1 items-center gap-3 text-14 font-medium !text-primary">
        <span className="shrink-0 rounded-md bg-layer-1 px-2 py-0.5 font-code text-12 font-medium text-secondary">{project.key}</span>
        <span className="truncate">{project.name}</span>
      </Link>
      {(() => {
        const starred = preferenceOf(prefs, project.id)?.starred ?? false;
        const label = translate(starred ? "sidebar.unstar" : "sidebar.star");
        return <button type="button" aria-pressed={starred} aria-label={`${label}: ${project.name}`} title={label} onClick={() => void setPreference(project.id, { starred: !starred })} className="bg-transparent p-1 text-tertiary hover:bg-transparent hover:text-primary">
          <Star aria-hidden size={14} className={starred ? "text-accent-primary" : undefined} fill={starred ? "currentColor" : "none"} />
        </button>;
      })()}
      <span className="flex items-center gap-1.5 text-13 text-secondary">{project.visibility === "private" ? <Lock aria-hidden size={13} /> : <Globe aria-hidden size={13} />}{translate(`projects.visibility.${project.visibility}`)}</span>
      {project.archived && <span className="rounded-full bg-layer-1 px-2 py-0.5 text-12 font-medium text-secondary">{translate("projects.archivedBadge")}</span>}
      {project.role === null && !project.archived && project.visibility === "public" && <button type="button" className="secondary" onClick={async () => { await action("join_project", { projectId: project.id }); await load(); }}>{translate("projects.join")}</button>}
    </li>)}</ul>}
  </section>;
}
