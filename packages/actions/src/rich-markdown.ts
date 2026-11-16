import { ActionError } from "./members";
import { getSchema } from "@tiptap/core";
import { markdownToDocWithWarnings, type MarkdownOptions, WRITTEN_FORM_CODE_LANGUAGES, WRITTEN_FORM_MAX_INPUT_LENGTH, inputTooLongMessage } from "./markdown-doc";
import { wikiEditorExtensions } from "./wiki-editor-extensions";
import { richTextMarkdown, writtenFormAttributePolicy } from "./written-form";
import { isAllowedLinkHref, isWrittenFormColor, writtenFormCalloutIcons } from "./written-form-attributes";

type WrittenNode = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>; content?: WrittenNode[] };
type PreparedWrittenForm = { document: unknown; markdown: string; warnings: string[]; warningDetails: Array<{ code: string; message: string }> };
type WrittenStorage = "verbatim" | "derived";
type PreparedWrittenFormPolicy = { allowPreservedImportWarnings?: boolean };
const editorSchema = getSchema(wikiEditorExtensions);
const privateUse = /[\uE200\uE201]/g;

function sanitizeDocument(value: unknown): unknown {
  if (typeof value === "string") return value.replace(privateUse, "");
  if (Array.isArray(value)) return value.map(sanitizeDocument);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeDocument(child)]));
}

function resolveDocumentReferences(document: unknown, options: MarkdownOptions): unknown {
  const resolveReference = options.resolveReference;
  if (!resolveReference || !document || typeof document !== "object") return document;
  const visit = (node: WrittenNode, inCode = false): WrittenNode | WrittenNode[] => {
    const code = inCode || node.type === "codeBlock" || node.marks?.some((mark) => mark.type === "code") === true;
    if (node.type === "text" && typeof node.text === "string" && !code && !node.marks?.some((mark) => mark.type === "link")) {
      const pattern = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(?<![A-Z0-9_])([A-Z][A-Z0-9]{1,11}-\d+)(?![A-Z0-9_-])/g;
      const output: WrittenNode[] = [];
      let offset = 0;
      for (const match of node.text.matchAll(pattern)) {
        const start = match.index!;
        if (start > offset) output.push({ ...node, text: node.text.slice(offset, start) });
        const label = (match[1] ?? match[3]!).trim();
        const identity = match[2]?.trim();
        const explicit = identity?.match(/^(work-item|page|wiki):(.+)$/i);
        const kind = (explicit?.[1]?.toLowerCase() as "work-item" | "page" | "wiki" | undefined) ?? (match[3] ? "work-item" : undefined);
        const resolved = explicit ? { kind, id: explicit[2]!, label } : resolveReference(label, kind);
        if (resolved && "candidates" in resolved) throw new ActionError("Ambiguous Markdown reference \"" + label + "\". Candidates: " + resolved.candidates.map((candidate) => candidate.kind + " " + candidate.id).join(", "), 400);
        if (!resolved) {
          if (match[3]) output.push({ ...node, text: match[0] });
          else if (options.preserveUnresolvedReferences) output.push({ ...node, text: match[0] });
          else throw new ActionError("Markdown reference \"" + label + "\" did not match an accessible work item, Page, or Wiki page. Candidates: none.", 400);
        } else output.push({ type: "text", text: label, marks: [...(node.marks ?? []), { type: "link", attrs: { href: "weft://" + resolved.kind + "/" + resolved.id, kind: resolved.kind, targetId: resolved.id, target: label } }] });
        offset = start + match[0].length;
      }
      if (!output.length) return node;
      if (offset < node.text.length) output.push({ ...node, text: node.text.slice(offset) });
      return output;
    }
    if (!node.content?.length) return node;
    return { ...node, content: node.content.flatMap((child) => {
      const converted = visit(child, code);
      return Array.isArray(converted) ? converted : [converted];
    }) };
  };
  return visit(document as WrittenNode) as unknown;
}

