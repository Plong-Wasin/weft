import { expect, test } from "bun:test";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { AllSelection, EditorState, TextSelection } from "@tiptap/pm/state";
import { blockRangeOfSelection, moveTopLevelBlock, moveTopLevelRange, rangeStartAfterMove, selectedBlockRange } from "../src/wiki-block-moves";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    /** A block that holds blocks, like a list item or a table cell: the selection can sit in a paragraph nested inside it. */
    box: { group: "block", content: "paragraph+", toDOM: () => ["div", 0] },
    /** A block with no text, like a rule or an image: a selection cannot start or end inside it. */
    rule: { group: "block", atom: true, toDOM: () => ["hr"] },
    text: {},
  },
});

/** An editor stand-in with the two members the block moves use: the state and the dispatch that replaces it. */
function fakeEditor(texts: string[]) {
  const doc = schema.node("doc", null, texts.map((text) => schema.node("paragraph", null, [schema.text(text)])));
  const editor = { state: EditorState.create({ doc }), view: { dispatch: (tr: ReturnType<EditorState["tr"]["setMeta"]>) => { editor.state = editor.state.apply(tr); } } };
  return editor as unknown as Editor & { state: EditorState };
}

const texts = (editor: Editor) => { const out: string[] = []; editor.state.doc.forEach((node) => out.push(node.textContent)); return out; };
/** Start of block `index`; the document end when there is no such block. */
const startOf = (editor: Editor, index: number) => { let pos = editor.state.doc.content.size; editor.state.doc.forEach((_node, offset, i) => { if (i === index) pos = offset; }); return pos; };
const select = (editor: Editor, fromBlock: number, toBlock: number) => {
  const from = startOf(editor, fromBlock) + 1;
  const to = startOf(editor, toBlock) + 2;
  (editor as unknown as { state: EditorState }).state = editor.state.apply(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
};

test("a grip outside any selection moves only its own block", () => {
  const editor = fakeEditor(["a", "b", "c", "d"]);
  expect(selectedBlockRange(editor, startOf(editor, 1))).toEqual({ from: startOf(editor, 1), to: startOf(editor, 2) });
});

test("a grip inside a selection that spans blocks takes every block the selection touches", () => {
  const editor = fakeEditor(["a", "b", "c", "d"]);
  select(editor, 1, 2);
  expect(selectedBlockRange(editor, startOf(editor, 2))).toEqual({ from: startOf(editor, 1), to: startOf(editor, 3) });
  expect(selectedBlockRange(editor, startOf(editor, 1))).toEqual({ from: startOf(editor, 1), to: startOf(editor, 3) });
});

test("a grip on a block outside the selection moves just that block", () => {
  const editor = fakeEditor(["a", "b", "c", "d"]);
  select(editor, 1, 2);
  expect(selectedBlockRange(editor, startOf(editor, 3))).toEqual({ from: startOf(editor, 3), to: startOf(editor, 4) });
});

test("a selection that ends at the very start of a block leaves that block out", () => {
  const editor = fakeEditor(["a", "b", "c", "d"]);
  const from = startOf(editor, 0) + 1;
  const to = startOf(editor, 2) + 1;
  editor.state = editor.state.apply(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
  expect(selectedBlockRange(editor, startOf(editor, 0))).toEqual({ from: startOf(editor, 0), to: startOf(editor, 2) });
});

test("moving a range down and up keeps its order", () => {
  const editor = fakeEditor(["a", "b", "c", "d"]);
  const range = { from: startOf(editor, 0), to: startOf(editor, 2) };
  expect(moveTopLevelRange(editor, range, startOf(editor, 4))).toBe(true);
  expect(texts(editor)).toEqual(["c", "d", "a", "b"]);
  expect(moveTopLevelRange(editor, { from: startOf(editor, 2), to: startOf(editor, 4) }, startOf(editor, 1))).toBe(true);
  expect(texts(editor)).toEqual(["c", "a", "b", "d"]);
});

test("dropping a range on or inside itself changes nothing", () => {
  const editor = fakeEditor(["a", "b", "c", "d"]);
  const range = { from: startOf(editor, 1), to: startOf(editor, 3) };
  expect(moveTopLevelRange(editor, range, startOf(editor, 1))).toBe(false);
  expect(moveTopLevelRange(editor, range, startOf(editor, 2))).toBe(false);
  expect(moveTopLevelRange(editor, range, startOf(editor, 3))).toBe(false);
  expect(texts(editor)).toEqual(["a", "b", "c", "d"]);
});

test("a stale range past the end of the document is refused", () => {
  const editor = fakeEditor(["a", "b"]);
  expect(moveTopLevelRange(editor, { from: 0, to: 999 }, 0)).toBe(false);
});

test("moveTopLevelBlock still moves a single block", () => {
  const editor = fakeEditor(["a", "b", "c"]);
  expect(moveTopLevelBlock(editor, startOf(editor, 0), startOf(editor, 3))).toBe(true);
  expect(texts(editor)).toEqual(["b", "c", "a"]);
});

/** A document of one paragraph, a two-paragraph box, then a paragraph; returns the editor and the position inside each text. */
function nestedEditor() {
  const p = (text: string) => schema.node("paragraph", null, [schema.text(text)]);
  const doc = schema.node("doc", null, [p("a"), schema.node("box", null, [p("b1"), p("b2")]), p("c")]);
  const editor = { state: EditorState.create({ doc }), view: { dispatch: (tr: ReturnType<EditorState["tr"]["setMeta"]>) => { editor.state = editor.state.apply(tr); } } } as unknown as Editor & { state: EditorState };
  const find = (text: string) => { let at = -1; doc.descendants((node, pos) => { if (node.isText && node.text === text) at = pos; }); return at; };
  const blockStart = (index: number) => { let pos = doc.content.size; doc.forEach((_n, offset, i) => { if (i === index) pos = offset; }); return pos; };
  return { editor, find, blockStart, size: doc.content.size };
}
const selectBetween = (editor: Editor & { state: EditorState }, from: number, to: number) => { editor.state = editor.state.apply(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to))); };

