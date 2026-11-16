import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { Command, Search } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "./api";
import { CreateWorkItemModal } from "./create-work-item-modal";
import { paths } from "./routes";
import { projectsKey } from "./shell/sidebar";
import { themes, useTheme, type Theme } from "./theme";
import type { Current, Member, Project } from "./types";
import { isPaletteToggle, matchesQuery, modalDialogOpen, paletteToolAllowed, type PaletteTool, nextActive, pageLocation, paletteKeys, type PaletteAction } from "./command-palette-model";

/** The top-bar button dispatches this event; the palette, mounted once for every signed-in screen, listens for it. */
export const openPaletteEvent = "weft:open-command-palette";

type Group = "workItems" | "pages" | "navigate" | "projects" | "settings" | "create" | "workspaces" | "theme" | "account";
const groupLabel: Record<Group, MessageKey> = {
  workItems: "palette.groupWorkItems", pages: "palette.groupPages", navigate: "palette.groupNavigate", projects: "palette.groupProjects",
  settings: "palette.groupSettings", create: "palette.groupCreate", workspaces: "palette.groupWorkspaces", theme: "palette.groupTheme", account: "palette.groupAccount",
};

type Entry = { id: string; group: Group; label: string; hint?: string; /** Where a result lives, shown as a small tag beside it. */ where?: string; /** Results from the server already match the query; local entries are filtered here. */ local: boolean; run: () => void };
type WorkHit = { id: string; displayId: string; title: string; snippet: string };
type PageHit = { id: string; title: string; snippet: string; projectId: string | null };
type Found = { status: "idle" | "loading" | "done" | "failed"; items: WorkHit[]; pages: PageHit[] };

const wsSettings: Array<{ label: MessageKey; to: (slug: string) => string; tool?: PaletteTool }> = [
  { label: "settings.general", to: paths.workspaceSettings },
  { label: "members.title", to: paths.workspaceMembers },
  { label: "settings.invites", to: paths.workspaceInvites, tool: "invites" },
  { label: "settings.agents", to: paths.workspaceAgents },
  { label: "settings.skills", to: paths.workspaceSkills },
  { label: "settings.exports", to: paths.workspaceExports, tool: "exports" },
  { label: "settings.usage", to: paths.workspaceUsage, tool: "usage" },
  { label: "runtimes.title", to: paths.workspaceRuntimes, tool: "runtimes" },
  { label: "rail.ai", to: paths.workspaceAi, tool: "ai" },
];