export function normalizeRichTextDocument(document: unknown): unknown {
  const candidate = document && typeof document === "object" && (document as WrittenNode).type === "doc" && !(document as WrittenNode).content?.length
    ? { ...(document as WrittenNode), content: [{ type: "paragraph" }] }
    : document;
  const source = editorSchema.nodeFromJSON(candidate).toJSON() as WrittenNode;
  const normalize = (node: WrittenNode): WrittenNode | WrittenNode[] | null => {
    if (node.type === "text" && !node.text) return null;
    if (node.type === "mention" && node.attrs?.id == null && node.attrs?.label == null) return null;
    const effectiveMarks = node.marks?.filter((mark) => !(mark.type === "link" && mark.attrs?.href == null && mark.attrs?.kind == null && mark.attrs?.targetId == null) && !(mark.type === "link" && !mark.attrs?.kind && !mark.attrs?.targetId && !isAllowedLinkHref(mark.attrs?.href)) && !(mark.type === "textStyle" && mark.attrs?.color == null));
    const normalizeMark = (mark: NonNullable<WrittenNode["marks"]>[number]) => {
      const markAttrs = mark.attrs ? Object.fromEntries(Object.entries(mark.attrs).filter(([name]) => writtenFormAttributePolicy[`mark:${mark.type}.${name}`]?.persisted !== false || mark.type === "link" && name === "target" && !!mark.attrs?.kind && !!mark.attrs?.targetId)) : undefined;
      const normalizedAttrs = markAttrs && typeof markAttrs.href === "string" ? { ...markAttrs, href: markAttrs.href.replace(/</g, "%3C").replace(/>/g, "%3E") } : markAttrs;
      return mark.type === "link" && typeof normalizedAttrs?.target === "string" ? { ...mark, attrs: { ...normalizedAttrs, target: normalizedAttrs.target.trim() } } : { ...mark, ...(normalizedAttrs ? { attrs: normalizedAttrs } : {}) };
    };
    if (node.type === "text" && effectiveMarks?.length && !effectiveMarks.some((mark) => mark.type === "code")) {
      const text = node.text ?? "";
      const leading = text.match(/^\s*/)?.[0] ?? "";
      const trailing = text.length > leading.length ? text.match(/\s*$/)?.[0] ?? "" : "";
      const core = text.slice(leading.length, text.length - trailing.length);
      const marks = effectiveMarks.map(normalizeMark);
      if (leading || trailing) return [
        ...(leading ? [{ type: "text", text: leading }] : []),
        ...(core ? [{ ...node, text: core, marks }] : []),
        ...(trailing ? [{ type: "text", text: trailing }] : []),
      ];
    }
    const content = (node.content ?? []).flatMap((child) => {
      const value = normalize(child);
      return Array.isArray(value) ? value : value ? [value] : [];
    });
    const merged: WrittenNode[] = [];
    for (const child of content) {
      const previous = merged.at(-1);
      if (child.type === "text" && previous?.type === "text" && JSON.stringify(child.marks ?? []) === JSON.stringify(previous.marks ?? [])) previous.text = (previous.text ?? "") + (child.text ?? "");
      else if (previous && ["bulletList", "orderedList", "taskList"].includes(child.type ?? "") && previous.type === child.type && JSON.stringify(previous.attrs ?? {}) === JSON.stringify(child.attrs ?? {})) previous.content = [...(previous.content ?? []), ...(child.content ?? [])];
      else merged.push(child);
    }
    let attrs = node.type === "mention" && node.attrs?.label === node.attrs?.id ? { ...node.attrs, label: null } : node.attrs;
    if (attrs) attrs = Object.fromEntries(Object.entries(attrs).filter(([name]) => writtenFormAttributePolicy[`node:${node.type}.${name}`]?.persisted !== false));
    // The default callout icon and an absent colour are display defaults, the same whether stored or not.
    if (attrs && node.type === "callout") { const { icon, color, ...rest } = attrs; attrs = { ...rest, ...(icon && icon !== "💡" ? { icon } : {}), ...(color ? { color } : {}) }; }
    if (attrs && !Object.keys(attrs).length) attrs = undefined;
    const marks = effectiveMarks?.map(normalizeMark);
    // CodeBlockLowlight uses javascript as the editor default, while Markdown's
    // unlabeled fence parses as null. These spellings all mean an unlabeled block.
    if (node.type === "codeBlock" && attrs && [null, "", "javascript"].includes(attrs.language as string | null)) attrs = { ...attrs, language: null };
    const { attrs: _sourceAttrs, ...nodeWithoutAttrs } = node;
    return { ...nodeWithoutAttrs, ...(attrs ? { attrs } : {}), ...(marks?.length ? { marks } : marks ? { marks: undefined } : {}), ...(node.content ? { content: merged } : {}) };
  };
  return normalize(source);
}

