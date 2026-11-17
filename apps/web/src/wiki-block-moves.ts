import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { ResolvedPos } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";

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

/** Whether `$pos` is the very first position inside its top-level block: no content of that block lies before it. */
function atBlockStart($pos: ResolvedPos): boolean {
  if ($pos.depth === 0 || $pos.parentOffset !== 0) return false;
  for (let depth = 1; depth < $pos.depth; depth++) if ($pos.index(depth) !== 0) return false;
  return true;
}

/** Whether `$pos` is the very last position inside its top-level block: no content of that block lies after it. */
function atBlockEnd($pos: ResolvedPos): boolean {
  if ($pos.depth === 0 || $pos.parentOffset !== $pos.parent.content.size) return false;
  for (let depth = 1; depth < $pos.depth; depth++) if ($pos.index(depth) !== $pos.node(depth).childCount - 1) return false;
  return true;
}

/**
 * The run of whole top-level blocks a selection covers: the block of a caret, or every block a range touches.
 * A selection that only reaches the edge of a block (it ends at the very start of one, or starts at the very end of one) does not take that block along.
 * Null for a caret between blocks.
 */
export function blockRangeOfSelection(selection: Selection): BlockRange | null {
  const { $from, $to } = selection;
  if (selection.empty) return $from.depth === 0 ? null : { from: $from.before(1), to: $from.after(1) };
  // An empty block is both at its start and at its end: a selection that begins or ends in it covers it, so only a block with content on the far side is left out.
  const from = $from.depth === 0 ? $from.pos : atBlockEnd($from) && !atBlockStart($from) ? $from.after(1) : $from.before(1);
  const to = $to.depth === 0 ? $to.pos : atBlockStart($to) && !atBlockEnd($to) ? $to.before(1) : $to.after(1);
  return from < to ? { from, to } : $from.depth === 0 ? null : { from: $from.before(1), to: $from.after(1) };
}

/** The blocks a grip at `pos` moves: the selected run when the grabbed block is part of it, otherwise just that block. */
export function selectedBlockRange(editor: Editor, pos: number): BlockRange | null {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return null;
  const single = { from: pos, to: pos + node.nodeSize };
  if (editor.state.selection.empty) return single;
  const run = blockRangeOfSelection(editor.state.selection);
  return run && run.from <= pos && single.to <= run.to ? run : single;
}

/** Where the first block of `range` starts once the run has moved to the insertion boundary `destination`. */
export function rangeStartAfterMove(range: BlockRange, destination: number): number {
  return destination > range.from ? destination - (range.to - range.from) : destination;
}

/**
 * Moves the blocks in `range` to the insertion boundary `destination` (an offset in the current document).
 * Several blocks move one at a time, last first when going down and first first when going up, because a single transaction that deletes and re-inserts
 * a whole run made y-prosemirror's diff mis-pair nodes while a collaborator was editing (a block vanished and another appeared twice); moving one block
 * per transaction is the path that stays correct. Yjs normally merges transactions made within its capture window into one undo step (the e2e flow checks that one undo restores the order).
 * With `keepCaret`, the caret stays in the first moved block; with `keepRange`, the moved blocks stay selected, so the next move carries the whole run again.
 * Without either, the selection is left to the transactions' own mapping.
 */
export function moveTopLevelRange(editor: Editor, range: BlockRange, destination: number, options: { keepCaret?: boolean; keepRange?: boolean } = {}): boolean {
  const size = range.to - range.from;
  if (size <= 0 || range.to > editor.state.doc.content.size || staysPut(range.from, size, destination)) return false;
  const blocks: Array<{ pos: number; size: number }> = [];
  editor.state.doc.forEach((node, pos) => { if (pos >= range.from && pos < range.to) blocks.push({ pos, size: node.nodeSize }); });
  const insertAt = rangeStartAfterMove(range, destination);
  if (blocks.length === 1) {
    const tr = editor.state.tr;
    const node = tr.doc.nodeAt(range.from)!;
    tr.delete(range.from, range.to).insert(insertAt, node);
    if (options.keepRange || options.keepCaret) tr.setSelection(Selection.near(tr.doc.resolve(insertAt + 1)));
    editor.view.dispatch(tr);
    return true;
  }
  if (destination < range.from) {
    // Going up, each block's position is unchanged by the moves before it; it lands right after the blocks already placed.
    let landing = destination;
    for (const block of blocks) {
      const tr = editor.state.tr;
      const node = tr.doc.nodeAt(block.pos)!;
      tr.delete(block.pos, block.pos + block.size).insert(landing, node);
      editor.view.dispatch(tr);
      landing += block.size;
    }
  } else {
    // Going down, the last block goes first; each earlier block lands right before the ones already placed.
    let landing = destination;
    for (const block of [...blocks].reverse()) {
      const tr = editor.state.tr;
      const node = tr.doc.nodeAt(block.pos)!;
      tr.delete(block.pos, block.pos + block.size).insert(landing - block.size, node);
      editor.view.dispatch(tr);
      landing -= block.size;
    }
  }
  if (options.keepRange || options.keepCaret) {
    const { doc } = editor.state;
    // A selection slides to the nearest text, so a run that starts or ends with an atom block (a rule, an image) cannot be selected exactly: it falls back to a caret at the nearest text inside the run.
    const wanted = options.keepRange ? TextSelection.between(doc.resolve(insertAt + 1), doc.resolve(insertAt + size - 1)) : null;
    const run = wanted && blockRangeOfSelection(wanted);
    const selection = wanted && run?.from === insertAt && run.to === insertAt + size ? wanted : Selection.near(doc.resolve(insertAt + 1));
    editor.view.dispatch(editor.state.tr.setSelection(selection));
  }
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
