import * as React from "react";
import { cn } from "@/lib/utils";

type CardProps<T extends React.ElementType> = { as?: T; className?: string } & Omit<React.ComponentPropsWithRef<T>, "as" | "className">;

/** shadcn Card surface. `as` keeps the element the screen means: a section, a form or a list. */
export function Card<T extends React.ElementType = "div">({ as, className, ...props }: CardProps<T>) {
  const Element: React.ElementType = as ?? "div";
  return <Element data-slot="card" className={cn("rounded-[var(--radius)] border border-border bg-card", className)} {...props} />;
}
