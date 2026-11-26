import { Button } from "@/ui/button";
import React from "react";
import type { Editor } from "@tiptap/core";
import { ArrowDown, ArrowUp, Copy, GripVertical, Trash2 } from "lucide-react";
import { translate } from "@weft/shared";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { duplicateTopLevelBlock, moveTopLevelRange, rangeStartAfterMove, selectedBlockRange, staysPut, type BlockRange } from "./wiki-block-moves";
import { autoScrollStep, dropBoundary, type BlockSpan } from "./wiki-block-drop";

type Block = { pos: number; node: import("@tiptap/pm/model").Node; element: HTMLElement };
type Drag = {
  source: Block;
  /** The blocks that move with it: the whole selection when the grabbed block is part of one, otherwise just the grabbed block. */
  range: BlockRange;
  /** What the range held when the drag began, so an edit under the drag cancels it. */
  content: import("@tiptap/pm/model").Fragment;
  /** Pointer position in the viewport. */
  pointer: { x: number; y: number };
  /** Where the pointer grabbed the block, so the ghost keeps its place under the pointer. */
  grab: { x: number; y: number };
  /** Insertion boundary in the document, and the viewport y of the line drawn there. Null when the drop would not move anything. */
  drop: { pos: number; top: number } | null;
};

const GRIP_SIZE = 24;
const DRAG_SOURCE_CLASS = "wiki-block-dragging";

