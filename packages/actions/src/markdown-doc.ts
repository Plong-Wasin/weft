import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { PhrasingContent, Root, RootContent } from "mdast";
import { isAllowedLinkHref, isWrittenFormColor, writtenFormCalloutIcons } from "./written-form-attributes";
import { scanWrittenFormDelimiters, scanWrittenFormNesting, scanWrittenFormTables, withoutFencedCode, WRITTEN_FORM_MAX_NESTING_DEPTH, WRITTEN_FORM_TABLE_TOO_LARGE } from "./written-form-guard";
export { WRITTEN_FORM_MAX_NESTING_DEPTH };

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Mark[] };
export type ReferenceKind = "work-item" | "page" | "wiki";
export type ResolvedReference = { kind: ReferenceKind; id: string; label: string };
export type MarkdownOptions = { /** "kind:uuid" of stable references already stored in the row being edited: they stay links when the writer cannot resolve them (resolution decides display, never storage). */ existingStableReferences?: string[]; resolveReference?: (target: string, kind?: ReferenceKind) => ResolvedReference | { candidates: ResolvedReference[] } | null; preserveUnresolvedReferences?: boolean; preserveStableReferences?: boolean;
  /** Markdown the Written form serializer produced or an earlier write already validated: skips the untrusted-text delimiter scan. Nesting and length limits always apply. */
  trustedSource?: boolean;
  /** The data behind `resolveReference`, so a worker thread can rebuild the same resolver (functions cannot cross a thread). */
  references?: ResolvedReference[];
  /** Reading a stored row: it was validated when written, so only a stall-guard cap applies and a row that cannot be parsed degrades to its raw text, never to a blank document. */
  storedRead?: boolean;
  /** Internal: skip the length cap (used by stored reads, which have their own limit). */
  noLengthCap?: boolean };
/** Resolve a title or key against a fixed list of accessible references. */
export function resolverFromReferences(references: ResolvedReference[]): NonNullable<MarkdownOptions["resolveReference"]> {
  return (target, kind) => {
    const matches = references.filter((reference) => (!kind || reference.kind === kind) && reference.label.toLocaleLowerCase() === target.trim().toLocaleLowerCase());
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return { candidates: matches };
    return null;
  };
}
export type MarkdownWarning = { code: string; message: string };
export const WRITTEN_FORM_MAX_INPUT_LENGTH = 200_000;
/** The plain refusal for text over the cap: names the limit, says why special characters count for more, and gives the length when known. */
export const inputTooLongMessage = (length?: number) => `This text is too long to save. The limit is ${WRITTEN_FORM_MAX_INPUT_LENGTH.toLocaleString("en-US")} characters, and special characters such as _ * [ ] ( ) and \\ take extra room when saved, so text close to the limit may not fit.${length ? ` This text needs ${length.toLocaleString("en-US")} characters.` : ""} Shorten it or split it.`;
export const WRITTEN_FORM_CODE_LANGUAGES = new Set(["javascript", "typescript", "python", "json", "html", "css", "diff", "text", "mermaid"]);
const writtenNodes = new Set(["paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "listItem", "horizontalRule", "hardBreak", "text", "table", "tableRow", "tableHeader", "tableCell", "taskList", "taskItem", "callout", "assetImage", "mention"]);
const writtenMarks = new Set(["bold", "italic", "strike", "code", "link", "underline", "textStyle", "highlight", "subscript", "superscript"]);
function sanitizeWfBlock(value: unknown, warnings: Set<string>): Node | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) { warnings.add("unsupported"); return null; }
  const node = value as Node;
  if (!writtenNodes.has(node.type ?? "")) { warnings.add("unsupported"); return null; }
  if (node.type === "codeBlock" && node.attrs?.language != null && !WRITTEN_FORM_CODE_LANGUAGES.has(String(node.attrs.language).toLowerCase())) {
    warnings.add("language"); node.attrs = { ...node.attrs, language: null };
  }
  if (node.type === "callout" && node.attrs) {
    if (node.attrs.color != null && !isWrittenFormColor(node.attrs.color)) { warnings.add("color"); node.attrs = { ...node.attrs, color: null }; }
    if (node.attrs.icon != null && !writtenFormCalloutIcons.includes(node.attrs.icon as typeof writtenFormCalloutIcons[number])) { warnings.add("icon"); node.attrs = { ...node.attrs, icon: "💡" }; }
  }
  if (node.type === "text" && typeof node.text !== "string") { warnings.add("unsupported"); return null; }
  if (node.marks) node.marks = node.marks.filter((mark) => {
    if (!writtenMarks.has(mark.type)) { warnings.add("unsupported"); return false; }
    if (mark.type === "link") {
      const { kind, targetId } = mark.attrs ?? {};
      // An internal reference is trusted only when its href is exactly the canonical one built from its own kind and target.
      if (kind != null || targetId != null) {
        const canonical = ["work-item", "page", "wiki"].includes(String(kind)) && typeof targetId === "string" && targetId !== "" && mark.attrs?.href === `weft://${kind}/${targetId}`;
        if (!canonical) { warnings.add("link"); return false; }
      } else if (!safeHref(String(mark.attrs?.href ?? ""))) { warnings.add("link"); return false; }
    }
    if ((mark.type === "textStyle" || mark.type === "highlight") && mark.attrs?.color != null && !isWrittenFormColor(mark.attrs.color)) { warnings.add("color"); return false; }
    return true;
  });
  if (node.content) node.content = node.content.flatMap((child) => {
    const clean = sanitizeWfBlock(child, warnings);
    return clean ? [clean] : [];
  });
  return node;
}

