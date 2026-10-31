import React from 'react';
import { Icon, type IconName } from './icons';
import { t, useLocale } from '../i18n';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';

/** Modal dialog: traps Tab, closes on Escape or a backdrop click, and returns focus to whatever opened it. */
export function Dialog({ label, onClose, children, wide, bare, className = '', initialFocus, footer, returnFocus }: { label: string; onClose: () => void; children: React.ReactNode; wide?: boolean; bare?: boolean; className?: string; initialFocus?: React.RefObject<HTMLElement | null>; footer?: React.ReactNode; returnFocus?: React.RefObject<HTMLElement | null> }) {
  useLocale();
  const root = React.useRef<HTMLElement>(null);
  const opener = React.useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  React.useLayoutEffect(() => {
    const target = initialFocus?.current ?? root.current?.querySelector<HTMLElement>('[data-autofocus]') ?? root.current?.querySelector<HTMLElement>('.dialog-body ' + FOCUSABLE.replaceAll(', ', ', .dialog-body ')) ?? root.current;
    target?.focus();
    const from = opener.current;
    return () => {
      requestAnimationFrame(() => {
        const target = returnFocus?.current?.isConnected ? returnFocus.current : from;
        const open = document.querySelector('[role="dialog"][aria-modal="true"]');
        const lost = !document.activeElement || document.activeElement === document.body;
        if (lost && target?.isConnected && (!open || open.contains(target))) target.focus();
      });
    };
  }, []);
  function keydown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((item) => item.offsetParent !== null || item === document.activeElement);
    if (!controls.length) return;
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || !root.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !root.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  return <div className="overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={root} tabIndex={-1} className={`dialog ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={label} onKeyDown={keydown}>
      {!bare && <div className="dialog-head"><h2>{label}</h2><button type="button" className="ghost icon-button" aria-label={t('common.close')} onClick={onClose}><Icon name="x" /></button></div>}
      {bare ? children : <div className="dialog-body">{children}</div>}
      {footer && <div className="dialog-foot">{footer}</div>}
    </section>
  </div>;
}

type MenuContext = { close: () => void };
const MenuCtx = React.createContext<MenuContext>({ close: () => undefined });

/** A button that opens a small menu (role=menu). Arrow keys move, Escape closes and returns focus to the button. */
export function MenuButton({ label, icon, iconOnly, children, align = 'right', up, className = 'secondary', ariaLabel, disabled, badge, onOpenChange }: { label: string; icon?: IconName; iconOnly?: boolean; children: React.ReactNode; align?: 'left' | 'right'; up?: boolean; className?: string; ariaLabel?: string; disabled?: boolean; badge?: React.ReactNode; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = React.useState(false);
  const wrap = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const change = React.useCallback((next: boolean) => { setOpen(next); onOpenChange?.(next); }, [onOpenChange]);
  React.useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const away = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) change(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, change]);
  function keydown(event: React.KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); change(false); trigger.current?.focus(); return; }
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items[items.length - 1]?.focus(); }
    else if (event.key === 'Tab') change(false);
  }
  return <div className="menu-wrap" ref={wrap} onKeyDown={keydown}>
    <button ref={trigger} type="button" className={`${className}${iconOnly ? ' icon-button' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel ?? (iconOnly ? label : undefined)} disabled={disabled} onClick={() => change(!open)}>
      {icon && <Icon name={icon} />}{!iconOnly && <span>{label}</span>}{badge}
    </button>
    {open && <div className={`menu ${align === 'left' ? 'left' : ''} ${up ? 'up' : ''}`} role="menu" aria-label={label}>
      <MenuCtx.Provider value={{ close: () => change(false) }}>{children}</MenuCtx.Provider>
    </div>}
  </div>;
}

export function MenuItem({ icon, children, onSelect, disabled, checked, danger }: { icon?: IconName; children: React.ReactNode; onSelect: () => void; disabled?: boolean; checked?: boolean; danger?: boolean }) {
  const { close } = React.useContext(MenuCtx);
  return <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} className={`menu-item${danger ? ' danger' : ''}`} disabled={disabled} onClick={() => { close(); onSelect(); }}>
    {icon && <Icon name={icon} />}<span>{children}</span>{checked && <span style={{ marginLeft: 'auto' }}><Icon name="check" small /></span>}
  </button>;
}

export function Badge({ tone, children, label }: { tone?: 'accent' | 'success' | 'warning' | 'danger' | 'info'; children: React.ReactNode; label?: string }) {
  return <span className={`badge ${tone ?? ''}`} aria-label={label}>{children}</span>;
}

export function Spinner() { return <span className="skeleton" style={{ width: 16, height: 16, borderRadius: 8 }} aria-hidden="true" />; }

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return <div className="skeleton-list" aria-hidden="true">{Array.from({ length: rows }, (_, index) => <span key={index} className="skeleton" style={{ height: 22, width: `${92 - (index % 3) * 14}%` }} />)}</div>;
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="empty-state"><h2>{title}</h2>{children && <p>{children}</p>}{action}</div>;
}

// Toasts: a tiny module store so any handler can announce a result without prop drilling.
type Toast = { id: number; text: string; tone?: 'danger' };
let toasts: Toast[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
export function toast(text: string, tone?: 'danger') {
  const id = ++toastSeq;
  toasts = [...toasts, { id, text, tone }];
  toastListeners.forEach((listener) => listener());
  window.setTimeout(() => { toasts = toasts.filter((item) => item.id !== id); toastListeners.forEach((listener) => listener()); }, 4500);
}
export function ToastRegion() {
  const items = React.useSyncExternalStore((listener) => { toastListeners.add(listener); return () => { toastListeners.delete(listener); }; }, () => toasts, () => toasts);
  if (items.length === 0) return null;
  return <div className="toast-region">{items.map((item) => <div key={item.id} className={`toast ${item.tone ?? ''}`} role="status">{item.text}</div>)}</div>;
}
