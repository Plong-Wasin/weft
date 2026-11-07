import React from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { translate } from "@weft/shared";

/** Row, column, and table actions for the table containing the editor selection. */
export function TableControls({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const active = useEditorState({ editor, selector: ({ editor: current }) => !!current?.isActive("table") });
  if (!editor || !editable || !active) return null;
  const actions: Array<[string, () => void]> = [
    ["Insert row above", () => editor.chain().focus().addRowBefore().run()],
    ["Insert row below", () => editor.chain().focus().addRowAfter().run()],
    ["Duplicate row", () => { const { state } = editor; const { $from } = state.selection; const row = $from.node(-1); const cells = Array.from({ length: row.childCount }, (_, i) => row.child(i).toJSON()); editor.chain().focus().addRowAfter().run(); const pos = editor.state.selection.$from.before(-1); editor.commands.insertContentAt(pos + 1, { type: "tableRow", content: cells }); }],
    ["Clear row", () => clearAxis(editor, "row")],
    ["Delete row", () => editor.chain().focus().deleteRow().run()],
    ["Insert column left", () => editor.chain().focus().addColumnBefore().run()],
    ["Insert column right", () => editor.chain().focus().addColumnAfter().run()],
    ["Duplicate column", () => { editor.chain().focus().addColumnAfter().run(); }],
    ["Clear column", () => clearAxis(editor, "column")],
    ["Delete column", () => editor.chain().focus().deleteColumn().run()],
    ["Toggle header row", () => editor.chain().focus().toggleHeaderRow().run()],
    ["Toggle header column", () => editor.chain().focus().toggleHeaderColumn().run()],
    ["Delete table", () => editor.chain().focus().deleteTable().run()],
  ];
  return <div className="flex flex-wrap gap-1 border-b border-subtle px-2 py-1" aria-label="Table controls">{actions.map(([label, run]) => <button key={label} type="button" className="rounded border border-subtle px-2 py-1 text-12" onMouseDown={(event) => event.preventDefault()} onClick={run}>{label}</button>)}</div>;
}

function clearAxis(editor: Editor, axis: "row" | "column") {
  const { $from } = editor.state.selection;
  const table = $from.node(-3);
  const rowIndex = $from.index(-2);
  const cellIndex = $from.index(-1);
  if (axis === "row") {
    const row = table.child(rowIndex);
    let offset = 0;
    for (let index = 0; index < row.childCount; index++) { clearCell(editor, $from.before(-2) + 1 + offset); offset += row.child(index).nodeSize; }
  } else {
    for (let index = 0; index < table.childCount; index++) {
      const row = table.child(index);
      if (cellIndex < row.childCount) { let rowOffset = 0; for (let r = 0; r < index; r++) rowOffset += table.child(r).nodeSize; let cellOffset = 0; for (let c = 0; c < cellIndex; c++) cellOffset += row.child(c).nodeSize; clearCell(editor, $from.before(-3) + 1 + rowOffset + 1 + cellOffset); }
    }
  }
}
function clearCell(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (node) editor.chain().command(({ tr }) => { tr.delete(pos + 1, pos + node.nodeSize - 1).insert(pos + 1, editor.schema.nodes.paragraph!.create()); return true; }).run();
}
