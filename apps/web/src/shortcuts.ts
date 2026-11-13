/** Tooltip text that names the keyboard shortcut, in the same form as the shell's sidebar toggle: "Bold (Ctrl/⌘+B)". */
export function withShortcut(label: string, key: string): string {
  return `${label} (Ctrl/⌘+${key})`;
}

/** Fired on the document by the Ctrl/⌘+K editor shortcut; the Link button of the focused editor opens its form. */
export const OPEN_LINK_EVENT = "weft:open-link";
