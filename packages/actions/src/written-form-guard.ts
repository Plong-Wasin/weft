/**
 * Linear-time checks that run on the RAW Written form text before remark sees it.
 * remark/micromark is quadratic on two shapes: deeply nested block markers on one line ("+ + + ..."), and stray inline closers ("a] a] ...").
 * Both are measured here in one pass each, so the cost of a hostile input is bounded by its length, never by what the parser would build.
 */
export const WRITTEN_FORM_MAX_NESTING_DEPTH = 64;
/** Block markers (quote, list) across the whole text. Real documents stay far below it; it bounds the pre-scan itself. */
export const WRITTEN_FORM_MAX_BLOCK_MARKERS = 20_000;
/** Inline closers with no matching opener, and openers never closed, per paragraph and in total. Well-formed text has none. */
export const WRITTEN_FORM_MAX_STRAY_DELIMITERS_PER_PARAGRAPH = 1_000;
export const WRITTEN_FORM_MAX_STRAY_DELIMITERS_TOTAL = 5_000;
export const WRITTEN_FORM_MAX_DELIMITER_RUN = 64;

export function withoutFencedCode(source: string): string {
  const kept: string[] = [];
  let fence: { closing: RegExp } | null = null;
  for (const line of source.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && marker && marker.length <= WRITTEN_FORM_MAX_DELIMITER_RUN) {
      const character = marker[0] === "`" ? "`" : "~";
      fence = { closing: new RegExp(`^ {0,3}${character}{${marker.length},}[ \\t]*$`) };
      continue;
    }
    if (fence) {
      if (fence.closing.test(line)) fence = null;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

const isSpace = (character: string | undefined) => character === " " || character === "\t";
/** Count the consecutive quote and list markers that open a line: "- 1. > text" is three. */
function leadingMarkers(line: string): number {
  let index = 0, count = 0;
  for (;;) {
    while (isSpace(line[index])) index++;
    const character = line[index];
    if (character === ">") { count++; index++; continue; }
    if ((character === "-" || character === "+" || character === "*") && (index + 1 >= line.length || isSpace(line[index + 1]))) { count++; index++; continue; }
    if (character !== undefined && character >= "0" && character <= "9") {
      let end = index;
      while (line[end] !== undefined && line[end]! >= "0" && line[end]! <= "9" && end - index < 10) end++;
      if ((line[end] === "." || line[end] === ")") && (end + 1 >= line.length || isSpace(line[end + 1]))) { count++; index = end + 1; continue; }
    }
    return count;
  }
}

/** Nesting depth of quotes and lists, from markers and indentation, without building any tree. */
export function scanWrittenFormNesting(text: string): "nesting-too-deep" | "input-too-complex" | null {
  const source = withoutFencedCode(text);
  let maximumDepth = 0, totalMarkers = 0;
  let listIndents: number[] = [];
  for (const line of source.split("\n")) {
    const markers = leadingMarkers(line);
    totalMarkers += markers;
    if (markers > WRITTEN_FORM_MAX_NESTING_DEPTH) return "nesting-too-deep";
    if (totalMarkers > WRITTEN_FORM_MAX_BLOCK_MARKERS) return "input-too-complex";
    const depthBefore = listIndents.length;
    let offset = Math.min(3, line.match(/^ */)?.[0].length ?? 0);
    let quotes = 0;
    while (line[offset] === ">") { quotes++; offset++; if (line[offset] === " ") offset++; }
    const list = /^( *)(?:[-+*]|\d+[.)])\s+/.exec(line);
    if (list) {
      const indent = list[1]!.length;
      if (indent < 4 || listIndents.length > 0) {
        while (listIndents.length && indent <= listIndents[listIndents.length - 1]!) listIndents.pop();
        listIndents.push(indent);
      }
    } else if (!/^\s*$/.test(line) && !/^(?: {4}|\t)/.test(line)) listIndents = [];
    maximumDepth = Math.max(maximumDepth, quotes + listIndents.length, depthBefore + markers);
    if (maximumDepth > WRITTEN_FORM_MAX_NESTING_DEPTH) return "nesting-too-deep";
  }
  return null;
}

const isWhitespace = (character: string | undefined) => character === undefined || /\s/.test(character);
const isPunctuation = (character: string | undefined) => character !== undefined && /[!-/:-@[-`{-~\p{P}\p{S}]/u.test(character);

/**
 * Stray inline delimiters: `]` with no `[`, emphasis closers with no opener, openers that never close. Applies to untrusted Markdown text only;
 * the serializer escapes every such character, so editor documents have none.
 */
export function scanWrittenFormDelimiters(text: string): "input-too-complex" | null {
  const source = withoutFencedCode(text);
  let total = 0, paragraph = 0;
  let brackets = 0, destinations = 0;
  const open: Record<string, number> = { "*": 0, _: 0, "~": 0 };
  const flush = () => {
    const leftover = open["*"]! + open._! + open["~"]! + brackets + destinations;
    paragraph += leftover; total += leftover;
    brackets = 0; destinations = 0; open["*"] = 0; open._ = 0; open["~"] = 0;
    const exceeded = paragraph > WRITTEN_FORM_MAX_STRAY_DELIMITERS_PER_PARAGRAPH || total > WRITTEN_FORM_MAX_STRAY_DELIMITERS_TOTAL;
    paragraph = 0;
    return exceeded;
  };
  let inCode = 0;
  const stray = () => { paragraph++; total++; return paragraph > WRITTEN_FORM_MAX_STRAY_DELIMITERS_PER_PARAGRAPH || total > WRITTEN_FORM_MAX_STRAY_DELIMITERS_TOTAL; };
  for (const line of source.split("\n")) {
    if (/^\s*$/.test(line)) { if (flush()) return "input-too-complex"; inCode = 0; continue; }
    if (/^(?: {4}|\t)/.test(line) && paragraph === 0 && brackets === 0) continue;
    for (let index = 0; index < line.length;) {
      const character = line[index]!;
      if (character === "\\") { index += 2; continue; }
      if (character === "`") {
        let end = index + 1;
        while (line[end] === "`") end++;
        const length = end - index;
        if (length > WRITTEN_FORM_MAX_DELIMITER_RUN) return "input-too-complex";
        inCode = inCode === 0 ? length : inCode === length ? 0 : inCode;
        index = end; continue;
      }
      if (inCode) { index++; continue; }
      if (character === "[") { brackets++; index++; continue; }
      if (character === "]") {
        if (brackets > 0) { brackets--; if (line[index + 1] === "(") destinations++; } else if (stray()) return "input-too-complex";
        index++; continue;
      }
      if (character === ")") { if (destinations > 0) destinations--; index++; continue; }
      if (character === "*" || character === "_" || character === "~") {
        let end = index + 1;
        while (line[end] === character) end++;
        if (end - index > WRITTEN_FORM_MAX_DELIMITER_RUN) return "input-too-complex";
        const before = line[index - 1], after = line[end];
        const left = !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
        const right = !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
        const canOpen = character === "_" ? left && (!right || isPunctuation(before)) : left;
        const canClose = character === "_" ? right && (!left || isPunctuation(after)) : right;
        if (canClose && open[character]! > 0) open[character]!--;
        else if (canClose) { if (stray()) return "input-too-complex"; }
        else if (canOpen) open[character]!++;
        index = end; continue;
      }
      index++;
    }
    // A list item or quote line starts a new inline context.
    if (/^\s{0,3}(?:[-+*]|\d+[.)]|>)(?:\s|$)/.test(line)) { if (flush()) return "input-too-complex"; }
  }
  return flush() ? "input-too-complex" : null;
}