/** The nearest ancestor that scrolls vertically, which is where a drag near its edges scrolls the page. */
function scrollContainer(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Hover, drag and menu controls for top-level Wiki blocks. All edits use editor transactions, so Yjs collaborators receive them.
 * The grip sits on the first line of its block and is placed again on scroll and resize; a drag shows a ghost under the pointer,
 * dims the source block and draws a drop line at the boundary the block would land on.
 */
export function WikiBlockControls({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const [hovered, setHovered] = React.useState<Block | null>(null);
  const [menu, setMenu] = React.useState<Block | null>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const [, setLayoutVersion] = React.useState(0);
  const root = React.useRef<HTMLDivElement>(null);
  const pointerStart = React.useRef<{ x: number; y: number; pos: number } | null>(null);
  const didDrag = React.useRef(false);
  // The pointer listeners are attached once per editor, so they read the drag through this ref rather than through state.
  const dragRef = React.useRef<Drag | null>(null);
  const ghostRef = React.useRef<HTMLDivElement | null>(null);

  const updateDrag = React.useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const blockAt = React.useCallback((target: EventTarget | null): Block | null => {
    if (!editor || !(target instanceof Element)) return null;
    let element: Element | null = target;
    while (element && element.parentElement !== editor.view.dom) element = element.parentElement;
    if (!(element instanceof HTMLElement)) return null;
    let result: Block | null = null;
    editor.state.doc.forEach((node, pos) => {
      if (editor.view.nodeDOM(pos) === element) result = { pos, node, element: element as HTMLElement };
    });
    return result;
  }, [editor]);

  /** Whether the block captured earlier still sits at its position as the same node; an edit above it moves or changes it. */
  const stillAt = React.useCallback((block: Block) => editor?.state.doc.nodeAt(block.pos)?.eq(block.node) === true, [editor]);
  const stillRange = React.useCallback((drag: Drag) => !!editor && drag.range.to <= editor.state.doc.content.size && editor.state.doc.slice(drag.range.from, drag.range.to).content.eq(drag.content), [editor]);

  const blockAtPos = React.useCallback((pos: number): Block | null => {
    // A stale position can lie past the end of the document after an edit, and ProseMirror throws for it.
    if (!editor || pos < 0 || pos >= editor.state.doc.content.size) return null;
    const node = editor.state.doc.nodeAt(pos);
    const element = editor.view.nodeDOM(pos);
    return node && element instanceof HTMLElement ? { pos, node, element } : null;
  }, [editor]);

  /**
   * The boundary a pointer at height y would drop the source on: the nearest edge of the top-level blocks, whatever sits under the pointer,
   * so the gutter, the margins and the gaps between blocks all work.
   */
  const dropFor = React.useCallback((range: BlockRange, y: number): Drag["drop"] => {
    if (!editor) return null;
    const spans: BlockSpan[] = [];
    editor.state.doc.forEach((node, pos) => {
      const element = editor.view.nodeDOM(pos);
      if (!(element instanceof HTMLElement)) return;
      const bounds = element.getBoundingClientRect();
      spans.push({ pos, size: node.nodeSize, top: bounds.top, bottom: bounds.bottom });
    });
    const boundary = dropBoundary(spans, y);
    return boundary && !staysPut(range.from, range.to - range.from, boundary.pos) ? boundary : null;
  }, [editor]);

  const moveBlocks = React.useCallback((range: BlockRange, destination: number) => {
    // A run the person selected stays selected after the move, so the next drag or Move up/down carries the whole run again.
    if (editor) moveTopLevelRange(editor, range, destination, { keepRange: !editor.state.selection.empty && range.to - range.from > (editor.state.doc.nodeAt(range.from)?.nodeSize ?? 0) });
  }, [editor]);

  const endDrag = React.useCallback(() => {
    pointerStart.current = null;
    updateDrag(null);
  }, [updateDrag]);

  /** Drops the drag and the menu when the block they hold no longer sits where they captured it. */
  const cancelStale = React.useCallback(() => {
    const current = dragRef.current;
    if (current && !stillRange(current)) endDrag();
    setMenu((open) => open && !stillAt(open) ? null : open);
  }, [endDrag, stillAt, stillRange]);

  React.useEffect(() => {
    if (!editor || !editable) return;
    const dom = editor.view.dom;
    const onMove = (event: MouseEvent) => {
      if (dragRef.current) return;
      const next = blockAt(event.target);
      setHovered((current) => current?.pos === next?.pos ? current : next);
    };
    const onDragOver = (event: DragEvent) => { if (blockAt(event.target)) event.preventDefault(); };
    const onDrop = (event: DragEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const target = blockAt(event.target);
      if (!target) return;
      event.preventDefault();
      endDrag();
      if (!stillRange(current)) return;
      const bounds = target.element.getBoundingClientRect();
      const destination = event.clientY > bounds.top + bounds.height / 2 ? target.pos + target.node.nodeSize : target.pos;
      moveBlocks(current.range, destination);
    };
    const onPointerMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current) {
        const pointer = { x: event.clientX, y: event.clientY };
        updateDrag({ ...current, pointer, drop: dropFor(current.range, event.clientY) });
        return;
      }
      const start = pointerStart.current;
      if (!start || (Math.abs(start.x - event.clientX) <= 4 && Math.abs(start.y - event.clientY) <= 4)) return;
      const source = blockAtPos(start.pos);
      if (!source) return;
      const range = selectedBlockRange(editor, source.pos);
      const first = range && blockAtPos(range.from);
      if (!range || !first) return;
      const bounds = first.element.getBoundingClientRect();
      didDrag.current = true;
      updateDrag({
        source,
        range,
        content: editor.state.doc.slice(range.from, range.to).content,
        pointer: { x: event.clientX, y: event.clientY },
        grab: { x: start.x - bounds.left, y: start.y - bounds.top },
        drop: dropFor(range, event.clientY),
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) { pointerStart.current = null; return; }
      const drop = dropFor(current.range, event.clientY);
      endDrag();
      if (drop && stillRange(current)) moveBlocks(current.range, drop.pos);
    };
    const onPointerCancel = () => endDrag();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current) endDrag();
    };
    const onLeave = (event: MouseEvent) => {
      if (dragRef.current) return;
      if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) return;
      setHovered(null);
      setMenu(null);
    };
    const onSelection = () => {
      // The caret reveals the grip too, so the block menu is reachable from the keyboard.
      if (!editor.isFocused || dragRef.current) return;
      const { $from } = editor.state.selection;
      setHovered($from.depth > 0 ? blockAtPos($from.before(1)) : null);
    };
    const relayout = () => setLayoutVersion((version) => version + 1);
    const resizeObserver = new ResizeObserver(relayout);
    resizeObserver.observe(dom);
    dom.addEventListener("mousemove", onMove);
    dom.addEventListener("mouseleave", onLeave);
    dom.addEventListener("dragover", onDragOver);
    dom.addEventListener("drop", onDrop);
    editor.on("selectionUpdate", onSelection);
    editor.on("update", cancelStale);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", relayout);
    window.addEventListener("scroll", relayout, true);
    return () => {
      resizeObserver.disconnect();
      dom.removeEventListener("mousemove", onMove);
      dom.removeEventListener("mouseleave", onLeave);
      dom.removeEventListener("dragover", onDragOver);
      dom.removeEventListener("drop", onDrop);
      editor.off("selectionUpdate", onSelection);
      editor.off("update", cancelStale);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", relayout, true);
    };
  }, [blockAt, blockAtPos, cancelStale, dropFor, editable, editor, endDrag, moveBlocks, stillAt, stillRange, updateDrag]);

  // While a drag is held near the top or bottom of its scroll area, the page scrolls and the drop boundary follows the content under the pointer.
  const dragging = drag !== null;
  React.useEffect(() => {
    if (!editor || !dragging) return;
    const scroller = scrollContainer(editor.view.dom);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let frame = 0;
    const tick = () => {
      const current = dragRef.current;
      if (current) {
        const area = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        const step = autoScrollStep(current.pointer.y, area, reducedMotion);
        if (step !== 0) {
          if (scroller) scroller.scrollTop += step;
          else window.scrollBy(0, step);
          updateDrag({ ...current, drop: dropFor(current.range, current.pointer.y) });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging, dropFor, editor, updateDrag]);

  // The ghost is a copy of the dragged blocks in its own layer on the page, so it is not clipped by the editor.
  const rangeFrom = drag?.range.from ?? null;
  const rangeTo = drag?.range.to ?? null;
  React.useEffect(() => {
    if (!editor || rangeFrom === null || rangeTo === null) return;
    const elements: HTMLElement[] = [];
    editor.state.doc.forEach((node, pos) => {
      const element = pos >= rangeFrom && pos < rangeTo ? editor.view.nodeDOM(pos) : null;
      if (element instanceof HTMLElement) elements.push(element);
    });
    const sourceElement = elements[0];
    if (!sourceElement) return;
    const ghost = document.createElement("div");
    ghost.className = "wiki-editor shadow-xl";
    ghost.dataset.testid = "wiki-block-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.cssText = `position:fixed;left:0;top:0;z-index:60;pointer-events:none;opacity:.92;max-width:none;width:${sourceElement.getBoundingClientRect().width}px;background:var(--card);border-radius:.375rem;padding:.25rem .5rem;`;
    const content = document.createElement("div");
    content.className = "ProseMirror";
    // The editor gives .ProseMirror a 10rem minimum height; the ghost is only as tall as the block it copies.
    content.style.minHeight = "0";
    for (const element of elements) {
      const copy = element.cloneNode(true) as HTMLElement;
      copy.classList.remove(DRAG_SOURCE_CLASS);
      content.appendChild(copy);
    }
    ghost.appendChild(content);
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
    return () => {
      ghost.remove();
      ghostRef.current = null;
    };
  }, [editor, rangeFrom, rangeTo]);

  // A decoration dims the source blocks, so the dimming survives ProseMirror replacing a block's DOM during the drag.
  React.useEffect(() => {
    if (!editor || rangeFrom === null || rangeTo === null) return;
    editor.registerPlugin(new Plugin({
      key: new PluginKey("wikiBlockDragSource"),
      props: {
        decorations: (state) => {
          const dimmed: Decoration[] = [];
          state.doc.forEach((node, pos) => { if (pos >= rangeFrom && pos < rangeTo) dimmed.push(Decoration.node(pos, pos + node.nodeSize, { class: DRAG_SOURCE_CLASS })); });
          return DecorationSet.create(state.doc, dimmed);
        },
      },
    }));
    editor.view.dispatch(editor.state.tr);
    return () => { editor.unregisterPlugin("wikiBlockDragSource"); };
  }, [editor, rangeFrom, rangeTo]);

  React.useEffect(() => {
    const ghost = ghostRef.current;
    if (!ghost || !drag) return;
    ghost.style.transform = `translate(${drag.pointer.x - drag.grab.x}px, ${drag.pointer.y - drag.grab.y}px)`;
  });

  /** Viewport y of the centre of the block's first line: the first textblock's first character, or the block's top when it has no text. */
  const firstLineCenter = (block: Block): number => {
    let textPos: number | null = null;
    editor?.state.doc.nodesBetween(block.pos, block.pos + block.node.nodeSize, (node, pos) => {
      if (textPos !== null) return false;
      if (node.isTextblock) { textPos = pos + 1; return false; }
      return true;
    });
    if (editor && textPos !== null) {
      const caret = editor.view.coordsAtPos(textPos);
      return (caret.top + caret.bottom) / 2;
    }
    return block.element.getBoundingClientRect().top + GRIP_SIZE / 2;
  };

  /** Top-level blocks in document order, with their positions and sizes. */
  const topLevel = (): Array<{ pos: number; size: number }> => {
    const blocks: Array<{ pos: number; size: number }> = [];
    editor?.state.doc.forEach((node, pos) => blocks.push({ pos, size: node.nodeSize }));
    return blocks;
  };

  const moveFromMenu = (block: Block, direction: "up" | "down") => {
    // The menu may have been open while a collaborator edited: re-read the block and its neighbour from the document now.
    const live = blockAtPos(block.pos);
    if (!live || !live.node.eq(block.node)) { setMenu(null); return; }
    const range = selectedBlockRange(editor!, live.pos);
    const blocks = topLevel();
    const neighbour = direction === "up" ? blocks.find((item) => item.pos + item.size === range?.from) : blocks.find((item) => item.pos === range?.to);
    if (!range || !neighbour) { setMenu(null); return; }
    const destination = direction === "up" ? neighbour.pos : neighbour.pos + neighbour.size;
    moveBlocks(range, destination);
    setMenu(null);
    // The blocks now sit where the document put them; keep the grip on the grabbed one and in keyboard focus.
    const movedTo = rangeStartAfterMove(range, destination) + (live.pos - range.from);
    setHovered(blockAtPos(movedTo));
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="wiki-block-handle"]')?.focus());
  };

  if (!editor || !editable) return null;
  // The hovered block was captured before the last edit; re-read it so its node size matches the document being drawn.
  const stale = menu ?? hovered;
  const current = stale ? blockAtPos(stale.pos) : null;
  const frame = root.current?.getBoundingClientRect();
  const handleTop = current && frame ? firstLineCenter(current) - frame.top - GRIP_SIZE / 2 : null;
  // A grip inside a selection that spans several blocks moves all of them, so Move up and Move down look past the whole run.
  const range = current ? selectedBlockRange(editor, current.pos) : null;
  const blocks = current ? topLevel() : [];
  const above = range ? blocks.find((block) => block.pos + block.size === range.from) ?? null : null;
  const below = range ? blocks.find((block) => block.pos === range.to) ?? null : null;
  const editorBox = editor.view.dom.getBoundingClientRect();
  const dropLine = drag?.drop && frame ? { top: drag.drop.top - frame.top - 1, left: editorBox.left - frame.left, width: editorBox.width } : null;
  return <div ref={root} className="pointer-events-none absolute inset-0 z-20" data-testid="wiki-block-controls">
    {current && handleTop !== null && <div className="pointer-events-auto absolute -left-6 flex items-start gap-1" style={{ top: handleTop }}>
      <Button type="button" data-testid="wiki-block-handle" aria-label={translate("wiki.blockHandle")} title={translate("wiki.blockHandle")}
        className="grid size-6 shrink-0 cursor-grab place-items-center text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
        aria-haspopup="menu" aria-expanded={menu?.pos === current.pos}
        onPointerDown={(event) => { if (event.button !== 0) return; pointerStart.current = { x: event.clientX, y: event.clientY, pos: current.pos }; didDrag.current = false; }}
        onKeyDown={(event) => { if (event.key === "Escape" && menu) setMenu(null); }}
        onClick={() => { if (didDrag.current) { didDrag.current = false; return; } setMenu(menu?.pos === current.pos ? null : current); }}>
        <GripVertical aria-hidden size={16} />
      </Button>
      {menu?.pos === current.pos && <div role="menu" data-testid="wiki-block-menu" aria-label={translate("wiki.blockMenu")} className="absolute left-6 top-0 grid min-w-36 gap-0.5 rounded-md border border-border bg-card p-1 shadow-lg"
        onKeyDown={(event) => { if (event.key === "Escape") { setMenu(null); root.current?.querySelector<HTMLElement>('[data-testid="wiki-block-handle"]')?.focus(); } }}>
        {above && <Button type="button" role="menuitem" className="flex items-center gap-2 px-2 text-left hover:bg-accent" onClick={() => moveFromMenu(menu, "up")}>
          <ArrowUp aria-hidden size={14} />{translate("wiki.blockMoveUp")}</Button>}
        {below && <Button type="button" role="menuitem" className="flex items-center gap-2 px-2 text-left hover:bg-accent" onClick={() => moveFromMenu(menu, "down")}>
          <ArrowDown aria-hidden size={14} />{translate("wiki.blockMoveDown")}</Button>}
        <Button type="button" role="menuitem" className="flex items-center gap-2 px-2 text-left hover:bg-accent" onClick={() => {
          duplicateTopLevelBlock(editor, menu.pos);
          setMenu(null);
        }}><Copy aria-hidden size={14} />{translate("wiki.blockDuplicate")}</Button>
        <Button type="button" role="menuitem" className="flex items-center gap-2 px-2 text-left text-destructive hover:bg-accent" onClick={() => {
          const node = editor.state.doc.nodeAt(menu.pos);
          if (node) editor.chain().focus().deleteRange({ from: menu.pos, to: menu.pos + node.nodeSize }).run();
          setMenu(null);
        }}><Trash2 aria-hidden size={14} />{translate("wiki.blockDelete")}</Button>
      </div>}
    </div>}
    {dropLine && <div data-testid="wiki-block-drop-line" aria-hidden="true" className="pointer-events-none absolute h-0.5 rounded-full" style={{ top: dropLine.top, left: dropLine.left, width: dropLine.width, background: "var(--primary)" }} />}
  </div>;
}