/** Only web, mail and relative links reach the wiki; embedded whitespace cannot disguise an unsafe scheme. */
const safeHref = (url: string) => isAllowedLinkHref(url);

const parser = unified().use(remarkParse).use(remarkGfm);
const decodeField = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

/** Plain text of a Markdown subtree, markers dropped. */
function plain(node: RootContent | PhrasingContent): string {
  if ("value" in node) return node.value;
  if ("alt" in node && node.type === "image") return node.alt ?? "";
  return "children" in node ? (node.children as RootContent[]).map(plain).join("") : "";
}

function inline(nodes: PhrasingContent[], marks: Mark[] = [], preserveUnsupportedSource = false, options: MarkdownOptions = {}): Node[] {
  const output: Node[] = [];
  let active = [...marks];
  const closingBudget = new Map<string, number>();
  for (const node of nodes) if (node.type === "html") for (const match of node.value.matchAll(/<\/(u|sub|sup|span|mark)\s*>/gi)) {
    const key = match[1]!.toLowerCase(); closingBudget.set(key, (closingBudget.get(key) ?? 0) + 1);
  }
  const text = (value: string, appliedMarks = active) => {
    value = value.replace(/\u2060/g, "");
    if (!value) return;
    const markedWhitespace = appliedMarks.length > 0 && !appliedMarks.some((mark) => mark.type === "code");
    const leading = markedWhitespace ? value.match(/^\s*/)?.[0] ?? "" : "";
    const trailing = markedWhitespace && value.length > leading.length ? value.match(/\s*$/)?.[0] ?? "" : "";
    const core = value.slice(leading.length, value.length - trailing.length);
    if (leading) output.push({ type: "text", text: leading });
    if (core) output.push({ type: "text", text: core, ...(appliedMarks.length ? { marks: [...appliedMarks] } : {}) });
    if (trailing) output.push({ type: "text", text: trailing });
    if (!leading && !core && !trailing) output.push({ type: "text", text: value, ...(appliedMarks.length ? { marks: [...appliedMarks] } : {}) });
  };
  const addText = (value: string) => {
    value = value.replace(/[\uE200\uE201]/g, "");
    if (value.includes("==")) {
      for (const part of value.split(/(==)/)) {
        if (part !== "==") addText(part);
        else { const index = active.map((mark) => mark.type).lastIndexOf("highlight"); if (index >= 0) active.splice(index, 1); else active.push({ type: "highlight" }); }
      }
      return;
    }
    const pattern = /(!\[\[(?:asset:)?([^\]|]*)(?:\|([^\]]+))?\]\]|@\{([^{}]*)\}|(?<![A-Z0-9_])([A-Z][A-Z0-9]{1,11}-\d+)(?![A-Z0-9_-])|(?<!!)(\[\[([^\]|]*)(?:\|([^\]]+))?\]\]))/g;
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      const at = match.index!; text(value.slice(offset, at));
      if (match[1]?.startsWith("![[")) output.push({ type: "assetImage", attrs: { assetId: match[2]?.trim() ? decodeField(match[2].trim()) : null, alt: match[3] ? decodeField(match[3]) : null } });
      else if (match[4] !== undefined) {
        const token = match[4], separator = token.lastIndexOf("|"), rawLabel = (separator < 0 ? token.trim() : token.slice(0, separator)).replace(/\\([|}\]])/g, "$1").replace(/\u2060/g, ""), label = rawLabel.includes("%") ? decodeField(rawLabel) : rawLabel, id = separator < 0 ? token.trim() : token.slice(separator + 1).trim();
        output.push({ type: "mention", attrs: { id: id || null, label: label || id || null } });
      } else if (match[5] || match[7]) {
        const identity = match[8]?.trim();
        const explicit = identity?.match(/^(work-item|page|wiki):(.+)$/i);
        const decodedTarget = decodeField(match[7] !== undefined ? match[7] : match[5]!);
        const target = explicit ? decodedTarget : decodedTarget.trim();
        const explicitResolution = explicit ? options.resolveReference?.(target, explicit[1]!.toLowerCase() as ReferenceKind) : null;
        const resolved = explicit
          ? !options.resolveReference ? { kind: explicit[1]!.toLowerCase() as ReferenceKind, id: explicit[2]!, label: target }
            : explicitResolution && !("candidates" in explicitResolution) && explicitResolution.id === explicit[2] ? explicitResolution
              : options.preserveStableReferences || options.existingStableReferences?.includes(`${explicit[1]!.toLowerCase()}:${explicit[2]!.toLowerCase()}`) ? { kind: explicit[1]!.toLowerCase() as ReferenceKind, id: explicit[2]!, label: target } : null
          : options.resolveReference?.(target, /^[A-Z][A-Z0-9]{1,11}-\d+$/.test(target) ? "work-item" : undefined);
        if (resolved && "candidates" in resolved) throw new Error(`Ambiguous Markdown reference "${target}". Candidates: ${resolved.candidates.map((candidate) => `${candidate.kind} ${candidate.id}`).join(", ")}`);
        if (resolved) text(target, [...active, { type: "link", attrs: { href: `weft://${resolved.kind}/${resolved.id}`, kind: resolved.kind, targetId: resolved.id, target } }]);
        else if (match[5]) text(match[0]);
        else if (options.preserveUnresolvedReferences) text(match[0]);
        else if (options.resolveReference) throw new Error(`Markdown reference "${target}" did not match an accessible work item, Page, or Wiki page. Candidates: none.`);
        else text(match[0]);
      } else {
        const target = match[6]!;
        const resolved = options.resolveReference?.(target, "work-item");
        if (resolved && "candidates" in resolved) throw new Error(`Ambiguous Markdown reference "${target}". Candidates: ${resolved.candidates.map((candidate) => `${candidate.kind} ${candidate.id}`).join(", ")}`);
        if (resolved) output.push({ type: "text", text: resolved.label, marks: [...active, { type: "link", attrs: { href: `weft://work-item/${resolved.id}`, kind: "work-item", targetId: resolved.id, target: resolved.label } }] });
        else text(match[0]);
      }
      offset = at + match[0].length;
    }
    text(value.slice(offset));
  };
  for (const node of nodes) {
    if (node.type === "html") {
      const htmlParts = node.value.split(/(<\/?(?:u|sub|sup|span|mark|br)\b[^>]*>)/gi);
      for (const part of htmlParts) {
        if (/^<br\s*\/?\s*>$/i.test(part.trim())) { output.push({ type: "hardBreak" }); continue; }
        const tag = part.trim().match(/^<(\/)?(u|sub|sup|span|mark)\b([^>]*)>$/i);
        if (!tag) {
          if (!/[<>]/.test(part) && /(?:\*\*|__|~~|\[[^\]]+\]\()/.test(part)) {
            const parsed = parser.parse(part) as Root;
            for (const child of parsed.children) if (child.type === "paragraph") output.push(...inline(child.children, active, preserveUnsupportedSource, options));
            else addText(part);
          } else addText(part);
          continue;
        }
        const closing = !!tag[1], name = tag[2]!.toLowerCase();
        const color = name === "span" ? tag[3]!.match(/^\s+style\s*=\s*(["'])\s*color\s*:\s*(#[\da-f]{3,8}|[a-z]+)\s*;?\s*\1\s*$/i)?.[2] : name === "mark" ? tag[3]!.match(/^\s+data-color\s*=\s*(["'])(#[\da-f]{3,8}|[a-z]+)\1\s*$/i)?.[2] : undefined;
        const markType = name === "span" ? "textStyle" : name === "mark" ? "highlight" : name === "u" ? "underline" : name === "sub" ? "subscript" : "superscript";
        const allowed = closing ? active.some((mark) => mark.type === markType) : name === "span" || name === "mark"
          ? isWrittenFormColor(color)
          : !tag[3]!.trim();
        if (allowed) {
          if (closing) {
            const index = active.map((mark) => mark.type).lastIndexOf(markType);
            if (index >= 0) { active.splice(index, 1); continue; }
            closingBudget.set(name, Math.max(0, (closingBudget.get(name) ?? 0) - 1));
          }
          else if ((closingBudget.get(name) ?? 0) > 0) {
            closingBudget.set(name, closingBudget.get(name)! - 1);
            active.push({ type: markType, ...(["span", "mark"].includes(name) ? { attrs: { color: color!.toLowerCase() } } : {}) });
            continue;
          } else { addText(part); continue; }
        }
        addText(part);
      }
      continue;
    }
    switch (node.type) {
      case "text": addText(node.value); break;
      case "strong": output.push(...inline(node.children, [...active, { type: "bold" }], preserveUnsupportedSource, options)); break;
      case "emphasis": output.push(...inline(node.children, [...active, { type: "italic" }], preserveUnsupportedSource, options)); break;
      case "delete": output.push(...inline(node.children, [...active, { type: "strike" }], preserveUnsupportedSource, options)); break;
      case "inlineCode": if (node.value) output.push({ type: "text", text: node.value.replace(/[\uE200\uE201]/g, ""), marks: [{ type: "code" }] }); break;
      case "link": output.push(...(safeHref(node.url) ? inline(node.children, [...active, { type: "link", attrs: { href: node.url } }], preserveUnsupportedSource, options) : preserveUnsupportedSource ? [{ type: "text", text: `[${plain(node)}](${node.url})`, ...(active.length ? { marks: active } : {}) }] : inline(node.children, active, preserveUnsupportedSource, options))); break;
      case "image": output.push(...(preserveUnsupportedSource ? [{ type: "text", text: `![${node.alt ?? ""}](${node.url})` }] : [{ type: "text", text: node.alt ?? "" }])); break;
      case "break": output.push({ type: "hardBreak" }); break;
      default: addText(plain(node));
    }
  }
  return output;
}

function paragraph(nodes: PhrasingContent[], preserveUnsupportedSource = false, options: MarkdownOptions = {}): Node {
  if (nodes.length === 1 && nodes[0]?.type === "html" && /^<!--\s*empty paragraph\s*-->$/i.test(nodes[0].value.trim())) return { type: "paragraph" };
  const content = inline(nodes, [], preserveUnsupportedSource, options);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

function blocks(nodes: RootContent[], preserveUnsupportedSource = false, options: MarkdownOptions = {}, warnings = new Set<string>()): Node[] {
  return nodes.flatMap((node): Node[] => {
    switch (node.type) {
      case "paragraph": {
        if (/^<br\s+data-empty-paragraph>$/i.test(plain(node).trim())) return [{ type: "paragraph" }];
        const content = inline(node.children, [], preserveUnsupportedSource, options);
        const result: Node[] = [];
        let text: Node[] = [];
        const flush = () => { if (text.length) result.push({ type: "paragraph", content: text }); text = []; };
        for (const part of content) {
          if (part.type === "assetImage") { flush(); result.push(part); }
          else text.push(part);
        }
        flush();
        return result.length ? result : [{ type: "paragraph" }];
      }
      case "heading": return node.depth > 6 && preserveUnsupportedSource
        ? [{ type: "paragraph", content: [{ type: "text", text: `${"#".repeat(node.depth)} ${plain(node)}` }] }]
        : [{ type: "heading", attrs: { level: Math.min(node.depth, 6) }, content: inline(node.children, [], preserveUnsupportedSource, options) }];
      case "code": return [{ type: "codeBlock", attrs: { language: node.lang ?? null }, ...(node.value ? { content: [{ type: "text", text: node.value.replace(/[\uE200\uE201]/g, "") }] } : {}) }];
      case "blockquote": {
        const firstChild = node.children[0];
        const firstText = firstChild?.type === "paragraph" ? plain(firstChild) : "";
        const callout = /^\[!([a-z][a-z0-9_-]*)(?:\|([^\]\n]+))?\](?:\n|$)/i.exec(firstText);
        if (callout) {
          // The editor's default icon is a display default: an icon is stored only when the text names one.
          const attrs: Record<string, unknown> = { type: callout[1]!.toLowerCase(), color: null };
          for (const raw of (callout[2] ?? "").split("|").filter(Boolean)) {
            const [key, ...valueParts] = raw.split("=");
            const value = valueParts.join("=");
            if (key === "color" && isWrittenFormColor(value)) attrs.color = value;
            else if (key === "icon" && writtenFormCalloutIcons.includes(value as typeof writtenFormCalloutIcons[number])) attrs.icon = value;
          }
          const bodyNodes = [...node.children];
          const first = bodyNodes[0];
          if (first?.type === "paragraph" && first.children[0]?.type === "text") {
            const marker = first.children[0].value.match(/^\[![a-z][a-z0-9_-]*(?:\|[^\]]+)?\]/i)?.[0] ?? "";
            const rest = first.children[0].value.slice(marker.length);
            first.children[0].value = rest.startsWith("\r\n") ? rest.slice(2) : rest.startsWith("\n") ? rest.slice(1) : rest.replace(/^[ \t]+/, "");
            if (!plain(first).trim()) bodyNodes.shift();
          }
          const content = blocks(bodyNodes, preserveUnsupportedSource, options, warnings);
          return [{ type: "callout", attrs, content: content.length ? content : [{ type: "paragraph" }] }];
        }
        const remaining = node.children;
        const inner = blocks(remaining, preserveUnsupportedSource, options, warnings);
        return [{ type: "blockquote", content: inner.length ? inner : [{ type: "paragraph" }] }];
      }
      case "thematicBreak": return [{ type: "horizontalRule" }];
      case "html": {
        if (/^<!--\s*empty paragraph\s*-->$/i.test(node.value.trim())) return [{ type: "paragraph" }];
        const blockMarker = /^<!--\s*wf-block:([\s\S]+?)\s*-->$/i.exec(node.value.trim());
        if (blockMarker) {
          try { const clean = sanitizeWfBlock(JSON.parse(decodeURIComponent(blockMarker[1]!)), warnings); return clean ? [clean] : []; }
          catch { warnings.add("unsupported"); return []; }
        }
        return [paragraph([{ type: "text", value: node.value }], preserveUnsupportedSource, options)];
      }
      case "list": {
        // A list item is a paragraph followed by blocks, so an item that starts with a list, code or heading gets an empty paragraph first.
        const groups: Array<{ task: boolean; items: typeof node.children }> = [];
        for (const item of node.children) {
          const task = item.checked !== null && item.checked !== undefined;
          const group = groups.at(-1);
          if (group?.task === task) group.items.push(item); else groups.push({ task, items: [item] });
        }
        return groups.map(({ task, items: source }) => {
          const items = source.map((item) => { const inner = blocks(item.children, preserveUnsupportedSource, options, warnings); return { type: task ? "taskItem" : "listItem", ...(task ? { attrs: { checked: item.checked === true } } : {}), content: inner[0]?.type === "paragraph" ? inner : [{ type: "paragraph" }, ...inner] }; });
          return task ? { type: "taskList", content: items } : node.ordered ? { type: "orderedList", attrs: { start: node.start ?? 1 }, content: items } : { type: "bulletList", content: items };
        });
      }
      case "table": {
        const expectedCells = node.children[0]?.children.length ?? 0;
        if (preserveUnsupportedSource && node.children.some((row) => row.children.length !== expectedCells)) {
          return [{ type: "paragraph", content: [{ type: "text", text: node.children.map((row) => row.children.map((cell) => cell.children.map(plain).join("")).join(" | ")).join("\n") }] }];
        }
        const columnCount = Math.max(1, ...node.children.map((row) => row.children.length));
        return [{ type: "table", content: node.children.map((row, rowIndex) => ({
          type: "tableRow",
          content: Array.from({ length: columnCount }, (_, columnIndex) => {
            const cell = row.children[columnIndex];
            const sourceChildren = cell?.children ?? [];
            const marker = sourceChildren.find((child) => child.type === "html" && /^<!--\s*wf-(cell|header)\s*-->$/i.test(child.value.trim()));
            const cellChildren = marker ? sourceChildren.filter((child) => child !== marker) : sourceChildren;
            const cellContent: Node[] = [];
            let explicitCellType: "tableCell" | "tableHeader" | null = null;
            let phrasing: PhrasingContent[] = [];
            const flushPhrasing = () => { if (phrasing.length) cellContent.push(paragraph(phrasing, preserveUnsupportedSource, options)); phrasing = []; };
            for (const child of cellChildren) {
              if (child.type === "html" && /^<br\s+data-block-break\s*\/?\s*>$/i.test(child.value.trim())) { flushPhrasing(); continue; }
              if (child.type === "html" && /^<!--\s*empty paragraph\s*-->$/i.test(child.value.trim())) { flushPhrasing(); cellContent.push({ type: "paragraph" }); continue; }
              const cellBlocksMarker = child.type === "html" ? /^<!--\s*wf-cell-blocks:(tableCell|tableHeader):([\s\S]+?)\s*-->$/i.exec(child.value.trim()) : null;
              if (cellBlocksMarker) {
                flushPhrasing();
                explicitCellType = cellBlocksMarker[1]!.toLowerCase() === "tableheader" ? "tableHeader" : "tableCell";
                try {
                  const decoded = JSON.parse(decodeURIComponent(cellBlocksMarker[2]!));
                  if (!Array.isArray(decoded)) throw new Error("Invalid table blocks");
                  for (const block of decoded) { const clean = sanitizeWfBlock(block, warnings); if (clean) cellContent.push(clean); }
                } catch { warnings.add("unsupported"); }
                continue;
              }
              const blockMarker = child.type === "html" ? /^<!--\s*wf-block:([\s\S]+?)\s*-->$/i.exec(child.value.trim()) : null;
              if (blockMarker) {
                flushPhrasing();
                try { const decoded = JSON.parse(decodeURIComponent(blockMarker[1]!)); const clean = sanitizeWfBlock(decoded, warnings); if (clean) cellContent.push(clean); }
                catch { cellContent.push({ type: "paragraph", content: [{ type: "text", text: child.type === "html" ? child.value : plain(child) }] }); }
                continue;
              }
              phrasing.push(child as PhrasingContent);
            }
            flushPhrasing();
            return {
              type: explicitCellType ?? (marker?.type === "html" && /wf-cell/i.test(marker.value) || rowIndex > 0 && marker?.type === "html" && /wf-header/i.test(marker.value) ? (marker.value.match(/wf-(cell|header)/i)?.[1] === "cell" ? "tableCell" : "tableHeader") : rowIndex === 0 ? "tableHeader" : "tableCell"),
              content: cell ? cellContent.length ? cellContent : [{ type: "paragraph" }] : [{ type: "paragraph" }],
            };
          }),
        })) }];
      }
      // Raw HTML and anything else the editor lacks: its text, one paragraph per row/line.
      default: { const text = plain(node); return text.trim() ? text.split(/\n+/).filter((l) => l.trim()).map((l) => paragraph([{ type: "text", value: l }], preserveUnsupportedSource, options)) : []; }
    }
  });
}

/** The document of a stored row: validated when written, so never refused by the write caps and never blank. */
export function storedMarkdownToDoc(text: string, options: MarkdownOptions = {}): { type: "doc"; content: Node[] } {
  return markdownToDocWithWarnings(text, { ...options, storedRead: true }).document;
}

/** AI answer Markdown to the wiki editor's (TipTap) document JSON. Never throws on unsupported nodes. */
export function markdownToDoc(text: string, options: MarkdownOptions = {}): { type: "doc"; content: Node[] } {
  return markdownToDocWithWarnings(text, options).document;
}

function guardedDocument(message: string, code: "nesting-too-deep" | "input-too-complex" | "input-too-long") {
  return { document: { type: "doc" as const, content: [{ type: "paragraph" as const }] }, warnings: [message], warningDetails: [{ code, message }] };
}

/** Reference openers (`[[`) in one text: each one is resolved, and a text dense with them parses very slowly, so there is a plain limit that is checked before any parse. */
export const WRITTEN_FORM_MAX_REFERENCES = 2_000;
export const WRITTEN_FORM_TOO_MANY_REFERENCES = `This text has too many [[ brackets (more than ${WRITTEN_FORM_MAX_REFERENCES.toLocaleString("en-US")}; references and links to other items use them). Remove some or split it.`;
export function tooManyReferences(text: string) {
  let count = 0;
  for (let at = text.indexOf("[["); at >= 0; at = text.indexOf("[[", at + 2)) if (++count > WRITTEN_FORM_MAX_REFERENCES) return true;
  return false;
}
function preflightWrittenForm(text: string, trusted: boolean): "nesting-too-deep" | "input-too-complex" | "table-too-large" | "too-many-references" | null {
  return scanWrittenFormNesting(text) ?? scanWrittenFormTables(text) ?? (trusted ? null : tooManyReferences(text) ? "too-many-references" : scanWrittenFormDelimiters(text));
}

/** Larger than any accepted write; only guards against parsing something that was never written through the converter. */
export const WRITTEN_FORM_STORED_READ_LIMIT = 1_000_000;
export const rawTextDocument = (text: string) => ({ document: { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text }] }] as Node[] }, warnings: [] as string[], warningDetails: [{ code: "stored-text-unparsed", message: "This stored text is shown as plain text." }] as MarkdownWarning[] });