const structureMessages = {
  "task-state-simplified": "A task's checked or unchecked state was not kept exactly as set.",
  "table-header-simplified": "Which table cells are headers was changed when saved.",
  "code-language-simplified": "A code block's language was changed when saved.",
  "list-start-simplified": "The starting number of a numbered list was changed when saved.",
  "callout-type-simplified": "A callout's type was changed when saved.",
  "image-alt-simplified": "An image's description (alt text) was not kept.",
} as const;
type StructureWarningCode = keyof typeof structureMessages;
const normalizedLanguage = (value: unknown) => value === null || value === undefined || value === "" || value === "javascript" ? null : value;
function structureFeatures(document: unknown) {
  const features: Record<StructureWarningCode, unknown[]> = { "task-state-simplified": [], "table-header-simplified": [], "code-language-simplified": [], "list-start-simplified": [], "callout-type-simplified": [], "image-alt-simplified": [] };
  const visit = (node: WrittenNode) => {
    if (node.type === "taskItem") features["task-state-simplified"].push(node.attrs?.checked === true);
    else if (node.type === "tableCell" || node.type === "tableHeader") features["table-header-simplified"].push(node.type);
    else if (node.type === "codeBlock") features["code-language-simplified"].push(normalizedLanguage(node.attrs?.language));
    else if (node.type === "orderedList") features["list-start-simplified"].push(node.attrs?.start ?? 1);
    else if (node.type === "callout") features["callout-type-simplified"].push(node.attrs?.type ?? "note");
    else if (node.type === "assetImage") features["image-alt-simplified"].push(node.attrs?.alt || null);
    node.content?.forEach(visit);
  };
  if (document && typeof document === "object") visit(document as WrittenNode);
  return features;
}
function withoutStructureFeatures(document: unknown): unknown {
  const visit = (node: WrittenNode): WrittenNode => {
    let next: WrittenNode = node;
    if (node.type === "taskItem") next = { ...node, attrs: { ...node.attrs, checked: null } };
    else if (node.type === "tableHeader") next = { ...node, type: "tableCell" };
    else if (node.type === "codeBlock") next = { ...node, attrs: { ...node.attrs, language: null } };
    else if (node.type === "orderedList") next = { ...node, attrs: { ...node.attrs, start: 1 } };
    else if (node.type === "callout") next = { ...node, attrs: { ...node.attrs, type: "note" } };
    else if (node.type === "assetImage") next = { ...node, attrs: { ...node.attrs, alt: null } };
    return next.content ? { ...next, content: next.content.map(visit) } : next;
  };
  return document && typeof document === "object" ? visit(document as WrittenNode) : document;
}
/** Compare two documents after normalisation; each kept-or-warned attribute that changed gets its own code, anything else is the generic structure warning. */
export function describeStructureChanges(before: unknown, after: unknown): Array<{ code: string; message: string }> {
  const left = normalizeRichTextDocument(before), right = normalizeRichTextDocument(after);
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  const changes: Array<{ code: string; message: string }> = [];
  if (JSON.stringify(withoutStructureFeatures(left)) !== JSON.stringify(withoutStructureFeatures(right))) changes.push({ code: "structure-simplified", message: "Some formatting or block layout was simplified when saved." });
  const leftFeatures = structureFeatures(left), rightFeatures = structureFeatures(right);
  for (const code of Object.keys(structureMessages) as StructureWarningCode[]) {
    if (JSON.stringify(leftFeatures[code]) !== JSON.stringify(rightFeatures[code])) changes.push({ code, message: structureMessages[code] });
  }
  return changes;
}

function unknownAttributeWarnings(document: unknown): string[] {
  const warnings = new Set<string>();
  const visit = (node: WrittenNode) => {
    const nodeAttrs = editorSchema.nodes[node.type ?? ""]?.spec.attrs ?? {};
    for (const name of Object.keys(node.attrs ?? {})) if (!(name in nodeAttrs)) warnings.add("node:" + node.type + "." + name + " is not part of the editor schema and would be dropped");
    for (const mark of node.marks ?? []) {
      const markAttrs = editorSchema.marks[mark.type ?? ""]?.spec.attrs ?? {};
      for (const name of Object.keys(mark.attrs ?? {})) if (!(name in markAttrs)) warnings.add("mark:" + mark.type + "." + name + " is not part of the editor schema and would be dropped");
    }
    node.content?.forEach(visit);
  };
  if (document && typeof document === "object") visit(document as WrittenNode);
  return [...warnings].sort();
}
function unknownSchemaWarnings(document: unknown): Array<{ code: string; message: string }> {
  const warnings: Array<{ code: string; message: string }> = [];
  const visit = (node: WrittenNode) => {
    if (!editorSchema.nodes[node.type ?? ""]) warnings.push({ code: "unknown-schema-node", message: "This content can't be saved because it contains a block the editor does not support." });
    for (const mark of node.marks ?? []) if (!editorSchema.marks[mark.type ?? ""]) warnings.push({ code: "unknown-schema-mark", message: "This content can't be saved because it contains formatting the editor does not support." });
    node.content?.forEach(visit);
  };
  if (document && typeof document === "object") visit(document as WrittenNode);
  return warnings;
}

function nonPersistedAttributeWarnings(document: unknown): Array<{ code: string; message: string }> {
  const warnings = new Map<string, { code: string; message: string }>();
  const label = (key: string) => ({
    "node:paragraph.textAlign": "text alignment", "node:heading.textAlign": "heading alignment",
    "node:tableCell.backgroundColor": "table cell colour", "node:tableHeader.backgroundColor": "table header colour",
    "node:tableCell.colwidth": "table column width", "node:tableHeader.colwidth": "table column width",
    "node:assetImage.width": "image width", "node:assetImage.alignment": "image alignment",
    "mark:link.title": "link title", "mark:link.target": "link opening behavior", "mark:link.rel": "link relationship", "mark:link.class": "link style",
    "mark:link.unavailable": "private link indicator", "node:mention.mentionSuggestionChar": "mention typing shortcut",
  } as Record<string, string>)[key] ?? "this formatting option";
  const visit = (node: WrittenNode) => {
    const attrs = editorSchema.nodes[node.type ?? ""]?.spec.attrs ?? {};
    for (const [name, value] of Object.entries(node.attrs ?? {})) {
      const key = `node:${node.type}.${name}`, policy = writtenFormAttributePolicy[key];
      if (policy?.persisted === false && value !== (attrs[name] as { default?: unknown } | undefined)?.default) warnings.set(key, { code: "attribute-not-persisted", message: `The ${label(key)} was not kept.` });
    }
    for (const mark of node.marks ?? []) {
      const attrs = editorSchema.marks[mark.type ?? ""]?.spec.attrs ?? {};
      for (const [name, value] of Object.entries(mark.attrs ?? {})) {
        const key = `mark:${mark.type}.${name}`, policy = writtenFormAttributePolicy[key];
        if (policy?.persisted === false && !(mark.type === "link" && name === "unavailable") && !(mark.type === "link" && name === "target" && !!mark.attrs?.kind && !!mark.attrs?.targetId) && value !== (attrs[name] as { default?: unknown } | undefined)?.default) warnings.set(key, { code: "attribute-not-persisted", message: `The ${label(key)} was not kept.` });
      }
    }
    node.content?.forEach(visit);
  };
  if (document && typeof document === "object") visit(document as WrittenNode);
  return [...warnings.values()];
}