/** Memory bound: tables are held as one node per cell, so a huge table costs hundreds of MB. Cells are counted per table and in total. */
export const WRITTEN_FORM_MAX_TABLE_CELLS = 20_000;
export const WRITTEN_FORM_MAX_DOCUMENT_CELLS = 20_000;
export const WRITTEN_FORM_TABLE_TOO_LARGE = "This table is too large to save. Split it into smaller tables.";

/** Count the cells of each pipe table (and of all tables) in raw text, outside fenced code. */
export function scanWrittenFormTables(text: string): "table-too-large" | null {
  let total = 0, table = 0;
  for (const line of withoutFencedCode(text).split("\n")) {
    if (!/^ {0,3}\|/.test(line)) { table = 0; continue; }
    if (/^[\s|:-]+$/.test(line) && line.includes("-")) continue; // the delimiter row holds no cells
    let pipes = 0;
    for (let index = 0; index < line.length; index++) { if (line[index] === "\\") index++; else if (line[index] === "|") pipes++; }
    const cells = Math.max(1, /\|\s*$/.test(line) ? pipes - 1 : pipes);
    table += cells; total += cells;
    if (table > WRITTEN_FORM_MAX_TABLE_CELLS || total > WRITTEN_FORM_MAX_DOCUMENT_CELLS) return "table-too-large";
  }
  return null;
}

/** The same bound for a document: cells per table and in total, counted without recursion. */
export function documentTableTooLarge(document: unknown): boolean {
  let total = 0;
  const stack: unknown[] = [document];
  while (stack.length) {
    const node = stack.pop() as { type?: string; content?: unknown[] } | null;
    if (!node || typeof node !== "object") continue;
    if (node.type === "table") {
      let cells = 0;
      const inner: unknown[] = [node];
      while (inner.length) {
        const part = inner.pop() as { type?: string; content?: unknown[] } | null;
        if (!part || typeof part !== "object") continue;
        if (part.type === "tableCell" || part.type === "tableHeader") { cells++; continue; }
        if (Array.isArray(part.content)) for (const child of part.content) inner.push(child);
      }
      total += cells;
      if (cells > WRITTEN_FORM_MAX_TABLE_CELLS || total > WRITTEN_FORM_MAX_DOCUMENT_CELLS) return true;
      continue;
    }
    if (Array.isArray(node.content)) for (const child of node.content) stack.push(child);
  }
  return false;
}

/** Block nesting of a document, counted iteratively so a 100,000-level document cannot overflow the stack. */
export const WRITTEN_FORM_MAX_DOCUMENT_DEPTH = 72;
export function documentTooDeep(document: unknown, limit = WRITTEN_FORM_MAX_DOCUMENT_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[document, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (!node || typeof node !== "object") continue;
    if (depth > limit) return true;
    const content = (node as { content?: unknown }).content;
    if (Array.isArray(content)) for (const child of content) stack.push([child, depth + 1]);
  }
  return false;
}
