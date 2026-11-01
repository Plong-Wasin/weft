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

/** Project menu, a vertical list inside the sidebar: a turned-off feature has no entry. */
export function ProjectNav({ workspace, projectKey, features }: { workspace: string; projectKey: string; features: ProjectFeatures }) {
  return <nav aria-label={`${translate("projectNav.label")} ${projectKey}`}><ul className="ml-4 grid gap-0.5 border-l border-subtle pl-2">
    {menu.filter((entry) => !entry.feature || features[entry.feature]).map((entry) => <li key={entry.label}><NavLink to={entry.path(workspace, projectKey)}
      className={({ isActive }) => `flex items-center gap-2 rounded-md px-2.5 py-1 text-13 font-medium ${isActive ? "bg-layer-1-selected text-primary" : "text-secondary hover:bg-layer-transparent-hover"}`}>
      <entry.icon aria-hidden size={14} />{translate(entry.label)}</NavLink></li>)}
  </ul></nav>;
}
