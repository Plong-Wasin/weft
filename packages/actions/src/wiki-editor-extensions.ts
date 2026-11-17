import { Extension, Mark, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Mention from "@tiptap/extension-mention";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight } from "lowlight";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import Typography from "@tiptap/extension-typography";
import { Markdown } from "@tiptap/markdown";
import { isAllowedLinkHref, writtenFormLinkSchemes } from "./written-form-attributes";
import { translate } from "@weft/shared";

export const editorPalette = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"] as const;

/** Languages shared by editor code blocks and their read-only views. */
export function createWikiLowlight() {
  return createLowlight({ javascript, typescript, python, json, html: xml, css, diff });
}

/** Colours land in `style` attributes, including on public pages, so only plain hex values pass; anything else (a stored `red; background: url(...)`) is dropped. */
export function safeEditorColor(value: unknown): string | null {
  return typeof value === "string" && (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) || ["red", "orange", "yellow", "green", "blue", "purple", "gray", "black", "white"].includes(value.toLowerCase())) ? value.toLowerCase() : null;
}

const simpleInlineMark = (name: string, tag: string) => Mark.create({ name, parseHTML() { return [{ tag }]; }, renderHTML() { return [tag, 0]; } });
const SubscriptMark = simpleInlineMark("subscript", "sub");
const SuperscriptMark = simpleInlineMark("superscript", "sup");

