import React from "react";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, Eraser, GripHorizontal, GripVertical, Heading, Plus, Table2, Trash2 } from "lucide-react";
import { translate } from "@weft/shared";
import { suggestionOpen } from "./editor-extensions";

/** Hover and caret controls for Wiki, description and Comment tables: `+` at the right and bottom edges, grips at the column tops, row lefts and the table corner. */

type Axis = "row" | "column" | "table";
export type TableAction = "insertRowAbove" | "insertRowBelow" | "duplicateRow" | "clearRow" | "deleteRow" | "insertColumnLeft" | "insertColumnRight" | "duplicateColumn" | "clearColumn" | "deleteColumn" | "toggleHeaderRow" | "toggleHeaderColumn" | "deleteTable";
type Located = { pos: number; node: ProseMirrorNode };
type Hover = { el: HTMLTableElement; row: number | null; col: number | null };
type Caret = { el: HTMLTableElement; row: number; col: number };
/** The menu is anchored to a document position (its row, its cell in the first row, or its table) that every transaction maps; a deleted anchor closes it. */
type Menu = { axis: Axis; index: number; pos: number };
type Resolved = { el: HTMLTableElement; axis: Axis; index: number; located: Located; row: number; col: number };
type Box = { left: number; top: number; right: number; bottom: number };

const GRIP = 24;
const GAP = 4;
/** How far outside a table the pointer still counts as hovering it, so the `+` and grips can be reached. */
const ZONE = 28;
const PLUS = 24;
const MENU_WIDTH = 184;