function withoutNonPersistedAttributes(document: unknown): unknown {
  const visit = (node: WrittenNode): WrittenNode => {
    const marks = node.marks?.filter((mark) => !(mark.type === "link" && !mark.attrs?.kind && !mark.attrs?.targetId && !isAllowedLinkHref(mark.attrs?.href))).map((mark) => ({
      ...mark,
      ...(mark.attrs ? { attrs: Object.fromEntries(Object.entries(mark.attrs).filter(([name]) => writtenFormAttributePolicy[`mark:${mark.type}.${name}`]?.persisted !== false || mark.type === "link" && name === "target" && !!mark.attrs?.kind && !!mark.attrs?.targetId)) } : {}),
    }));
    return {
      ...node,
      ...(node.attrs ? { attrs: Object.fromEntries(Object.entries(node.attrs).filter(([name]) => writtenFormAttributePolicy[`node:${node.type}.${name}`]?.persisted !== false)) } : {}),
      ...(marks ? { marks } : {}),
      ...(node.content ? { content: node.content.map(visit) } : {}),
    };
  };
  return document && typeof document === "object" ? visit(structuredClone(document) as WrittenNode) : document;
}

function unsupportedLinkWarnings(document: unknown) {
  const warnings = new Map<string, { code: string; message: string }>();
  const visit = (node: WrittenNode) => {
    for (const mark of node.marks ?? []) if (mark.type === "link" && !mark.attrs?.kind && !mark.attrs?.targetId && !isAllowedLinkHref(mark.attrs?.href)) {
      const key = `mark:link.href:${String(mark.attrs?.href ?? "")}`;
      warnings.set(key, { code: "link-not-persisted", message: "An unsupported or unsafe link destination was removed; its text was kept." });
    }
    node.content?.forEach(visit);
  };
  if (document && typeof document === "object") visit(document as WrittenNode);
  return [...warnings.values()];
}
/** Drop unsafe link targets, colours and code languages; used on write and on every read of live Yjs state, which is stored as typed. */
export function sanitizeWrittenDocument(document: unknown) {
  const warnings = new Map<string, { code: string; message: string }>();
  const visit = (node: WrittenNode): WrittenNode => {
    let attrs = node.attrs ? { ...node.attrs } : undefined;
    if (node.type === "codeBlock" && attrs?.language != null && !WRITTEN_FORM_CODE_LANGUAGES.has(String(attrs.language).toLowerCase())) {
      warnings.set("language", { code: "unsupported-code-language", message: "An unsupported code language was removed; the code was kept." });
      attrs.language = null;
    }
    if (node.type === "heading" && attrs?.level != null && !(Number.isInteger(attrs.level) && Number(attrs.level) >= 1 && Number(attrs.level) <= 6)) {
      warnings.set("heading-level", { code: "heading-level-simplified", message: "A heading level outside 1 to 6 was set to the nearest level the editor supports." });
      attrs.level = Math.min(6, Math.max(1, Math.trunc(Number(attrs.level)) || 1));
    }
    if (node.type === "callout" && attrs) {
      if (attrs.color != null && !isWrittenFormColor(attrs.color)) { warnings.set("callout-color", { code: "unsafe-color", message: "An unsupported callout color was removed." }); attrs.color = null; }
      if (attrs.icon != null && !writtenFormCalloutIcons.includes(attrs.icon as typeof writtenFormCalloutIcons[number])) { warnings.set("callout-icon", { code: "unsupported-callout-metadata", message: "An unsupported callout icon was removed." }); attrs.icon = "💡"; }
    }
    const marks = node.marks?.flatMap((mark) => {
      if (mark.type === "link") {
        const internal = ["work-item", "page", "wiki"].includes(String(mark.attrs?.kind)) && typeof mark.attrs?.targetId === "string" && mark.attrs?.href === `weft://${mark.attrs.kind}/${mark.attrs.targetId}`;
        if (!internal && !isAllowedLinkHref(mark.attrs?.href)) {
          warnings.set("unsafe-link", { code: "unsafe-link", message: "An unsafe link was removed; its text was kept." }); return [];
        }
      }
      if ((mark.type === "textStyle" || mark.type === "highlight") && mark.attrs?.color != null && !isWrittenFormColor(mark.attrs.color)) {
        warnings.set("unsafe-color", { code: "unsafe-color", message: "An unsupported color was removed; its text was kept." }); return [];
      }
      return [mark];
    });
    return { ...node, ...(attrs ? { attrs } : {}), ...(marks ? { marks } : {}), ...(node.content ? { content: node.content.map(visit) } : {}) };
  };
  return { document: document && typeof document === "object" ? visit(structuredClone(document) as WrittenNode) : document, warnings: [...warnings.values()] };
}