export function markdownToDocWithWarnings(text: string, options: MarkdownOptions = {}): { document: { type: "doc"; content: Node[] }; warnings: string[]; warningDetails: MarkdownWarning[] } {
  if (options.storedRead) {
    if (!text) return markdownToDocWithWarnings(text, { ...options, storedRead: false, trustedSource: true });
    if (text.length > WRITTEN_FORM_STORED_READ_LIMIT) return rawTextDocument(text);
    const parsed = markdownToDocWithWarnings(text, { ...options, storedRead: false, trustedSource: true, noLengthCap: true });
    return parsed.warningDetails.some(({ code }) => ["input-too-long", "input-too-complex", "nesting-too-deep"].includes(code)) ? rawTextDocument(text) : parsed;
  }
  // Serialised Written form is a few percent longer than the text it came from, so trusted parse-back gets 25% headroom.
  if (!options.noLengthCap && text.length > (options.trustedSource ? Math.floor(WRITTEN_FORM_MAX_INPUT_LENGTH * 1.25) : WRITTEN_FORM_MAX_INPUT_LENGTH)) return guardedDocument("This text is too long to save. Shorten it or split it.", "input-too-long");
  const preflight = preflightWrittenForm(text, options.trustedSource === true);
  if (preflight) return guardedDocument(preflight === "nesting-too-deep" ? `This text is nested too deeply to save safely; reduce the nesting below ${WRITTEN_FORM_MAX_NESTING_DEPTH} levels.` : preflight === "table-too-large" ? WRITTEN_FORM_TABLE_TOO_LARGE : preflight === "too-many-references" ? WRITTEN_FORM_TOO_MANY_REFERENCES : "This text is too complex to save. Shorten it or split it.", preflight === "table-too-large" || preflight === "too-many-references" ? "input-too-complex" : preflight);
  try { return parseMarkdownToDocWithWarnings(text, options); }
  catch (error) {
    if (error instanceof RangeError) return guardedDocument(`This text is nested too deeply to save safely; reduce the nesting below ${WRITTEN_FORM_MAX_NESTING_DEPTH} levels.`, "nesting-too-deep");
    throw error;
  }
}

