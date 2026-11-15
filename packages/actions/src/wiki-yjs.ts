import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { normalizeAssetImages, wikiEditorExtensions } from "./wiki-editor-extensions";
export { normalizeAssetImages } from "./wiki-editor-extensions";

const schema = getSchema(wikiEditorExtensions);
export const wikiYFragment = "default";
export function createWikiYDoc(content: unknown) {
  const initial = content && typeof content === "object" ? content : { type: "doc", content: [{ type: "paragraph" }] };
  return prosemirrorJSONToYDoc(schema, normalizeAssetImages(initial), wikiYFragment);
}
/** Throws when the JSON is not a document the editor's schema allows: unknown nodes or marks, wrong nesting, bad attributes, or no block at all. */
export function assertWikiDoc(content: unknown) { schema.nodeFromJSON(normalizeAssetImages(content)).check(); }
export function wikiYState(document: Y.Doc) { return Buffer.from(Y.encodeStateAsUpdate(document)); }
export function wikiContentFromYState(state: Uint8Array) {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  try { return normalizeAssetImages(yDocToProsemirrorJSON(document, wikiYFragment)); } finally { document.destroy(); }
}
export function wikiYStateFromContent(content: unknown) {
  const document = createWikiYDoc(content);
  try { return wikiYState(document); } finally { document.destroy(); }
}

/** Applies the smallest structural and text edits that make the current document match content. */
export function wikiYStateAfterContent(currentState: Uint8Array | null, content: unknown) {
  if (!currentState) return wikiYStateFromContent(content);
  const current = new Y.Doc();
  const desired = createWikiYDoc(content);
  try {
    Y.applyUpdate(current, currentState);
    const currentRoot = current.getXmlFragment(wikiYFragment);
    const desiredRoot = desired.getXmlFragment(wikiYFragment);
    current.transact(() => reconcileChildren(currentRoot, desiredRoot));
    return wikiYState(current);
  } finally { current.destroy(); desired.destroy(); }
}

type XmlNode = Y.XmlElement | Y.XmlText | Y.XmlHook;
type XmlParent = Y.XmlElement | Y.XmlFragment;

function textOf(node: XmlNode): string {
  if (node instanceof Y.XmlText) return node.toString();
  if (node instanceof Y.XmlElement) return node.toArray().map((child) => textOf(child)).join("");
  return "";
}

function compatible(current: XmlNode, desired: XmlNode): boolean {
  if (current instanceof Y.XmlText || desired instanceof Y.XmlText) return current instanceof Y.XmlText && desired instanceof Y.XmlText;
  return current instanceof Y.XmlElement && desired instanceof Y.XmlElement && current.nodeName === desired.nodeName;
}

function matchScore(current: XmlNode, desired: XmlNode): number {
  if (!compatible(current, desired)) return Number.NEGATIVE_INFINITY;
  const a = textOf(current);
  const b = textOf(desired);
  if (JSON.stringify(current.toJSON()) === JSON.stringify(desired.toJSON())) return 10_000;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix += 1;
  const similarity = a.length + b.length ? (prefix + suffix) / (a.length + b.length) : 0;
  const attrBonus = current instanceof Y.XmlElement && desired instanceof Y.XmlElement && JSON.stringify(current.getAttributes()) === JSON.stringify(desired.getAttributes()) ? 100 : 0;
  return 100 + similarity * 1_000 + attrBonus;
}

/** Above this many block pairs the middle of a rewrite is replaced as a whole instead of aligned block by block (the alignment costs one score per pair, each over the blocks' text). */
const MAX_ALIGNED_PAIRS = 40_000;

/** Blocks identical at the start and at the end stay as they are; only the changed middle is aligned, and a middle too large to align is replaced. */
function alignedPairs(current: XmlNode[], desired: XmlNode[]): Array<[number, number]> {
  const key = (node: XmlNode) => JSON.stringify(node.toJSON());
  let head = 0;
  while (head < current.length && head < desired.length && key(current[head]!) === key(desired[head]!)) head += 1;
  let tail = 0;
  while (tail < current.length - head && tail < desired.length - head && key(current[current.length - tail - 1]!) === key(desired[desired.length - tail - 1]!)) tail += 1;
  const middleCurrent = current.slice(head, current.length - tail), middleDesired = desired.slice(head, desired.length - tail);
  const middle = middleCurrent.length * middleDesired.length > MAX_ALIGNED_PAIRS ? [] : alignedMiddle(middleCurrent, middleDesired);
  return [
    ...Array.from({ length: head }, (_, index): [number, number] => [index, index]),
    ...middle.map(([i, j]): [number, number] => [i + head, j + head]),
    ...Array.from({ length: tail }, (_, index): [number, number] => [current.length - tail + index, desired.length - tail + index]),
  ];
}