test("a selection ending at the first position of a nested paragraph leaves the block out, and one ending after its first paragraph takes it", () => {
  const { editor, find, blockStart, size } = nestedEditor();
  selectBetween(editor, find("a"), find("b1")); // ends at the start of the box's first paragraph
  expect(selectedBlockRange(editor, blockStart(0))).toEqual({ from: blockStart(0), to: blockStart(1) });
  selectBetween(editor, find("a"), find("b2")); // ends at the start of the box's second paragraph: the box is touched
  expect(selectedBlockRange(editor, blockStart(0))).toEqual({ from: blockStart(0), to: blockStart(2) });
  expect(selectedBlockRange(editor, blockStart(1))).toEqual({ from: blockStart(0), to: blockStart(2) });
  expect(size).toBeGreaterThan(0);
});

test("a selection that starts at the very end of a block leaves that block out", () => {
  const { editor, find, blockStart } = nestedEditor();
  selectBetween(editor, find("a") + 1, find("c") + 1); // from the end of "a" into "c"
  expect(selectedBlockRange(editor, blockStart(1))).toEqual({ from: blockStart(1), to: blockStart(3) });
  expect(selectedBlockRange(editor, blockStart(0))).toEqual({ from: blockStart(0), to: blockStart(1) });
  selectBetween(editor, find("b2") + 2, find("c") + 1); // from the end of the box's last paragraph
  expect(selectedBlockRange(editor, blockStart(1))).toEqual({ from: blockStart(1), to: blockStart(2) });
});

test("rangeStartAfterMove gives the first block's new start for a move down and a move up", () => {
  expect(rangeStartAfterMove({ from: 10, to: 30 }, 50)).toBe(30);
  expect(rangeStartAfterMove({ from: 10, to: 30 }, 4)).toBe(4);
});

test("keepRange leaves the moved blocks selected, so a second move carries the same run", () => {
  const editor = fakeEditor(["a", "b", "c", "d"]);
  const range = { from: startOf(editor, 0), to: startOf(editor, 2) };
  expect(moveTopLevelRange(editor, range, startOf(editor, 4), { keepRange: true })).toBe(true);
  expect(texts(editor)).toEqual(["c", "d", "a", "b"]);
  const next = selectedBlockRange(editor, startOf(editor, 2));
  expect(next).toEqual({ from: startOf(editor, 2), to: startOf(editor, 4) });
  expect(moveTopLevelRange(editor, next!, startOf(editor, 0), { keepRange: true })).toBe(true);
  expect(texts(editor)).toEqual(["a", "b", "c", "d"]);
});