/** Row, column, and table actions for the table containing the editor selection or the pointer. */
export function TableControls({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const [hover, setHover] = React.useState<Hover | null>(null);
  const [menu, setMenu] = React.useState<Menu | null>(null);
  const [overlayFocus, setOverlayFocus] = React.useState(false);
  const [, setVersion] = React.useState(0);
  const root = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  // Escape from a cell asks for the table grip; the grip may not be rendered yet, so it is focused after the next render.
  const focusCorner = React.useRef(false);
  // Read by the editor's key handler, which is registered once per editor: an open menu takes Escape before the table corner does.
  const menuOpen = React.useRef(false);
  menuOpen.current = menu !== null;

  React.useEffect(() => {
    if (!editor || !editable) return;
    const dom = editor.view.dom;
    const relayout = () => setVersion((version) => version + 1);
    const onUpdate = () => {
      // Hover indexes captured before an edit may name other cells now; the pointer re-reports its table on its next move.
      setHover(null);
      relayout();
    };
    // Every document change maps the open menu's anchor; a remote or local delete of that row, column or table closes the menu.
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      setMenu((current) => {
        if (!current) return null;
        const mapped = transaction.mapping.mapResult(current.pos, 1);
        if (mapped.deleted) return null;
        return mapped.pos === current.pos ? current : { ...current, pos: mapped.pos };
      });
    };
    const onMove = (event: MouseEvent) => {
      const next = hoverAt(dom, event.clientX, event.clientY);
      setHover((current) => sameHover(current, next) ? current : next);
    };
    const onLeaveWindow = (event: MouseEvent) => { if (!event.relatedTarget) setHover(null); };
    const onPointerDown = (event: PointerEvent) => {
      // Any pointer-down outside the menu and its grips closes it, including a click in the page content.
      const target = event.target;
      if (target instanceof Node && root.current?.contains(target)) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuOpen.current) {
        // The menu takes this Escape alone: no other Escape handler of the page or the editor runs for it.
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        editor.view.focus();
        return;
      }
      // Escape leaves the table for its controls: Tab then walks the corner, grips and `+` buttons.
      // Capture phase: ProseMirror's own keydown handler runs on the same element and would otherwise take the key first.
      if (event.key !== "Escape" || event.defaultPrevented || suggestionOpen(editor) || !caretTable(editor)) return;
      event.preventDefault();
      focusCorner.current = true;
      setVersion((version) => version + 1);
    };
    const resizeObserver = new ResizeObserver(relayout);
    resizeObserver.observe(dom);
    editor.on("update", onUpdate);
    editor.on("transaction", onTransaction);
    editor.on("selectionUpdate", relayout);
    editor.on("focus", relayout);
    editor.on("blur", relayout);
    dom.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseout", onLeaveWindow);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", relayout);
    window.addEventListener("scroll", relayout, true);
    return () => {
      resizeObserver.disconnect();
      editor.off("update", onUpdate);
    editor.off("transaction", onTransaction);
      editor.off("selectionUpdate", relayout);
      editor.off("focus", relayout);
      editor.off("blur", relayout);
      dom.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseout", onLeaveWindow);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", relayout, true);
    };
  }, [editor, editable]);

  // Focus moves into the first menu item when a menu opens, so the keyboard can pick an action.
  React.useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menu]);

  React.useEffect(() => {
    if (!focusCorner.current) return;
    const corner = root.current?.querySelector<HTMLElement>('[data-table-grip="table"]');
    if (corner) { focusCorner.current = false; corner.focus(); }
  });

  if (!editor || !editable) return null;
  const frame = root.current?.getBoundingClientRect();
  const caret = editor.isFocused || overlayFocus || menu ? caretTable(editor) : null;
  const open = menu ? resolveMenu(editor, menu) : null;
  const tables = [...new Set([hover?.el, caret?.el, open?.el].filter((el): el is HTMLTableElement => !!el))];

  const closeMenu = () => { setMenu(null); editor.view.focus(); };
  const openMenu = (axis: Axis, index: number, el: HTMLTableElement) => {
    if (open && open.axis === axis && open.index === index && open.el === el) { setMenu(null); return; }
    const located = locateTable(editor, el);
    if (!located) return;
    const pos = axis === "table" ? located.pos : axis === "row" ? rowStart(located, index) : cellStart(located, 0, index);
    if (pos !== null) setMenu({ axis, index, pos });
  };
  const runMenu = (action: TableAction) => {
    const current = open;
    setMenu(null);
    if (!current) return;
    runTableAction(editor, current.located, current.row, current.col, action);
    editor.view.focus();
  };
  const addAt = (el: HTMLTableElement, action: "insertRowBelow" | "insertColumnRight") => {
    const located = locateTable(editor, el);
    if (!located || located.node.childCount === 0) return;
    const lastRow = located.node.childCount - 1, lastColumn = located.node.child(0).childCount - 1;
    runTableAction(editor, located, action === "insertRowBelow" ? lastRow : 0, action === "insertColumnRight" ? lastColumn : 0, action);
  };

  const overlay = frame ? tables.map((el, tableIndex) => {
    const box = relative(el.getBoundingClientRect(), frame);
    const rows = Array.from(el.rows);
    const columns = rows[0] ? Array.from(rows[0].cells) : [];
    const hovered = hover?.el === el ? hover : null;
    const here = caret?.el === el ? caret : null;
    const here_open = open?.el === el ? open : null;
    const rowBox = (index: number) => { const row = rows[index]; return row ? relative(row.getBoundingClientRect(), frame) : null; };
    const columnBox = (index: number) => { const cell = columns[index]; return cell ? relative(cell.getBoundingClientRect(), frame) : null; };
    const grips: React.ReactNode[] = [];
    columns.forEach((_, index) => {
      if (!(hovered?.col === index || here?.col === index || (here_open?.axis === "column" && here_open.index === index))) return;
      const cell = columnBox(index)!;
      const label = translate("table.columnMenu");
      grips.push(<TableGrip key={`column-${index}`} id={`column-${index}`} label={label} left={(cell.left + cell.right) / 2 - GRIP / 2} top={box.top - GRIP - GAP} expanded={here_open?.axis === "column" && here_open.index === index} onOpen={() => openMenu("column", index, el)}><GripHorizontal aria-hidden size={16} /></TableGrip>);
    });
    rows.forEach((_, index) => {
      if (!(hovered?.row === index || here?.row === index || (here_open?.axis === "row" && here_open.index === index))) return;
      const row = rowBox(index)!;
      const label = translate("table.rowMenu");
      grips.push(<TableGrip key={`row-${index}`} id={`row-${index}`} label={label} left={box.left - GRIP - GAP} top={(row.top + row.bottom) / 2 - GRIP / 2} expanded={here_open?.axis === "row" && here_open.index === index} onOpen={() => openMenu("row", index, el)}><GripVertical aria-hidden size={16} /></TableGrip>);
    });
    grips.push(<TableGrip key="table" id="table" label={translate("table.tableMenu")} left={box.left - GRIP - GAP} top={box.top - GRIP - GAP} expanded={here_open?.axis === "table"} onOpen={() => openMenu("table", 0, el)}><Table2 aria-hidden size={15} /></TableGrip>);
    return <React.Fragment key={tableIndex}>
      {grips}
      <AddButton kind="column" label={translate("table.addColumn")} left={box.right + GAP} top={(box.top + box.bottom) / 2 - PLUS / 2} onAdd={() => addAt(el, "insertColumnRight")} />
      <AddButton kind="row" label={translate("table.addRow")} left={(box.left + box.right) / 2 - PLUS / 2} top={box.bottom + GAP} onAdd={() => addAt(el, "insertRowBelow")} />
    </React.Fragment>;
  }) : null;

  const menuView = (() => {
    if (!open || !frame) return null;
    const place = menuPlace(open, frame, frame.width);
    if (!place) return null;
    const items = menuItems(open);
    return <div ref={menuRef} role="menu" data-testid="table-menu" aria-label={translate(menuLabelKey(open.axis))} className="pointer-events-auto absolute z-30 grid min-w-44 gap-0.5 rounded-md border border-subtle bg-surface-1 p-1 shadow-lg" style={{ left: place.left, top: place.top }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
        const at = buttons.indexOf(document.activeElement as HTMLElement);
        buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }}>
      {items.map((item) => <button key={item.action} type="button" role="menuitem" title={translate(`table.${item.action}.help` as never)} className={`table-control flex items-center gap-2 rounded px-2 py-1.5 text-left text-13 hover:bg-layer-transparent-hover ${item.danger ? "text-danger" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => runMenu(item.action)}>
        <item.icon aria-hidden size={14} />{translate(`table.${item.action}` as never)}
      </button>)}
    </div>;
  })();

  return <div ref={root} className="pointer-events-none absolute inset-0 z-20" data-testid="table-controls" onFocus={() => setOverlayFocus(true)} onBlur={(event) => {
    const next = event.relatedTarget;
    const inside = next instanceof Node && !!root.current?.contains(next);
    setOverlayFocus(inside);
    if (!inside && !(next instanceof Node && editor.view.dom.contains(next))) setMenu(null);
  }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); if (menu) { event.stopPropagation(); closeMenu(); } else editor.view.focus(); } }}>
    {overlay}
    {menuView}
  </div>;
}

function TableGrip({ id, label, left, top, expanded, onOpen, children }: { id: string; label: string; left: number; top: number; expanded: boolean; onOpen: () => void; children: React.ReactNode }) {
  return <button type="button" data-table-grip={id} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={expanded}
    className="table-control pointer-events-auto absolute grid size-6 place-items-center rounded text-tertiary hover:bg-layer-transparent-hover hover:text-primary aria-expanded:bg-layer-transparent-selected aria-expanded:text-primary"
    style={{ left, top }} onMouseDown={(event) => event.preventDefault()} onClick={onOpen}>{children}</button>;
}

function AddButton({ kind, label, left, top, onAdd }: { kind: "row" | "column"; label: string; left: number; top: number; onAdd: () => void }) {
  return <button type="button" data-table-add={kind} aria-label={label} title={label}
    className="table-control pointer-events-auto absolute grid size-6 place-items-center rounded-full border border-subtle bg-surface-1 text-secondary shadow-sm hover:bg-layer-transparent-hover hover:text-primary"
    style={{ left, top }} onMouseDown={(event) => event.preventDefault()} onClick={onAdd}><Plus aria-hidden size={14} /></button>;
}

function menuLabelKey(axis: Axis): "table.rowMenu" | "table.columnMenu" | "table.tableMenu" {
  return axis === "row" ? "table.rowMenu" : axis === "column" ? "table.columnMenu" : "table.tableMenu";
}

function menuItems(menu: { axis: Axis; index: number }): Array<{ action: TableAction; icon: React.ComponentType<{ "aria-hidden"?: boolean; size?: number }>; danger?: boolean }> {
  if (menu.axis === "table") return [{ action: "deleteTable", icon: Trash2, danger: true }];
  if (menu.axis === "row") {
    const items: Array<{ action: TableAction; icon: React.ComponentType<{ "aria-hidden"?: boolean; size?: number }>; danger?: boolean }> = [
      { action: "insertRowAbove", icon: ArrowUp }, { action: "insertRowBelow", icon: ArrowDown }, { action: "duplicateRow", icon: Copy }, { action: "clearRow", icon: Eraser }, { action: "deleteRow", icon: Trash2, danger: true },
    ];
    if (menu.index === 0) items.push({ action: "toggleHeaderRow", icon: Heading });
    return items;
  }
  const items: Array<{ action: TableAction; icon: React.ComponentType<{ "aria-hidden"?: boolean; size?: number }>; danger?: boolean }> = [
    { action: "insertColumnLeft", icon: ArrowLeft }, { action: "insertColumnRight", icon: ArrowRight }, { action: "duplicateColumn", icon: Copy }, { action: "clearColumn", icon: Eraser }, { action: "deleteColumn", icon: Trash2, danger: true },
  ];
  if (menu.index === 0) items.push({ action: "toggleHeaderColumn", icon: Heading });
  return items;
}

/** Where the menu opens, from its grip: beside a row grip, below a column grip or the corner grip. */
function menuPlace(menu: Pick<Resolved, "el" | "axis" | "index">, frame: DOMRect, frameWidth: number): { left: number; top: number } | null {
  const box = relative(menu.el.getBoundingClientRect(), frame);
  let grip: { left: number; top: number };
  if (menu.axis === "table") grip = { left: box.left - GRIP - GAP, top: box.top - GRIP - GAP };
  else if (menu.axis === "column") {
    const cell = menu.el.rows[0]?.cells[menu.index];
    if (!cell) return null;
    const rect = relative(cell.getBoundingClientRect(), frame);
    grip = { left: (rect.left + rect.right) / 2 - GRIP / 2, top: box.top - GRIP - GAP };
  } else {
    const row = menu.el.rows[menu.index];
    if (!row) return null;
    const rect = relative(row.getBoundingClientRect(), frame);
    grip = { left: box.left - GRIP - GAP, top: (rect.top + rect.bottom) / 2 - GRIP / 2 };
  }
  // Beside a row grip the menu opens to its right; under the other grips it opens below.
  return menu.axis === "row"
    ? { left: Math.max(0, Math.min(grip.left + GRIP + GAP, frameWidth - MENU_WIDTH)), top: grip.top }
    : { left: Math.max(0, Math.min(grip.left, frameWidth - MENU_WIDTH)), top: grip.top + GRIP + GAP };
}

function relative(rect: DOMRect, frame: DOMRect): Box {
  return { left: rect.left - frame.left, top: rect.top - frame.top, right: rect.right - frame.left, bottom: rect.bottom - frame.top };
}

function hoverAt(root: HTMLElement, x: number, y: number): Hover | null {
  for (const el of Array.from(root.querySelectorAll("table"))) {
    const box = el.getBoundingClientRect();
    if (x < box.left - ZONE || x > box.right + ZONE || y < box.top - ZONE || y > box.bottom + ZONE) continue;
    const rows = Array.from(el.rows);
    const row = rows.findIndex((tr) => { const rect = tr.getBoundingClientRect(); return y >= rect.top && y < rect.bottom; });
    const cells = rows[0] ? Array.from(rows[0].cells) : [];
    const col = cells.findIndex((cell) => { const rect = cell.getBoundingClientRect(); return x >= rect.left && x < rect.right; });
    return { el, row: row < 0 ? null : row, col: col < 0 ? null : col };
  }
  return null;
}

function sameHover(a: Hover | null, b: Hover | null): boolean {
  return a === b || (!!a && !!b && a.el === b.el && a.row === b.row && a.col === b.col);
}

/** The table the caret is in, with the caret's row and column; read from the live selection. */
function caretTable(editor: Editor): Caret | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== "table") continue;
    const dom = editor.view.nodeDOM($from.before(depth));
    const el = dom instanceof HTMLTableElement ? dom : dom instanceof HTMLElement ? dom.querySelector("table") : null;
    return el ? { el, row: $from.index(depth), col: $from.index(depth + 1) } : null;
  }
  return null;
}

/** The table element's position in the live document, or null when it is no longer in the document. */
function locateTable(editor: Editor, el: HTMLTableElement): Located | null {
  let found: Located | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || node.type.name !== "table") return !found;
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof Node && (dom === el || dom.contains(el))) found = { pos, node };
    return false;
  });
  return found;
}

/** Document position where a row starts inside the located table. */
function rowStart(located: Located, row: number): number {
  let pos = located.pos + 1;
  for (let index = 0; index < row; index++) pos += located.node.child(index).nodeSize;
  return pos;
}

/** Document position where a cell starts, in the given row of the located table. */
function cellStart(located: Located, row: number, column: number): number {
  let pos = rowStart(located, row) + 1;
  const cells = located.node.child(row);
  for (let index = 0; index < column; index++) pos += cells.child(index).nodeSize;
  return pos;
}

/** The live table, row and column an open menu's anchor names now, or null when the anchor no longer holds that node. */
function resolveMenu(editor: Editor, menu: Menu): Resolved | null {
  const { doc } = editor.state;
  if (menu.pos < 0 || menu.pos > doc.content.size) return null;
  const $pos = doc.resolve(menu.pos);
  const node = $pos.nodeAfter;
  if (!node) return null;
  let located: Located | null = null, row = 0, col = 0;
  if (menu.axis === "table") {
    if (node.type.name !== "table") return null;
    located = { pos: menu.pos, node };
  } else if (menu.axis === "row") {
    if (node.type.name !== "tableRow" || $pos.parent.type.name !== "table") return null;
    located = { pos: $pos.before(), node: $pos.parent };
    row = $pos.index();
  } else {
    const depth = $pos.depth;
    if (!["tableCell", "tableHeader"].includes(node.type.name) || $pos.parent.type.name !== "tableRow" || depth < 2) return null;
    const table = $pos.node(depth - 1);
    if (table.type.name !== "table") return null;
    located = { pos: $pos.before(depth - 1), node: table };
    col = $pos.index();
  }
  const dom = editor.view.nodeDOM(located.pos);
  const el = dom instanceof HTMLTableElement ? dom : dom instanceof HTMLElement ? dom.querySelector("table") : null;
  if (!el) return null;
  return { el, axis: menu.axis, index: menu.axis === "row" ? row : menu.axis === "column" ? col : 0, located, row, col };
}

/** Position inside the first paragraph of a cell, for a table that starts at `tablePos`. */
function cellTextPos(table: ProseMirrorNode, tablePos: number, row: number, col: number): number {
  let pos = tablePos + 1;
  for (let index = 0; index < row; index++) pos += table.child(index).nodeSize;
  pos += 1;
  const cells = table.child(row);
  for (let index = 0; index < col; index++) pos += cells.child(index).nodeSize;
  return pos + 2;
}

/** Runs one table action in a single transaction, so one undo step reverts it. */
export function runTableAction(editor: Editor, { pos, node }: Located, row: number, col: number, action: TableAction) {
  const select = () => cellTextPos(node, pos, row, col);
  switch (action) {
    case "insertRowAbove": return editor.chain().setTextSelection(select()).addRowBefore().run();
    case "insertRowBelow": return editor.chain().setTextSelection(select()).addRowAfter().run();
    case "insertColumnLeft": return editor.chain().setTextSelection(select()).addColumnBefore().run();
    case "insertColumnRight": return editor.chain().setTextSelection(select()).addColumnAfter().run();
    case "deleteRow": return editor.chain().setTextSelection(select()).deleteRow().run();
    case "deleteColumn": return editor.chain().setTextSelection(select()).deleteColumn().run();
    case "deleteTable": return editor.chain().setTextSelection(select()).deleteTable().run();
    case "clearRow": return clearAxis(editor, pos, node, "row", row, col);
    case "clearColumn": return clearAxis(editor, pos, node, "column", row, col);
    case "duplicateRow": return duplicateRow(editor, pos, node, row, col);
    case "duplicateColumn": return duplicateColumn(editor, pos, node, row, col);
    case "toggleHeaderRow": return toggleHeader(editor, pos, node, "row", row, col);
    case "toggleHeaderColumn": return toggleHeader(editor, pos, node, "column", row, col);
  }
}

function clearAxis(editor: Editor, tablePos: number, table: ProseMirrorNode, axis: "row" | "column", rowIndex: number, columnIndex: number) {
  const cells: number[] = [];
  let rowPos = tablePos + 1;
  for (let r = 0; r < table.childCount; r++) {
    const row = table.child(r); let cellPos = rowPos + 1;
    for (let c = 0; c < row.childCount; c++) {
      if ((axis === "row" && r === rowIndex) || (axis === "column" && c === columnIndex)) cells.push(cellPos);
      cellPos += row.child(c).nodeSize;
    }
    rowPos += row.nodeSize;
  }
  const tr = editor.state.tr;
  for (const pos of cells.reverse()) { const cell = tr.doc.nodeAt(pos); if (!cell) continue; tr.replaceWith(pos + 1, pos + cell.nodeSize - 1, editor.schema.nodes.paragraph!.create()); }
  editor.view.dispatch(tr);
}

function duplicateRow(editor: Editor, tablePos: number, table: ProseMirrorNode, rowIndex: number, columnIndex: number) {
  const rows = Array.from({ length: table.childCount }, (_, index) => table.child(index));
  rows.splice(rowIndex + 1, 0, table.child(rowIndex));
  replaceTable(editor, tablePos, table, table.type.create(table.attrs, rows), rowIndex, columnIndex);
}

function duplicateColumn(editor: Editor, tablePos: number, table: ProseMirrorNode, rowIndex: number, columnIndex: number) {
  const rows = Array.from({ length: table.childCount }, (_, index) => {
    const row = table.child(index), cells = Array.from({ length: row.childCount }, (_, cell) => row.child(cell));
    cells.splice(columnIndex + 1, 0, row.child(columnIndex));
    return row.type.create(row.attrs, cells);
  });
  replaceTable(editor, tablePos, table, table.type.create(table.attrs, rows), rowIndex, columnIndex);
}

function toggleHeader(editor: Editor, tablePos: number, table: ProseMirrorNode, axis: "row" | "column", rowIndex: number, columnIndex: number) {
  const selected = axis === "row"
    ? Array.from({ length: table.child(rowIndex).childCount }, (_, column) => table.child(rowIndex).child(column))
    : Array.from({ length: table.childCount }, (_, row) => table.child(row).child(columnIndex));
  const toggleToHeader = !selected.every((cell) => cell.type.name === "tableHeader");
  const headerRows = new Set(Array.from({ length: table.childCount }, (_, row) => row).filter((row) => Array.from({ length: table.child(row).childCount }, (_, column) => table.child(row).child(column).type.name === "tableHeader").every(Boolean)));
  const headerColumnActive = Array.from({ length: table.childCount }, (_, row) => table.child(row).child(0).type.name === "tableHeader").every(Boolean);
  const rows = Array.from({ length: table.childCount }, (_, row) => {
    const current = table.child(row);
    const cells = Array.from({ length: current.childCount }, (_, column) => {
      if ((axis === "row" && row === rowIndex) || (axis === "column" && column === columnIndex)) {
        if (!toggleToHeader && ((axis === "column" && headerRows.has(row)) || (axis === "row" && column === 0 && headerColumnActive))) return current.child(column);
        const cell = current.child(column), targetType = editor.schema.nodes[toggleToHeader ? "tableHeader" : "tableCell"]!;
        return targetType.create(cell.attrs, cell.content, cell.marks);
      }
      return current.child(column);
    });
    return current.type.create(current.attrs, cells);
  });
  replaceTable(editor, tablePos, table, table.type.create(table.attrs, rows), rowIndex, columnIndex);
}

function replaceTable(editor: Editor, tablePos: number, oldTable: ProseMirrorNode, replacement: ProseMirrorNode, rowIndex: number, columnIndex: number) {
  const tr = editor.state.tr.replaceWith(tablePos, tablePos + oldTable.nodeSize, replacement);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cellTextPos(replacement, tablePos, rowIndex, columnIndex))));
  editor.view.dispatch(tr);
}

