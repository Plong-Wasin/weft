import React from "react";
import { translate } from "@weft/shared";

/** A small modal for one short form. Esc and a click on the backdrop close it; the first field takes focus. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const panel = React.useRef<HTMLElement>(null);
  const id = React.useId();
  // Callers pass a fresh onClose every render; keep the latest in a ref so focus moves once, on open, not on every re-render.
  const close = React.useRef(onClose);
  close.current = onClose;
  React.useEffect(() => {
    panel.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return <div role="presentation" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={id} className="grid w-full max-w-md gap-4 rounded-lg bg-surface-1 p-5 shadow-xl">
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
