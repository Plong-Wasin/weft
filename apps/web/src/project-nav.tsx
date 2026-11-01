import React from "react";
import { NavLink } from "react-router";
import { CalendarSync, Inbox, Layers, ListChecks, Package, FileText } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { paths } from "./routes";

export const projectFeatureKeys = ["cycles", "modules", "intake"] as const;
export type ProjectFeatureKey = (typeof projectFeatureKeys)[number];
export type ProjectFeatures = Record<ProjectFeatureKey, boolean>;

type Entry = { feature?: ProjectFeatureKey; path: (workspace: string, key: string) => string; label: MessageKey; icon: typeof Layers };

/** One entry per project menu item. Toggleable ones name their feature; later features add their entry here and nothing else. */
const menu: Entry[] = [
  { path: paths.workItems, label: "workItems.title", icon: ListChecks },
  { feature: "cycles", path: paths.cycles, label: "cycles.title", icon: CalendarSync },
  { feature: "modules", path: paths.modules, label: "modules.title", icon: Package },
  { path: paths.views, label: "projectNav.views", icon: Layers },
  { path: paths.pages, label: "projectNav.pages", icon: FileText },
  { feature: "intake", path: paths.intake, label: "intake.title", icon: Inbox },
];

/** Project menu: a turned-off feature has no entry. */
export function ProjectNav({ workspace, projectKey, features }: { workspace: string; projectKey: string; features: ProjectFeatures }) {
  return <nav aria-label={translate("projectNav.label")} className="flex gap-1 border-b border-subtle overflow-x-auto">
    {menu.filter((entry) => !entry.feature || features[entry.feature]).map((entry) => <NavLink key={entry.label} to={entry.path(workspace, projectKey)}
      className={({ isActive }) => `flex items-center gap-1.5 px-3 py-2 text-14 font-medium whitespace-nowrap border-b-2 ${isActive ? "border-accent-strong text-accent-text" : "border-transparent text-secondary hover:text-primary"}`}>
      <entry.icon aria-hidden size={14} />{translate(entry.label)}</NavLink>)}
  </nav>;
}

/** Admin checkboxes for every toggle; `onChange` receives the one feature that flipped. */
export function FeatureToggles({ features, canAdmin, onChange }: { features: ProjectFeatures; canAdmin: boolean; onChange: (feature: ProjectFeatureKey, enabled: boolean) => void }) {
  return <fieldset>
    <legend>{translate("features.title")}</legend>
    {projectFeatureKeys.map((feature) => <label key={feature}>
      <input type="checkbox" disabled={!canAdmin} checked={features[feature]} onChange={(event) => onChange(feature, event.target.checked)} />{translate(`features.${feature}` as MessageKey)}
    </label>)}
  </fieldset>;
}
