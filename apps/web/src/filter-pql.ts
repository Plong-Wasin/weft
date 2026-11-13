import { priorityOrder } from "./work-item-layout";

/** The date fields the filter bar offers; each takes an inclusive range with either end optional. */
export const dateFilters = ["startDate", "dueDate", "createdAt"] as const;
export type DateFilter = (typeof dateFilters)[number];
export interface DateRange { from: string; to: string }
/** The named filters the bar offers, in the order they compile. */
export const namedFilters = ["state", "priority", "type", "estimate", "assignee", "label", "cycle", "module", "createdBy"] as const;
export type NamedFilter = (typeof namedFilters)[number];

/** What the filter chips hold. Named filters store ids ("none" in `assignee` means unassigned, priority stores its own names). */
export type Filters = Record<NamedFilter, string[]> & Record<DateFilter, DateRange>;
export type Entry = { id: string; name: string };
/** The project lookups that turn ids into the names PQL reads and back. */
export type Lookup = Record<Exclude<NamedFilter, "priority">, Entry[]>;

export const emptyFilters = (): Filters => ({
  state: [], priority: [], type: [], estimate: [], assignee: [], label: [], cycle: [], module: [], createdBy: [],
  startDate: { from: "", to: "" }, dueDate: { from: "", to: "" }, createdAt: { from: "", to: "" },
});

export const hasFilters = (filters: Filters) => namedFilters.some((key) => filters[key].length > 0) || dateFilters.some((key) => filters[key].from !== "" || filters[key].to !== "");
export const countFilters = (filters: Filters) => namedFilters.filter((key) => filters[key].length > 0).length + dateFilters.filter((key) => filters[key].from !== "" || filters[key].to !== "").length;

const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const operandOf = (entries: Entry[], id: string): string | null => {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  // A name two entries share would be ambiguous in PQL, so it is written as the id.
  return quote(entries.filter((candidate) => candidate.name.toLowerCase() === entry.name.toLowerCase()).length > 1 ? entry.id : entry.name);
};
const setCondition = (field: string, operands: string[]) => operands.length === 0 ? null : operands.length === 1 ? `${field} = ${operands[0]}` : `${field} IN (${operands.join(", ")})`;

/** Writes the chips as one PQL string: the filters joined by AND, in a fixed order, so the same chips always give the same text. */
export function filtersToPql(filters: Filters, lookup: Lookup): string {
  const parts: string[] = [];
  const push = (part: string | null) => { if (part) parts.push(part); };
  push(setCondition("state", filters.state.map((id) => operandOf(lookup.state, id)).filter((value): value is string => value !== null)));
  push(setCondition("priority", filters.priority.filter((id) => (priorityOrder as readonly string[]).includes(id))));
  push(setCondition("type", filters.type.map((id) => operandOf(lookup.type, id)).filter((value): value is string => value !== null)));
  // The chips hold Estimate point ids; PQL reads the point value ("8", "M").
  push(setCondition("estimate", filters.estimate.map((id) => operandOf(lookup.estimate, id)).filter((value): value is string => value !== null)));
  const people = filters.assignee.filter((id) => id !== "none").map((id) => operandOf(lookup.assignee, id)).filter((value): value is string => value !== null);
  const unassigned = filters.assignee.includes("none");
  const assigned = setCondition("assignee", people);
  push(assigned && unassigned ? `(${assigned} OR hasNoAssignee())` : assigned ?? (unassigned ? "hasNoAssignee()" : null));
  for (const key of ["label", "cycle", "module", "createdBy"] as const) push(setCondition(key, filters[key].map((id) => operandOf(lookup[key], id)).filter((value): value is string => value !== null)));
  for (const key of dateFilters) {
    const { from, to } = filters[key];
    push(from && to ? `${key} BETWEEN ${from} AND ${to}` : from ? `${key} >= ${from}` : to ? `${key} <= ${to}` : null);
  }
  return parts.join(" AND ");
}

type Token = { type: "word" | "string" | "symbol"; text: string; pos: number; end: number };
const wordStart = /[\p{L}\p{N}_]/u;
const wordPart = /[\p{L}\p{N}_.\-@:/]/u;