/** Counts real remark parses, so tests can prove that list endpoints do bounded work. */
export const markdownParseStats = { parses: 0 };

function parseMarkdownToDocWithWarnings(text: string, options: MarkdownOptions = {}): { document: { type: "doc"; content: Node[] }; warnings: string[]; warningDetails: MarkdownWarning[] } {
  // Private-use characters are ordinary text and are never converter instructions.
  markdownParseStats.parses++;
  const tree = parser.parse(text) as Root;
  const preserveLiteralAutolinks = (node: any) => {
    // An autolink the parser built from already-decoded text (escapes in the source) has no position; its text is exactly the literal text.
    if (node.type === "link" && node.position?.start.offset == null) {
      node.type = "text"; node.value = (node.children ?? []).map((child: { value?: string }) => child.value ?? "").join(""); delete node.url; delete node.title; delete node.children;
      return;
    }
    if (node.type === "link" && node.position?.start.offset != null && node.position.end.offset != null) {
      const raw = text.slice(node.position.start.offset, node.position.end.offset);
      if (!raw.startsWith("[") && !raw.startsWith("<")) {
        // The writer backslash-escapes punctuation (or uses a numeric entity) inside literal URLs and e-mail addresses; the text is what those escapes stand for.
        node.type = "text"; node.value = raw.replace(/\\([!-\/:-@\[-`{-~])|&#(\d+);|&#x([\da-f]+);/gi, (_match, punctuation, decimal, hex) => punctuation ?? String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex, 16))); delete node.url; delete node.title; delete node.children;
        return;
      }
    }
    node.children?.forEach(preserveLiteralAutolinks);
  };
  preserveLiteralAutolinks(tree);
  let tooDeep = false;
  const measureDepth = (node: { type: string; children?: Array<any> }, depth: number) => {
    const next = depth + (node.type === "blockquote" || node.type === "list" ? 1 : 0);
    if (next > WRITTEN_FORM_MAX_NESTING_DEPTH) tooDeep = true;
    node.children?.forEach((child) => measureDepth(child, next));
  };
  measureDepth(tree, 0);
  if (tooDeep) return { document: { type: "doc", content: [{ type: "paragraph" }] }, warnings: [`This text is nested too deeply to save safely; reduce the nesting below ${WRITTEN_FORM_MAX_NESTING_DEPTH} levels.`], warningDetails: [{ code: "nesting-too-deep", message: `This text is nested too deeply to save safely; reduce the nesting below ${WRITTEN_FORM_MAX_NESTING_DEPTH} levels.` }] };
  const warningKinds = new Set<string>();
  if (/\]\(\s*<?(?:\/\\|\\\\)/.test(text)) warningKinds.add("link");
  const known = new Set(["root", "paragraph", "heading", "code", "blockquote", "thematicBreak", "list", "listItem", "table", "text", "strong", "emphasis", "delete", "inlineCode", "link", "break", "html", "tableRow", "tableCell", "tableHeader"]);
  const inspect = (node: { type: string; depth?: number; url?: string; value?: string; children?: Array<any> }) => {
    if (!known.has(node.type)) warningKinds.add(node.type);
    if (node.type === "image") warningKinds.add("image");
    if (node.type === "link" && !safeHref(node.url ?? "")) warningKinds.add("link");
    if (node.type === "text" && [...(node.value ?? "").matchAll(/\]\((?:<([\s\S]*?)>|([^)]*))\)/g)].some((match) => !safeHref(match[1] ?? match[2] ?? ""))) warningKinds.add("link");
    if (node.type === "blockquote") {
      const callout = /^\[![a-z][a-z0-9_-]*(?:\|([^\]\n]+))?\]/i.exec(node.children?.map(plain).join("\n") ?? "");
      if (callout?.[1]) {
        const seen = new Set<string>();
        for (const raw of callout[1].split("|")) {
          const [key, ...valueParts] = raw.split("=");
          const value = valueParts.join("=");
          const valid = key === "color" ? isWrittenFormColor(value) : key === "icon" ? writtenFormCalloutIcons.includes(value as typeof writtenFormCalloutIcons[number]) : false;
          if (!valid || seen.has(key!)) warningKinds.add("callout");
          seen.add(key!);
        }
      }
    }
    if (node.type === "text" && [...(node.value ?? "").matchAll(/(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)].some((match) => {
      const target = match[1]!.trim(), identity = match[2]?.trim() ?? "";
      const explicit = /^(work-item|page|wiki):([^\s|]+)$/i.exec(identity);
      if (explicit) {
        if (options.preserveStableReferences || options.existingStableReferences?.includes(`${explicit[1]!.toLowerCase()}:${explicit[2]!.toLowerCase()}`)) return false;
        if (!options.resolveReference) return false;
        const resolution = options.resolveReference(target, explicit[1]!.toLowerCase() as ReferenceKind);
        return !resolution || "candidates" in resolution || resolution.id !== explicit[2];
      }
      if (!options.resolveReference) return true;
      const kind = /^[A-Z][A-Z0-9]{1,11}-\d+$/.test(target) ? "work-item" : undefined;
      const resolution = options.resolveReference(target, kind);
      return !resolution || "candidates" in resolution;
    })) warningKinds.add("reference");
    if (node.type === "heading" && (node.depth ?? 1) > 6) warningKinds.add("heading");
    if (node.type === "table" && node.children?.some((row) => row.children?.length !== node.children?.[0]?.children?.length)) warningKinds.add("table");
    node.children?.forEach(inspect);
  };
  tree.children.forEach(inspect);
  const allowedTags = /<!--\s*(?:empty paragraph|wf-(?:cell|header)|wf-cell-blocks:[\s\S]*?|wf-block:[\s\S]*?)\s*-->|<br\s+(?:data-block-break\s*)?\/?\s*>|<br\s*\/?\s*>|<\/?(?:u|sub|sup)\s*>|<span\s+style\s*=\s*(["'])\s*color\s*:\s*(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|red|orange|yellow|green|blue|purple|gray|black|white)\s*;?\s*\1\s*>|<\/span\s*>|<mark\s+data-color\s*=\s*(["'])(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|red|orange|yellow|green|blue|purple|gray|black|white)\2\s*>|<\/mark\s*>/gi;
  const originalTags = withoutFencedCode(text).replace(/\]\(<[^>]*>\)/g, "").match(/<[^>]*>/g) ?? [];
  if (originalTags.some((tag) => { allowedTags.lastIndex = 0; return !allowedTags.test(tag); })) warningKinds.add("html");
  const pairedTagNames = ["u", "sub", "sup", "span", "mark"];
  if (pairedTagNames.some((name) => {
    const opening = originalTags.filter((tag) => new RegExp(`^<${name}\\b`, "i").test(tag)).length;
    const closing = originalTags.filter((tag) => new RegExp(`^</${name}\\s*>$`, "i").test(tag)).length;
    return opening !== closing;
  })) warningKinds.add("html");
  if (options.preserveUnresolvedReferences && /^ {0,3}#{7,}(?:\s|$)/m.test(text)) warningKinds.add("heading");
  if (options.preserveUnresolvedReferences) for (const match of text.matchAll(/(?<!!)\[\[([^\]|]*)(?:\|([^\]]+))?\]\]/g)) {
    const identity = match[2]?.trim() ?? "";
    if (!/^(?:work-item|page|wiki):[^\s|]+$/i.test(identity)) {
      const target = match[1]!.trim();
      const kind = /^[A-Z][A-Z0-9]{1,11}-\d+$/.test(target) ? "work-item" : undefined;
      const resolution = options.resolveReference?.(target, kind);
      if (!resolution || "candidates" in resolution) warningKinds.add("reference");
    }
  }
  const content = blocks(tree.children, options.preserveUnresolvedReferences, options, warningKinds);
  const explanations: Record<string, string> = {
    html: "Some HTML in your text was kept as plain text.",
    image: "An external image was kept as plain text; upload it as a Weft image to embed it.",
    link: "An unsafe link was removed; its text was kept.",
    reference: "This reference couldn't be matched, so it was kept as plain text.",
    table: "This table was kept as plain text because its rows have different numbers of cells.",
    heading: "This heading was kept as plain text because the editor supports up to six levels.",
    callout: "An unsupported callout color, icon, or option was removed.",
    unsupported: "A table cell block with unsupported content was omitted.",
    language: "An unsupported code language was removed; the code text was kept.",
    color: "An unsupported color was removed; the text was kept.",
    icon: "An unsupported callout icon was removed.",
  };
  const warningCodes: Record<string, string> = { html: "unsupported-html", image: "external-image", link: "unsafe-link", reference: "unresolved-reference", table: "irregular-table", heading: "deep-heading", callout: "unsupported-callout-metadata", unsupported: "unsupported-markdown", language: "unsupported-code-language", color: "unsafe-color", icon: "unsupported-callout-metadata" };
  const warningDetails = [...warningKinds].sort().map((kind) => ({
    code: warningCodes[kind] ?? "unsupported-markdown",
    message: explanations[kind] ?? "Some formatting was simplified; the text was kept.",
  }));
  return {
    document: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] },
    warnings: warningDetails.map(({ message }) => message), warningDetails,
  };
}

/** First non-empty line of the answer without Markdown markers, capped at 120 characters. */
export function markdownTitle(text: string): string {
  const tree = parser.parse(text) as Root;
  const first = tree.children.map((n) => plain(n).split("\n").find((l) => l.trim())?.trim() ?? "").find(Boolean) ?? "";
  return first.slice(0, 120);
}
