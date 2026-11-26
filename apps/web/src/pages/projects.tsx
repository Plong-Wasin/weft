import { Button } from "@/ui/button";
import React from "react";
import { Globe, Lock, Plus, Star } from "lucide-react";
import { sanitizeProjectKey, translate, type MessageKey } from "@weft/shared";
import { action, actionResult } from "../api";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { projectsKey } from "../shell/sidebar";
import { matchesProjectSearch, preferenceOf, useProjectPreferences } from "../shell/project-preferences";
import { paths } from "../routes";
import { useWorkspace } from "../layouts/workspace-layout";
import { EmptyState } from "../empty-state";
import { PageHeader } from "../shell/page-header";
import type { Project } from "../types";

import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
type Visibility = Project["visibility"];
type Shape = "simple" | "full";

export function ProjectsPanel() {
  const { workspace } = useWorkspace();
  const [projects, setProjects] = React.useState<Project[] | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [showArchived, setShowArchived] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [name, setName] = React.useState("");
  const [key, setKey] = React.useState("");
  const [suggestKey, setSuggestKey] = React.useState(true);
  const [visibility, setVisibility] = React.useState<Visibility>("public");
  const [shape, setShape] = React.useState<Shape>("simple");
  const [note, setNote] = React.useState<string | null>(null);
  const client = useQueryClient();
  const { prefs, setPreference } = useProjectPreferences(workspace.id);
  const visibleProjects = (projects ?? []).filter((project) => matchesProjectSearch(project, search));
  const load = React.useCallback(async () => {
    setProjects(await action<Project[]>("list_projects", { workspaceId: workspace.id, archived: showArchived }) ?? []);
    await client.invalidateQueries({ queryKey: projectsKey(workspace.id) });
  }, [workspace.id, showArchived, client]);
  React.useEffect(() => { void load(); }, [load]);
  const form = creating && <form className="my-0 grid max-w-2xl gap-4 rounded-lg border border-border bg-card p-4" aria-label={translate("projects.createTitle")} onSubmit={async (event) => {
      event.preventDefault();
      const result = await actionResult<Project>("create_project", { workspaceId: workspace.id, name, key, visibility, shape });
      setNote("error" in result ? (/^\d+$/.test(result.error) ? translate("projects.failed") : result.error) : null);
      if ("data" in result) { setName(""); setKey(""); setSuggestKey(true); setShape("simple"); setCreating(false); await load(); }
    }}>
      <h2 className="m-0 text-base font-semibold text-foreground">{translate("projects.createTitle")}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-muted-foreground">{translate("projects.name")}<Input className="text-base md:text-sm" autoFocus required value={name} onChange={(event) => {
          const value = event.target.value;
          setName(value);
          if (suggestKey) setKey(sanitizeProjectKey(value));
        }} /></label>
        <label className="text-sm font-medium text-muted-foreground">{translate("projects.key")}<Input className="text-base md:text-sm" required pattern="[A-Z][A-Z0-9]{1,11}" title={translate("projects.keyHint")} aria-describedby="project-key-help" value={key} onChange={(event) => {
          setSuggestKey(false);
          setKey(event.target.value.toUpperCase());
        }} /></label>
      </div>
      <p id="project-key-help" className="m-0 text-sm text-muted-foreground">{translate("projects.keyHelp")}</p>
      <label className="w-full max-w-xs text-sm font-medium text-muted-foreground">{translate("projects.visibility")}<select className="text-base md:text-sm pointer-coarse:min-h-11" value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)}>
        <option value="public">{translate("projects.visibility.public")}</option>
        <option value="private">{translate("projects.visibility.private")}</option>
      </select></label>
      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-sm font-medium text-muted-foreground">{translate("projects.shape")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["simple", "full"] as const).map((option) => <label key={option} className={`grid cursor-pointer gap-1 rounded-lg border p-3 text-sm ${shape === option ? "border-border bg-muted" : "border-border"}`}>
            <span className="flex items-center gap-2 font-medium text-foreground"><input type="radio" name="project-shape" value={option} checked={shape === option} onChange={() => setShape(option)} />{translate(`projects.shape${option === "simple" ? "Simple" : "Full"}` as MessageKey)}</span>
            <span className="pl-6 text-muted-foreground">{translate(`projects.shape${option === "simple" ? "Simple" : "Full"}Desc` as MessageKey)}</span>
          </label>)}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button className="pointer-coarse:min-h-11">{translate("projects.create")}</Button>
        <Button type="button" className="pointer-coarse:min-h-11" onClick={() => { setCreating(false); setNote(null); }}>{translate("projects.cancel")}</Button>
      </div>
      {note && <p role="alert" className="m-0 text-sm text-destructive">{note}</p>}
    </form>;
  return <section className="grid gap-4">
    <PageHeader title={translate("projects.title")} actions={<div className="flex w-screen max-w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end">
      <Input aria-label={translate("projects.find")} type="search" className="w-full max-w-80 sm:w-64 sm:max-w-none" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={translate("projects.searchPlaceholder")} />
      <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent pointer-coarse:min-h-11"><Checkbox checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />{translate("projects.showArchived")}</label>
      {!creating && <Button type="button" className="flex items-center gap-1.5 pointer-coarse:min-h-11" onClick={() => setCreating(true)}><Plus aria-hidden size={14} />{translate("projects.new")}</Button>}
    </div>} />
    {form}
    {projects !== null && projects.length === 0 && <EmptyState title={translate(showArchived ? "projects.noArchived" : "projects.empty")} description={showArchived ? undefined : translate("projects.emptyHint")}
      action={showArchived || creating ? undefined : <Button type="button" onClick={() => setCreating(true)}>{translate("projects.createFirst")}</Button>} />}
    {projects !== null && projects.length > 0 && visibleProjects.length === 0 && <p role="status" className="m-0 text-sm text-muted-foreground">{search.trim() ? translate("projects.noSearchResults") : translate("projects.empty")}</p>}
    {projects !== null && visibleProjects.length > 0 && <ul aria-label={translate("projects.title")} className="m-0 grid list-none gap-1 rounded-xl border border-border bg-card p-1 empty:hidden">{visibleProjects.map((project) => <li key={project.id} data-project-row className="grid min-h-14 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-4 py-2 transition-colors hover:bg-accent">
      <Link to={paths.workItems(workspace.slug, project.key)} aria-label={`${project.key} · ${project.name}`} className="flex min-w-0 items-center gap-3 text-sm font-medium !text-foreground">
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-code text-xs font-medium text-muted-foreground">{project.key}</span>
        <span className="thai-room truncate" title={project.name}>{project.name}</span>
      </Link>
      <div className="flex min-w-0 shrink-0 items-center">
      {(() => {
        const starred = preferenceOf(prefs, project.id)?.starred ?? false;
        const label = translate(starred ? "sidebar.unstar" : "sidebar.star");
        return <Button variant="ghost" type="button" aria-pressed={starred} aria-label={`${label}: ${project.name}`} title={label} onClick={() => void setPreference(project.id, { starred: !starred })} className="border-l border-border bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11">
          <Star aria-hidden size={14} className={starred ? "text-foreground" : undefined} fill={starred ? "currentColor" : "none"} />
        </Button>;
      })()}
      <span className="flex min-h-9 items-center gap-1.5 whitespace-nowrap border-l border-border pl-3 text-sm text-muted-foreground">{project.visibility === "private" ? <Lock aria-hidden size={13} /> : <Globe aria-hidden size={13} />}{translate(`projects.visibility.${project.visibility}`)}</span>
      {project.archived && <span className="whitespace-nowrap border-l border-border pl-3 text-xs font-medium text-muted-foreground">{translate("projects.archivedBadge")}</span>}
      {project.role === null && !project.archived && project.visibility === "public" && <Button type="button" className="ml-3 pointer-coarse:min-h-11" onClick={async () => { await action("join_project", { projectId: project.id }); await load(); }}>{translate("projects.join")}</Button>}
      </div>
    </li>)}</ul>}
  </section>;
}
