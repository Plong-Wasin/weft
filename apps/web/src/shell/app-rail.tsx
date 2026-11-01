import React from "react";
import { NavLink, useLocation } from "react-router";
import { Bot, BookOpen, Briefcase, Settings } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { paths } from "../routes";

export type Section = "work" | "wiki" | "ai" | "settings";

/** Which rail section the current URL belongs to. Everything outside wiki, AI, and settings is Work. */
export function sectionOf(pathname: string, workspaceSlug: string): Section {
  const rest = pathname.slice(`/${encodeURIComponent(workspaceSlug)}`.length);
  if (/^\/wiki(\/|$)/.test(rest)) return "wiki";
  if (/^\/ai(\/|$)/.test(rest)) return "ai";
  if (/^\/settings(\/|$)/.test(rest)) return "settings";
  return "work";
}

const entries: Array<{ section: Section; label: MessageKey; icon: typeof Bot; to: (workspace: string) => string }> = [
  { section: "work", label: "rail.work", icon: Briefcase, to: paths.home },
  { section: "wiki", label: "wiki.title", icon: BookOpen, to: paths.wiki },
  { section: "ai", label: "rail.ai", icon: Bot, to: paths.ai },
  { section: "settings", label: "nav.settings", icon: Settings, to: paths.workspaceSettings },
];

/** App rail: Work, Wiki, AI, Settings. Vertical icon column on desktop; a labelled row inside the drawer on phones. */
export function AppRail({ workspaceSlug, horizontal = false }: { workspaceSlug: string; horizontal?: boolean }) {
  const active = sectionOf(useLocation().pathname, workspaceSlug);
  return <nav aria-label={translate("shell.rail")} className={horizontal ? "flex gap-1 border-b border-subtle p-2" : "flex w-14 shrink-0 flex-col items-center gap-1 border-r border-subtle bg-surface-1 py-2"}>
    {entries.map((entry) => <NavLink key={entry.section} to={entry.to(workspaceSlug)} aria-current={active === entry.section ? "page" : undefined} title={translate(entry.label)}
      className={`flex items-center gap-1 rounded-md ${horizontal ? "flex-1 flex-col px-1 py-1.5 text-11" : "w-11 flex-col px-1 py-1.5 text-10"} font-medium ${active === entry.section ? "bg-layer-1-selected text-primary" : "text-secondary hover:bg-layer-transparent-hover"}`}>
      <entry.icon aria-hidden size={18} /><span>{translate(entry.label)}</span></NavLink>)}
  </nav>;
}
