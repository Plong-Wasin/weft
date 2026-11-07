import { Extension, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";

export { Mention };

export const Callout = Node.create({
  name: "callout", group: "block", content: "block+", defining: true,
  parseHTML() { return [{ tag: "aside[data-callout]" }]; },
  renderHTML() { return ["aside", { "data-callout": "" }, 0]; },
});

export const assetImage = Node.create({
  name: "assetImage", group: "inline", inline: true, atom: true,
  addAttributes() { return { assetId: { default: null } }; },
});

const TableKeyboardNavigation = Extension.create({
  name: "tableKeyboardNavigation",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const { $from } = this.editor.state.selection;
        let tableDepth = $from.depth;
        while (tableDepth > 0 && $from.node(tableDepth).type.name !== "table") tableDepth -= 1;
        if (tableDepth === 0) return false;
        const table = $from.node(tableDepth);
        const rowIndex = $from.index(tableDepth);
        const cellIndex = $from.index(tableDepth + 1);
        if (rowIndex === table.childCount - 1 && cellIndex === table.child(rowIndex).childCount - 1) return this.editor.chain().addRowAfter().run();
        return this.editor.commands.goToNextCell();
      },
      "Shift-Tab": () => {
        const { $from } = this.editor.state.selection;
        let tableDepth = $from.depth;
        while (tableDepth > 0 && $from.node(tableDepth).type.name !== "table") tableDepth -= 1;
        return tableDepth > 0 ? this.editor.commands.goToPreviousCell() : false;
      },
    };
  },
});

/** Inline link options shared by every editor: Markdown `[text](url)` converts on type and paste; clicks are handled by the editor, anchors keep Tiptap's default new-tab attributes (noopener noreferrer nofollow). */
export const linkConfig = { markdownLinks: true, openOnClick: false } as const;

/** Schema extensions used by both the browser editor and server-side Yjs conversion. */
export const wikiEditorExtensions = [
  StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3, 4, 5, 6] }, link: linkConfig }), Mention,
  Table.configure({ resizable: true }), TableRow, TableHeader, TableCell, TaskList, TaskItem.configure({ nested: true }), TableKeyboardNavigation,
  TextStyle, Color, Callout, assetImage,
];
