import { isAllowedLinkHref, isWrittenFormColor, writtenFormCalloutIcons } from "./written-form-attributes";

/** Browser-safe parts of the Written form converter shared by Actions and the editor source mode. */
type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>; content?: Node[] };
export const writtenFormNodeAllowlist = new Set(["doc", "paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "listItem", "horizontalRule", "hardBreak", "text", "table", "tableRow", "tableHeader", "tableCell", "taskList", "taskItem", "callout", "assetImage", "mention"]);
export const writtenFormMarkAllowlist = new Set(["bold", "italic", "strike", "code", "link", "underline", "textStyle", "highlight", "subscript", "superscript"]);
export function writtenFormSchemaIssues(schema: { nodes: Record<string, unknown>; marks: Record<string, unknown> }) {
  return [
    ...Object.keys(schema.nodes).filter((name) => !writtenFormNodeAllowlist.has(name)).map((name) => `node:${name}`),
    ...Object.keys(schema.marks).filter((name) => !writtenFormMarkAllowlist.has(name)).map((name) => `mark:${name}`),
  ].sort();
}
type WrittenAttributePolicy = { persisted: true } | { persisted: false; reason: string };
const persisted = { persisted: true } as const;
const excluded = (reason: string): WrittenAttributePolicy => ({ persisted: false, reason });
/** Explicit Written form decisions for every attribute exposed by wikiEditorExtensions. */
export const writtenFormAttributePolicy: Record<string, WrittenAttributePolicy> = {
  "node:paragraph.textAlign": excluded("Written form paragraphs do not encode alignment; the editor warns when this legacy attribute is removed."),
  "node:heading.textAlign": excluded("Written form headings do not encode alignment; the editor warns when this legacy attribute is removed."),
  "node:heading.level": persisted,
  "node:orderedList.start": persisted,
  "node:orderedList.type": excluded("Only the editor's standard decimal ordered-list style is stored; custom list styles are not offered in the editor."),
  "node:codeBlock.language": persisted,
  "node:tableHeader.colspan": excluded("Markdown pipe tables have no column-span syntax; the serializer warns when non-default."),
  "node:tableHeader.rowspan": excluded("Markdown pipe tables have no row-span syntax; the serializer warns when non-default."),
  "node:tableHeader.colwidth": excluded("Markdown pipe tables have no column-width syntax; the serializer warns when present."),
  "node:tableHeader.align": excluded("Markdown pipe tables have no cell-alignment syntax; the serializer warns when set."),
  "node:tableCell.colspan": excluded("Markdown pipe tables have no column-span syntax; the serializer warns when non-default."),
  "node:tableCell.rowspan": excluded("Markdown pipe tables have no row-span syntax; the serializer warns when non-default."),
  "node:tableCell.colwidth": excluded("Markdown pipe tables have no column-width syntax; the serializer warns when present."),
  "node:tableCell.align": excluded("Markdown pipe tables have no cell-alignment syntax; the serializer warns when set."),
  "node:tableCell.backgroundColor": excluded("Markdown pipe tables have no cell-background syntax; the serializer warns when set."),
  "node:tableHeader.backgroundColor": excluded("Markdown pipe tables have no cell-background syntax; the serializer warns when set."),
  "node:taskItem.checked": persisted,
  "node:callout.type": persisted,
  "node:callout.color": persisted,
  "node:callout.icon": persisted,
  "node:assetImage.assetId": persisted,
  "node:assetImage.alt": persisted,
  "node:assetImage.width": excluded("Written form asset references do not encode display width; the serializer warns when set."),
  "node:assetImage.alignment": excluded("Written form asset references use the centered default; the serializer warns when changed."),
  "node:mention.id": persisted,
  "node:mention.label": persisted,
  "node:mention.mentionSuggestionChar": excluded("The editor's typing trigger is interaction state, not part of a saved mention."),
  "mark:link.href": persisted,
  "mark:link.kind": persisted,
  "mark:link.targetId": persisted,
  "mark:link.rel": excluded("Link rel is a safe rendering default, not Written form content."),
  "mark:link.target": excluded("Ordinary link opening behavior is omitted with a warning; stable internal links use this attribute as their visible reference label."),
  "mark:link.class": excluded("CSS classes are not stored in Written form."),
  "mark:link.title": excluded("Link titles are not stored in Written form; the serializer warns when set."),
  "mark:link.unavailable": excluded("The unavailable-reference marker is viewer-local and never stored in Written form."),
  "mark:textStyle.color": persisted,
  "mark:highlight.color": persisted,
};
export function writtenFormAttributeIssues(schema: { nodes: Record<string, unknown>; marks: Record<string, unknown> }) {
  const issues: string[] = [];
  const declared = new Set<string>();
  for (const [kind, entries] of [["node", schema.nodes], ["mark", schema.marks]] as const) for (const [name, rawType] of Object.entries(entries)) {
    const attrs = (rawType as { spec?: { attrs?: Record<string, unknown> } })?.spec?.attrs ?? {};
    for (const attr of Object.keys(attrs)) {
      const key = `${kind}:${name}.${attr}`;
      declared.add(key);
      if (!writtenFormAttributePolicy[key]) issues.push(key);
    }
  }
  for (const key of Object.keys(writtenFormAttributePolicy)) if (!declared.has(key)) issues.push(`stale:${key}`);
  return issues.sort();
}
const safeMarkdownHref = (value: unknown) => isAllowedLinkHref(value);
const escapeWrittenText = (value: string) => value
  .replace(/&(?=(?:[A-Za-z][A-Za-z0-9]+|#\d+|#x[\da-f]+);)/gi, "&amp;")
  .replace(/(!\[[^\]]*\]\()([a-z][a-z0-9+.-]*):/gi, "$1$2\u2060:")
  .replace(/@\{/g, "@\u2060{").replace(/\[\[/g, "[\u2060[").replace(/==/g, "=\u2060=")
  .replace(/</g, "&#60;").replace(/([\\*_~`>!()])/g, "\\$1").replace(/(?<!\[)\[(?!\[)/g, "\\[").replace(/(?<!\])\](?!\])/g, "\\]").replace(/\|/g, "\\|")
  .replace(/^(\d+)\.([ \t])/, "$1\\.$2")
  .replace(/^([+*\-])(?=$|[ \t])/, "\\$1")
  .replace(/^(#{1,6}[ \t]|>[ \t]|[-*][ \t]|\|[ \t])/, "\\$1");
/** Fallback escape: a backslash before every ASCII punctuation character is always legal CommonMark, so plain text cannot form markup, autolinks or block starters. */
let paranoidText = false;
/**
 * The shortest escaping that stops text from forming links: the normal escaping, but an underscore between two letters or digits and a parenthesis are left alone (neither can open markup in text)
 * and the colon of `scheme://` is escaped so no autolink forms. Tried after the normal form fails to read back and before the all-punctuation form, which is longer.
 */
let linkSafeText = false;
const linkSafeEscapeText = (value: string) => escapeWrittenText(value)
  .replace(/([A-Za-z0-9])\\_/g, "$1_")
  // A parenthesis is literal unless a `]` before it closes a link, and the `]` of text is always escaped: parentheses need no backslash in text (a read-back check still decides).
  .replace(/\\([()])/g, "$1")
  .replace(/(https?|ftp):\/\//gi, "$1\\://")
  .replace(/www\./gi, (match) => `${match.slice(0, 3)}\\.`);
const paranoidEscapeText = (value: string) => value
  // Backslashes are enough for URLs and e-mail addresses (the parser reads the escapes back out of a literal autolink); only the Weft tokens ==, @{ and [[ need a word joiner, dropped again on read.
  .replace(/==+/g, (run) => run.split("").join("\u2060")).replace(/@\{/g, "@\u2060{").replace(/\[\[/g, "[\u2060[")
  .replace(/[!-/:-@[-`{-~]/g, (char) => char === "<" ? "&#60;" : char === "|" ? "&#124;" : `\\${char}`)
  .replace(/\t/g, "&#9;").replace(/ +(?=\n)/g, (spaces) => "&#32;".repeat(spaces.length));
const encodeField = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeReferenceLabel = (value: string) => value.replace(/[%\[\]|=@{}*_~`<>\\]/g, (char) => encodeField(char));
const encodeMentionLabel = (value: string) => escapeWrittenText(value).replace(/[%|}\]{}@]/g, (char) => encodeField(char));
const imageWrittenForm = (node: Node) => `![[asset:${encodeField(String(node.attrs?.assetId ?? ""))}${node.attrs?.alt ? `|${encodeField(String(node.attrs.alt))}` : ""}]]`;
const opaqueBlock = (node: Node) => `<!-- wf-block:${encodeURIComponent(JSON.stringify(node))} -->`;
const requiresOpaqueBlock = (node: Node): boolean => node.type === "table" && (node.content ?? []).some((row) => (row.content ?? []).some((cell) => (cell.content ?? []).some((child) => child.type !== "paragraph"))) || node.type === "callout" && (node.content ?? []).some((child) => child.type !== "paragraph") || node.type === "blockquote" && (node.content ?? []).some((child) => child.type === "orderedList") || (node.content ?? []).some(requiresOpaqueBlock);
/** A space or tab written as a character reference, so it survives at the edge of a line. */
const entityWhitespace = (value: string) => value.replace(/[ \t]/g, (character) => character === "\t" ? "&#9;" : "&#32;");
const encodeEdgeSpaces = (line: string, preserveHardBreak = false) => {
  if (/^\s{2,}(?:[-*+] |\d+[.] |>\s)/.test(line)) return line;
  const hardBreakSpaces = preserveHardBreak && / {2}$/.test(line) ? "  " : "";
  const content = hardBreakSpaces ? line.slice(0, -2) : line;
  const leading = content.match(/^[ \t]+/)?.[0] ?? "";
  const trailing = content.length > leading.length ? content.match(/[ \t]+$/)?.[0] ?? "" : "";
  return `${entityWhitespace(leading)}${content.slice(leading.length, content.length - trailing.length)}${entityWhitespace(trailing)}${hardBreakSpaces}`;
};
const encodeInlineBoundarySpace = (node: Node, previous?: Node, next?: Node) => {
  if (node.type !== "text") return null;
  const value = node.text ?? "";
  if (/^\s+$/.test(value) && (previous?.type === "hardBreak" || next?.type === "hardBreak")) return entityWhitespace(value);
  if (previous?.type === "hardBreak" && /^[ \t]+/.test(value)) return value.replace(/^[ \t]+/, entityWhitespace);
  return null;
};
const quoteBlocks = (content: string) => {
  const lines = content.split("\n");
  return lines.map((line, index) => {
    if (!line) return ">";
    const structuralIndent = line.match(/^ +/)?.[0] ?? "";
    return `> ${structuralIndent}${encodeEdgeSpaces(line.slice(structuralIndent.length), index < lines.length - 1)}`;
  }).join("\n");
};
const inline = (node: Node, hardBreak = "  \n"): string => {
  if (node.type === "text") {
    const marks = node.marks ?? [];
    const raw = node.text ?? "";
    const codeMark = marks.some((mark) => mark.type === "code");
    const trimEdges = marks.length > 0 && !codeMark;
    const leading = trimEdges ? raw.match(/^\s*/)?.[0] ?? "" : "";
    const trailing = trimEdges && raw.length > leading.length ? raw.match(/\s*$/)?.[0] ?? "" : "";
    let value = raw.slice(leading.length, raw.length - trailing.length);
    const visibleValue = value;
    if (!codeMark) value = paranoidText ? paranoidEscapeText(value) : linkSafeText ? linkSafeEscapeText(value) : escapeWrittenText(value);
    if (!value) return leading + trailing;
    for (const mark of [...marks].reverse()) {
      if (mark.type === "bold") value = `**${value}**`;
      else if (mark.type === "italic") value = `_${value}_`;
      else if (mark.type === "strike") value = `~~${value}~~`;
      else if (mark.type === "code") {
        const size = Math.max(1, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1));
        const fence = "`".repeat(size);
        value = `${fence}${value.includes("`") || /^\s|\s$/.test(value) ? ` ${value} ` : value}${fence}`;
      }
      else if (mark.type === "link" && mark.attrs?.kind && mark.attrs?.targetId) value = `[[${encodeReferenceLabel(visibleValue.trim())}|${String(mark.attrs.kind)}:${String(mark.attrs.targetId)}]]`;
      else if (mark.type === "link" && safeMarkdownHref(mark.attrs?.href)) {
        const originalHref = String(mark.attrs?.href ?? "");
        const href = originalHref.replace(/</g, "%3C").replace(/>/g, "%3E");
        value = `[${value}](${/[\s()<>]/.test(originalHref) ? `<${href}>` : href})`;
      }
      else if (mark.type === "highlight") value = isWrittenFormColor(mark.attrs?.color) ? `<mark data-color="${String(mark.attrs?.color)}">${value}</mark>` : `==${value}==`;
      else if (mark.type === "underline") value = `<u>${value}</u>`;
      else if (mark.type === "subscript") value = `<sub>${value}</sub>`;
      else if (mark.type === "superscript") value = `<sup>${value}</sup>`;
      else if (mark.type === "textStyle" && isWrittenFormColor(mark.attrs?.color)) value = `<span style="color:${String(mark.attrs?.color)}">${value}</span>`;
    }
    return `${leading.replace(/[ \t]/g, "&#32;")}${value}${trailing.replace(/[ \t]/g, "&#32;")}`;
  }
  if (node.type === "hardBreak") return hardBreak;
  if (node.type === "mention") {
    const id = node.attrs?.id == null ? "" : String(node.attrs.id);
    const label = String(node.attrs?.label ?? node.attrs?.name ?? "");
    if (!id && !label) return "";
    return `@{${label && label !== id ? `${encodeMentionLabel(label)}|${id}` : id}}`;
  }
  if (node.type === "assetImage") return imageWrittenForm(node);
  return (node.content ?? []).map((child) => inline(child, hardBreak)).join("");
};
const inlineContent = (nodes: Node[], hardBreak = "  \n") => nodes.map((node, index) => {
  const boundary = encodeInlineBoundarySpace(node, nodes[index - 1], nodes[index + 1]);
  if (boundary !== null) return boundary;
  let written = inline(node, hardBreak);
  // Spaces and tabs at the edge of a line next to a hard break would be dropped on reading: write them as character references.
  if (node.type === "text") {
    if (nodes[index + 1]?.type === "hardBreak") written = written.replace(/[ \t]+$/, entityWhitespace);
    if (nodes[index - 1]?.type === "hardBreak") written = written.replace(/^[ \t]+/, entityWhitespace);
  }
  return written;
}).join("");
function block(node: Node, hardBreak = "  \n"): string {
  const children = node.content ?? [];
  const rawCalloutType = node.attrs?.type;
  const calloutType = typeof rawCalloutType === "string" && /^[a-z][a-z0-9_-]*$/i.test(rawCalloutType) ? rawCalloutType : "note";
  const calloutMeta = [
    isWrittenFormColor(node.attrs?.color) ? `color=${String(node.attrs.color)}` : "",
    typeof node.attrs?.icon === "string" && writtenFormCalloutIcons.includes(node.attrs.icon as typeof writtenFormCalloutIcons[number]) && node.attrs.icon !== "💡" ? `icon=${node.attrs.icon}` : "",
  ].filter(Boolean);
  switch (node.type) {
    case "heading": return `${"#".repeat(Math.max(1, Math.min(6, Number(node.attrs?.level) || 1)))} ${encodeEdgeSpaces(inlineContent(children, "<br>"))}`;
    case "paragraph": return children.length ? encodeEdgeSpaces(inlineContent(children, hardBreak)) : "<!-- empty paragraph -->";
    case "assetImage": return imageWrittenForm(node);
    case "codeBlock": {
      const body = children.map((part) => part.text ?? "").join("");
      const ticks = Math.max(0, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
      const fence = "`".repeat(Math.max(3, ticks + 1));
      const language = typeof node.attrs?.language === "string" && /^[a-z0-9_+-]*$/i.test(node.attrs.language) ? node.attrs.language : "";
      return `${fence}${language}\n${body}\n${fence}`;
    }
    case "bulletList": case "orderedList": case "taskList": return children.map((item, i) => {
      const prefix = node.type === "orderedList" ? `${Number(node.attrs?.start ?? 1) + i}.` : node.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}]` : "-";
      const value = block(item, hardBreak);
      const [first, ...rest] = value.split("\n");
      const contentColumn = node.type === "taskList" ? 2 : prefix.length + 1;
      const continuation = (line: string) => {
        const nestedIndent = line.match(/^ +/)?.[0] ?? "";
        return `${" ".repeat(contentColumn)}${nestedIndent}${encodeEdgeSpaces(line.slice(nestedIndent.length))}`;
      };
      return [`${prefix} ${encodeEdgeSpaces(first ?? "", rest.length > 0)}`, ...rest.map((line) => line ? continuation(line) : "")].join("\n");
    }).join("\n");
    case "listItem": case "taskItem": return children.map((child, index) => {
      const previous = children[index - 1]?.type ?? "";
      const listAfter = /List$/.test(previous) && child.type === "paragraph";
      const paragraphPair = previous === "paragraph" && child.type === "paragraph";
      // A thematic break directly under any text line would be a setext underline, so it always follows a blank line.
      const needsBlank = child.type === "horizontalRule" && index > 0 || previous === "paragraph" && ["orderedList", "assetImage"].includes(child.type ?? "");
      const serialized = requiresOpaqueBlock(child) ? opaqueBlock(child) : block(child, hardBreak);
      return `${index > 0 && (listAfter || paragraphPair || needsBlank) ? "\n\n" : index > 0 ? "\n" : ""}${serialized}`;
    }).join("");
    case "table": return children.map((row, i) => `| ${(row.content ?? []).map((cell) => {
      const cellBlocks = cell.content ?? [];
      if (cellBlocks.some((child) => child.type !== "paragraph")) {
        return `<!-- wf-cell-blocks:${cell.type}:${encodeURIComponent(JSON.stringify(cellBlocks))} -->`;
      }
      const marker = cell.type === "tableCell" && i === 0 ? "<!-- wf-cell -->" : cell.type === "tableHeader" && i > 0 ? "<!-- wf-header -->" : "";
      return `${marker}${cellBlocks.map((child) => encodeEdgeSpaces(block(child, "<br>")).replaceAll("|", "\\|")).join("<br data-block-break>")}`;
    }).join(" | ")} |${i === 0 ? `\n| ${(row.content ?? []).map(() => "---").join(" | ")} |` : ""}`).join("\n");
    case "blockquote": return quoteBlocks(children.map((child) => requiresOpaqueBlock(child) ? opaqueBlock(child) : block(child, hardBreak)).join("\n\n"));
    case "callout": return `> [!${calloutType}${calloutMeta.length ? `|${calloutMeta.join("|")}` : ""}]${children[0]?.type === "horizontalRule" ? "\n>\n" : "\n"}${quoteBlocks(children.map((child) => requiresOpaqueBlock(child) ? opaqueBlock(child) : block(child, hardBreak)).join("\n\n"))}`;
    case "horizontalRule": return "---";
    default: return inlineContent(children, hardBreak);
  }
}
/** Serialize a Tiptap document to Written form and report unsupported nodes or marks. */
export function richTextMarkdown(document: unknown, options: { paranoid?: ReadonlySet<number> | "all"; opaque?: ReadonlySet<number> | "all"; linkSafe?: ReadonlySet<number> | "all" } = {}) {
  const nodes = (document as Node | null)?.content ?? [];
  const unsupported = new Set<string>();
  const scan = (node: Node) => {
    if (!writtenFormNodeAllowlist.has(node.type ?? "")) unsupported.add(node.type ?? "unknown");
    for (const mark of node.marks ?? []) {
      if (!writtenFormMarkAllowlist.has(mark.type ?? "")) unsupported.add(mark.type ?? "unknown-mark");
      if (mark.type === "link" && !mark.attrs?.kind && !mark.attrs?.targetId && mark.attrs?.href != null && !safeMarkdownHref(mark.attrs.href)) unsupported.add("link");
      const attrs = mark.attrs ?? {};
      if (mark.type === "link" && !attrs.kind && (attrs.title != null || attrs.class != null || attrs.target != null || attrs.rel != null && attrs.rel !== "noopener noreferrer nofollow")) unsupported.add("link");
      if (mark.type === "textStyle" && mark.attrs?.color != null && !isWrittenFormColor(mark.attrs.color)) unsupported.add("textStyle");
      if (mark.type === "highlight" && mark.attrs?.color != null && !isWrittenFormColor(mark.attrs.color)) unsupported.add("highlight");
    }
    if (node.type === "heading" && Number(node.attrs?.level ?? 1) > 6) unsupported.add("heading");
    if (node.type === "orderedList" && node.attrs?.type != null) unsupported.add("orderedList");
    if (node.type === "codeBlock" && node.attrs?.language != null && (typeof node.attrs.language !== "string" || !/^[a-z0-9_+-]*$/i.test(node.attrs.language))) unsupported.add("codeBlock");
    if (node.type === "mention" && Object.hasOwn(node.attrs ?? {}, "mentionSuggestionChar") && node.attrs?.mentionSuggestionChar !== "@") unsupported.add("mention");
    if (node.type === "assetImage" && (node.attrs?.width != null || Object.hasOwn(node.attrs ?? {}, "alignment") && node.attrs?.alignment !== "center")) unsupported.add("assetImage");
    if (node.type === "callout" && Object.hasOwn(node.attrs ?? {}, "type") && (typeof node.attrs?.type !== "string" || !/^[a-z][a-z0-9_-]*$/i.test(node.attrs.type))) unsupported.add("callout");
    if (node.type === "callout" && node.attrs?.color != null && !isWrittenFormColor(node.attrs.color)) unsupported.add("callout");
    if (node.type === "callout" && Object.hasOwn(node.attrs ?? {}, "icon") && node.attrs?.icon !== "💡" && !writtenFormCalloutIcons.includes(String(node.attrs?.icon) as typeof writtenFormCalloutIcons[number])) unsupported.add("callout");
    if (["tableCell", "tableHeader"].includes(node.type ?? "") && (node.attrs?.align != null || node.attrs?.colspan != null && node.attrs.colspan !== 1 || node.attrs?.rowspan != null && node.attrs.rowspan !== 1 || node.attrs?.colwidth != null)) unsupported.add("table");
    for (const child of node.content ?? []) scan(child);
  };
  nodes.forEach(scan);
  let markdown: string;
  try {
    markdown = nodes.map((node, index) => {
      paranoidText = options.paranoid === "all" || options.paranoid?.has(index) === true;
      linkSafeText = !paranoidText && (options.linkSafe === "all" || options.linkSafe?.has(index) === true);
      return options.opaque === "all" || options.opaque?.has(index) || requiresOpaqueBlock(node) ? opaqueBlock(node) : block(node);
    }).join("\n\n");
  } finally { paranoidText = false; linkSafeText = false; }
  return { markdown, markdownWarnings: [...unsupported].sort().map((type) => type === "codeBlock" ? "An unsupported code language was removed; the code was kept." : type === "link" ? "An unsupported link was removed; its text was kept." : "Some formatting was simplified; the text was kept.") };
}
