import React from "react";
import type { Editor } from "@tiptap/core";
import { Copy, GripVertical, Trash2 } from "lucide-react";
import { translate } from "@weft/shared";

type Block = { pos: number; node: import("@tiptap/pm/model").Node; element: HTMLElement };

/** Hover and drag controls for top-level Wiki blocks. All edits use editor transactions, so Yjs collaborators receive them. */
export function WikiBlockControls({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const [hovered, setHovered] = React.useState<Block | null>(null);
  const [menu, setMenu] = React.useState<Block | null>(null);
  const [dragPos, setDragPos] = React.useState<number | null>(null);
  const root = React.useRef<HTMLDivElement>(null);
  const pointerStart = React.useRef<{ x: number; y: number; pos: number } | null>(null);
  const didDrag = React.useRef(false);

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

  React.useEffect(() => {
    if (!editor || !editable) return;
    const dom = editor.view.dom;
    const onMove = (event: MouseEvent) => {
      if (dragPos !== null) return;
      const next = blockAt(event.target);
      setHovered((current) => current?.pos === next?.pos ? current : next);
    };
    const onDragOver = (event: DragEvent) => { if (blockAt(event.target)) event.preventDefault(); };
    const onDrop = (event: DragEvent) => {
      if (dragPos === null) return;
      const target = blockAt(event.target);
      if (!target) return;
      event.preventDefault();
      const bounds = target.element.getBoundingClientRect();
      const destination = event.clientY > bounds.top + bounds.height / 2 ? target.pos + target.node.nodeSize : target.pos;
      moveBlock(dragPos, destination);
      setDragPos(null);
    };
    const onPointerMove = (event: PointerEvent) => {
      const start = pointerStart.current;
      if (dragPos !== null || !start || (Math.abs(start.x - event.clientX) <= 4 && Math.abs(start.y - event.clientY) <= 4)) return;
      setDragPos(start.pos);
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = pointerStart.current;
      if (dragPos === null) { pointerStart.current = null; return; }
      const target = blockAt(document.elementFromPoint(event.clientX, event.clientY) ?? event.target);
      const dragged = !!start && (Math.abs(start.x - event.clientX) > 4 || Math.abs(start.y - event.clientY) > 4);
      if (target && dragged) {
        const bounds = target.element.getBoundingClientRect();
        const destination = event.clientY > bounds.top + bounds.height / 2 ? target.pos + target.node.nodeSize : target.pos;
        moveBlock(dragPos, destination);
        didDrag.current = true;
      }
      pointerStart.current = null;
      setDragPos(null);
    };
    const onLeave = (event: MouseEvent) => {
      if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) return;
      setHovered(null);
      setMenu(null);
    };
    dom.addEventListener("mousemove", onMove);
    dom.addEventListener("mouseleave", onLeave);
    dom.addEventListener("dragover", onDragOver);
    dom.addEventListener("drop", onDrop);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      dom.removeEventListener("mouseleave", onLeave);
      dom.removeEventListener("dragover", onDragOver);
      dom.removeEventListener("drop", onDrop);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [blockAt, dragPos, editable, editor]);

  const position = (block: Block) => {
    const container = root.current;
    if (!container) return { top: 0 };
    return { top: block.element.getBoundingClientRect().top - container.getBoundingClientRect().top };
  };

  const moveBlock = (sourcePos: number, targetPos: number) => {
    if (!editor || sourcePos === targetPos) return;
    const source = editor.state.doc.nodeAt(sourcePos);
    const target = editor.state.doc.nodeAt(targetPos);
    if (!source || !target) return;
    let insertPos = targetPos + (sourcePos < targetPos ? target.nodeSize : 0);
    const tr = editor.state.tr.delete(sourcePos, sourcePos + source.nodeSize);
    if (sourcePos < insertPos) insertPos -= source.nodeSize;
    tr.insert(insertPos, source);
    editor.view.dispatch(tr);
  };

  if (!editor || !editable) return null;
  const current = menu ?? hovered;
  const currentPos = current ? position(current) : null;
  return <div ref={root} className="pointer-events-none absolute inset-0 z-20" data-testid="wiki-block-controls">
    {current && currentPos && <div className="pointer-events-auto absolute -left-6 flex items-start gap-1" style={{ top: currentPos.top }}>
      <button type="button" data-testid="wiki-block-handle" aria-label={translate("wiki.blockHandle")} title={translate("wiki.blockHandle")}
        className="grid size-6 shrink-0 cursor-grab place-items-center rounded text-tertiary hover:bg-layer-transparent-hover hover:text-primary active:cursor-grabbing"
        onPointerDown={(event) => { pointerStart.current = { x: event.clientX, y: event.clientY, pos: current.pos }; didDrag.current = false; }}
        onClick={() => { if (didDrag.current) { didDrag.current = false; return; } setMenu(menu?.pos === current.pos ? null : current); }}>
        <GripVertical aria-hidden size={16} />
      </button>
      {menu?.pos === current.pos && <div role="menu" data-testid="wiki-block-menu" aria-label={translate("wiki.blockMenu")} className="absolute left-6 top-0 grid min-w-36 gap-0.5 rounded-md border border-subtle bg-surface-1 p-1 shadow-lg">
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
  </div>;
}
