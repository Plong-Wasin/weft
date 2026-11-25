import React from "react";
import { PanelRight, PanelRightClose } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";

export type DetailsPanelKind = "cycle" | "module" | "work-item";
const unavailableStorage = new Map<string, boolean>();

function storageKey(kind: DetailsPanelKind) {
  return `weft:details-panel:${kind}`;
}

export function readDetailsPanelOpen(kind: DetailsPanelKind): boolean {
  const key = storageKey(kind);
  try { return localStorage.getItem(key) !== "false"; } catch { return unavailableStorage.get(key) ?? true; }
}

export function writeDetailsPanelOpen(kind: DetailsPanelKind, open: boolean) {
  const key = storageKey(kind);
  try { localStorage.setItem(key, String(open)); unavailableStorage.delete(key); } catch { unavailableStorage.set(key, open); /* the choice still applies until this page closes */ }
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest("input, textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox']");
}

export function useDetailsPanel(kind: DetailsPanelKind, enabled = true) {
  const [open, setOpen] = React.useState(() => readDetailsPanelOpen(kind));
  const toggle = React.useCallback(() => {
    const next = !open;
    setOpen(next);
    writeDetailsPanelOpen(kind, next);
  }, [kind, open]);

  React.useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "i" && !event.isComposing && !isTypingTarget(event.target)) {
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, toggle]);

  return { open, toggle };
}

export function DetailsPanelToggle({ open, onToggle, panelId, testId }: { open: boolean; onToggle: () => void; panelId: string; testId?: string }) {
  const label = translate((open ? "detailsPanel.hide" : "detailsPanel.show") as MessageKey);
  return <button type="button" className="icon-button-ghost hidden lg:grid rounded-lg" data-testid={testId} aria-expanded={open} aria-pressed={open} aria-controls={panelId} aria-label={label}
    title={`${label} (Ctrl/⌘+I)`} onClick={onToggle}>
    {open ? <PanelRightClose aria-hidden size={16} /> : <PanelRight aria-hidden size={16} />}
  </button>;
}
