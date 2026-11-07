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

export const assetImageAttributes = () => ({
  assetId: { default: null },
  width: { default: null, parseHTML: (element: HTMLElement) => Number(element.getAttribute("data-width")) || null, renderHTML: (attributes: { width?: number | null }) => attributes.width ? { "data-width": attributes.width } : {} },
  alignment: { default: "center", parseHTML: (element: HTMLElement) => element.getAttribute("data-alignment") ?? "center", renderHTML: (attributes: { alignment?: string }) => ({ "data-alignment": attributes.alignment }) },
});

export const assetImage = Node.create({
  name: "assetImage", group: "block", atom: true, draggable: true,
  addAttributes: assetImageAttributes,
  parseHTML() { return [{ tag: "img[data-asset-id]" }]; },
  renderHTML({ node }) { return ["img", { "data-asset-id": node.attrs.assetId, ...(node.attrs.width ? { "data-width": node.attrs.width } : {}), "data-alignment": node.attrs.alignment }]; },
});

/** Converts stored pre-block inline images into sibling blocks without losing surrounding paragraph text. */
export function normalizeAssetImages(value: unknown): any {
  if (!value || typeof value !== "object") return value;
  const node = value as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
  if (!Array.isArray(node.content)) return node.type === "assetImage" ? { ...node, attrs: { assetId: null, width: null, alignment: "center", ...node.attrs } } : value;
  const content = node.content.flatMap((child) => {
    const normalized = normalizeAssetImages(child) as { type?: string; content?: unknown[]; attrs?: Record<string, unknown> };
    if (normalized?.type !== "paragraph" || !Array.isArray(normalized.content) || !normalized.content.some((part) => (part as { type?: string })?.type === "assetImage")) return [normalized];
    const result: unknown[] = []; let inline: unknown[] = [];
    const flush = () => { if (inline.length) result.push({ ...normalized, content: inline }); inline = []; };
    for (const part of normalized.content) { if ((part as { type?: string })?.type === "assetImage") { flush(); result.push(part); } else inline.push(part); }
    flush(); return result;
  });
  return { ...node, content };
}

/** Inline link options shared by every editor: Markdown `[text](url)` converts on type and paste; clicks are handled by the editor, anchors keep Tiptap's default new-tab attributes (noopener noreferrer nofollow). */
export const linkConfig = { markdownLinks: true, openOnClick: false } as const;

/** Schema extensions used by both the browser editor and server-side Yjs conversion. */
export const wikiEditorExtensions = [
  StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3, 4, 5, 6] }, link: linkConfig }), Mention,
  Table.configure({ resizable: true }), TableRow, TableHeader, TableCell, TaskList, TaskItem.configure({ nested: true }),
  TextStyle, Color, Callout, assetImage,
];