/** Pick one rich-text representation and give callers an actionable conflict message. */
export function richTextInput(document: unknown, markdown: unknown, documentName: string, markdownName: string, options: MarkdownOptions = {}) {
  return richTextInputWithDetails(document, markdown, documentName, markdownName, options).document;
}

function richTextInputWithDetails(document: unknown, markdown: unknown, documentName: string, markdownName: string, options: MarkdownOptions) {
  if (document !== undefined && markdown !== undefined) throw new ActionError(`Send either ${markdownName} (Markdown text) or ${documentName} (a Tiptap document), not both.`, 400);
  if (markdown !== undefined) {
    if (typeof markdown !== "string") throw new ActionError(`${markdownName} must be Markdown text; pass a string.`, 400);
    if (markdown.length > WRITTEN_FORM_MAX_INPUT_LENGTH) throw new ActionError(inputTooLongMessage(markdown.length), 400, "input-too-long");
    const source = markdown.replace(privateUse, "");
    try {
      const converted = markdownToDocWithWarnings(source, options);
      const limitWarning = converted.warningDetails.find(({ code }) => ["nesting-too-deep", "input-too-complex", "input-too-long"].includes(code));
      if (limitWarning) throw new ActionError(limitWarning.message, 400, limitWarning.code);
      return { document: converted.document, warningDetails: converted.warningDetails };
    }
    catch (error) {
      // An ActionError keeps its status, code and message on every path (the limit codes are documented).
      if (error instanceof ActionError) throw error;
      throw new ActionError(error instanceof Error ? error.message : "Invalid Markdown reference.", 400);
    }
  }
  return { document: resolveDocumentReferences(sanitizeDocument(document), options), warningDetails: [] as Array<{ code: string; message: string }> };
}

/** Apply the shared document/Markdown storage policy, checking the semantic round trip before a write. */
export function prepareRichText(document: unknown, markdown: unknown, documentName: string, markdownName: string, options: MarkdownOptions = {}, storage: WrittenStorage = "derived", policy: PreparedWrittenFormPolicy = {}): PreparedWrittenForm {
  try { return prepareRichTextChecked(document, markdown, documentName, markdownName, options, storage, policy); }
  catch (error) {
    if (error instanceof RangeError) throw new ActionError("This text is nested too deeply to save safely; reduce the nesting below 64 levels.", 400, "nesting-too-deep");
    throw error;
  }
}