test("a run of three moves down and up in order, and a destination next to the run changes nothing", () => {
  const editor = fakeEditor(["a", "b", "c", "d", "e"]);
  const run = { from: startOf(editor, 0), to: startOf(editor, 3) };
  expect(moveTopLevelRange(editor, run, startOf(editor, 5))).toBe(true);
  expect(texts(editor)).toEqual(["d", "e", "a", "b", "c"]);
  expect(moveTopLevelRange(editor, { from: startOf(editor, 2), to: startOf(editor, 5) }, startOf(editor, 0))).toBe(true);
  expect(texts(editor)).toEqual(["a", "b", "c", "d", "e"]);
  expect(moveTopLevelRange(editor, { from: startOf(editor, 1), to: startOf(editor, 4) }, startOf(editor, 4))).toBe(false);
  expect(moveTopLevelRange(editor, { from: startOf(editor, 1), to: startOf(editor, 4) }, startOf(editor, 1))).toBe(false);
  expect(texts(editor)).toEqual(["a", "b", "c", "d", "e"]);
});

test("one move per block still lands the run in one dispatch per block, never leaving a block out", () => {
  const editor = fakeEditor(["a", "b", "c", "d"]);
  const seen: string[][] = [];
  const dispatch = editor.view.dispatch;
  editor.view.dispatch = (tr) => { dispatch(tr); seen.push(texts(editor)); };
  moveTopLevelRange(editor, { from: startOf(editor, 1), to: startOf(editor, 3) }, startOf(editor, 4));
  // Every intermediate document is a permutation of the four blocks.
  for (const state of seen) expect([...state].sort()).toEqual(["a", "b", "c", "d"]);
  expect(texts(editor)).toEqual(["a", "d", "b", "c"]);
});

test("a run that ends with an atom block cannot be selected exactly, so the move leaves a caret in its first block", () => {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("x")]), schema.node("paragraph", null, [schema.text("a")]), schema.node("rule"), schema.node("paragraph", null, [schema.text("y")])]);
  const editor = { state: EditorState.create({ doc }), view: { dispatch: (tr: ReturnType<EditorState["tr"]["setMeta"]>) => { editor.state = editor.state.apply(tr); } } } as unknown as Editor & { state: EditorState };
  let aStart = 0; doc.forEach((node, pos) => { if (node.textContent === "a") aStart = pos; });
  const ruleEnd = aStart + 3 + 1; // "a" paragraph is 3 wide, the rule 1
  expect(moveTopLevelRange(editor, { from: aStart, to: ruleEnd }, doc.content.size, { keepRange: true })).toBe(true);
  expect(editor.state.selection.empty).toBe(true);
  const kinds: string[] = []; editor.state.doc.forEach((node) => kinds.push(node.type.name));
  expect(kinds).toEqual(["paragraph", "paragraph", "paragraph", "rule"]);
});

test("the keyboard run comes from the selection alone: a select-all covers every block, a caret between blocks covers none", () => {
  const editor = fakeEditor(["a", "b", "c"]);
  editor.state = editor.state.apply(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
  expect(blockRangeOfSelection(editor.state.selection)).toEqual({ from: 0, to: editor.state.doc.content.size });
  select(editor, 0, 1);
  expect(blockRangeOfSelection(editor.state.selection)).toEqual({ from: startOf(editor, 0), to: startOf(editor, 2) });
});

test("an empty paragraph at either end of a selection is part of the run", () => {
  const p = (text: string) => schema.node("paragraph", null, text ? [schema.text(text)] : []);
  const doc = schema.node("doc", null, [p(""), p("bb"), p("cc"), p("")]);
  const editor = { state: EditorState.create({ doc }), view: { dispatch: (tr: ReturnType<EditorState["tr"]["setMeta"]>) => { editor.state = editor.state.apply(tr); } } } as unknown as Editor & { state: EditorState };
  const at = (index: number) => { let pos = doc.content.size; doc.forEach((_n, offset, i) => { if (i === index) pos = offset; }); return pos; };
  const range = (from: number, to: number) => { editor.state = editor.state.apply(editor.state.tr.setSelection(TextSelection.create(doc, from, to))); return blockRangeOfSelection(editor.state.selection); };
  expect(range(at(0) + 1, at(1) + 2)).toEqual({ from: at(0), to: at(2) }); // empty first paragraph into "bb"
  expect(range(at(2) + 2, at(3) + 1)).toEqual({ from: at(2), to: at(4) }); // "cc" into the empty last paragraph
  expect(range(at(0) + 1, at(3) + 1)).toEqual({ from: at(0), to: at(4) }); // empty to empty
});
