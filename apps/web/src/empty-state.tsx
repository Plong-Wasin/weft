import React from "react";

/** The one empty-state block: a short title, one sentence of value, and at most one primary action (omit it when the viewer cannot act). */
export function EmptyState({ title, description, action, icon, className = "" }: { title: string; description?: string; action?: React.ReactNode; icon?: React.ReactNode; className?: string }) {
  return <div role="status" className={`mx-auto grid max-w-md justify-items-center gap-2 px-4 py-10 text-center ${className}`}>
    {icon && <span aria-hidden className="mb-1 grid size-10 place-items-center rounded-full bg-layer-1 text-secondary">{icon}</span>}
    <p className="m-0 text-16 font-semibold text-primary">{title}</p>
    {description && <p className="m-0 text-14 text-secondary">{description}</p>}
    {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
  </div>;
}
