import React from 'react';

const FOCUSABLE = '[data-autofocus], [role="option"]:not([disabled]), button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type PopoverApi = { close: (restoreFocus?: boolean) => void };

/**
 * A button that opens an anchored popover. The popover is `position: fixed`, so a scrolling table never clips it,
 * and it stays inside the trigger's DOM subtree, so "focus left the row" checks keep working.
 * Escape closes and returns focus to the button; a click outside or any scroll outside the popover closes it.
 */
export function PopoverField({ label, className = '', openClassName = '', triggerLabel, children, disabled, popoverClassName = '', onOpenChange, triggerRef, title }: {
  label: string;
  className?: string;
  openClassName?: string;
  triggerLabel: React.ReactNode;
  children: (api: PopoverApi) => React.ReactNode;
  disabled?: boolean;
  popoverClassName?: string;
  onOpenChange?: (open: boolean) => void;
  triggerRef?: React.Ref<HTMLButtonElement>;
  title?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const wrap = React.useRef<HTMLSpanElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const pop = React.useRef<HTMLDivElement>(null);
  const setTrigger = (node: HTMLButtonElement | null) => {
    (trigger as React.MutableRefObject<HTMLButtonElement | null>).current = node;
    if (typeof triggerRef === 'function') triggerRef(node);
    else if (triggerRef) (triggerRef as React.MutableRefObject<HTMLButtonElement | null>).current = node;
  };
  const change = React.useCallback((next: boolean) => { setOpen(next); onOpenChange?.(next); if (!next) setPos(null); }, [onOpenChange]);
  const close = React.useCallback((restoreFocus = true) => { change(false); if (restoreFocus) trigger.current?.focus(); }, [change]);

  React.useLayoutEffect(() => {
    if (!open || !trigger.current || !pop.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = pop.current.offsetWidth;
    const height = pop.current.scrollHeight;
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const below = spaceBelow >= Math.min(height, 260) || spaceBelow >= spaceAbove;
    const maxHeight = Math.max(160, below ? spaceBelow : spaceAbove);
    const shown = Math.min(height, maxHeight);
    setPos({ top: below ? rect.bottom + 4 : Math.max(8, rect.top - shown - 4), left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), maxHeight });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => pop.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true }));
    const away = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) change(false); };
    // A scroll only closes the popover when it moves the trigger: focusing a row scrolls the table without moving the cell the popover hangs off.
    const origin = trigger.current?.getBoundingClientRect();
    const scroll = (event: Event) => {
      if (pop.current?.contains(event.target as Node)) return;
      const now = trigger.current?.getBoundingClientRect();
      if (event.type === 'scroll' && origin && now && Math.abs(now.top - origin.top) < 1 && Math.abs(now.left - origin.left) < 1) return;
      change(false);
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', scroll);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('mousedown', away); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', scroll); };
  }, [open, change]);

  function keydown(event: React.KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { change(false); return; }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && pop.current?.contains(event.target as Node)) {
      const items = Array.from(pop.current.querySelectorAll<HTMLElement>('[role="option"]:not([disabled]), [data-pop-item]:not([disabled])'));
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[index < 0 && event.key === 'ArrowUp' ? items.length - 1 : next]?.focus();
    }
  }

  return <span className="pop-wrap" ref={wrap} onKeyDown={keydown}>
    <button ref={setTrigger} type="button" className={`${className} ${open ? openClassName : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={title} disabled={disabled} onClick={() => change(!open)}>{triggerLabel}</button>
    {open && <div ref={pop} className={`popover ${popoverClassName}`} role="dialog" aria-label={label} style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: 0, left: 0, visibility: 'hidden' }}>{children({ close })}</div>}
  </span>;
}
