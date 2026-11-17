import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";

/** Whether moving a block of `size` at `from` to the boundary `to` leaves the document unchanged. */
export const staysPut = (from: number, size: number, to: number) => to >= from && to <= from + size;

/** Top-level blocks in document order, with their positions and sizes. */
export function topLevelBlocks(editor: Editor): Array<{ pos: number; size: number }> {
  const blocks: Array<{ pos: number; size: number }> = [];
  editor.state.doc.forEach((node, pos) => blocks.push({ pos, size: node.nodeSize }));
  return blocks;
}

/** The top-level block that holds the selection, or null when the selection is not inside one. */
export function topLevelBlockAtSelection(editor: Editor): { pos: number; node: Node } | null {
  const { $from } = editor.state.selection;
  if ($from.depth === 0) return null;
  const pos = $from.before(1);
  const node = editor.state.doc.nodeAt(pos);
  return node ? { pos, node } : null;
}

/**
 * Moves the block at `sourcePos` to the insertion boundary `destination` (an offset in the current document) in one transaction, so Yjs collaborators receive one change and one undo reverts it.
 * With `keepCaret`, the caret stays in the moved block; the drag and menu paths keep the selection where it was.
 */
export function moveTopLevelBlock(editor: Editor, sourcePos: number, destination: number, options: { keepCaret?: boolean } = {}): boolean {
  const source = editor.state.doc.nodeAt(sourcePos);
  if (!source || staysPut(sourcePos, source.nodeSize, destination)) return false;
  // `destination` is an insertion boundary in the current document; removing the block first shifts it back by the block's size.
  const tr = editor.state.tr.delete(sourcePos, sourcePos + source.nodeSize);
  const insertAt = destination > sourcePos ? destination - source.nodeSize : destination;
  tr.insert(insertAt, source);
  if (options.keepCaret) tr.setSelection(Selection.near(tr.doc.resolve(insertAt + 1)));
  editor.view.dispatch(tr);
  return true;
}

/** Inserts a copy of the top-level block at `pos` directly after it, in one transaction. */
export function duplicateTopLevelBlock(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  return editor.chain().focus().insertContentAt(pos + node.nodeSize, node.toJSON()).run();
}
