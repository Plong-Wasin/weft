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

/** A run of whole top-level blocks: `from` is the start of the first, `to` the end of the last. */
export type BlockRange = { from: number; to: number };

/**
 * The blocks a grip at `pos` moves: every top-level block the selection touches when the grabbed block is one of them, otherwise just that block.
 * A selection that ends at the very start of a block does not take that block along.
 */
export function selectedBlockRange(editor: Editor, pos: number): BlockRange | null {
  const { doc, selection } = editor.state;
  const node = doc.nodeAt(pos);
  if (!node) return null;
  const single = { from: pos, to: pos + node.nodeSize };
  if (selection.empty) return single;
  const { $from, $to } = selection;
  const from = $from.depth > 0 ? $from.before(1) : $from.pos;
  const to = $to.depth === 0 ? $to.pos : $to.parentOffset === 0 ? $to.before(1) : $to.after(1);
  return from <= pos && single.to <= to ? { from, to } : single;
}

/**
 * Moves the blocks in `range` to the insertion boundary `destination` (an offset in the current document) in one transaction, so Yjs collaborators receive one change and one undo reverts it.
 * With `keepCaret`, the caret stays in the first moved block; the drag and menu paths keep the selection where it was.
 */
export function moveTopLevelRange(editor: Editor, range: BlockRange, destination: number, options: { keepCaret?: boolean } = {}): boolean {
  const size = range.to - range.from;
  if (size <= 0 || range.to > editor.state.doc.content.size || staysPut(range.from, size, destination)) return false;
  const content = editor.state.doc.slice(range.from, range.to).content;
  // `destination` is an insertion boundary in the current document; removing the blocks first shifts it back by their size.
  const tr = editor.state.tr.delete(range.from, range.to);
  const insertAt = destination > range.from ? destination - size : destination;
  tr.insert(insertAt, content);
  if (options.keepCaret) tr.setSelection(Selection.near(tr.doc.resolve(insertAt + 1)));
  editor.view.dispatch(tr);
  return true;
}

/** Moves the one block at `sourcePos`; see `moveTopLevelRange`. */
export function moveTopLevelBlock(editor: Editor, sourcePos: number, destination: number, options: { keepCaret?: boolean } = {}): boolean {
  const source = editor.state.doc.nodeAt(sourcePos);
  return !!source && moveTopLevelRange(editor, { from: sourcePos, to: sourcePos + source.nodeSize }, destination, options);
}

/** Inserts a copy of the top-level block at `pos` directly after it, in one transaction. */
export function duplicateTopLevelBlock(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  return editor.chain().focus().insertContentAt(pos + node.nodeSize, node.toJSON()).run();
}
