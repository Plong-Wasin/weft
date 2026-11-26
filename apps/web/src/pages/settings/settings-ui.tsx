import { Card } from "@/ui/card";
import React from "react";
import { translate, type MessageKey } from "@weft/shared";

/** The destructive entry point: outlined, so the filled danger button is kept for a confirmation. */
export const dangerOutline = "rounded-md border border-destructive/40 text-sm font-medium text-destructive hover:border-destructive/60 hover:bg-destructive/10 pointer-coarse:min-h-11";
export const dangerButton = "rounded-md bg-destructive text-sm font-medium text-primary-foreground hover:bg-destructive/90";
const InSettingsBlock = React.createContext(false);

/** Section heading of a settings page: title, one-line description, rule underneath (Plane's settings header). */
export function SettingsHeader({ title, description, children, level = 1 }: { title: string; description?: string; children?: React.ReactNode; level?: 1 | 2 }) {
  const Heading = level === 1 ? "h1" : "h2";
  return <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
    <div className="grid gap-1"><Heading className={level === 1 ? "text-lg font-semibold text-foreground" : "text-sm font-medium text-foreground"}>{title}</Heading>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div>
    {children}
  </header>;
}

/** A labelled block inside a settings page. */
export function SettingsBlock({ title, description, children }: { title?: string; description?: string; children: React.ReactNode }) {
  return <InSettingsBlock.Provider value={true}>
    <Card as="section" className="mb-6 grid gap-3 p-4 sm:p-5">
      {title && <div className="grid gap-0.5"><h2 className="text-sm font-medium text-foreground">{title}</h2>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div>}
      {children}
    </Card>
  </InSettingsBlock.Provider>;
}

/** Bordered list of rows (members, invites, labels, states). */
export function RowList({ children }: { children: React.ReactNode }) {
  const inSettingsBlock = React.useContext(InSettingsBlock);
  const classes = "m-0 grid list-none divide-y divide-[var(--border)] p-0";
  return inSettingsBlock ? <ul className={classes}>{children}</ul> : <Card as="ul" className={`${classes} rounded-xl`}>{children}</Card>;
}

export function Row({ children }: { children: React.ReactNode }) {
  const inSettingsBlock = React.useContext(InSettingsBlock);
  return <li className={`transition-colors duration-[120ms] hover:bg-accent focus-visible:bg-accent flex flex-wrap items-center gap-3 rounded-lg ${inSettingsBlock ? "px-0" : "px-4"} py-3 text-sm`}>{children}</li>;
}

/** Danger zone: a red-ruled block holding the destructive Actions of a settings page. */
export function DangerZone({ heading, description, children }: { heading: MessageKey; description: string; children: React.ReactNode }) {
  return <section aria-label={translate("settings.dangerZone")} className="mt-10 grid gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:p-5">
    <h2 className="text-sm font-medium text-destructive">{translate("settings.dangerZone")}</h2>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="grid gap-0.5"><p className="text-sm font-medium text-foreground">{translate(heading)}</p><p className="text-sm text-muted-foreground">{description}</p></div>
      {children}
    </div>
  </section>;
}

/** Inline status line of a settings page: shown for failures and confirmations. */
export function Note({ note, error }: { note: string | null; error?: boolean }) {
  return note ? <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>{note}</p> : null;
}
