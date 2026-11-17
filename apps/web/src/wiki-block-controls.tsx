import React from "react";
import type { Editor } from "@tiptap/core";
import { ArrowDown, ArrowUp, Copy, GripVertical, Trash2 } from "lucide-react";
import { translate } from "@weft/shared";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type Block = { pos: number; node: import("@tiptap/pm/model").Node; element: HTMLElement };
type Drag = {
  source: Block;
  /** Pointer position in the viewport. */
  pointer: { x: number; y: number };
  /** Where the pointer grabbed the block, so the ghost keeps its place under the pointer. */
  grab: { x: number; y: number };
  /** Insertion boundary in the document, and the viewport y of the line drawn there. Null when the drop would not move anything. */
  drop: { pos: number; top: number } | null;
};

const GRIP_SIZE = 24;
const DRAG_SOURCE_CLASS = "wiki-block-dragging";

/** Whether moving a block of `size` at `from` to the boundary `to` leaves the document unchanged. */
const staysPut = (from: number, size: number, to: number) => to >= from && to <= from + size;

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

  const blockAtPos = React.useCallback((pos: number): Block | null => {
    // A stale position can lie past the end of the document after an edit, and ProseMirror throws for it.
    if (!editor || pos < 0 || pos >= editor.state.doc.content.size) return null;
    const node = editor.state.doc.nodeAt(pos);
    const element = editor.view.nodeDOM(pos);
    return node && element instanceof HTMLElement ? { pos, node, element } : null;
  }, [editor]);

  /** The boundary a pointer at (x, y) would drop the source on: before or after the block under it, by which half it is in. */
  const dropFor = React.useCallback((source: Block, x: number, y: number): Drag["drop"] => {
    const target = blockAt(document.elementFromPoint(x, y));
    if (!target) return null;
    const bounds = target.element.getBoundingClientRect();
    const after = y > bounds.top + bounds.height / 2;
    const pos = after ? target.pos + target.node.nodeSize : target.pos;
    return staysPut(source.pos, source.node.nodeSize, pos) ? null : { pos, top: after ? bounds.bottom : bounds.top };
  }, [blockAt]);

  const moveBlock = React.useCallback((sourcePos: number, destination: number) => {
    if (!editor) return;
    const source = editor.state.doc.nodeAt(sourcePos);
    if (!source || staysPut(sourcePos, source.nodeSize, destination)) return;
    // `destination` is an insertion boundary in the current document; removing the block first shifts it back by the block's size.
    const tr = editor.state.tr.delete(sourcePos, sourcePos + source.nodeSize);
    tr.insert(destination > sourcePos ? destination - source.nodeSize : destination, source);
    editor.view.dispatch(tr);
  }, [editor]);

  const endDrag = React.useCallback(() => {
    pointerStart.current = null;
    updateDrag(null);
  }, [updateDrag]);

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
      const bounds = target.element.getBoundingClientRect();
      const destination = event.clientY > bounds.top + bounds.height / 2 ? target.pos + target.node.nodeSize : target.pos;
      moveBlock(current.source.pos, destination);
    };
    const onPointerMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current) {
        const pointer = { x: event.clientX, y: event.clientY };
        updateDrag({ ...current, pointer, drop: dropFor(current.source, event.clientX, event.clientY) });
        return;
      }
      const start = pointerStart.current;
      if (!start || (Math.abs(start.x - event.clientX) <= 4 && Math.abs(start.y - event.clientY) <= 4)) return;
      const source = blockAtPos(start.pos);
      if (!source) return;
      const bounds = source.element.getBoundingClientRect();
      didDrag.current = true;
      updateDrag({
        source,
        pointer: { x: event.clientX, y: event.clientY },
        grab: { x: start.x - bounds.left, y: start.y - bounds.top },
        drop: dropFor(source, event.clientX, event.clientY),
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) { pointerStart.current = null; return; }
      const drop = dropFor(current.source, event.clientX, event.clientY);
      endDrag();
      if (drop) moveBlock(current.source.pos, drop.pos);
    };
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
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
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
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", relayout, true);
    };
  }, [blockAt, blockAtPos, dropFor, editable, editor, endDrag, moveBlock, updateDrag]);

  // The ghost is a copy of the dragged block in its own layer on the page, so it is not clipped by the editor.
  const sourceElement = drag?.source.element ?? null;
  React.useEffect(() => {
    if (!sourceElement) return;
    const ghost = document.createElement("div");
    ghost.className = "wiki-editor shadow-xl";
    ghost.dataset.testid = "wiki-block-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.cssText = `position:fixed;left:0;top:0;z-index:60;pointer-events:none;opacity:.92;max-width:none;width:${sourceElement.getBoundingClientRect().width}px;background:var(--bg-surface-1);border-radius:.375rem;padding:.25rem .5rem;`;
    const content = document.createElement("div");
    content.className = "ProseMirror";
    const copy = sourceElement.cloneNode(true) as HTMLElement;
    copy.classList.remove(DRAG_SOURCE_CLASS);
    content.appendChild(copy);
    ghost.appendChild(content);
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
    return () => {
      ghost.remove();
      ghostRef.current = null;
    };
  }, [sourceElement]);

  // A decoration dims the source block, so the dimming survives ProseMirror replacing the block's DOM during the drag.
  const sourcePos = drag?.source.pos ?? null;
  React.useEffect(() => {
    if (!editor || sourcePos === null) return;
    editor.registerPlugin(new Plugin({
      key: new PluginKey("wikiBlockDragSource"),
      props: {
        decorations: (state) => {
          const node = state.doc.nodeAt(sourcePos);
          return node ? DecorationSet.create(state.doc, [Decoration.node(sourcePos, sourcePos + node.nodeSize, { class: DRAG_SOURCE_CLASS })]) : null;
        },
      },
    }));
    editor.view.dispatch(editor.state.tr);
    return () => { editor.unregisterPlugin("wikiBlockDragSource"); };
  }, [editor, sourcePos]);

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

  const moveFromMenu = (block: Block, destination: number) => {
    moveBlock(block.pos, destination);
    setMenu(null);
    // The block now sits where the document put it; keep the grip on it and in keyboard focus.
    const movedTo = destination > block.pos ? destination - block.node.nodeSize : destination;
    setHovered(blockAtPos(movedTo));
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="wiki-block-handle"]')?.focus());
  };

  if (!editor || !editable) return null;
  // The hovered block was captured before the last edit; re-read it so its node size matches the document being drawn.
  const stale = menu ?? hovered;
  const current = stale ? blockAtPos(stale.pos) : null;
  const frame = root.current?.getBoundingClientRect();
  const handleTop = current && frame ? firstLineCenter(current) - frame.top - GRIP_SIZE / 2 : null;
  const blocks = current ? topLevel() : [];
  const index = current ? blocks.findIndex((block) => block.pos === current.pos) : -1;
  const above = index > 0 ? blocks[index - 1] : null;
  const below = index >= 0 && index < blocks.length - 1 ? blocks[index + 1] : null;
  const editorBox = editor.view.dom.getBoundingClientRect();
  const dropLine = drag?.drop && frame ? { top: drag.drop.top - frame.top - 1, left: editorBox.left - frame.left, width: editorBox.width } : null;
  return <div ref={root} className="pointer-events-none absolute inset-0 z-20" data-testid="wiki-block-controls">
    {current && handleTop !== null && <div className="pointer-events-auto absolute -left-6 flex items-start gap-1" style={{ top: handleTop }}>
      <button type="button" data-testid="wiki-block-handle" aria-label={translate("wiki.blockHandle")} title={translate("wiki.blockHandle")}
        className="grid size-6 shrink-0 cursor-grab place-items-center rounded text-tertiary hover:bg-layer-transparent-hover hover:text-primary active:cursor-grabbing"
        onPointerDown={(event) => { pointerStart.current = { x: event.clientX, y: event.clientY, pos: current.pos }; didDrag.current = false; }}
        onClick={() => { if (didDrag.current) { didDrag.current = false; return; } setMenu(menu?.pos === current.pos ? null : current); }}>
        <GripVertical aria-hidden size={16} />
      </button>
      {menu?.pos === current.pos && <div role="menu" data-testid="wiki-block-menu" aria-label={translate("wiki.blockMenu")} className="absolute left-6 top-0 grid min-w-36 gap-0.5 rounded-md border border-subtle bg-surface-1 p-1 shadow-lg"
        onKeyDown={(event) => { if (event.key === "Escape") { setMenu(null); root.current?.querySelector<HTMLElement>('[data-testid="wiki-block-handle"]')?.focus(); } }}>
        {above && <button type="button" role="menuitem" className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-13 hover:bg-layer-transparent-hover" onClick={() => moveFromMenu(menu, above.pos)}>
          <ArrowUp aria-hidden size={14} />{translate("wiki.blockMoveUp")}</button>}
        {below && <button type="button" role="menuitem" className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-13 hover:bg-layer-transparent-hover" onClick={() => moveFromMenu(menu, below.pos + below.size)}>
          <ArrowDown aria-hidden size={14} />{translate("wiki.blockMoveDown")}</button>}
        <button type="button" role="menuitem" className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-13 hover:bg-layer-transparent-hover" onClick={() => {
          const node = editor.state.doc.nodeAt(menu.pos);
          if (node) editor.chain().focus().insertContentAt(menu.pos + node.nodeSize, node.toJSON()).run();
          setMenu(null);
        }}><Copy aria-hidden size={14} />{translate("wiki.blockDuplicate")}</button>
        <button type="button" role="menuitem" className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-13 text-danger hover:bg-layer-transparent-hover" onClick={() => {
          const node = editor.state.doc.nodeAt(menu.pos);
          if (node) editor.chain().focus().deleteRange({ from: menu.pos, to: menu.pos + node.nodeSize }).run();
          setMenu(null);
        }}><Trash2 aria-hidden size={14} />{translate("wiki.blockDelete")}</button>
      </div>}
    </div>}
    {dropLine && <div data-testid="wiki-block-drop-line" aria-hidden="true" className="pointer-events-none absolute h-0.5 rounded-full" style={{ top: dropLine.top, left: dropLine.left, width: dropLine.width, background: "var(--bg-accent-primary)" }} />}
  </div>;
}
