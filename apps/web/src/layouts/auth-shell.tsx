import React from "react";
import { translate } from "@weft/shared";

/** The Weft mark with "weft" as live text, like Plane's logo and name; the text follows the theme colour. */
export function Logo({ className = "" }: { className?: string }) {
  return <span className={`inline-flex items-center gap-2 text-primary ${className}`}>
    <img src="/brand/weft-mark.png" alt="" aria-hidden className="h-6 w-auto" />
    <span className="text-20 font-semibold lowercase leading-none tracking-tight">{translate("app.title")}</span>
  </span>;
}

/** Plane's auth layout: logo top left, a link to the other mode top right, a narrow centred column, language and theme at the foot. */
export function AuthShell({ action, footer, children }: { action?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) {
  return <div className="relative flex min-h-screen w-screen flex-col items-center overflow-y-auto bg-surface-1 px-8 pb-10 pt-6">
    <header className="sticky top-0 flex w-full flex-shrink-0 items-center justify-between gap-6">
      <Logo />
      {action}
    </header>
    <main className="flex w-full flex-1 flex-col items-center justify-center py-10">
      <div className="w-full max-w-[22.5rem]">{children}</div>
    </main>
    {footer && <footer className="flex flex-wrap items-center justify-center gap-4 text-13 text-secondary">{footer}</footer>}
  </div>;
}

/** Plane's workspace creation / invitation layout: a narrow rail with a divider and the logo, then the content. */
export function OnboardingShell({ action, children }: { action?: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col bg-surface-1 sm:flex-row">
    <div className="relative h-24 flex-shrink-0 sm:h-auto sm:w-2/12 md:w-3/12 lg:w-1/5">
      <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-[var(--border-subtle)] sm:left-1/2 sm:top-0 sm:h-full sm:w-px sm:-translate-x-1/2 sm:translate-y-0 md:left-1/3" />
      <div className="absolute left-5 top-1/2 -translate-y-1/2 bg-surface-1 px-3 sm:left-1/2 sm:top-12 sm:-translate-x-4 sm:translate-y-0 sm:px-0 sm:py-5 md:left-1/3"><Logo /></div>
      {action && <div className="absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-3 text-13 sm:fixed sm:right-16 sm:top-12 sm:translate-y-0 sm:py-5">{action}</div>}
    </div>
    <main className="flex flex-1 justify-center px-8 pb-8 pt-4 sm:items-center sm:justify-start sm:p-0 sm:pr-[8.33%]">
      <div className="w-full space-y-6 sm:max-w-md sm:space-y-8">{children}</div>
    </main>
  </div>;
}

/** Full-width Plane-style field: label above, 40px input. */
export const fieldClass = "h-10 w-full rounded-md border border-strong bg-surface-1 px-3 text-14 text-primary placeholder:text-placeholder focus:border-accent-strong focus:outline-none";
export const primaryButton = "h-10 w-full rounded-md bg-accent-primary px-3 text-14 font-medium text-on-color hover:bg-accent-primary-hover disabled:cursor-not-allowed disabled:opacity-50";