function alignedMiddle(current: XmlNode[], desired: XmlNode[]): Array<[number, number]> {
  const scores = Array.from({ length: current.length + 1 }, () => Array<number>(desired.length + 1).fill(0));
  const steps = Array.from({ length: current.length + 1 }, () => Array<"match" | "current" | "desired">(desired.length + 1).fill("match"));
  const gap = 600;
  for (let i = 1; i <= current.length; i += 1) { scores[i]![0] = scores[i - 1]![0]! - gap; steps[i]![0] = "current"; }
  for (let j = 1; j <= desired.length; j += 1) { scores[0]![j] = scores[0]![j - 1]! - gap; steps[0]![j] = "desired"; }
  for (let i = 1; i <= current.length; i += 1) for (let j = 1; j <= desired.length; j += 1) {
    const match = scores[i - 1]![j - 1]! + matchScore(current[i - 1]!, desired[j - 1]!);
    const removeCurrent = scores[i - 1]![j]! - gap;
    const insertDesired = scores[i]![j - 1]! - gap;
    if (match >= removeCurrent && match >= insertDesired) { scores[i]![j] = match; steps[i]![j] = "match"; }
    else if (removeCurrent >= insertDesired) { scores[i]![j] = removeCurrent; steps[i]![j] = "current"; }
    else { scores[i]![j] = insertDesired; steps[i]![j] = "desired"; }
  }
  const pairs: Array<[number, number]> = [];
  let i = current.length; let j = desired.length;
  while (i || j) {
    const step = steps[i]![j]!;
    if (i && j && step === "match") { if (Number.isFinite(matchScore(current[i - 1]!, desired[j - 1]!))) pairs.push([i - 1, j - 1]); i -= 1; j -= 1; }
    else if (i && (!j || step === "current")) i -= 1;
    else j -= 1;
  }
  return pairs.reverse();
}

type TextUnit = { value: string | Record<string, unknown>; attributes?: Record<string, unknown> };
function textUnits(text: Y.XmlText): TextUnit[] {
  return (text.toDelta() as Array<{ insert: string | Record<string, unknown>; attributes?: Record<string, unknown> }>).flatMap<TextUnit>((part) => {
    const attributes = part.attributes as Record<string, unknown> | undefined;
    if (typeof part.insert !== "string") return [{ value: part.insert as Record<string, unknown>, ...(attributes ? { attributes } : {}) }];
    return [...part.insert].map((value) => ({ value, ...(attributes ? { attributes } : {}) }));
  });
}
function sameUnit(a: TextUnit, b: TextUnit) { return a.value === b.value && JSON.stringify(a.attributes ?? {}) === JSON.stringify(b.attributes ?? {}); }
function unitLength(unit: TextUnit) { return typeof unit.value === "string" ? unit.value.length : 1; }

function reconcileText(current: Y.XmlText, desired: Y.XmlText) {
  const before = textUnits(current); const after = textUnits(desired);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && sameUnit(before[prefix]!, after[prefix]!)) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && sameUnit(before[before.length - suffix - 1]!, after[after.length - suffix - 1]!)) suffix += 1;
  const startIndex = before.slice(0, prefix).reduce((total, unit) => total + unitLength(unit), 0);
  const removeCount = before.slice(prefix, before.length - suffix).reduce((total, unit) => total + unitLength(unit), 0);
  const inserted = after.slice(prefix, after.length - suffix);
  if (removeCount) current.delete(startIndex, removeCount);
  let index = startIndex;
  for (const unit of inserted) {
    if (typeof unit.value === "string") { current.insert(index, unit.value, unit.attributes); index += unit.value.length; }
    else { current.insertEmbed(index, unit.value, unit.attributes); index += 1; }
  }
}

function reconcile(current: XmlNode, desired: XmlNode) {
  if (current instanceof Y.XmlText && desired instanceof Y.XmlText) {
    reconcileText(current, desired);
    return;
  }
  if (current instanceof Y.XmlElement && desired instanceof Y.XmlElement) {
    const currentAttrs = current.getAttributes();
    const desiredAttrs = desired.getAttributes();
    for (const key of Object.keys(currentAttrs)) if (!(key in desiredAttrs)) current.removeAttribute(key);
    for (const [key, value] of Object.entries(desiredAttrs)) if (value !== undefined && currentAttrs[key] !== value) current.setAttribute(key, value);
    reconcileChildren(current, desired);
  }
}

function reconcileChildren(current: XmlParent, desired: XmlParent) {
  const before = current.toArray() as XmlNode[];
  const after = desired.toArray() as XmlNode[];
  const pairs = alignedPairs(before, after);
  const retained = new Set(pairs.map(([i]) => before[i]!));
  for (let index = before.length - 1; index >= 0; index -= 1) if (!retained.has(before[index]!)) current.delete(index, 1);
  const desiredMatches = new Map(pairs.map(([i, j]) => [j, before[i]!]));
  for (let index = 0; index < after.length; index += 1) {
    const matched = desiredMatches.get(index);
    if (matched) {
      const live = current.toArray()[index] as XmlNode;
      reconcile(live, after[index]!);
    } else {
      const child = after[index]!;
      if (!(child instanceof Y.XmlElement || child instanceof Y.XmlText)) continue;
      current.insert(index, [child.clone()]);
    }
  }
}

/** Replaces a live document's content using normal Yjs operations so connected editors receive the write. */
export function replaceWikiYDocContent(document: Y.Doc, content: unknown) {
  const initial = content && typeof content === "object" ? content : { type: "doc", content: [{ type: "paragraph" }] };
  const fragment = document.getXmlFragment(wikiYFragment);
  const node = schema.nodeFromJSON(normalizeAssetImages(initial));
  document.transact(() => {
    if (fragment.length) fragment.delete(0, fragment.length);
    prosemirrorToYXmlFragment(node, fragment);
  });
}
