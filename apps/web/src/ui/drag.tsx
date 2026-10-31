import React from 'react';

export type DropInfo = { id: string; targetId: string | null; position: 'before' | 'after'; zone: string | null };
export type DragState = { id: string; label: string; x: number; y: number; targetId: string | null; position: 'before' | 'after'; zone: string | null };

const THRESHOLD = 5;

/**
 * Pointer-event drag and drop (not HTML5 DnD), so it works with a mouse, a pen and Playwright's mouse.
 * Drop targets carry `data-drag-target="<id>"` and `data-drag-kind`; an optional `data-drag-zone="<zone>"` marks a column
 * that accepts a drop below its last item. `enabled` false turns every handle off.
 */
export function useDragSort(kind: string, enabled: boolean, onDrop: (info: DropInfo) => void) {
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const dropRef = React.useRef(onDrop);
  dropRef.current = onDrop;

  const start = React.useCallback((id: string, label: string) => (event: React.PointerEvent) => {
    if (!enabled || event.button !== 0 || !event.isPrimary) return;
    const origin = { x: event.clientX, y: event.clientY };
    let active = false;
    let latest: DragState = { id, label, x: origin.x, y: origin.y, targetId: null, position: 'before', zone: null };
    const move = (moveEvent: PointerEvent) => {
      if (!active && Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < THRESHOLD) return;
      active = true;
      const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const target = element?.closest<HTMLElement>('[data-drag-target]');
      const zone = element?.closest<HTMLElement>('[data-drag-zone]')?.dataset.dragZone ?? null;
      const valid = target && target.dataset.dragKind === kind && target.dataset.dragTarget !== id ? target : null;
      let position: 'before' | 'after' = 'before';
      if (valid) { const rect = valid.getBoundingClientRect(); position = moveEvent.clientY > rect.top + rect.height / 2 ? 'after' : 'before'; }
      latest = { id, label, x: moveEvent.clientX, y: moveEvent.clientY, targetId: valid?.dataset.dragTarget ?? null, position, zone };
      setDrag(latest);
      const scroller = element?.closest<HTMLElement>('[data-drag-scroll]') ?? document.querySelector<HTMLElement>('[data-drag-scroll]');
      if (scroller) { const rect = scroller.getBoundingClientRect(); if (moveEvent.clientY < rect.top + 36) scroller.scrollTop -= 14; else if (moveEvent.clientY > rect.bottom - 36) scroller.scrollTop += 14; }
    };
    const finish = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', cancelKey, true);
      setDrag(null);
      if (active) {
        suppressClick();
        if (upEvent.type === 'pointerup' && (latest.targetId || latest.zone)) dropRef.current({ id, targetId: latest.targetId, position: latest.position, zone: latest.zone });
      }
    };
    const cancelKey = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') { keyEvent.stopPropagation(); finish(new PointerEvent('pointercancel')); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', cancelKey, true);
  }, [enabled, kind]);

  return { drag: drag && drag.id ? drag : null, start };
}

/** The click that ends a drag must not also open the card or row under the pointer. */
function suppressClick() {
  const block = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
  window.addEventListener('click', block, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener('click', block, true), 0);
}

export function DragGhost({ drag }: { drag: DragState | null }) {
  if (!drag) return null;
  return <div className="drag-ghost" aria-hidden="true" style={{ left: drag.x + 12, top: drag.y + 8 }}>{drag.label}</div>;
}

/** Class for a drop target: a line before or after it while the pointer is over it. */
export function dropClass(drag: DragState | null, id: string) {
  return drag && drag.targetId === id ? ` drop-${drag.position}` : '';
}
