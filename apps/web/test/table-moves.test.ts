import { expect, test } from "bun:test";
import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { planTableMove } from "../src/table-moves";

const schema = new Schema({
  nodes: {
    doc: { content: "table" },
    table: { content: "tableRow+", group: "block", toDOM: () => ["table", 0] },
    tableRow: { content: "(tableCell | tableHeader)*", toDOM: () => ["tr", 0] },
    tableCell: {
      content: "paragraph+",
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } },
      toDOM: () => ["td", 0],
    },
    tableHeader: {
      content: "paragraph+",
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } },
      toDOM: () => ["th", 0],
    },
    paragraph: { content: "text*", group: "block", toDOM: () => ["p", 0] },
    text: {},
  },
});

type Span = { colspan?: number; rowspan?: number };
/** A table from rows of [text, span] cells; a bare string is a plain cell. */
function table(rows: Array<Array<string | [string, Span]>>): ProseMirrorNode {
  return schema.nodes.table!.create(null, rows.map((cells) => schema.nodes.tableRow!.create(null, cells.map((cell) => {
    const [text, span] = typeof cell === "string" ? [cell, {}] : cell;
    return schema.nodes.tableCell!.create({ colspan: span.colspan ?? 1, rowspan: span.rowspan ?? 1, colwidth: null }, schema.nodes.paragraph!.create(null, text ? schema.text(text) : null));
  }))));
}
/** The text of each row's own cells, in document order: a cell covered by a row span is not listed. */
const rowTexts = (node: ProseMirrorNode | null) => node ? node.content.content.map((row) => row.content.content.map((cell) => cell.textContent)) : null;

const plain = () => table([["A1", "A2", "A3"], ["B1", "B2", "B3"], ["C1", "C2", "C3"]]);

test("moving a row reorders the rows and keeps every cell's content", () => {
  expect(rowTexts(planTableMove(plain(), "row", 0, 2))).toEqual([["B1", "B2", "B3"], ["C1", "C2", "C3"], ["A1", "A2", "A3"]]);
  expect(rowTexts(planTableMove(plain(), "row", 2, 0))).toEqual([["C1", "C2", "C3"], ["A1", "A2", "A3"], ["B1", "B2", "B3"]]);
});

test("moving a column reorders the cells of every row", () => {
  expect(rowTexts(planTableMove(plain(), "column", 0, 2))).toEqual([["A2", "A3", "A1"], ["B2", "B3", "B1"], ["C2", "C3", "C1"]]);
  expect(rowTexts(planTableMove(plain(), "column", 2, 0))).toEqual([["A3", "A1", "A2"], ["B3", "B1", "B2"], ["C3", "C1", "C2"]]);
});

test("a move to the same index leaves the table as it was", () => {
  expect(rowTexts(planTableMove(plain(), "row", 1, 1))).toEqual(rowTexts(plain()));
  expect(rowTexts(planTableMove(plain(), "column", 1, 1))).toEqual(rowTexts(plain()));
});

test("a row move is refused when a row span would be split by it", () => {
  // A1 spans rows 0 and 1. Moving row 1 (or moving anything across rows 0 to 1) would split it.
  const spanned = table([[["A1", { rowspan: 2 }], "A2"], ["B2"], ["C1", "C2"]]);
  expect(planTableMove(spanned, "row", 1, 2)).toBeNull();
  expect(planTableMove(spanned, "row", 0, 2)).toBeNull();
  // Moving the whole span's neighbour above it keeps rows 0 and 1 together, so the span stays whole.
  expect(rowTexts(planTableMove(spanned, "row", 2, 0))).toEqual([["C1", "C2"], ["A1", "A2"], ["B2"]]);
  // Rows 0 and 1 move past each other; the span over rows 2 and 3 is not touched.
  const beside = table([["X"], ["Q"], [["Y", { rowspan: 2 }], "W"], ["V"]]);
  expect(rowTexts(planTableMove(beside, "row", 0, 1))).toEqual([["Q"], ["X"], ["Y", "W"], ["V"]]);
});

test("a column move is refused when it would put another column inside a column span", () => {
  // A1 spans columns 0 and 1. Moving column 0 out of the span, or column 1 out of it, splits it.
  const spanned = table([[["A1", { colspan: 2 }], "A3"], ["B1", "B2", "B3"]]);
  expect(planTableMove(spanned, "column", 0, 2)).toBeNull();
  expect(planTableMove(spanned, "column", 1, 2)).toBeNull();
  // Column 0 is part of the merged cell: moving it, even one place within the span, takes it out of the merge.
  expect(planTableMove(spanned, "column", 0, 1)).toBeNull();
  // Column 2 moves in front of the span, which stays whole.
  expect(rowTexts(planTableMove(spanned, "column", 2, 0))).toEqual([["A3", "A1"], ["B3", "B1", "B2"]]);
});

test("a column move carries a row span with its column, and keeps the rows covered by it", () => {
  // A spans rows 0 and 1 in column 0; row 1 has no cell in column 0.
  const spanned = table([[["A", { rowspan: 2 }], "B", "C"], ["D", "E"], ["F", "G", "H"]]);
  expect(rowTexts(planTableMove(spanned, "column", 2, 0))).toEqual([["C", "A", "B"], ["E", "D"], ["H", "F", "G"]]);
});

test("a row move carries a row span with its row when the span is moved whole", () => {
  // Moving row 2 (outside the span rows 0 and 1) to the top does not touch A.
  const spanned = table([[["A", { rowspan: 2 }], "B"], ["C"], ["D", "E"]]);
  expect(rowTexts(planTableMove(spanned, "row", 2, 0))).toEqual([["D", "E"], ["A", "B"], ["C"]]);
});
