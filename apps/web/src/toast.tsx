import React from "react";
import { Check, CircleAlert } from "lucide-react";

type Toast = { id: number; tone: "success" | "error"; message: string };
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Shows a short message in the corner of the screen; it clears itself after a few seconds. */
export function showToast(message: string, tone: Toast["tone"] = "success") {
  const toast = { id: nextId++, tone, message };
  toasts = [...toasts.slice(-2), toast];
  emit();
  setTimeout(() => { toasts = toasts.filter((candidate) => candidate.id !== toast.id); emit(); }, tone === "error" ? 5000 : 2500);
}

/** Writes to the clipboard and tells the user what happened, either way. */
export async function copyText(text: string, done: string, failed: string) {
  try { await navigator.clipboard.writeText(text); showToast(done); return true; } catch { showToast(failed, "error"); return false; }
}

export function Toaster() {
  const current = React.useSyncExternalStore(subscribe, () => toasts);
  return <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[100] grid gap-2">
    {current.map((toast) => <div key={toast.id} className="flex items-center gap-2 rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary shadow-lg">
      {toast.tone === "success" ? <Check aria-hidden size={14} className="text-success-text" /> : <CircleAlert aria-hidden size={14} className="text-danger-text" />}
      {toast.message}
    </div>)}
  </div>;
}
