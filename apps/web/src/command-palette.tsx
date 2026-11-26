import { Button } from "@/ui/button";
import React from "react";
import { flushSync } from "react-dom";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { Command as CommandIcon, X } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "./api";
import { CreateWorkItemModal } from "./create-work-item-modal";
import { paths } from "./routes";
import { projectsKey } from "./shell/sidebar";
import { themes, useTheme, type Theme } from "./theme";
import type { Current, Member, Project } from "./types";
import { useAiEnabled } from "./ai-flag";
import { isPaletteToggle, matchesQuery, modalDialogOpen, paletteToolAllowed, type PaletteTool, pageLocation } from "./command-palette-model";
import { DialogClose, DialogContent } from "./ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
  const aiOn = useAiEnabled();
  const [query, setQuery] = React.useState("");
  const [activeEntryId, setActiveEntryId] = React.useState("");
  const [found, setFound] = React.useState<Found>({ status: "idle", items: [], pages: [] });
  const [creatingIn, setCreatingIn] = React.useState<Project | null>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const latest = React.useRef(0);
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
    setActiveEntryId("");
    setOpen(true);
  }, []);

  /** Base UI restores focus on Escape and outside dismissal; choosing an entry navigates instead. */
  const closePalette = React.useCallback(() => {
    setOpen(false);
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
      ...wsSettings.filter((section) => (!section.tool || paletteToolAllowed(section.tool, role)) && (section.tool !== "ai" || aiOn)).map((section): Entry => ({ id: `settings-${section.label}`, group: "settings", label: translate(section.label), local: true, run: () => navigate(section.to(slug)) })),
      ...projects.map((project): Entry => ({ id: `project-settings-${project.id}`, group: "settings", label: `${project.name}: ${translate("settings.label")}`, hint: project.key, local: true, run: () => navigate(paths.projectSettings(slug, project.key)) })),
    );
  }
  localEntries.push(
    ...current.workspaces.filter((item) => item.slug !== slug).map((item): Entry => ({ id: `workspace-${item.id}`, group: "workspaces", label: `${translate("palette.switchTo")} ${item.name}`, local: true, run: () => navigate(paths.home(item.slug)) })),
    ...themes.map(theme),
    { id: "account-shortcuts", group: "account", label: translate("shortcuts.title"), local: true, run: () => navigate(paths.shortcuts()) },
    ...(workspaceId === "" || paletteToolAllowed("tokens", role) ? [{ id: "account-tokens", group: "account" as const, label: translate("tokens.title"), local: true, run: () => navigate(workspace ? paths.workspaceApiTokens(workspace.slug) : paths.apiTokens()) }] : []),
    { id: "account-sign-out", group: "account", label: translate("auth.signOut"), local: true, run: () => void signOut() },
  );

  const visible = [...serverEntries, ...localEntries.filter((entry) => matchesQuery(`${entry.label} ${entry.hint ?? ""}`, text))];
  const commandValue = visible.some((entry) => entry.id === activeEntryId) ? activeEntryId : visible[0]?.id ?? "";
  React.useEffect(() => {
    if (open && !visible.some((entry) => entry.id === activeEntryId)) setActiveEntryId(visible[0]?.id ?? "");
  }, [open, activeEntryId, visible]);

  const grouped: Array<{ group: Group; entries: Entry[] }> = [];
  for (const entry of visible) {
    const currentGroup = grouped[grouped.length - 1];
    if (currentGroup?.group === entry.group) currentGroup.entries.push(entry);
    else grouped.push({ group: entry.group, entries: [entry] });
  }

  function choose(entry: Entry) {
    // Choosing an entry navigates or opens a dialog, so the palette closes without handing focus back.
    returnFocus.current = null;
    flushSync(() => setOpen(false));
    entry.run();
  }

  const creating = creatingIn && workspace
    ? <CreateWorkItemModal project={creatingIn} onClose={() => setCreatingIn(null)} onCreated={(item) => { setCreatingIn(null); navigate(paths.workItem(slug, item.displayId)); }} />
    : null;

  return <>
    <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal>
      <DialogContent aria-label={translate("palette.title")} initialFocus={input} finalFocus={() => returnFocus.current ?? false} className="flex max-h-[min(75vh,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-xl flex-col gap-0 overflow-hidden p-0">
        <Command shouldFilter={false} loop value={commandValue} onValueChange={setActiveEntryId} onKeyDownCapture={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement)) return;
          const selectedId = document.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')?.dataset.value ?? commandValue;
          const selectedEntry = visible.find((entry) => entry.id === selectedId);
          if (!selectedEntry) return;
          event.preventDefault();
          event.stopPropagation();
          choose(selectedEntry);
        }} className="min-h-0 flex-1">
          <CommandInput ref={input} aria-label={translate("palette.title")} placeholder={translate("palette.placeholder")} maxLength={200} value={query} onValueChange={setQuery} endContent={<DialogClose aria-label={translate("workItems.close")} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"><X aria-hidden size={16} /></DialogClose>} />
          <CommandList aria-label={translate("palette.results")} className="min-h-0 max-h-none flex-1">
            {grouped.map(({ group, entries }) => <CommandGroup key={group} heading={translate(groupLabel[group])}>
              {entries.map((entry) => <CommandItem key={entry.id} value={entry.id} keywords={[entry.label, entry.hint ?? "", entry.where ?? ""]} onSelect={() => choose(entry)} className="min-h-9 gap-2 rounded-md px-2.5 py-2 text-sm">
                <span className="min-w-0 flex-1 thai-room truncate">{entry.label}</span>
                {entry.where && <span className="max-w-[40%] shrink-0 thai-room truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{entry.where}</span>}
                {entry.hint && <span className="max-w-[40%] shrink thai-room truncate text-xs text-muted-foreground">{entry.hint}</span>}
              </CommandItem>)}
            </CommandGroup>)}
            {visible.length === 0 && <CommandEmpty role="status">{found.status === "loading" ? translate("palette.searching") : translate("palette.empty")}</CommandEmpty>}
          </CommandList>
          {found.status === "failed" && <p role="alert" className="m-0 border-t border-border px-3 py-2 text-xs text-destructive">{translate("palette.failed")}</p>}
          <p className="m-0 border-t border-border px-3 py-2 text-xs text-muted-foreground">{translate("palette.hint")}</p>
        </Command>
      </DialogContent>
    </DialogPrimitive.Root>
    {creating}
  </>;
}

/** Top-bar button for the palette. Its title shows the shortcut, so the key is discoverable. */
export function CommandPaletteButton({ shortcut }: { shortcut: string }) {
  const label = `${translate("palette.button")} (${shortcut})`;
  return <Button variant="ghost" type="button" aria-label={label} title={label} onClick={() => window.dispatchEvent(new Event(openPaletteEvent))}
    className="flex items-center bg-transparent p-2 text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11">
    <CommandIcon aria-hidden size={18} />
  </Button>;
}
