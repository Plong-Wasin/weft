import React from "react";
import { translate } from "@weft/shared";
import { api } from "../api";
import type { Workspace } from "../types";

export function slugify(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

/** Name and URL of a new workspace; `onCreated` receives the created workspace. Shared by the first-workspace screen and the switcher. */
export function CreateWorkspaceForm({ onCreated, onCancel }: { onCreated: (workspace: Workspace) => Promise<void> | void; onCancel?: () => void }) {
  const [workspaceName, setWorkspaceName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    const response = await fetch(`${api}/actions/create_workspace`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: workspaceName, slug }),
    });
    if (!response.ok) { setError(translate("workspace.createFailed")); return; }
    await onCreated(await response.json() as Workspace);
  }

  return <form onSubmit={createWorkspace} className="my-6 grid gap-4">
    <label className="grid gap-1.5">{translate("workspace.name")}<input required value={workspaceName} onChange={(event) => {
      const value = event.target.value; setWorkspaceName(value);
      if (!slug || slug === slugify(workspaceName)) setSlug(slugify(value));
    }} /></label>
    <label className="grid gap-1.5">{translate("workspace.slug")}<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
    <div className="flex gap-2"><button>{translate("workspace.create")}</button>{onCancel && <button type="button" className="secondary" onClick={onCancel}>{translate("workspace.close")}</button>}</div>
    {error && <p role="alert" className="text-danger-text">{error}</p>}
  </form>;
}