/** A reduced copy of the server tokenizer; anything it cannot read makes the text "not representable", and the server stays the judge of errors. */
function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '"' || char === "'") {
      let text = "";
      let j = i + 1;
      for (;;) {
        if (j >= source.length) return null;
        const c = source[j]!;
        if (c === "\\" && j + 1 < source.length) { const next = source[j + 1]!; text += next === '"' || next === "'" || next === "\\" ? next : c + next; j += 2; }
        else if (c === char) break;
        else { text += c; j += 1; }
      }
      tokens.push({ type: "string", text, pos: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (char === "!" || char === "<" || char === ">") {
      if (source[i + 1] === "=") { tokens.push({ type: "symbol", text: `${char}=`, pos: i, end: i + 2 }); i += 2; continue; }
      if (char === "!") return null;
      tokens.push({ type: "symbol", text: char, pos: i, end: i + 1 });
      i += 1;
      continue;
    }
    if ("=~(),".includes(char)) { tokens.push({ type: "symbol", text: char, pos: i, end: i + 1 }); i += 1; continue; }
    if (wordStart.test(char)) {
      let j = i + 1;
      while (j < source.length && wordPart.test(source[j]!)) j += 1;
      tokens.push({ type: "word", text: source.slice(i, j), pos: i, end: j });
      i = j;
      continue;
    }
    return null;
  }
  return tokens;
}

const stop = new Set(["AND", "OR", "ORDER", "LIMIT"]);
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads PQL back into chips. Returns null when the text uses anything the chips cannot say (OR between fields, NOT, `!=`,
 * functions, ORDER BY, LIMIT, a name that does not exist, the same field twice), so the editor keeps the text as it is.
 */
export function pqlToFilters(source: string, lookup: Lookup): Filters | null {
  const tokens = tokenize(source);
  if (!tokens) return null;
  const filters = emptyFilters();
  if (tokens.length === 0) return filters;
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset];
  const isWord = (token: Token | undefined, word: string) => token?.type === "word" && token.text.toUpperCase() === word;
  const isSymbol = (token: Token | undefined, text: string) => token?.type === "symbol" && token.text === text;
  const seen = new Set<string>();
  const once = (key: string) => { if (seen.has(key)) return false; seen.add(key); return true; };

  const value = (): string | null => {
    const token = peek();
    if (!token || token.type === "symbol") return null;
    if (token.type === "string") { at += 1; return token.text; }
    if (stop.has(token.text.toUpperCase()) || isSymbol(peek(1), "(")) return null;
    let last = token;
    at += 1;
    while (peek()?.type === "word" && !stop.has(peek()!.text.toUpperCase()) && !isSymbol(peek(1), "(")) { last = peek()!; at += 1; }
    return source.slice(token.pos, last.end);
  };
  const resolve = (entries: Entry[], text: string): string | null => {
    const byId = entries.find((entry) => entry.id === text);
    if (byId) return byId.id;
    const named = entries.filter((entry) => entry.name.toLowerCase() === text.toLowerCase());
    return named.length === 1 ? named[0]!.id : null;
  };
  const values = (): string[] | null => {
    if (isSymbol(peek(), "=")) { at += 1; const one = value(); return one === null ? null : [one]; }
    if (!isWord(peek(), "IN") || !isSymbol(peek(1), "(")) return null;
    at += 2;
    const list: string[] = [];
    for (;;) {
      const one = value();
      if (one === null) return null;
      list.push(one);
      if (isSymbol(peek(), ",")) { at += 1; continue; }
      break;
    }
    if (!isSymbol(peek(), ")")) return null;
    at += 1;
    return list;
  };
  const named = (field: NamedFilter): boolean => {
    const list = values();
    if (!list || !once(field)) return false;
    const ids: string[] = [];
    for (const text of list) {
      const id = field === "priority" ? (priorityOrder as readonly string[]).includes(text.toLowerCase()) ? text.toLowerCase() : null : resolve(lookup[field], text);
      if (id === null) return false;
      if (!ids.includes(id)) ids.push(id);
    }
    filters[field] = field === "assignee" ? [...filters.assignee.filter((id) => id === "none"), ...ids] : ids;
    return true;
  };
  const day = (): string | null => { const text = value(); return text !== null && isoDay.test(text) ? text : null; };
  const dated = (field: DateFilter): boolean => {
    const range = filters[field];
    if (isWord(peek(), "BETWEEN")) {
      at += 1;
      const from = day();
      if (from === null || !isWord(peek(), "AND")) return false;
      at += 1;
      const to = day();
      if (to === null || range.from || range.to) return false;
      filters[field] = { from, to };
      return true;
    }
    const symbol = peek();
    if (!isSymbol(symbol, ">=") && !isSymbol(symbol, "<=")) return false;
    at += 1;
    const one = day();
    const end = symbol!.text === "<=" ? "to" : "from";
    if (one === null || range[end]) return false;
    filters[field] = { ...range, [end]: one };
    return true;
  };
  const isCall = (name: string) => peek()?.type === "word" && peek()!.text.toLowerCase() === name.toLowerCase() && isSymbol(peek(1), "(") && isSymbol(peek(2), ")");
  const unassigned = (): boolean => {
    if (!isCall("hasNoAssignee")) return false;
    at += 3;
    filters.assignee = ["none", ...filters.assignee.filter((id) => id !== "none")];
    return true;
  };
  const condition = (): boolean => {
    const token = peek();
    if (!token || token.type !== "word") return false;
    if (isCall("hasNoAssignee")) return once("assignee") && unassigned();
    const key = [...namedFilters, ...dateFilters].find((candidate) => candidate.toLowerCase() === token.text.toLowerCase());
    if (!key) return false;
    at += 1;
    return (dateFilters as readonly string[]).includes(key) ? dated(key as DateFilter) : named(key as NamedFilter);
  };
  const term = (): boolean => {
    if (!isSymbol(peek(), "(")) return condition();
    // Only the shape the chips write for "these people or unassigned" may be parenthesised, in either order.
    at += 1;
    const callFirst = isCall("hasNoAssignee");
    if (callFirst) { if (!unassigned() || !isWord(peek(), "OR")) return false; at += 1; }
    if (peek()?.type !== "word" || peek()!.text.toLowerCase() !== "assignee") return false;
    at += 1;
    if (!named("assignee")) return false;
    if (!callFirst) { if (!isWord(peek(), "OR")) return false; at += 1; if (!unassigned()) return false; }
    if (!isSymbol(peek(), ")")) return false;
    at += 1;
    return true;
  };

  if (!term()) return null;
  while (at < tokens.length) {
    if (!isWord(peek(), "AND")) return null;
    at += 1;
    if (!term()) return null;
  }
  return filters;
}
