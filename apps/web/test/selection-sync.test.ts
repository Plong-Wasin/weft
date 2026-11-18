import { expect, test } from "bun:test";
import { Schema } from "@tiptap/pm/model";
import { AllSelection, EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { syncSelectionFromDom } from "../src/editor-extensions";

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", toDOM: () => ["p", 0] }, text: {} },
});
const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Wiki anchor")]), schema.node("paragraph", null, [schema.text("Open task")])]);

/** A view whose ProseMirror selection is `selection` while the browser's selection is a caret at `caret` (or a range when `collapsed` is false). */
function viewWith(selection: (state: EditorState) => EditorState["selection"], caret: number, collapsed = true) {
  const view = {
    state: EditorState.create({ doc }),
    dom: { contains: () => true, ownerDocument: { getSelection: () => ({ anchorNode: {}, isCollapsed: collapsed }) } },
    posAtDOM: () => caret,
    dispatch(transaction: Parameters<EditorState["apply"]>[0]) { view.state = view.state.apply(transaction); },
  };
  view.state = view.state.apply(view.state.tr.setSelection(selection(view.state)));
  return view;
}

test("a text range is collapsed to the caret the browser already moved to", () => {
  const view = viewWith((state) => TextSelection.create(state.doc, 1, 12), 15);
  syncSelectionFromDom(view as unknown as EditorView);
  expect(view.state.selection.empty).toBe(true);
  expect(view.state.selection.from).toBe(15);
});

test("a stale select-all is collapsed to the caret, so Enter cannot replace the whole document", () => {
  const view = viewWith((state) => new AllSelection(state.doc), 15);
  expect(view.state.selection).toBeInstanceOf(AllSelection);
  syncSelectionFromDom(view as unknown as EditorView);
  expect(view.state.selection).not.toBeInstanceOf(AllSelection);
  expect(view.state.selection.empty).toBe(true);
  expect(view.state.selection.from).toBe(15);
});

test("a real select-all keeps its range while the browser selection is still a range", () => {
  const view = viewWith((state) => new AllSelection(state.doc), 0, false);
  syncSelectionFromDom(view as unknown as EditorView);
  expect(view.state.selection).toBeInstanceOf(AllSelection);
});
