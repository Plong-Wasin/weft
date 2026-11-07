import React from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { translate } from "@weft/shared";


/** Row, column, and table actions for the table containing the editor selection. */
export function TableControls({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const active = useEditorState({ editor, selector: ({ editor: current }) => !!current?.isActive("table") });
  if (!editor || !editable || !active) return null;
  const actions: Array<[string, () => void]> = [
    ["insertRowAbove", () => editor.chain().focus().addRowBefore().run()],
    ["insertRowBelow", () => editor.chain().focus().addRowAfter().run()],
    ["duplicateRow", () => duplicateAxis(editor, "row")],
    ["clearRow", () => clearAxis(editor, "row")],
    ["deleteRow", () => editor.chain().focus().deleteRow().run()],
    ["insertColumnLeft", () => editor.chain().focus().addColumnBefore().run()],
    ["insertColumnRight", () => editor.chain().focus().addColumnAfter().run()],
    ["duplicateColumn", () => duplicateAxis(editor, "column")],
    ["clearColumn", () => clearAxis(editor, "column")],
    ["deleteColumn", () => editor.chain().focus().deleteColumn().run()],
    ["toggleHeaderRow", () => toggleHeader(editor, "row")],
    ["toggleHeaderColumn", () => toggleHeader(editor, "column")],
    ["deleteTable", () => editor.chain().focus().deleteTable().run()],
  ];
  return <div className="flex flex-wrap gap-1 border-b border-subtle px-2 py-1" aria-label={translate("table.controls")}>{actions.map(([key, run]) => <button key={key} type="button" className="rounded border border-subtle px-2 py-1 text-12" onMouseDown={(event) => event.preventDefault()} onClick={run}>{translate(`table.${key}` as never)}</button>)}</div>;
}

function clearAxis(editor: Editor, axis: "row" | "column") {
  const { $from } = editor.state.selection;
  const table = $from.node(-3), rowIndex = $from.index(-3), cellIndex = $from.index(-2);
  const cells: number[] = [];
  let rowPos = $from.before(-3) + 1;
  for (let r = 0; r < table.childCount; r++) {
    const row = table.child(r); let cellPos = rowPos + 1;
    for (let c = 0; c < row.childCount; c++) {
      if ((axis === "row" && r === rowIndex) || (axis === "column" && c === cellIndex)) cells.push(cellPos);
      cellPos += row.child(c).nodeSize;
    }
    rowPos += row.nodeSize;
  }
  const tr = editor.state.tr;
  for (const pos of cells.reverse()) { const cell = tr.doc.nodeAt(pos); if (!cell) continue; tr.replaceWith(pos + 1, pos + cell.nodeSize - 1, editor.schema.nodes.paragraph!.create()); }
  editor.view.dispatch(tr);
}

function duplicateAxis(editor: Editor, axis: "row" | "column") {
  const { $from } = editor.state.selection;
  const table = $from.node(-3), rowIndex = $from.index(-3), columnIndex = $from.index(-2);
  const tablePos = $from.before(-3);
  if (axis === "row") {
    const rows = Array.from({ length: table.childCount }, (_, index) => table.child(index));
    rows.splice(rowIndex + 1, 0, table.child(rowIndex));
    const replacement = table.type.create(table.attrs, rows);
    replaceTable(editor, tablePos, table, replacement, rowIndex, columnIndex);
    return;
  }
  const rows = Array.from({ length: table.childCount }, (_, rowIndex) => {
    const row = table.child(rowIndex), cells = Array.from({ length: row.childCount }, (_, index) => row.child(index));
    cells.splice(columnIndex + 1, 0, row.child(columnIndex));
    return row.type.create(row.attrs, cells);
  });
  const replacement = table.type.create(table.attrs, rows);
  replaceTable(editor, tablePos, table, replacement, rowIndex, columnIndex);
}

function toggleHeader(editor: Editor, axis: "row" | "column") {
  const { $from } = editor.state.selection;
  const table = $from.node(-3), rowIndex = $from.index(-3), columnIndex = $from.index(-2), tablePos = $from.before(-3);
  const selected = axis === "row"
    ? Array.from({ length: table.child(rowIndex).childCount }, (_, column) => table.child(rowIndex).child(column))
    : Array.from({ length: table.childCount }, (_, row) => table.child(row).child(columnIndex));
  const toggleToHeader = !selected.every((cell) => cell.type.name === "tableHeader");
  const headerRows = new Set(Array.from({ length: table.childCount }, (_, row) => row).filter((row) => Array.from({ length: table.child(row).childCount }, (_, column) => table.child(row).child(column).type.name === "tableHeader").every(Boolean)));
  const headerColumnActive = Array.from({ length: table.childCount }, (_, row) => table.child(row).child(0).type.name === "tableHeader").every(Boolean);
  const rows = Array.from({ length: table.childCount }, (_, rowIndex) => {
    const row = table.child(rowIndex);
    const cells = Array.from({ length: row.childCount }, (_, columnIndex) => {
      if ((axis === "row" && rowIndex === $from.index(-3)) || (axis === "column" && columnIndex === $from.index(-2))) {
        if (!toggleToHeader && ((axis === "column" && headerRows.has(rowIndex)) || (axis === "row" && columnIndex === 0 && headerColumnActive))) return row.child(columnIndex);
        const cell = row.child(columnIndex), targetType = editor.schema.nodes[toggleToHeader ? "tableHeader" : "tableCell"]!;
        return targetType.create(cell.attrs, cell.content, cell.marks);
      }
      return row.child(columnIndex);
    });
    return row.type.create(row.attrs, cells);
  });
  replaceTable(editor, tablePos, table, table.type.create(table.attrs, rows), rowIndex, columnIndex);
}

function replaceTable(editor: Editor, tablePos: number, oldTable: ProseMirrorNode, replacement: ProseMirrorNode, rowIndex: number, columnIndex: number) {
  const tr = editor.state.tr.replaceWith(tablePos, tablePos + oldTable.nodeSize, replacement);
  let pos = tablePos + 2;
  for (let row = 0; row < rowIndex; row++) pos += replacement.child(row).nodeSize;
  pos += 1;
  for (let column = 0; column < columnIndex; column++) pos += replacement.child(rowIndex).child(column).nodeSize;
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
  editor.view.dispatch(tr);
}
