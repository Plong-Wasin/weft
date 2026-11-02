import React from "react";
import { GripVertical } from "lucide-react";
import { translate } from "@weft/shared";

type Drag = { id: string; over: number };

/**
 * A bordered list whose rows reorder by dragging a handle (mouse, pen or touch) or by Arrow Up/Down on the focused handle.
 * The list reports the new order once, on drop; it does not hold the order itself.
 */
export function SortableList({ ids, onReorder, disabled = false, label, renderRow }: {
  ids: string[]; onReorder: (ids: string[]) => void; disabled?: boolean; label: (id: string) => string;
  renderRow: (id: string, grip: React.ReactNode) => React.ReactNode;
}) {
  const list = React.useRef<HTMLUListElement>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const [announce, setAnnounce] = React.useState("");
  const place = (id: string, to: number) => {
    const next = ids.filter((other) => other !== id);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
    if (next.some((other, index) => other !== ids[index])) {
      onReorder(next);
      setAnnounce(translate("sortable.moved").replace("{name}", label(id)).replace("{position}", String(next.indexOf(id) + 1)).replace("{total}", String(next.length)));
      // Reordering moves the row's element; put the focus back on its handle so Arrow keys keep working.
      requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-grip="${CSS.escape(id)}"]`)?.focus());
    }
  };
  const rowAt = (y: number) => {
    const rows = [...(list.current?.children ?? [])] as HTMLElement[];
    const hit = rows.findIndex((row) => { const box = row.getBoundingClientRect(); return y >= box.top && y <= box.bottom; });
    if (hit >= 0) return hit;
    return rows.length > 0 && y < rows[0]!.getBoundingClientRect().top ? 0 : rows.length - 1;
  };
  const grip = (id: string) => <button type="button" data-grip={id} disabled={disabled} aria-label={`${translate("sortable.reorder")}: ${label(id)}`} title={translate("sortable.hint")}
    className={`grid size-7 shrink-0 touch-none place-items-center rounded-md !bg-transparent !p-0 text-tertiary hover:!bg-layer-transparent-hover hover:text-primary ${drag?.id === id ? "cursor-grabbing" : "cursor-grab"}`}
    onPointerDown={(event) => {
      if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ id, over: ids.indexOf(id) });
    }}
    onPointerMove={(event) => { if (drag?.id === id) setDrag({ id, over: rowAt(event.clientY) }); }}
    onPointerUp={(event) => { if (drag?.id !== id) return; event.currentTarget.releasePointerCapture(event.pointerId); place(id, drag.over); setDrag(null); }}
    onPointerCancel={() => setDrag(null)}
    onLostPointerCapture={() => setDrag(null)}
    onKeyDown={(event) => {
      if (event.key === "Escape") setDrag(null);
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      place(id, ids.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1));
    }}><GripVertical aria-hidden size={14} /></button>;
  const from = drag ? ids.indexOf(drag.id) : -1;
  return <>
  <span role="status" aria-live="polite" className="sr-only">{announce}</span>
  <ul ref={list} className="m-0 list-none divide-y divide-[var(--border-subtle)] overflow-hidden rounded-lg border border-subtle bg-surface-1 p-0">
    {ids.map((id, index) => {
      const target = drag && drag.over === index && drag.over !== from ? (index > from ? "after" : "before") : null;
      return <li key={id} className={`flex flex-wrap items-center gap-3 px-3 py-3 text-14 ${drag?.id === id ? "opacity-50" : ""} ${target === "before" ? "shadow-[inset_0_2px_0_var(--bg-accent-primary)]" : target === "after" ? "shadow-[inset_0_-2px_0_var(--bg-accent-primary)]" : ""}`}>{renderRow(id, grip(id))}</li>;
    })}
  </ul>
  </>;
}
