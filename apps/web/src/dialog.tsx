import React from "react";
import { translate } from "@weft/shared";

/** A small modal for one short form. Esc and a click on the backdrop close it; the first field takes focus. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const panel = React.useRef<HTMLElement>(null);
  const id = React.useId();
  const downOnBackdrop = React.useRef(false);
  // Callers pass a fresh onClose every render; keep the latest in a ref so focus moves once, on open, not on every re-render.
  const close = React.useRef(onClose);
  close.current = onClose;
  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>("input, select, textarea, button, a[href], [tabindex]:not([tabindex='-1'])") ?? [])].filter((element) => !element.hasAttribute("disabled"));
    (panel.current?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea") ?? focusable()[0] ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) { event.preventDefault(); return; }
      const first = items[0]!; const last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (opener?.isConnected) opener.focus(); };
  }, []);
  return <div role="presentation" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(event) => { downOnBackdrop.current = event.target === event.currentTarget; }} onMouseUp={(event) => { if (downOnBackdrop.current && event.target === event.currentTarget) onClose(); downOnBackdrop.current = false; }}>
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} className="grid w-full max-w-md gap-4 rounded-lg bg-surface-1 p-5 shadow-xl">
      <h2 id={id} className="m-0 text-16 font-semibold text-primary">{title}</h2>
      {children}
    </section>
  </div>;
}

/** Cancel on the left of the primary action, as every form dialog ends. */
export function DialogActions({ onClose, submit }: { onClose: () => void; submit: string }) {
  return <div className="flex justify-end gap-2">
    <button type="button" className="secondary" onClick={onClose}>{translate("comments.cancel")}</button>
    <button type="submit">{submit}</button>
  </div>;
}
