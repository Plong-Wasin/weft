import React from "react";

/** A button that opens a floating panel. Closes on outside click, Escape, or when `close` is called by the panel. */
export function Popover({ label, trigger, align = "left", className = "", panelClassName = "", panelRole = "menu", children }: {
  label: string; trigger: React.ReactNode; align?: "left" | "right"; className?: string; panelClassName?: string; panelRole?: "menu" | "dialog";
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return <div ref={root} className="relative">
    <button type="button" aria-label={label} aria-haspopup={panelRole} aria-expanded={open} onClick={() => setOpen(!open)}
      className={`flex items-center gap-1.5 rounded-md bg-transparent p-1.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary ${className}`}>{trigger}</button>
    {open && <div role={panelRole} aria-label={label} className={`absolute top-full z-30 mt-1 min-w-56 rounded-lg border border-subtle bg-surface-1 p-1 shadow-lg ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}>
      {children(() => setOpen(false))}
    </div>}
  </div>;
}

export const menuItemClass = "flex w-full items-center gap-2 rounded-md bg-transparent px-2.5 py-1.5 text-left text-14 text-primary hover:bg-layer-transparent-hover";
