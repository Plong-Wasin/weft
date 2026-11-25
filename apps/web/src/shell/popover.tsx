import React from "react";
import { createPortal } from "react-dom";
import { Check, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

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

export function getPopoverPosition(anchor: Rect, panel: Pick<DOMRect, "width" | "height">, viewport: { width: number; height: number }, align: "left" | "right") {
  const margin = 16;
  const gap = 4;
  const viewportHeight = Math.max(0, viewport.height - margin * 2);
  const requestedHeight = Math.min(panel.height, viewportHeight);
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const opensAbove = below < requestedHeight && above > below;
  const maxHeight = Math.max(0, Math.min(viewportHeight, opensAbove ? above : below));
  const height = Math.min(requestedHeight, maxHeight);
  const top = opensAbove
    ? Math.max(margin, anchor.top - gap - height)
    : Math.min(anchor.bottom + gap, viewport.height - margin - height);
  const desiredLeft = align === "right" ? anchor.right - panel.width : anchor.left;
  const left = Math.max(margin, Math.min(desiredLeft, viewport.width - margin - panel.width));
  return { left, top, maxHeight: `${maxHeight}px` };
}

/** Arrow keys, Home and End move focus between the enabled items of a menu panel; ArrowUp and ArrowDown wrap around. */
export function moveMenuFocus(event: React.KeyboardEvent, panel: HTMLElement | null) {
  if (!panel || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...panel.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]")].filter((item) => !(item as HTMLButtonElement).disabled);
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return; // a search field or other control inside the panel keeps its own arrow keys
  const last = items.length - 1;
  const next = event.key === "Home" ? 0
    : event.key === "End" ? last
    : event.key === "ArrowDown" ? (index === last ? 0 : index + 1)
    : (index <= 0 ? last : index - 1);
  event.preventDefault();
  items[next].focus();
}

/** A button that opens a floating panel. Closes on outside click, Escape, or when `close` is called by the panel. */
export function Popover({ label, panelLabel = label, trigger, align = "left", className = "", panelClassName = "", panelRole = "menu", onOpen, children }: {
  label: string; panelLabel?: string; trigger: React.ReactNode; align?: "left" | "right"; className?: string; panelClassName?: string; panelRole?: "menu" | "dialog";
  onOpen?: () => void;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const menuPopup = React.useRef<HTMLDivElement>(null);
  const skipFocusRestore = React.useRef(false);
  const [position, setPosition] = React.useState<{ left: number; top: number; maxHeight: string }>();
  const positionPanel = React.useCallback(() => {
    const anchor = root.current?.querySelector("button");
    if (!anchor || !panel.current) {
      skipFocusRestore.current = true;
      setOpen(false);
      return;
    }
    if (!isVisibleInScrollContainers(anchor)) {
      skipFocusRestore.current = true;
      setOpen(false);
      return;
    }
    const bounds = anchor.getBoundingClientRect();
    const rect = panel.current.getBoundingClientRect();
    const inlineMaxHeight = panel.current.style.maxHeight;
    panel.current.style.removeProperty("max-height");
    const authoredMaxHeight = getComputedStyle(panel.current).maxHeight;
    if (inlineMaxHeight) panel.current.style.maxHeight = inlineMaxHeight;
    const parsedMaxHeight = Number.parseFloat(authoredMaxHeight);
    const authoredHeightLimit = Number.isFinite(parsedMaxHeight) ? parsedMaxHeight : Number.POSITIVE_INFINITY;
    const size = { width: rect.width, height: Math.min(panel.current.scrollHeight, authoredHeightLimit) };
    const next = getPopoverPosition(bounds, size, { width: window.innerWidth, height: window.innerHeight }, align);
    const maxHeight = Math.min(Number.parseFloat(next.maxHeight), authoredHeightLimit);
    const positioned = { ...next, maxHeight: `${maxHeight}px` };
    // Resize handlers need to move a visible panel before the browser's next paint; React may batch the state update until after a resize caller measures it.
    Object.assign(panel.current.style, { left: `${positioned.left}px`, top: `${positioned.top}px`, maxHeight: positioned.maxHeight, visibility: "visible" });
    setPosition(positioned);
  }, [align]);
  React.useEffect(() => {
    if (!open || panelRole === "menu") return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      root.current?.querySelector("button")?.focus(); // hand focus back to the trigger before the panel unmounts
      setOpen(false);
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onPointer); document.removeEventListener("keydown", onKey, true); };
  }, [open, panelRole]);
  React.useLayoutEffect(() => {
    if (panelRole === "menu") { setPosition(undefined); return; }
    if (!open) { setPosition(undefined); return; }
    positionPanel();
    const onViewportChange = () => positionPanel();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(onViewportChange);
    if (root.current) observer?.observe(root.current);
    if (panel.current) observer?.observe(panel.current);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      observer?.disconnect();
    };
  }, [open, positionPanel, panelRole]);
  React.useEffect(() => {
    if (panelRole === "menu") return;
    // The panel sits at the end of <body>, so move focus into it when it opens from its trigger; Tab then reaches its items.
    if (!position || !panel.current) return;
    const trigger = root.current?.querySelector("button");
    if (document.activeElement !== trigger) return;
    panel.current.querySelector<HTMLElement>("input:not([type=hidden]), button, [href], select, textarea, [tabindex]:not([tabindex='-1'])")?.focus();
  }, [position === undefined, panelRole]);
  React.useEffect(() => {
    if (!open || panelRole !== "menu" || document.activeElement !== root.current?.querySelector("button")) return;
    menuPopup.current?.querySelector<HTMLElement>("[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]")?.focus();
  }, [open, panelRole]);
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (panelRole === "menu") return;
    // Closing from inside the portal panel would drop focus to <body>; hand it back to the trigger.
    if (open) { wasOpen.current = true; return; }
    if (wasOpen.current) {
      wasOpen.current = false;
      if (!skipFocusRestore.current && document.activeElement === document.body) root.current?.querySelector("button")?.focus();
      skipFocusRestore.current = false;
    }
  }, [open, panelRole]);
  const portalRoot = root.current?.closest("dialog") ?? (typeof document !== "undefined" ? document.body : null);
  const floatingPanel = open && portalRoot ? createPortal(
    <div ref={panel} data-popover-panel role={panelRole} aria-label={panelLabel} className={`card-surface fixed z-50 min-w-56 rounded-lg p-1 shadow-lg ${panelClassName}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (panelRole === "menu") moveMenuFocus(event, panel.current); }}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, maxWidth: "calc(100vw - 1rem)", ...(position ? { maxHeight: position.maxHeight } : {}), overflowX: "hidden", overflowY: "auto", visibility: position ? "visible" : "hidden" }}>
      {children(() => setOpen(false))}
    </div>, portalRoot) : null;
  if (panelRole === "menu") return <DropdownMenu open={open} onOpenChange={(nextOpen) => { if (nextOpen && !open) onOpen?.(); setOpen(nextOpen); }}>
    <div ref={root} className="relative">
      <DropdownMenuTrigger aria-label={label} title={label} className={`flex items-center gap-1.5 rounded-md bg-transparent p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${className}`}>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent ref={menuPopup} align={align === "right" ? "end" : "start"} sideOffset={4} data-popover-panel aria-label={panelLabel} onKeyDown={(event) => moveMenuFocus(event, menuPopup.current)} className={cn("max-h-[min(32rem,var(--available-height))] min-w-56", panelClassName)}>
        {children(() => setOpen(false))}
      </DropdownMenuContent>
    </div>
  </DropdownMenu>;
  return <div ref={root} className="relative">
    <button type="button" aria-label={label} title={label} aria-haspopup={panelRole} aria-expanded={open} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}
      className={`flex items-center gap-1.5 rounded-md bg-transparent p-1.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary ${className}`}>{trigger}</button>
    {floatingPanel}
  </div>;
}

export const menuItemClass = "inset-row-hover flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-popover-foreground outline-none focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground pointer-coarse:min-h-11";

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
  if (isSwitch) return <button type="button" role={role} aria-checked={Boolean(checked)} title={hint} aria-describedby={hint ? hintId : undefined} className={rowClass} {...props}>
    <span className="flex min-w-0 items-center gap-2"><Icon aria-hidden size={16} className={`shrink-0 ${danger ? "" : "text-secondary"}`} />{children}</span>
    <Check aria-hidden size={14} className={`shrink-0 ${checked ? "text-current" : "invisible"}`} />
    {hint && <span id={hintId} hidden>{hint}</span>}
  </button>;
  return <DropdownMenuItem title={hint} aria-describedby={hint ? hintId : undefined} className={rowClass} {...props as React.ComponentProps<typeof DropdownMenuItem>}>
    <span className="flex min-w-0 items-center gap-2"><Icon aria-hidden size={16} className={`shrink-0 ${danger ? "" : "text-muted-foreground"}`} />{children}</span>
    {hint && <span id={hintId} hidden>{hint}</span>}
  </DropdownMenuItem>;
}
