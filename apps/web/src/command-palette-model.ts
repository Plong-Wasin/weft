import type { MessageKey } from "@weft/shared";

/**
 * Keys the command palette answers to, by KeyboardEvent.key. The shortcuts page builds its palette rows from this map,
 * so the page cannot list a key the palette does not handle.
 */
export const paletteKeys = {
  ArrowDown: { action: "next", key: "↓", describe: "shortcuts.paletteNext" },
  ArrowUp: { action: "previous", key: "↑", describe: "shortcuts.palettePrevious" },
  Enter: { action: "run", key: "Enter", describe: "shortcuts.paletteRun" },
  Escape: { action: "close", key: "Esc", describe: "shortcuts.paletteClose" },
} as const satisfies Record<string, { action: string; key: string; describe: MessageKey }>;

export type PaletteAction = (typeof paletteKeys)[keyof typeof paletteKeys]["action"];

export type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { defaultPrevented?: boolean };

/** Cmd+K on Mac or Ctrl+K elsewhere opens and closes the palette. Alt or Shift combinations are other shortcuts, and a key an editor already handled (Cmd+K makes a link inside text) is left to it. */
export function isPaletteToggle(event: ShortcutKeyEvent): boolean {
  return !event.defaultPrevented && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}

/** Mac shows the Command symbol and other systems show Ctrl. */
export function isMacPlatform(userAgent: string): boolean {
  return /Macintosh|iPhone|iPad|iPod/.test(userAgent);
}

export type Shortcut = { keys: string[]; describe: MessageKey };

/** Every shortcut the web app answers to. "Mod" means Command on Mac and Ctrl elsewhere. */
export const openPaletteShortcut: Shortcut = { keys: ["Mod", "K"], describe: "shortcuts.openPalette" };
export const shortcuts: Shortcut[] = [
  openPaletteShortcut,
  { keys: ["Mod", "\\"], describe: "shortcuts.toggleSidebar" },
  { keys: ["Esc"], describe: "shortcuts.closeMenu" },
  ...Object.values(paletteKeys).map((entry) => ({ keys: [entry.key], describe: entry.describe })),
  // Rich-text editors (descriptions, comments, Wiki pages). Mod+K is the Link shortcut there, as the toolbar tooltips say.
  { keys: ["Mod", "K"], describe: "shortcuts.editorLink" },
  { keys: ["Mod", "B"], describe: "shortcuts.editorBold" },
  { keys: ["Mod", "I"], describe: "shortcuts.editorItalic" },
  { keys: ["Mod", "Shift", "S"], describe: "shortcuts.editorStrike" },
  { keys: ["Mod", "E"], describe: "shortcuts.editorCode" },
  { keys: ["Mod", "Shift", "8"], describe: "shortcuts.editorBulletList" },
  { keys: ["Mod", "Shift", "7"], describe: "shortcuts.editorOrderedList" },
  { keys: ["Mod", "Shift", "B"], describe: "shortcuts.editorQuote" },
];

/** Shows a shortcut's keys for the reader's platform, for example "⌘ K" or "Ctrl K". */
export function formatShortcut(keys: string[], mac: boolean): string {
  return keys.map((key) => key === "Mod" ? (mac ? "⌘" : "Ctrl") : key).join(" ");
}

/** Case-insensitive: every typed word must appear in the label or its keywords. An empty query matches everything. */
export function matchesQuery(text: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Where a Pages search hit opens: a project Page under its project key, or a wiki page in the Wiki. "unavailable" when its project is not in the list yet. */
export function pageLocation(projectId: string | null, projects: ReadonlyArray<{ id: string; key: string }>): { kind: "project"; key: string } | { kind: "wiki" } | { kind: "unavailable" } {
  if (projectId === null) return { kind: "wiki" };
  const project = projects.find((item) => item.id === projectId);
  return project ? { kind: "project", key: project.key } : { kind: "unavailable" };
}

/** Moves the highlighted row by one, wrapping at both ends. */
export function nextActive(active: number, delta: 1 | -1, length: number): number {
  if (length === 0) return 0;
  return (active + delta + length) % length;
}

export type PaletteTool = "invites" | "runtimes" | "ai" | "exports" | "tokens" | "usage";

/** Palette entries that lead to a page the viewer cannot use are left out: Invites and Usage are for Admins; Runtimes, AI, Exports and API tokens are for Admins and Members. Until the role is known they stay hidden. */
export function paletteToolAllowed(tool: PaletteTool, role: "Admin" | "Member" | "Guest" | null): boolean {
  if (role === null) return false;
  if (tool === "invites" || tool === "usage") return role === "Admin";
  return role !== "Guest";
}

/** True when a modal dialog other than the palette itself is on screen; the palette does not open over it. */
export function modalDialogOpen(root: Pick<ParentNode, "querySelector">): boolean {
  return root.querySelector('[aria-modal="true"]') !== null;
}
