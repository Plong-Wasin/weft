import React from "react";
import { translate, type MessageKey } from "@weft/shared";

export const dangerButton = "bg-danger-primary text-on-color hover:bg-danger-primary-hover";

/** Section heading of a settings page: title, one-line description, rule underneath (Plane's settings header). */
export function SettingsHeader({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-subtle pb-4">
    <div className="grid gap-1"><h1 className="text-18 font-semibold text-primary">{title}</h1>{description && <p className="text-13 text-secondary">{description}</p>}</div>
    {children}
  </header>;
}

/** A labelled block inside a settings page. */
export function SettingsBlock({ title, description, children }: { title?: string; description?: string; children: React.ReactNode }) {
  return <section className="mb-8 grid gap-3">
    {title && <div className="grid gap-0.5"><h3 className="text-16 font-medium text-primary">{title}</h3>{description && <p className="text-13 text-secondary">{description}</p>}</div>}
    {children}
  </section>;
}

/** Bordered list of rows (members, invites, labels, states). */
export function RowList({ children }: { children: React.ReactNode }) {
  return <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] rounded-lg border border-subtle bg-surface-1 p-0">{children}</ul>;
}

export function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-14">{children}</li>;
}

/** Danger zone: a red-ruled block holding the destructive Actions of a settings page. */
export function DangerZone({ heading, description, children }: { heading: MessageKey; description: string; children: React.ReactNode }) {
  return <section aria-label={translate("settings.dangerZone")} className="mt-10 grid gap-3 rounded-lg border border-danger-strong p-4">
    <h3 className="text-16 font-medium text-danger-text">{translate("settings.dangerZone")}</h3>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="grid gap-0.5"><p className="text-14 font-medium text-primary">{translate(heading)}</p><p className="text-13 text-secondary">{description}</p></div>
      {children}
    </div>
  </section>;
}

/** Inline status line of a settings page: shown for failures and confirmations. */
export function Note({ note, error }: { note: string | null; error?: boolean }) {
  return note ? <p role={error ? "alert" : "status"} className={`text-13 ${error ? "text-danger-text" : "text-secondary"}`}>{note}</p> : null;
}