function prepareRichTextChecked(document: unknown, markdown: unknown, documentName: string, markdownName: string, options: MarkdownOptions, storage: WrittenStorage, policy: PreparedWrittenFormPolicy): PreparedWrittenForm {
  options = { ...options, preserveUnresolvedReferences: true };
  const sourceMarkdown = typeof markdown === "string" ? markdown.replace(privateUse, "") : undefined;
  const input = richTextInputWithDetails(document, sourceMarkdown, documentName, markdownName, options);
  const resolvedDocument = input.document;
  if (resolvedDocument === undefined) return { document: undefined, markdown: "", warnings: [], warningDetails: [] };
  const safe = sanitizeWrittenDocument(resolvedDocument);
  const attributeWarnings = nonPersistedAttributeWarnings(resolvedDocument);
  const linkWarnings = unsupportedLinkWarnings(resolvedDocument);
  const cleanDocument = withoutNonPersistedAttributes(safe.document);
  let serialized = richTextMarkdown(cleanDocument);
  const warnings: Array<{ code: string; message: string }> = [];
  const sourceWarnings = input.warningDetails;
  if (sourceMarkdown !== undefined) warnings.push(...sourceWarnings);
  warnings.push(...serialized.markdownWarnings.map((message) => ({ code: "written-form-loss", message })));
  warnings.push(...attributeWarnings);
  warnings.push(...linkWarnings);
  warnings.push(...safe.warnings);
  warnings.push(...unknownSchemaWarnings(resolvedDocument));
  warnings.push(...unknownAttributeWarnings(resolvedDocument).map((message) => ({ code: "unknown-document-attribute", message })));
  const parseBack = (markdown: string) => markdownToDocWithWarnings(markdown, { ...options, trustedSource: true, ...(sourceMarkdown === undefined ? { preserveStableReferences: true } : {}) });
  const verified = writeVerified(cleanDocument, resolvedDocument, parseBack, serialized);
  serialized = verified.serialized;
  const roundTrip = verified.roundTrip;
  const limitCode = roundTrip.warningDetails.find(({ code }) => ["input-too-long", "input-too-complex", "nesting-too-deep"].includes(code));
  if (limitCode) throw new ActionError(limitCode.code === "input-too-long" ? inputTooLongMessage(verified.serialized.markdown.length) : limitCode.message, 400, limitCode.code);
  // An over-cap serialised form is refused as such, before any text-loss verdict: the escaped form of valid text can be the longer one.
  const unresolvedForCap = sourceWarnings.some(({ code }) => code === "unresolved-reference");
  const prospective = storage === "verbatim" && sourceMarkdown !== undefined && !unresolvedForCap ? sourceMarkdown : serialized.markdown;
  if (prospective.length > WRITTEN_FORM_MAX_INPUT_LENGTH) throw new ActionError(inputTooLongMessage(prospective.length), 400, "input-too-long");
  warnings.push(...roundTrip.warningDetails);
  const uniqueWarnings = [...new Map(warnings.map((warning) => [warning.code + "\u0000" + warning.message, warning])).values()];
  let sameText = false;
  let structureChanges: Array<{ code: string; message: string }> = [];
  try {
    sameText = JSON.stringify(richTextTextContent(resolvedDocument)) === JSON.stringify(richTextTextContent(roundTrip.document));
    if (sameText) structureChanges = describeStructureChanges(safe.document, roundTrip.document);
  } catch { sameText = false; }
  // Whitespace that could not be kept (tabs or spaces at the edge of a line, an invisible mark) is named, not reported as a generic structure change.
  const whitespace = sameText ? whitespaceChanges(resolvedDocument, roundTrip.document) : null;
  if (whitespace) { structureChanges = structureChanges.filter(({ code }) => code !== "structure-simplified"); structureChanges.push({ code: "whitespace-simplified", message: `Some whitespace was simplified (${whitespace}). The words and links are unchanged.` }); }
  uniqueWarnings.push(...structureChanges);
  const allowedImportWarnings = new Set(policy.allowPreservedImportWarnings
    ? sourceWarnings.filter(({ code }) => ["unsupported-html", "external-image", "unsafe-link", "unresolved-reference", "irregular-table", "deep-heading", "unsupported-callout-metadata", "unsupported-markdown"].includes(code)).map(({ code, message }) => `${code}\u0000${message}`)
    : []);
  const blockingWarnings = uniqueWarnings.filter(({ code, message }) => ["unknown-document-attribute", "unknown-schema-node", "unknown-schema-mark", "semantic-round-trip-loss"].includes(code) && !allowedImportWarnings.has(`${code}\u0000${message}`));
  if (blockingWarnings.length) {
    const code = blockingWarnings[0]!.code;
    const message = code === "unknown-document-attribute" ? "This content can't be saved because it contains an editor setting the app doesn't recognize."
      : code === "unknown-schema-node" ? "This content can't be saved because it contains a block the editor doesn't support."
        : code === "unknown-schema-mark" ? "This content can't be saved because it contains formatting the editor doesn't support."
          : "Some text or a link could not be saved exactly as written. Nothing was changed.";
    throw new ActionError(message, 400, code);
  }
  // An unknown block or setting is reported as such; text-loss is only for text or links that cannot be written back.
  if (!sameText) throw new ActionError("Some text or a link could not be saved exactly as written. Nothing was changed.", 400, "text-loss");
  const unresolvedText = sourceWarnings.some(({ code }) => code === "unresolved-reference");
  const finalMarkdown = storage === "verbatim" && sourceMarkdown !== undefined && !unresolvedText ? sourceMarkdown : serialized.markdown;
  // Storage never exceeds the documented cap, so what is written can always be read back whole.
  if (finalMarkdown.length > WRITTEN_FORM_MAX_INPUT_LENGTH) throw new ActionError(inputTooLongMessage(finalMarkdown.length), 400, "input-too-long");
  // The document that is cached with the Markdown is what a parse of the stored form gives (the Markdown wins), not the input document. A verbatim form (the writer's own Markdown) is parsed once more for it.
  const cached = finalMarkdown === serialized.markdown ? roundTrip.document : parseBack(finalMarkdown).document;
  return { document: cached, markdown: finalMarkdown, warnings: uniqueWarnings.map(({ message }) => message), warningDetails: uniqueWarnings };
}

/** The text of each block, with a hard break as a newline: what a reader of the stored form would see, whitespace included. */
function textBlocks(document: unknown): string[] {
  const blocks: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    const children: any[] = Array.isArray(node.content) ? node.content : [];
    if (children.some((child) => child?.type === "text" || child?.type === "hardBreak")) {
      blocks.push(children.map((child) => child?.type === "text" ? String(child.text ?? "") : child?.type === "hardBreak" ? "\n" : "").join(""));
      return;
    }
    for (const child of children) visit(child);
  };
  visit(document);
  return blocks;
}
/** What whitespace did not survive the written form, in words; null when none was lost. */
export function whitespaceChanges(original: unknown, readBack: unknown): string | null {
  const before = textBlocks(original), after = textBlocks(readBack);
  if (before.length !== after.length) return null;
  const lost = new Set<string>();
  before.forEach((text, index) => {
    const other = after[index]!;
    if (text === other) return;
    if (text.replace(/\s+/g, " ").trim() !== other.replace(/\s+/g, " ").trim()) return;
    if (text.includes("\t") && !other.includes("\t")) lost.add("tabs");
    if (text.includes("\uFEFF") && !other.includes("\uFEFF")) lost.add("an invisible byte-order mark");
    if (/(^|\n)[ \t]+|[ \t]+(\n|$)/.test(text) && !/(^|\n)[ \t]+|[ \t]+(\n|$)/.test(other)) lost.add("spaces at the start or end of a line");
    if ((text.match(/\n/g)?.length ?? 0) > (other.match(/\n/g)?.length ?? 0)) lost.add("a hard break became a plain newline");
    if (!lost.size) lost.add("runs of spaces");
  });
  return lost.size ? [...lost].join(", ") : null;
}
const sameTextContent = (left: unknown, right: unknown) => { try { return JSON.stringify(richTextTextContent(left)) === JSON.stringify(richTextTextContent(right)); } catch { return false; } };
type ParsedBack = ReturnType<typeof markdownToDocWithWarnings>;
/**
 * The one verified serialiser. Every top-level block is written as normal Markdown, then with every ASCII punctuation character of its text escaped,
 * then as an exact JSON block comment, whichever reads back with the same text and links first; the whole is checked again. `serialized` may carry an already-computed normal pass.
 */
