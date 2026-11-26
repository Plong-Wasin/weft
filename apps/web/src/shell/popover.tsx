import { Button } from "@/ui/button";
import React from "react";
import { Check, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Popover as PopoverPrimitive, PopoverContent, PopoverTrigger } from "../ui/popover";

type Rect = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

function intersects(start: number, end: number, clipStart: number, clipEnd: number) {
  return end > clipStart && start < clipEnd;
}

function isVisibleInScrollContainers(element: HTMLElement) {
  const bounds = element.getBoundingClientRect();
  if (!intersects(bounds.left, bounds.right, 0, window.innerWidth) || !intersects(bounds.top, bounds.bottom, 0, window.innerHeight)) return false;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    const clip = ancestor.getBoundingClientRect();
    const left = clip.left + ancestor.clientLeft;
    const top = clip.top + ancestor.clientTop;
    if (style.overflowX !== "visible" && !intersects(bounds.left, bounds.right, left, left + ancestor.clientWidth)) return false;
    if (style.overflowY !== "visible" && !intersects(bounds.top, bounds.bottom, top, top + ancestor.clientHeight)) return false;
  }
  return true;
}

/** A button that opens a floating panel. Closes on outside click, Escape, or when `close` is called by the panel. */
export function Popover({ label, panelLabel = label, trigger, align = "left", className = "", panelClassName = "", panelRole = "menu", onOpen, children }: {
  label: string; panelLabel?: string; trigger: React.ReactNode; align?: "left" | "right"; className?: string; panelClassName?: string; panelRole?: "menu" | "dialog";
  onOpen?: () => void;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const panelContainer = root.current?.closest<HTMLElement>('dialog[open], [data-slot="dialog-content"], [data-create-modal]') ?? undefined;
  React.useEffect(() => {
    if (!open || panelRole !== "dialog") return;
    const anchor = root.current?.querySelector("button");
    const closeWhenAnchorIsHidden = () => {
      if (!anchor || !isVisibleInScrollContainers(anchor)) setOpen(false);
    };
    window.addEventListener("scroll", closeWhenAnchorIsHidden, true);
    window.addEventListener("resize", closeWhenAnchorIsHidden);
    return () => {
      window.removeEventListener("scroll", closeWhenAnchorIsHidden, true);
      window.removeEventListener("resize", closeWhenAnchorIsHidden);
    };
  }, [open, panelRole]);
  const triggerClass = cn("flex items-center gap-1.5 rounded-md bg-transparent p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background pointer-coarse:min-h-11 pointer-coarse:min-w-11", className, "pointer-coarse:min-h-11 pointer-coarse:min-w-11");
  // A trigger that brings no surface of its own is a ghost button; one with a background keeps the bordered secondary.
  if (panelRole === "menu") return <DropdownMenu open={open} onOpenChange={(nextOpen) => { if (nextOpen && !open) onOpen?.(); setOpen(nextOpen); }}>
    <div ref={root} className="relative">
      <DropdownMenuTrigger aria-label={label} title={label} className={triggerClass}>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent container={panelContainer} align={align === "right" ? "end" : "start"} sideOffset={4} data-popover-panel aria-label={panelLabel} className={cn("max-h-[min(32rem,var(--available-height))] min-w-56", panelClassName)}>
        {children(() => setOpen(false))}
      </DropdownMenuContent>
    </div>
  </DropdownMenu>;
  return <PopoverPrimitive open={open} onOpenChange={(nextOpen) => { if (nextOpen && !open) onOpen?.(); setOpen(nextOpen); }}>
    <div ref={root} className="relative" onKeyDownCapture={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    }}>
      <PopoverTrigger render={<Button variant={triggerClass.split(" ").includes("bg-transparent") ? "ghost" : "secondary"} type="button" aria-label={label} title={label} className={triggerClass} />}>{trigger}</PopoverTrigger>
      <PopoverContent container={panelContainer} align={align === "right" ? "end" : "start"} sideOffset={4} role={panelRole} aria-label={panelLabel} data-popover-panel className={cn("w-auto p-1", panelClassName)}>
        {children(() => setOpen(false))}
      </PopoverContent>
    </div>
  </PopoverPrimitive>;
}

export const menuItemClass = "transition-colors flex h-auto min-h-9 w-full hover:bg-accent items-center gap-2 px-2.5 py-1.5 text-left text-sm text-popover-foreground outline-none focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground pointer-coarse:min-h-11";

/**
 * A menu row with a leading icon. A `menuitemcheckbox` row carries `aria-checked` and a check mark while it is on.
 * `hint` becomes the row's tooltip (`title`) and its described-by text, kept out of the visible row.
 */
export function MenuItem({ icon: Icon, role = "menuitem", checked, hint, danger = false, className = "", children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon; role?: "menuitem" | "menuitemcheckbox"; checked?: boolean; hint?: string; danger?: boolean;
}) {
  const hintId = React.useId();
  const isSwitch = role === "menuitemcheckbox";
  const rowClass = cn(menuItemClass, "cursor-default outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", isSwitch && "!justify-between", danger && "text-destructive focus:text-destructive", className);
  if (isSwitch) return <Button type="button" role={role} aria-checked={Boolean(checked)} title={hint} aria-describedby={hint ? hintId : undefined} className={rowClass} {...props}>
    <span className="flex min-w-0 items-center gap-2"><Icon aria-hidden size={16} className={`shrink-0 ${danger ? "" : "text-muted-foreground"}`} />{children}</span>
    <Check aria-hidden size={14} className={`shrink-0 ${checked ? "text-current" : "invisible"}`} />
    {hint && <span id={hintId} hidden>{hint}</span>}
  </Button>;
  return <DropdownMenuItem title={hint} aria-describedby={hint ? hintId : undefined} className={rowClass} {...props as React.ComponentProps<typeof DropdownMenuItem>}>
    <span className="flex min-w-0 items-center gap-2"><Icon aria-hidden size={16} className={`shrink-0 ${danger ? "" : "text-muted-foreground"}`} />{children}</span>
    {hint && <span id={hintId} hidden>{hint}</span>}
  </DropdownMenuItem>;
}
