import React from "react";

/** Shared page heading rhythm. Breadcrumbs and actions share the title row and may wrap without covering each other; on phones the breadcrumb takes its own line above the title. */
export function PageHeader({ title, breadcrumb, actions, level = 1, className = "" }: {
  title: React.ReactNode;
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  level?: 1 | 2;
  className?: string;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return <header data-testid="page-header" className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 ${className}`}>
    {breadcrumb && <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground max-sm:basis-full">{breadcrumb}</div>}
    <Heading className="m-0 flex min-w-0 flex-1 items-center gap-2 text-2xl font-semibold leading-tight text-foreground max-sm:text-xl">{title}</Heading>
    {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
  </header>;
}
