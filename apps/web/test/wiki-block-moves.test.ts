import { expect, test } from "bun:test";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { moveTopLevelBlock, moveTopLevelRange, selectedBlockRange } from "../src/wiki-block-moves";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
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
  const from = startOf(editor, fromBlock) + 2;
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

test("moving a range down and up keeps its order in one transaction", () => {
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