function writeVerified(cleanDocument: unknown, compareDocument: unknown, parseBack: (markdown: string) => ParsedBack, first: ReturnType<typeof richTextMarkdown>) {
  let serialized = first;
  let roundTrip = parseBack(serialized.markdown);
  let same = sameTextContent(compareDocument, roundTrip.document);
  if (!same) {
    const topLevel = ((cleanDocument as WrittenNode | undefined)?.content ?? []);
    const modes: Array<"normal" | "linkSafe" | "paranoid" | "opaque"> = topLevel.map((block) => {
      const single = { type: "doc", content: [block] };
      for (const mode of ["normal", "linkSafe", "paranoid", "opaque"] as const) {
        const written = richTextMarkdown(single, { linkSafe: mode === "linkSafe" ? "all" : undefined, paranoid: mode === "paranoid" ? "all" : undefined, opaque: mode === "opaque" ? "all" : undefined }).markdown;
        if (sameTextContent(single, parseBack(written).document)) return mode;
      }
      return "opaque";
    });
    const indexes = (mode: string) => new Set(modes.flatMap((value, index) => value === mode ? [index] : []));
    for (const attempt of [{ linkSafe: indexes("linkSafe"), paranoid: indexes("paranoid"), opaque: indexes("opaque") }, { linkSafe: "all" as const, paranoid: indexes("paranoid"), opaque: indexes("opaque") }, { paranoid: "all" as const, opaque: indexes("opaque") }, { opaque: "all" as const }]) {
      const retry = richTextMarkdown(cleanDocument, attempt);
      const retryTrip = parseBack(retry.markdown);
      if (sameTextContent(compareDocument, retryTrip.document)) { serialized = retry; roundTrip = retryTrip; same = true; break; }
    }
  }
  // The normal form of valid text can be the longer one (every underscore and parenthesis escaped): over the cap, the shortest form that still reads back is tried before the write is refused.
  if (same && serialized.markdown.length > WRITTEN_FORM_MAX_INPUT_LENGTH) {
    const short = richTextMarkdown(cleanDocument, { linkSafe: "all" });
    if (short.markdown.length < serialized.markdown.length) {
      const trip = parseBack(short.markdown);
      if (sameTextContent(compareDocument, trip.document)) { serialized = short; roundTrip = trip; }
    }
  }
  return { serialized, roundTrip, same };
}

/**
 * Written form of a document for any read, copy, export or stored derived column: the verified, escalating serialisation, never the bare serialiser.
 * Synchronous and in-process: use `writtenFormOf` (worker-guarded) for documents that may be large.
 */
/** Warnings the serialiser reports for a document (unsupported nodes, marks and attributes). */
export function writtenFormWarnings(document: unknown): string[] { return richTextMarkdown(document ?? { type: "doc", content: [] }).markdownWarnings; }
/** Every character of the document's text as escaped plain text: linear, never needs a parse to be safe. */
export function plainTextWrittenForm(document: unknown): string { return richTextMarkdown(document, { paranoid: "all" }).markdown; }
export function writtenFormOfSync(document: unknown): string {
  const clean = withoutNonPersistedAttributes(sanitizeWrittenDocument(document ?? { type: "doc", content: [] }).document);
  const parseBack = (markdown: string) => markdownToDocWithWarnings(markdown, { preserveUnresolvedReferences: true, preserveStableReferences: true, trustedSource: true });
  return writeVerified(clean, clean, parseBack, richTextMarkdown(clean)).serialized.markdown;
}

