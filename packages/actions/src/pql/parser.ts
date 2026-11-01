import { PqlError } from "./errors";

/** Hard limits that keep hostile input cheap to reject. */
export const pqlLimits = { maxLength: 2000, maxTokens: 600, maxDepth: 24, maxListItems: 100, maxLimit: 1000 } as const;

export type Token =
  | { type: "word"; text: string; pos: number; end: number }
  | { type: "string"; text: string; pos: number; end: number }
  | { type: "symbol"; text: string; pos: number; end: number };

const wordStart = /[\p{L}\p{N}_]/u;
const wordPart = /[\p{L}\p{N}_.\-@:/]/u;

/** Splits the source into words, quoted strings and symbols. Anything else is an error at its offset. */
export function tokenize(source: string): Token[] {
  if (source.length > pqlLimits.maxLength) throw new PqlError(pqlLimits.maxLength, `query is longer than ${pqlLimits.maxLength} characters`);
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (/\s/.test(char)) { i += 1; continue; }
    if (tokens.length >= pqlLimits.maxTokens) throw new PqlError(i, `query has more than ${pqlLimits.maxTokens} tokens`);
    if (char === '"' || char === "'") {
      let text = "";
      let j = i + 1;
      for (;;) {
        if (j >= source.length) throw new PqlError(i, "unterminated string");
        const c = source[j]!;
        if (c === "\\" && j + 1 < source.length) {
          const next = source[j + 1]!;
          text += next === '"' || next === "'" || next === "\\" ? next : c + next;
          j += 2;
        } else if (c === char) break;
        else { text += c; j += 1; }
      }
      tokens.push({ type: "string", text, pos: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (char === "!" || char === "<" || char === ">") {
      if (source[i + 1] === "=") { tokens.push({ type: "symbol", text: `${char}=`, pos: i, end: i + 2 }); i += 2; continue; }
      if (char === "!") throw new PqlError(i, 'unexpected "!", did you mean "!="?');
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
    throw new PqlError(i, `unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

export type Operator = "=" | "!=" | "~" | "IN" | "NOT IN" | "<" | "<=" | ">" | ">=" | "BETWEEN" | "IS NULL" | "IS NOT NULL";

/** One value on the right of an operator: a literal (quoted or bare) or a function call. */
export type ValueNode = { kind: "literal"; text: string; quoted: boolean; pos: number } | { kind: "call"; name: string; pos: number };

export type Expr =
  | { kind: "and" | "or"; left: Expr; right: Expr; pos: number }
  | { kind: "not"; expr: Expr; pos: number }
  | { kind: "condition"; field: string; operator: Operator; operatorPos: number; values: ValueNode[]; pos: number }
  | { kind: "call"; name: string; pos: number };

export interface Query {
  where: Expr | null;
  orderBy: Array<{ field: string; direction: "asc" | "desc"; pos: number }>;
  limit: { value: number; pos: number } | null;
}

const upper = (text: string) => text.toUpperCase();
const stopWords = new Set(["AND", "OR", "ORDER", "LIMIT"]);
const comparison = new Set(["=", "!=", "~", "<", "<=", ">", ">="]);

/** Recursive-descent parser: Field Operator Value, AND, OR, NOT, parentheses, ORDER BY, LIMIT. */
export function parse(source: string): Query {
  const tokens = tokenize(source);
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset];
  const endPos = source.length;
  const here = () => peek()?.pos ?? endPos;
  const isWord = (token: Token | undefined, word: string) => token?.type === "word" && upper(token.text) === word;
  const isSymbol = (token: Token | undefined, symbol: string) => token?.type === "symbol" && token.text === symbol;
  const fail = (reason: string, pos = here()): never => { throw new PqlError(pos, reason); };

  function expectSymbol(symbol: string, reason: string) {
    if (!isSymbol(peek(), symbol)) fail(reason);
    at += 1;
  }

  function parseCall(): { name: string; pos: number } {
    const name = peek() as Token;
    at += 1;
    expectSymbol("(", `expected "(" after ${name.text}`);
    if (!isSymbol(peek(), ")")) fail(`function ${name.text}() takes no arguments`);
    at += 1;
    return { name: name.text, pos: name.pos };
  }

  const isCallAhead = () => peek()?.type === "word" && isSymbol(peek(1), "(");

  function parseValue(): ValueNode {
    const token = peek();
    if (!token) return fail("a value is expected");
    if (token.type === "string") { at += 1; return { kind: "literal", text: token.text, quoted: true, pos: token.pos }; }
    if (token.type === "symbol") return fail("a value is expected");
    if (stopWords.has(upper(token.text))) return fail(`a value is expected, found ${token.text}`);
    if (isCallAhead()) return { kind: "call", ...parseCall() };
    // A bare value is a run of words ("In Progress"), read up to AND, OR, ORDER, LIMIT, a symbol or the end.
    const first = token;
    let last: Token = token;
    at += 1;
    while (peek()?.type === "word" && !stopWords.has(upper((peek() as Token).text)) && !isSymbol(peek(1), "(")) { last = peek() as Token; at += 1; }
    return { kind: "literal", text: source.slice(first.pos, last.end), quoted: false, pos: first.pos };
  }

  function parseOperator(): { operator: Operator; pos: number } {
    const token = peek();
    if (!token) return fail("an operator is expected");
    const pos = token.pos;
    if (token.type === "symbol" && comparison.has(token.text)) { at += 1; return { operator: token.text as Operator, pos }; }
    if (token.type === "word") {
      const word = upper(token.text);
      if (word === "IN" || word === "BETWEEN") { at += 1; return { operator: word, pos }; }
      if (word === "NOT" && isWord(peek(1), "IN")) { at += 2; return { operator: "NOT IN", pos }; }
      if (word === "IS") {
        if (isWord(peek(1), "NULL")) { at += 2; return { operator: "IS NULL", pos }; }
        if (isWord(peek(1), "NOT") && isWord(peek(2), "NULL")) { at += 3; return { operator: "IS NOT NULL", pos }; }
        return fail("expected NULL or NOT NULL after IS", peek(1)?.pos ?? endPos);
      }
    }
    return fail(`an operator is expected, found ${token.type === "string" ? "a string" : JSON.stringify(token.text)}`);
  }

  function parseCondition(): Expr {
    const fieldToken = peek() as Token;
    if (fieldToken.type !== "word") return fail(`a field name is expected, found ${JSON.stringify(fieldToken.text)}`);
    if (isCallAhead()) return { kind: "call", ...parseCall() };
    at += 1;
    const { operator, pos: operatorPos } = parseOperator();
    const values: ValueNode[] = [];
    if (operator === "IN" || operator === "NOT IN") {
      expectSymbol("(", `${operator} needs a parenthesised list`);
      for (;;) {
        if (values.length >= pqlLimits.maxListItems) fail(`a list holds at most ${pqlLimits.maxListItems} values`);
        values.push(parseValue());
        if (isSymbol(peek(), ",")) { at += 1; continue; }
        break;
      }
      expectSymbol(")", 'expected "," or ")" in the list');
    } else if (operator === "BETWEEN") {
      values.push(parseValue());
      if (!isWord(peek(), "AND")) fail("BETWEEN needs two values joined by AND");
      at += 1;
      values.push(parseValue());
    } else if (operator !== "IS NULL" && operator !== "IS NOT NULL") values.push(parseValue());
    return { kind: "condition", field: fieldToken.text, operator, operatorPos, values, pos: fieldToken.pos };
  }

  function parsePrimary(depth: number): Expr {
    const token = peek();
    if (!token) return fail("a condition is expected");
    if (isSymbol(token, "(")) {
      if (depth >= pqlLimits.maxDepth) fail(`nesting is deeper than ${pqlLimits.maxDepth} levels`);
      at += 1;
      const inner = parseOr(depth + 1);
      expectSymbol(")", 'expected ")"');
      return inner;
    }
    return parseCondition();
  }

  function parseNot(depth: number): Expr {
    if (isWord(peek(), "NOT")) {
      if (depth >= pqlLimits.maxDepth) fail(`nesting is deeper than ${pqlLimits.maxDepth} levels`);
      const pos = here();
      at += 1;
      return { kind: "not", expr: parseNot(depth + 1), pos };
    }
    return parsePrimary(depth);
  }

  function parseAnd(depth: number): Expr {
    let left = parseNot(depth);
    while (isWord(peek(), "AND")) { const pos = here(); at += 1; left = { kind: "and", left, right: parseNot(depth), pos }; }
    return left;
  }

  function parseOr(depth: number): Expr {
    let left = parseAnd(depth);
    while (isWord(peek(), "OR")) { const pos = here(); at += 1; left = { kind: "or", left, right: parseAnd(depth), pos }; }
    return left;
  }

  const query: Query = { where: null, orderBy: [], limit: null };
  if (peek() && !isWord(peek(), "ORDER") && !isWord(peek(), "LIMIT")) query.where = parseOr(0);
  if (isWord(peek(), "ORDER")) {
    at += 1;
    if (!isWord(peek(), "BY")) fail("expected BY after ORDER");
    at += 1;
    for (;;) {
      const token = peek();
      if (!token || token.type !== "word") return fail("a field name is expected after ORDER BY");
      at += 1;
      let direction: "asc" | "desc" = "asc";
      if (isWord(peek(), "ASC")) at += 1;
      else if (isWord(peek(), "DESC")) { direction = "desc"; at += 1; }
      query.orderBy.push({ field: token.text, direction, pos: token.pos });
      if (isSymbol(peek(), ",")) { at += 1; continue; }
      break;
    }
  }
  if (isWord(peek(), "LIMIT")) {
    at += 1;
    const token = peek();
    if (!token || token.type !== "word" || !/^[0-9]+$/.test(token.text)) return fail("LIMIT needs a whole number");
    at += 1;
    const value = Number(token.text);
    if (value < 1) fail("LIMIT must be at least 1", token.pos);
    if (value > pqlLimits.maxLimit) fail(`LIMIT must be at most ${pqlLimits.maxLimit}`, token.pos);
    query.limit = { value, pos: token.pos };
  }
  if (peek()) fail(`unexpected ${peek()!.type === "string" ? "string" : JSON.stringify(peek()!.text)}`);
  return query;
}
