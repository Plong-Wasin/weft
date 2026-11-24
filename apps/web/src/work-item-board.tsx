import React from "react";
import { ChevronsLeft, ChevronsRight, GripVertical, Plus } from "lucide-react";
import { formatNumber, translate, type MessageKey } from "@weft/shared";

const t = (key: string) => translate(key as MessageKey);

export interface BoardColumn<T> { key: string; name: string; icon?: React.ReactNode; items: T[] }
interface Draggable { id: string; displayId: string }
type Over = { column: string; before: string | null } | null;
type Drag = { id: string; x: number; y: number; width: number; height: number; offsetX: number; offsetY: number; over: Over };
type KeyboardMoveKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
type KeyboardMove = { id: string; key: KeyboardMoveKey };

/** Distance (px) the pointer must travel before a mouse or pen press becomes a drag. */
const slop = 5;
/** Touch presses start a drag only after this long without moving, so a swipe still scrolls the board. */
const holdMs = 250;
const edge = 48;

/**
 * Kanban columns with cards that drag with the pointer (mouse, pen, or a touch long-press). The component
 * only reports where a card was dropped; the caller decides which Action that means.
 */
export function Board<T extends Draggable>({ columns, renderCard, ghost, canDrag, reorderWithinColumn, announcePosition, onDrop, collapsed, onToggle, canAdd, onAdd, quick, quickForm }: {
  columns: Array<BoardColumn<T>>;
  renderCard: (item: T, reorderHandle: React.ReactNode) => React.ReactNode;
  ghost: (item: T) => React.ReactNode;
  canDrag: boolean;
  reorderWithinColumn: boolean;
  announcePosition: boolean;
  onDrop: (id: string, column: string, beforeId: string | null) => void | boolean | Promise<void | boolean>;
  collapsed: string[];
  onToggle: (column: string) => void;
  canAdd: boolean;
  onAdd: (column: string) => void;
  quick: string | null;
  quickForm: (column: string) => React.ReactNode;
}) {
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const [announce, setAnnounce] = React.useState("");
  const scroller = React.useRef<HTMLDivElement>(null);
  const keyboardQueue = React.useRef<KeyboardMove[]>([]);
  const keyboardBusy = React.useRef(false);
  const focusAfterMove = React.useRef<{ id: string; column: string } | null>(null);
  const latest = React.useRef({ columns, collapsed, canDrag, reorderWithinColumn, announcePosition, onDrop });
  latest.current = { columns, collapsed, canDrag, reorderWithinColumn, announcePosition, onDrop };
  const live = React.useRef<{ drag: Drag | null; byId: Map<string, T>; scrollSpeed: number }>({ drag: null, byId: new Map(), scrollSpeed: 0 });
  const justDragged = React.useRef(false);
  /** True from a touch press until it ends: the long-press that starts a drag must not open the browser context menu. */
  const touching = React.useRef(false);
  const everything = columns.flatMap((column) => column.items);
  live.current.byId = new Map(everything.map((item) => [item.id, item]));

  /** Where the pointer would drop: the column under it and the card it lands above (null = end of the column). */
  const targetAt = (x: number, y: number, id: string): Over => {
    const hit = document.elementFromPoint(x, y);
    const columnEl = hit?.closest<HTMLElement>("[data-column]");
    if (!columnEl) return null;
    const column = columnEl.dataset.column!;
    const cards = [...columnEl.querySelectorAll<HTMLElement>("[data-card-id]")].filter((card) => card.dataset.cardId !== id);
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      if (y < box.top + box.height * 0.6) return { column, before: card.dataset.cardId! };
    }
    return { column, before: null };
  };

  const start = (event: React.PointerEvent<HTMLElement>, item: T) => {
    if (!canDrag || (event.pointerType === "mouse" && event.button !== 0)) return;
    if ((event.target as HTMLElement).closest("input, select, textarea, [role=menu], [role=dialog], [data-no-drag]")) return;
    const card = event.currentTarget;
    const box = card.getBoundingClientRect();
    const origin = { x: event.clientX, y: event.clientY };
    const touch = event.pointerType === "touch";
    touching.current = touch;
    let active = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const begin = (x: number, y: number) => {
      active = true;
      const next: Drag = { id: item.id, x, y, width: box.width, height: box.height, offsetX: origin.x - box.left, offsetY: origin.y - box.top, over: null };
      next.over = targetAt(x, y, item.id);
      live.current.drag = next;
      setDrag(next);
    };
    const preventScroll = (touchEvent: TouchEvent) => { if (active) touchEvent.preventDefault(); };
    const move = (e: PointerEvent) => {
      if (!active) {
        const far = Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > (touch ? 8 : slop);
        if (!far) return;
        if (touch) return stop(false); // a swipe before the hold: let the browser scroll
        begin(e.clientX, e.clientY);
      }
      const bounds = scroller.current?.getBoundingClientRect();
      live.current.scrollSpeed = bounds ? (e.clientX < bounds.left + edge ? -14 : e.clientX > bounds.right - edge ? 14 : 0) : 0;
      const next = { ...live.current.drag!, x: e.clientX, y: e.clientY, over: targetAt(e.clientX, e.clientY, item.id) };
      live.current.drag = next;
      setDrag(next);
    };
    const stop = (commit: boolean) => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.removeEventListener("touchmove", preventScroll);
      live.current.scrollSpeed = 0;
      setTimeout(() => { touching.current = false; }, 300);
      const finished = live.current.drag;
      live.current.drag = null;
      if (!active) return;
      setDrag(null);
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
      if (commit && finished?.over) void onDrop(item.id, finished.over.column, finished.over.before);
    };
    const up = () => stop(true);
    const cancel = () => stop(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    if (touch) {
      document.addEventListener("touchmove", preventScroll, { passive: false });
      timer = setTimeout(() => begin(origin.x, origin.y), holdMs);
    }
  };

  // Scroll the board sideways while a card is held near its left or right edge.
  const dragging = drag !== null;
  React.useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const tick = () => {
      const el = scroller.current;
      if (el && live.current.scrollSpeed) {
        el.scrollLeft += live.current.scrollSpeed;
        const current = live.current.drag;
        if (current) {
          const over = targetAt(current.x, current.y, current.id);
          live.current.drag = { ...current, over };
          setDrag(live.current.drag);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  const dragged = drag ? live.current.byId.get(drag.id) : undefined;

  React.useLayoutEffect(() => {
    const pending = focusAfterMove.current;
    if (!pending || !columns.some((column) => column.key === pending.column && column.items.some((item) => item.id === pending.id))) return;
    const handle = scroller.current?.querySelector<HTMLButtonElement>(`[data-reorder="${CSS.escape(pending.id)}"]`);
    if (!handle) return;
    handle.scrollIntoView({ block: "nearest", inline: "nearest" });
    handle.focus({ preventScroll: true });
    focusAfterMove.current = null;
  }, [columns]);

  /** Apply queued arrows against the newest board snapshot so repeated presses don't reuse stale groups. */
  const processKeyboardQueue = async () => {
    if (keyboardBusy.current) return;
    keyboardBusy.current = true;
    let announcement: string | null = null;
    try {
      while (keyboardQueue.current.length > 0) {
        const { id, key } = keyboardQueue.current.shift()!;
        const state = latest.current;
        if (!state.canDrag) continue;
        const source = state.columns.find((column) => column.items.some((card) => card.id === id));
        if (!source) continue;
        const item = source.items.find((card) => card.id === id)!;
        const itemIndex = source.items.findIndex((card) => card.id === id);
        let destination = source;
        let before: string | null = null;
        let position = itemIndex + 1;
        if (key === "ArrowLeft" || key === "ArrowRight") {
          const visible = state.columns.filter((column) => !state.collapsed.includes(column.key));
          const visibleIndex = visible.findIndex((column) => column.key === source.key);
          const next = visible[visibleIndex + (key === "ArrowRight" ? 1 : -1)];
          if (!next) continue;
          destination = next;
          position = Math.min(itemIndex, destination.items.length) + 1;
          before = destination.items[position - 1]?.id ?? null;
        } else {
          if (!state.reorderWithinColumn || source.items.length < 2) continue;
          if (key === "ArrowUp") { before = source.items[itemIndex - 1]?.id ?? null; position = itemIndex; }
          else { before = source.items[itemIndex + 2]?.id ?? null; position = itemIndex + 2; }
          if ((key === "ArrowUp" && itemIndex === 0) || (key === "ArrowDown" && itemIndex === source.items.length - 1)) continue;
        }
        const expected = [...destination.items.filter((card) => card.id !== id)];
        const insertion = before ? expected.findIndex((card) => card.id === before) : expected.length;
        expected.splice(insertion < 0 ? expected.length : insertion, 0, item);
        if (destination.key !== source.key) focusAfterMove.current = { id, column: destination.key };
        let result: void | boolean;
        try { result = await state.onDrop(id, destination.key, before); }
        catch {
          focusAfterMove.current = null;
          keyboardQueue.current = [];
          announcement = null;
          break;
        }
        if (result === false) {
          focusAfterMove.current = null;
          keyboardQueue.current = [];
          announcement = null;
          break;
        }
        const deadline = performance.now() + 2_000;
        let settled = false;
        let leftResults = false;
        while (performance.now() < deadline) {
          leftResults = !latest.current.columns.some((column) => column.items.some((card) => card.id === id));
          if (leftResults) { settled = true; break; }
          const actual = latest.current.columns.find((column) => column.key === destination.key);
          settled = !!actual && actual.items.some((card) => card.id === id) && (!state.announcePosition || actual.items.map((card) => card.id).join("\0") === expected.map((card) => card.id).join("\0"));
          if (settled) break;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        if (!settled) {
          keyboardQueue.current = [];
          focusAfterMove.current = null;
          scroller.current?.querySelector<HTMLButtonElement>(`[data-reorder="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
          announcement = null;
          break;
        }
        if (leftResults || focusAfterMove.current?.id === id) {
          focusAfterMove.current = null;
          scroller.current?.focus({ preventScroll: true });
        }
        announcement = state.announcePosition && !leftResults
          ? t("board.moved").replace("{name}", item.displayId).replace("{column}", destination.name).replace("{position}", String(position))
          : t("board.movedTo").replace("{name}", item.displayId).replace("{column}", destination.name);
      }
    } catch {
      keyboardQueue.current = [];
      focusAfterMove.current = null;
      announcement = null;
    } finally {
      keyboardBusy.current = false;
      if (announcement) setAnnounce(announcement);
    }
  };

  /** Move a card with the keyboard using the same drop action as pointer dragging. */
  const moveByKeyboard = (id: string, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!latest.current.canDrag || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !latest.current.reorderWithinColumn) return;
    event.preventDefault();
    setAnnounce("");
    keyboardQueue.current.push({ id, key: event.key as KeyboardMoveKey });
    void processKeyboardQueue();
  };

  const reorderHandle = (item: T) => <button type="button" data-reorder={item.id} disabled={!canDrag}
    aria-label={`${t("sortable.reorder")}: ${item.displayId}`} aria-keyshortcuts={reorderWithinColumn ? "ArrowLeft ArrowRight ArrowUp ArrowDown" : "ArrowLeft ArrowRight"} title={t(reorderWithinColumn ? "board.reorderHint" : "board.reorderColumnsHint")}
    className="grid size-7 shrink-0 touch-none cursor-grab place-items-center rounded-md bg-transparent p-0 text-tertiary hover:bg-layer-transparent-hover hover:text-primary"
    onKeyDown={(event) => { moveByKeyboard(item.id, event); }}>
    <GripVertical aria-hidden size={14} />
  </button>;

  return <div ref={scroller} tabIndex={-1} className="flex min-h-96 items-start gap-3 overflow-x-auto pb-3" data-testid="board">
    <span role="status" aria-live="polite" className="sr-only">{announce}</span>
    {columns.map((column) => {
      const closed = collapsed.includes(column.key);
      const over = drag?.over?.column === column.key;
      if (closed) return <section key={column.key} data-column={column.key} data-testid={`column-${column.name}`} aria-label={column.name} data-collapsed
        className={`flex w-11 shrink-0 flex-col items-center gap-2 rounded-lg border border-subtle py-2 ${over ? "bg-accent-subtle" : "bg-layer-1"}`}>
        <button type="button" aria-expanded={false} aria-label={`${t("layout.toggleGroup")}: ${column.name}`} title={t("layout.toggleGroup")} className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={() => onToggle(column.key)}><ChevronsRight aria-hidden size={14} /></button>
        {column.icon}
        <span className="text-13 font-medium text-primary [writing-mode:vertical-rl]">{column.name}</span>
        <span className="text-12 text-tertiary">{formatNumber(column.items.length)}</span>
      </section>;
      return <section key={column.key} data-column={column.key} data-testid={`column-${column.name}`} aria-label={column.name}
        className={`flex w-[22rem] max-w-[85vw] shrink-0 flex-col gap-2 rounded-lg border p-1 transition-colors ${over ? "border-accent-strong bg-accent-subtle" : "border-transparent bg-transparent"}`}>
        <header className="flex items-center gap-2 px-1 py-0.5">
          {column.icon}
          <h4 className="m-0 flex-1 truncate text-16 font-medium text-primary">{column.name} <span className="font-normal text-tertiary">{formatNumber(column.items.length)}</span></h4>
          <button type="button" aria-expanded aria-label={`${t("layout.toggleGroup")}: ${column.name}`} title={t("layout.toggleGroup")} className="rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={() => onToggle(column.key)}><ChevronsLeft aria-hidden size={14} /></button>
          {canAdd && <button type="button" aria-label={t("layout.addToGroup").replace("{group}", column.name)} title={t("layout.addToGroup").replace("{group}", column.name)} className="inline-flex items-center gap-1 rounded-md bg-transparent p-1 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={() => onAdd(column.key)}><Plus aria-hidden size={14} /><span className="hidden text-11 max-sm:inline">{t("layout.addShort")}</span></button>}
        </header>
        <div className="flex min-h-12 flex-col gap-2">
          {column.items.map((item) => <React.Fragment key={item.id}>
            {drag?.over?.column === column.key && drag.over.before === item.id && <div aria-hidden className="h-0.5 rounded-full bg-accent-primary" />}
            <article data-card-id={item.id} data-testid={`card-${item.displayId}`} data-dragging={drag?.id === item.id ? "" : undefined}
              className={`select-none rounded-lg border border-subtle bg-surface-1 p-3 ${canDrag ? "cursor-grab" : ""} ${drag?.id === item.id ? "opacity-40" : ""}`}
              onPointerDown={(event) => start(event, item)} onDragStart={(event) => event.preventDefault()}
              onClickCapture={(event) => { if (justDragged.current) { event.preventDefault(); event.stopPropagation(); } }}
              onContextMenu={(event) => { if (drag || touching.current) event.preventDefault(); }}>
              {renderCard(item, reorderHandle(item))}
            </article>
          </React.Fragment>)}
          {drag?.over?.column === column.key && drag.over.before === null && <div aria-hidden className="h-0.5 rounded-full bg-accent-primary" />}
        </div>
        {quick === column.key && quickForm(column.key)}
        {canAdd && quick !== column.key && <button type="button" className="flex items-center gap-2 rounded-md bg-transparent px-2 py-1.5 text-left text-13 font-medium text-secondary hover:bg-layer-transparent-hover" onClick={() => onAdd(column.key)}><Plus aria-hidden size={14} />{t("workItems.new")}</button>}
      </section>;
    })}
    {drag && dragged && <div aria-hidden data-testid="drag-ghost" className="pointer-events-none fixed z-50 rotate-1 rounded-lg border border-accent-strong bg-surface-1 p-3 shadow-xl"
      style={{ left: drag.x - drag.offsetX, top: drag.y - drag.offsetY, width: drag.width }}>{ghost(dragged)}</div>}
  </div>;
}