type TextPart = { kind: "text"; text: string; href: string | null; code: boolean } | { kind: "mention"; id: string; label: string } | { kind: "asset"; id: string };
/** Formatting and block shape may simplify; words, destinations, and stable targets may not. */
export function richTextTextContent(document: unknown): TextPart[] {
  const parts: TextPart[] = [];
  const appendText = (text: string, href: string | null, code: boolean) => {
    const normalized = text.replace(/\s+/g, " ");
    if (!normalized) return;
    const previous = parts.at(-1);
    if (previous?.kind === "text" && previous.href === href && previous.code === code) previous.text += normalized;
    else parts.push({ kind: "text", text: normalized, href, code });
  };
  const blockTypes = new Set(["paragraph", "heading", "codeBlock", "blockquote", "bulletList", "orderedList", "taskList", "listItem", "taskItem", "table", "tableRow", "tableCell", "tableHeader", "callout", "horizontalRule", "assetImage"]);
  const visit = (node: WrittenNode, codeBlock = false) => {
    if (node.type === "text") {
      const link = node.marks?.find((mark) => mark.type === "link");
      const rawHref = link ? (link.attrs?.kind && link.attrs?.targetId ? `weft://${link.attrs.kind}/${link.attrs.targetId}` : String(link.attrs?.href ?? "")) : null;
      const internal = !!link?.attrs?.kind && !!link.attrs?.targetId;
      const href = rawHref && (internal || isAllowedLinkHref(rawHref)) ? rawHref.replace(/ /g, "%20").replace(/</g, "%3C").replace(/>/g, "%3E") : null;
      const value = node.text ?? "";
      const code = codeBlock || !!node.marks?.some((mark) => mark.type === "code");
      if (href && !code) {
        const leading = value.match(/^\s*/)?.[0] ?? "";
        const trailing = value.length > leading.length ? value.match(/\s*$/)?.[0] ?? "" : "";
        appendText(leading, null, false);
        appendText(value.slice(leading.length, value.length - trailing.length), href, false);
        appendText(trailing, null, false);
      } else appendText(value, href, code);
      return;
    }
    if (node.type === "mention") {
      const id = String(node.attrs?.id ?? "");
      parts.push({ kind: "mention", id, label: String(node.attrs?.label ?? node.attrs?.name ?? id) });
      return;
    }
    if (node.type === "assetImage") { parts.push({ kind: "asset", id: String(node.attrs?.assetId ?? "") }); return; }
    const childCode = codeBlock || node.type === "codeBlock";
    for (const [index, child] of (node.content ?? []).entries()) {
      if (index > 0 && blockTypes.has(child.type ?? "")) appendText(" ", null, childCode);
      visit(child, childCode);
    }
  };
  if (document && typeof document === "object") visit(document as WrittenNode);
  const normalized: TextPart[] = [];
  let pendingSpace = false;
  for (const part of parts) {
    if (part.kind !== "text") {
      normalized.push(part);
      pendingSpace = false;
      continue;
    }
    const value = part.text.replace(/\s+/g, " ");
    const leading = value.startsWith(" "), trailing = value.endsWith(" "), core = value.trim();
    pendingSpace ||= leading && normalized.at(-1)?.kind === "text";
    if (core) {
      if (pendingSpace && normalized.length) appendNormalized(" ", null, false);
      appendNormalized(core, part.href, part.code);
      pendingSpace = trailing;
    } else pendingSpace ||= trailing;
  }
  return normalized;

  function appendNormalized(text: string, href: string | null, code: boolean) {
    const previous = normalized.at(-1);
    if (previous?.kind === "text" && previous.href === href && previous.code === code) previous.text += text;
    else normalized.push({ kind: "text", text, href, code });
  }
}

/** Written form to document conversion with explicit losses for callers that accept agent or imported text. */
export function richTextInputWithWarnings(markdown: string, options: MarkdownOptions = {}) {
  try { return markdownToDocWithWarnings(markdown, options); }
  catch (error) { throw new ActionError(error instanceof Error ? error.message : "Invalid Markdown reference.", 400); }
}

/** Resolve the documented @{name} / @{id} Markdown mention tokens against people visible to the writer. */
export function resolveMarkdownMentions(document: unknown, people: Array<{ userId: string; name: string }>) {
  const root = structuredClone(document) as Node;
  const byId = new Map(people.map((person) => [person.userId, person]));
  const byName = new Map<string, Array<{ userId: string; name: string }>>();
  for (const person of people) byName.set(person.name.trim().toLocaleLowerCase(), [...(byName.get(person.name.trim().toLocaleLowerCase()) ?? []), person]);
  const visit = (node: Node) => {
    if (node.type === "mention") {
      const token = String(node.attrs?.id ?? "");
      const candidates = byName.get(token.trim().toLocaleLowerCase()) ?? [];
      const person = byId.get(token) ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!person) {
        const options = candidates.length > 1 ? candidates : people;
        throw new ActionError(`Markdown mention "${token}" was ${candidates.length > 1 ? "ambiguous" : "not found"}. Candidates: ${options.map(({ name, userId }) => `${name} (${userId})`).join(", ") || "none"}. Use @{exact name|user id}.`, 400);
      }
      node.attrs = { ...node.attrs, id: person.userId, label: person.name };
    }
    for (const child of node.content ?? []) visit(child);
  };
  if (root && typeof root === "object") visit(root);
  return root;
}

type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>; content?: Node[] };
export { richTextMarkdown, writtenFormAttributeIssues, writtenFormAttributePolicy, writtenFormMarkAllowlist, writtenFormNodeAllowlist, writtenFormSchemaIssues } from "./written-form";
