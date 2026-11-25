import React from "react";
import { translate, type MessageKey } from "@weft/shared";

/** The destructive entry point: outlined, so the filled danger button is kept for a confirmation. */
export const dangerOutline = "rounded-md border border-danger-strong px-3 py-1.5 text-14 font-medium text-danger-text hover:bg-danger-subtle max-sm:min-h-11";
export const dangerButton = "rounded-md bg-danger-primary px-3 py-1.5 text-14 font-medium text-on-color hover:bg-danger-primary-hover";

/** Section heading of a settings page: title, one-line description, rule underneath (Plane's settings header). */
export function SettingsHeader({ title, description, children, level = 1 }: { title: string; description?: string; children?: React.ReactNode; level?: 1 | 2 }) {
  const Heading = level === 1 ? "h1" : "h2";
  return <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-subtle pb-4">
    <div className="grid gap-1"><Heading className={level === 1 ? "text-18 font-semibold text-primary" : "text-12 font-semibold uppercase tracking-wide text-tertiary"}>{title}</Heading>{description && <p className="text-13 text-secondary">{description}</p>}</div>
    {children}
  </header>;
}

/** A labelled block inside a settings page. */
export function SettingsBlock({ title, description, children }: { title?: string; description?: string; children: React.ReactNode }) {
  return <section className="card-surface mb-6 grid gap-3 p-4 sm:p-5">
    {title && <div className="grid gap-0.5"><h2 className="text-12 font-semibold uppercase tracking-wide text-tertiary">{title}</h2>{description && <p className="text-13 text-secondary">{description}</p>}</div>}
    {children}
  </section>;
}

/** Bordered list of rows (members, invites, labels, states). */
export function RowList({ children }: { children: React.ReactNode }) {
  return <ul className="m-0 grid list-none gap-1 p-0">{children}</ul>;
}

export function Row({ children }: { children: React.ReactNode }) {
  return <li className="inset-row-hover flex flex-wrap items-center gap-3 rounded-lg px-3 py-3 text-14">{children}</li>;
}

/** Danger zone: a red-ruled block holding the destructive Actions of a settings page. */
export function DangerZone({ heading, description, children }: { heading: MessageKey; description: string; children: React.ReactNode }) {
  return <section aria-label={translate("settings.dangerZone")} className="mt-10 grid gap-3 rounded-xl border border-danger-strong bg-danger-subtle/20 p-4 sm:p-5">
    <h2 className="text-12 font-semibold uppercase tracking-wide text-danger-text">{translate("settings.dangerZone")}</h2>
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
