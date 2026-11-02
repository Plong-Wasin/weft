import { Node } from "@tiptap/core";
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

/** Schema extensions used by both the browser editor and server-side Yjs conversion. */
export const wikiEditorExtensions = [
  StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3, 4, 5, 6] }, link: { markdownLinks: true, openOnClick: false, HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" } } }), Mention,
  Table.configure({ resizable: true }), TableRow, TableHeader, TableCell, TaskList, TaskItem.configure({ nested: true }),
  TextStyle, Color, Callout, assetImage,
];
