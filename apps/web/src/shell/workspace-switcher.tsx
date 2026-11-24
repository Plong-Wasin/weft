import React from "react";
import { useNavigate } from "react-router";
import { Check, ChevronDown, Plus } from "lucide-react";
import { translate } from "@weft/shared";
import { paths } from "../routes";
import type { Workspace } from "../types";
import { CreateWorkspaceForm } from "./create-workspace-form";
import { Popover, menuItemClass } from "./popover";

/** Top-left workspace switcher: lists the user's workspaces and, where allowed, creates a new one. */
export function WorkspaceSwitcher({ workspace, workspaces, canCreate, refresh }: { workspace: Workspace; workspaces: Workspace[]; canCreate: boolean; refresh: () => Promise<void> }) {
  const navigate = useNavigate();
  const switchLabel = `${translate("workspace.switch")}: ${workspace.name}`;
  const [creating, setCreating] = React.useState(false);
  const createButton = React.useRef<HTMLButtonElement>(null);
  const form = React.useRef<HTMLDivElement>(null);
  const wasCreating = React.useRef(false);
  React.useEffect(() => {
    if (creating) form.current?.querySelector<HTMLInputElement>("input")?.focus();
    else if (wasCreating.current) createButton.current?.focus();
    wasCreating.current = creating;
  }, [creating]);
  return <Popover label={switchLabel} panelLabel={creating ? translate("workspace.new") : undefined} panelRole={creating ? "dialog" : "menu"} className="px-2 text-primary"
    trigger={<><span className="grid size-6 place-items-center rounded-md bg-accent-primary text-12 font-semibold text-on-color">{workspace.name.slice(0, 1).toUpperCase()}</span>
      <span className="max-w-32 truncate text-14 font-medium max-md:max-w-[4.5rem] max-[379px]:hidden">{workspace.name}</span><ChevronDown aria-hidden size={14} /></>}>
    {(close) => creating
      ? <div ref={form} className="w-72 p-2"><CreateWorkspaceForm onCancel={() => setCreating(false)} onCreated={async (created) => { await refresh(); close(); setCreating(false); navigate(paths.home(created.slug)); }} /></div>
      : <>
        <p className="px-2.5 py-1 text-12 font-medium text-tertiary">{translate("workspace.list")}</p>
        {workspaces.map((item) => <button type="button" role="menuitemradio" aria-checked={item.slug === workspace.slug} key={item.id} className={menuItemClass}
          onClick={() => { close(); if (item.slug !== workspace.slug) navigate(paths.home(item.slug)); }}>
          <span className="grid size-5 place-items-center rounded bg-layer-2 text-11 font-semibold">{item.name.slice(0, 1).toUpperCase()}</span>
          <span className="flex-1 truncate">{item.name}</span>{item.slug === workspace.slug && <Check aria-hidden size={14} />}
        </button>)}
        {canCreate && <button ref={createButton} type="button" role="menuitem" className={`${menuItemClass} mt-1 border-t border-subtle`} onClick={() => setCreating(true)}><Plus aria-hidden size={14} />{translate("workspace.new")}</button>}
      </>}
  </Popover>;
}