/** Keeps the palette's keys and its own rows on one list; the Enter key is ignored while an IME is composing text (Thai input). */
export function CommandPalette({ current, signOut }: { current: Current; signOut: () => Promise<void> }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [, setTheme] = useTheme();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [found, setFound] = React.useState<Found>({ status: "idle", items: [], pages: [] });
  const [creatingIn, setCreatingIn] = React.useState<Project | null>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const latest = React.useRef(0);
  const listId = React.useId();
  const slug = pathname.split("/")[1] ?? "";
  const workspace = current.workspaces.find((item) => item.slug === slug) ?? null;
  const workspaceId = workspace?.id ?? "";
  const text = query.trim();

  const { data: projects = [] } = useQuery({
    queryKey: projectsKey(workspaceId),
    queryFn: async () => await action<Project[]>("list_projects", { workspaceId, archived: false }) ?? [],
    enabled: open && workspaceId !== "",
  });

  const { data: members } = useQuery({
    queryKey: ["workspace-members", workspaceId],
    queryFn: async () => await action<Member[]>("list_members", { workspaceId }) ?? [],
    enabled: open && workspaceId !== "",
  });
  const role = members?.find((member) => member.userId === current.user.id)?.role ?? null;

  const openPalette = React.useCallback(() => {
    if (modalDialogOpen(document)) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    setOpen(true);
  }, []);

  /** Escape and the backdrop put focus back where the person was; a chosen entry navigates instead, so focus is left alone. */
  const closePalette = React.useCallback(() => {
    setOpen(false);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape is read here, not only in the search field, so it still closes the palette after Tab moves focus.
      if (open && event.key === "Escape") { event.preventDefault(); closePalette(); return; }
      // A create dialog already on screen keeps the keys; the palette does not open over it.
      if (!isPaletteToggle(event) || creatingIn) return;
      event.preventDefault();
      if (open) closePalette(); else openPalette();
    };
    const onOpenRequest = () => { if (!open) openPalette(); };
    document.addEventListener("keydown", onKey);
    window.addEventListener(openPaletteEvent, onOpenRequest);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(openPaletteEvent, onOpenRequest);
    };
  }, [open, creatingIn, openPalette, closePalette]);

  React.useEffect(() => { if (open) input.current?.focus(); }, [open]);

  React.useEffect(() => {
    if (!open || workspaceId === "" || text.length === 0) { setFound({ status: "idle", items: [], pages: [] }); return; }
    const ticket = ++latest.current;
    setFound((previous) => ({ ...previous, status: "loading" }));
    const timer = setTimeout(async () => {
      const [items, pages] = await Promise.all([
        action<WorkHit[]>("search_work_items", { workspaceId, query: text, limit: 8 }),
        action<PageHit[]>("search_wiki_pages", { workspaceId, query: text, limit: 8 }),
      ]);
      if (ticket !== latest.current) return;
      setFound(items === null || pages === null ? { status: "failed", items: items ?? [], pages: pages ?? [] } : { status: "done", items, pages });
    }, 200);
    return () => clearTimeout(timer);
  }, [open, text, workspaceId]);

  const theme = (value: Theme): Entry => ({ id: `theme-${value}`, group: "theme", label: `${translate("palette.themeTo")} ${translate(`theme.${value}`)}`, local: true, run: () => setTheme(value) });

  const serverEntries: Entry[] = text ? [
    ...found.items.map((hit): Entry => ({ id: `work-${hit.id}`, group: "workItems", label: `${hit.displayId} ${hit.title}`, hint: hit.snippet, local: false, run: () => navigate(paths.workItem(slug, hit.displayId)) })),
    ...found.pages.flatMap((page): Entry[] => {
      const at = pageLocation(page.projectId, projects);
      if (at.kind === "unavailable") return [];
      // A project whose Pages switch is off hides its Pages from search, the same as from the sidebar.
      if (page.projectId && projects.find((project) => project.id === page.projectId)?.features.pages === false) return [];
      return [{ id: `page-${page.id}`, group: "pages", label: page.title, hint: page.snippet, where: at.kind === "project" ? `${translate("palette.inProject")} ${at.key}` : translate("palette.inWiki"), local: false,
        run: () => navigate(at.kind === "project" ? paths.page(slug, at.key, page.id) : paths.wikiPage(slug, page.id)) }];
    }),
  ] : [];

  const localEntries: Entry[] = [];
  if (workspace) {
    localEntries.push(
      { id: "nav-projects", group: "navigate", label: translate("projects.title"), local: true, run: () => navigate(paths.projects(slug)) },
      { id: "nav-wiki", group: "navigate", label: translate("wiki.title"), local: true, run: () => navigate(paths.wiki(slug)) },
      { id: "nav-analytics", group: "navigate", label: translate("analytics.title"), local: true, run: () => navigate(paths.analytics(slug)) },
      ...projects.map((project): Entry => ({ id: `project-${project.id}`, group: "projects", label: project.name, hint: project.key, local: true, run: () => navigate(paths.workItems(slug, project.key)) })),
      ...projects.filter((project) => project.role === "Admin" || project.role === "Member").map((project): Entry => ({
        id: `create-${project.id}`, group: "create", label: `${translate("palette.newItemIn")} ${project.name}`, hint: project.key, local: true, run: () => setCreatingIn(project),
      })),
      ...wsSettings.filter((section) => !section.tool || paletteToolAllowed(section.tool, role)).map((section): Entry => ({ id: `settings-${section.label}`, group: "settings", label: translate(section.label), local: true, run: () => navigate(section.to(slug)) })),
      ...projects.map((project): Entry => ({ id: `project-settings-${project.id}`, group: "settings", label: `${project.name}: ${translate("settings.label")}`, hint: project.key, local: true, run: () => navigate(paths.projectSettings(slug, project.key)) })),
    );
  }
  localEntries.push(
    ...current.workspaces.filter((item) => item.slug !== slug).map((item): Entry => ({ id: `workspace-${item.id}`, group: "workspaces", label: `${translate("palette.switchTo")} ${item.name}`, local: true, run: () => navigate(paths.home(item.slug)) })),
    ...themes.map(theme),
    { id: "account-shortcuts", group: "account", label: translate("shortcuts.title"), local: true, run: () => navigate(paths.shortcuts()) },
    ...(workspaceId === "" || paletteToolAllowed("tokens", role) ? [{ id: "account-tokens", group: "account" as const, label: translate("tokens.title"), local: true, run: () => navigate(paths.apiTokens()) }] : []),
    { id: "account-sign-out", group: "account", label: translate("auth.signOut"), local: true, run: () => void signOut() },
  );

  const visible = [...serverEntries, ...localEntries.filter((entry) => matchesQuery(`${entry.label} ${entry.hint ?? ""}`, text))];
  const activeIndex = Math.min(active, Math.max(visible.length - 1, 0));
  const optionId = (index: number) => `${listId}-option-${index}`;

  function choose(entry: Entry) {
    // Choosing an entry navigates or opens a dialog, so the palette closes without handing focus back.
    setOpen(false);
    returnFocus.current = null;
    entry.run();
  }

  function onInputKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    const handled = paletteKeys[event.key as keyof typeof paletteKeys] as { action: PaletteAction } | undefined;
    // Escape (action "close") is handled by the document listener above.
    if (!handled || handled.action === "close") return;
    event.preventDefault();
    if (handled.action === "next") setActive(nextActive(activeIndex, 1, visible.length));
    else if (handled.action === "previous") setActive(nextActive(activeIndex, -1, visible.length));
    else if (handled.action === "run") { const entry = visible[activeIndex]; if (entry) choose(entry); }
  }

  const creating = creatingIn && workspace
    ? <CreateWorkItemModal project={creatingIn} onClose={() => setCreatingIn(null)} onCreated={(item) => { setCreatingIn(null); navigate(paths.workItem(slug, item.displayId)); }} />
    : null;
  if (!open) return creating;

  let previousGroup: Group | null = null;
  return <>
    <div className="fixed inset-0 z-50 flex justify-center bg-backdrop px-4 pt-[10vh] max-md:pt-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
      <div role="dialog" aria-modal="true" aria-label={translate("palette.title")} className="flex max-h-[75vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-subtle bg-surface-1 shadow-xl">
        <div className="flex items-center gap-2 border-b border-subtle px-3">
          <Search aria-hidden size={16} className="shrink-0 text-tertiary" />
          <input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={visible[activeIndex] ? optionId(activeIndex) : undefined} aria-label={translate("palette.title")}
            placeholder={translate("palette.placeholder")} maxLength={200} value={query} autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent py-3 text-14 text-primary placeholder:text-tertiary focus:outline-none"
            onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onInputKey} />
        </div>
        <div id={listId} role="listbox" aria-label={translate("palette.results")} className="min-h-0 flex-1 overflow-y-auto p-1">
          {visible.map((entry, index) => {
            const heading = entry.group !== previousGroup ? <p key={`heading-${entry.group}`} role="presentation" className="px-2.5 pb-1 pt-2 text-12 font-medium text-tertiary">{translate(groupLabel[entry.group])}</p> : null;
            previousGroup = entry.group;
            return <React.Fragment key={entry.id}>{heading}
              <div id={optionId(index)} role="option" aria-selected={index === activeIndex} onMouseMove={() => setActive(index)} onClick={() => choose(entry)}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-14 text-primary ${index === activeIndex ? "bg-layer-transparent-hover" : ""}`}>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.where && <span className="max-w-[40%] shrink-0 truncate rounded bg-layer-2 px-1.5 py-0.5 text-12 text-secondary">{entry.where}</span>}
                {entry.hint && <span className="max-w-[40%] shrink truncate text-12 text-tertiary">{entry.hint}</span>}
              </div>
            </React.Fragment>;
          })}
          {visible.length === 0 && <p role="status" className="px-2.5 py-3 text-14 text-secondary">{found.status === "loading" ? translate("palette.searching") : translate("palette.empty")}</p>}
          {found.status === "failed" && <p role="alert" className="px-2.5 py-2 text-12 text-danger-text">{translate("palette.failed")}</p>}
        </div>
        <p className="border-t border-subtle px-3 py-2 text-12 text-tertiary">{translate("palette.hint")}</p>
      </div>
    </div>
    {creating}
  </>;
}

/** Top-bar button for the palette. Its title shows the shortcut, so the key is discoverable. */
export function CommandPaletteButton({ shortcut }: { shortcut: string }) {
  const label = `${translate("palette.button")} (${shortcut})`;
  return <button type="button" aria-label={label} title={label} onClick={() => window.dispatchEvent(new Event(openPaletteEvent))}
    className="flex items-center rounded-md bg-transparent p-1.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary">
    <Command aria-hidden size={18} />
  </button>;
}
