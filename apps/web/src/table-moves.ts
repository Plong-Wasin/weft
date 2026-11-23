import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export type TableAxis = "row" | "column";

type PlacedCell = { row: number; column: number; rowspan: number; colspan: number; node: ProseMirrorNode };

/** Every cell that starts in a row, at its grid place. A cell covered by a span from an earlier row or column takes no place of its own. */
function placeCells(table: ProseMirrorNode): { cells: PlacedCell[]; width: number } {
  const cells: PlacedCell[] = [];
  const taken = new Set<string>();
  let width = 0;
  table.forEach((row, _offset, rowIndex) => {
    let column = 0;
    row.forEach((cell) => {
      while (taken.has(`${rowIndex},${column}`)) column += 1;
      const rowspan = Number(cell.attrs.rowspan) || 1, colspan = Number(cell.attrs.colspan) || 1;
      cells.push({ row: rowIndex, column, rowspan, colspan, node: cell });
      for (let down = 0; down < rowspan; down += 1) for (let across = 0; across < colspan; across += 1) taken.add(`${rowIndex + down},${column + across}`);
      column += colspan;
      width = Math.max(width, column);
    });
  });
  return { cells, width };
}

/** The number of grid columns a table spans, counting merged cells by their span. */
export function tableWidth(table: ProseMirrorNode): number {
  return placeCells(table).width;
}

/** The grid column where the `cellIndex`-th cell of a row starts, or null when the row has no such cell. */
export function gridColumnOfCell(table: ProseMirrorNode, row: number, cellIndex: number): number | null {
  const own = placeCells(table).cells.filter((cell) => cell.row === row).sort((a, b) => a.column - b.column);
  return own[cellIndex]?.column ?? null;
}

/** The index, among the cells that start in `row`, of the cell covering `gridColumn`; clamped into the row, or null for an empty row. */
export function cellIndexAtGridColumn(table: ProseMirrorNode, row: number, gridColumn: number): number | null {
  const own = placeCells(table).cells.filter((cell) => cell.row === row).sort((a, b) => a.column - b.column);
  if (own.length === 0) return null;
  const covering = own.findIndex((cell) => gridColumn >= cell.column && gridColumn < cell.column + cell.colspan);
  if (covering >= 0) return covering;
  return gridColumn < own[0]!.column ? 0 : own.length - 1;
}

/**
 * The table after one row or column moves from `from` to `to` (both final positions in the table), or null when the move would
 * split a merged cell: a cell whose rows (for a row) or columns (for a column) would no longer sit next to each other.
 * Cell attributes and content move with their cells; the result is a new node, the input is not changed.
 */
export function planTableMove(table: ProseMirrorNode, axis: TableAxis, from: number, to: number): ProseMirrorNode | null {
  const { cells, width } = placeCells(table);
  const count = axis === "row" ? table.childCount : width;
  if (from < 0 || from >= count || to < 0 || to >= count) return null;
  if (from === to) return table;
  // order[newPosition] is the old index that lands there; position[oldIndex] is the new index of an old row or column.
  const order = Array.from({ length: count }, (_, index) => index);
  order.splice(from, 1);
  order.splice(to, 0, from);
  const position: number[] = [];
  order.forEach((old, next) => { position[old] = next; });
  // A merged cell stays whole only if its rows (or columns) are not moved out of it and still sit next to each other.
  for (const cell of cells) {
    const start = axis === "row" ? cell.row : cell.column;
    const span = axis === "row" ? cell.rowspan : cell.colspan;
    if (span <= 1) continue;
    // A line that is part of a merged cell cannot leave it, even when the merged cell stays whole.
    if (from >= start && from < start + span) return null;
    const landed = Array.from({ length: span }, (_, step) => position[start + step]!);
    if (Math.max(...landed) - Math.min(...landed) + 1 !== span) return null;
  }
  if (axis === "row") {
    return table.type.create(table.attrs, order.map((old) => table.child(old)));
  }
  const rows = Array.from({ length: table.childCount }, (_, row) => {
    const own = cells.filter((cell) => cell.row === row).sort((a, b) => position[a.column]! - position[b.column]!);
    return table.child(row).type.create(table.child(row).attrs, own.map((cell) => cell.node));
  });
  return table.type.create(table.attrs, rows);
}