const GuardedColor = Color.extend({
  addGlobalAttributes() {
    return [{ types: this.options.types, attributes: { color: {
      default: null,
      parseHTML: (element: HTMLElement) => safeEditorColor(element.style.color?.replace(/['"]+/g, "")),
      renderHTML: (attributes: { color?: string | null }) => { const color = safeEditorColor(attributes.color); return color ? { style: `color: ${color}` } : {}; },
    } } }];
  },
});

const GuardedHighlight = Highlight.extend({
  addAttributes() {
    return { color: {
      default: null,
      parseHTML: (element: HTMLElement) => safeEditorColor(element.getAttribute("data-color") || element.style.backgroundColor),
      renderHTML: (attributes: { color?: string | null }) => { const color = safeEditorColor(attributes.color); return color ? { "data-color": color, style: `background-color: ${color}; color: inherit` } : {}; },
    } };
  },
});

export { Mention };

export const Callout = Node.create({
  name: "callout", group: "block", content: "block+", defining: true,
  addAttributes() { return { type: { default: "note", parseHTML: (el: HTMLElement) => el.getAttribute("data-callout-type") ?? "note", renderHTML: (attrs: { type?: string }) => ({ "data-callout-type": attrs.type ?? "note" }) }, color: { default: null, parseHTML: (el: HTMLElement) => safeEditorColor(el.getAttribute("data-color")), renderHTML: (attrs: { color?: string | null }) => { const color = safeEditorColor(attrs.color); return color ? { "data-color": color, style: `--callout-color: ${color}` } : {}; } }, icon: { default: "💡", parseHTML: (el: HTMLElement) => el.getAttribute("data-icon") ?? "💡", renderHTML: (attrs: { icon?: string }) => ({ "data-icon": attrs.icon }) } }; },
  parseHTML() { return [{ tag: "aside[data-callout]" }]; },
  renderHTML({ HTMLAttributes }) { return ["aside", { ...HTMLAttributes, "data-callout": "" }, ["span", { "data-callout-icon": "" }, HTMLAttributes["data-icon"] ?? "💡"], ["div", { "data-callout-content": "" }, 0]]; },
});

export const assetImageAttributes = () => ({
  assetId: { default: null },
  alt: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("alt"), renderHTML: (attributes: { alt?: string | null }) => attributes.alt ? { alt: attributes.alt } : {} },
  width: { default: null, parseHTML: (element: HTMLElement) => Number(element.getAttribute("data-width")) || null, renderHTML: (attributes: { width?: number | null }) => attributes.width ? { "data-width": attributes.width } : {} },
  alignment: { default: "center", parseHTML: (element: HTMLElement) => element.getAttribute("data-alignment") ?? "center", renderHTML: (attributes: { alignment?: string }) => ({ "data-alignment": attributes.alignment }) },
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
export const assetImage = Node.create({
  name: "assetImage", group: "block", atom: true, draggable: true,
  addAttributes: assetImageAttributes,
  parseHTML() { return [{ tag: "img[data-asset-id]" }]; },
  renderHTML({ node }) { return ["img", { "data-asset-id": node.attrs.assetId, ...(node.attrs.alt ? { alt: node.attrs.alt } : {}), ...(node.attrs.width ? { "data-width": node.attrs.width } : {}), "data-alignment": node.attrs.alignment }]; },
});

/** Converts stored pre-block inline images into sibling blocks without losing surrounding paragraph text. */
export function normalizeAssetImages(value: unknown): any {
  if (!value || typeof value !== "object") return value;
  const node = value as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
  if (!Array.isArray(node.content)) return node.type === "assetImage" ? { ...node, attrs: { assetId: null, width: null, alignment: "center", ...node.attrs } } : value;
  const isImage = (part: unknown) => (part as { type?: string })?.type === "assetImage";
  const content = node.content.flatMap((child) => {
    const normalized = normalizeAssetImages(child) as { type?: string; content?: unknown[]; attrs?: Record<string, unknown> };
    if (!["paragraph", "heading"].includes(normalized?.type ?? "") || !Array.isArray(normalized.content) || !normalized.content.some(isImage)) return [normalized];
    const images = normalized.content.filter(isImage);
    const rest = normalized.content.filter((part) => !isImage(part));
    // A heading holds inline content only: its text stays, the images follow it.
    if (normalized.type === "heading") return [...(rest.length ? [{ ...normalized, content: rest }] : []), ...images];
    const result: unknown[] = []; let inline: unknown[] = [];
    const flush = () => { if (inline.length) result.push({ ...normalized, content: inline }); inline = []; };
    for (const part of normalized.content) { if (isImage(part)) { flush(); result.push(part); } else inline.push(part); }
    flush(); return result;
  });
  // List and task items must start with a paragraph.
  if (["listItem", "taskItem"].includes(node.type ?? "") && content.length && isImage(content[0])) content.unshift({ type: "paragraph" });
  return { ...node, content };
}
/** Inline link options shared by every editor: Markdown `[text](url)` converts on type and paste; clicks are handled by the editor, anchors keep Tiptap's default new-tab attributes (noopener noreferrer nofollow). */
export const linkConfig = {
  markdownLinks: true, openOnClick: false, protocols: Array.from(writtenFormLinkSchemes),
  isAllowedUri: (url: string, { defaultValidate }: { defaultValidate: (url: string) => boolean }) => isAllowedLinkHref(url) && (/[a-z][a-z0-9+.-]*:/i.test(url) || defaultValidate(url)),
};
const StableLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      kind: { default: null, rendered: false },
      targetId: { default: null, rendered: false },
      target: { default: null, rendered: false },
      unavailable: { default: false, parseHTML: (element: HTMLElement) => element.hasAttribute("data-unavailable-reference"), renderHTML: (attributes: { unavailable?: boolean }) => attributes.unavailable ? { "data-unavailable-reference": "", contenteditable: "false", title: translate("editor.unavailableReference") } : {} },
    };
  },
});

const LegacyWrittenFormAttributes = Extension.create({
  name: "legacyWrittenFormAttributes",
  addGlobalAttributes() {
    return [
      { types: ["paragraph", "heading"], attributes: { textAlign: { default: null, rendered: false } } },
      { types: ["tableCell", "tableHeader"], attributes: { backgroundColor: { default: null, rendered: false } } },
    ];
  },
});

/** Schema extensions used by both the browser editor and server-side Yjs conversion. */
export const wikiEditorExtensions = [
  StarterKit.configure({ undoRedo: false, codeBlock: false, heading: { levels: [1, 2, 3, 4, 5, 6] }, link: false }),
  LegacyWrittenFormAttributes, StableLink.configure(linkConfig), CodeBlockLowlight.configure({ lowlight: createWikiLowlight(), defaultLanguage: "javascript" }), Typography.configure({ emDash: false }), Markdown, Mention,
  Table.configure({ resizable: false }), TableRow, TableHeader, TableCell, TaskList, TaskItem.configure({ nested: true }), TableKeyboardNavigation,
  TextStyle, GuardedColor, GuardedHighlight.configure({ multicolor: true }), SubscriptMark, SuperscriptMark, Callout, assetImage,
];
