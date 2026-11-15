import { expect, test } from "bun:test";
import { prepareRichText } from "../src/rich-markdown";
import { markdownToDocWithWarnings } from "../src/markdown-doc";

// Whitespace at the edge of a line is exact: written as character references and read back unchanged, a hard break stays a hard break, and what cannot be kept is named.
const paragraph = (...content: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
const text = (value: string) => ({ type: "text", text: value });
const written = (document: unknown) => prepareRichText(document, undefined, "d", "m", {}, "derived");
const readBack = (markdown: string) => (markdownToDocWithWarnings(markdown, { trustedSource: true } as never).document as { content: Array<{ content: unknown[] }> }).content[0]!.content;

test("a tab before a hard break and a tab after it are kept, and the hard break stays a hard break", () => {
  const result = written(paragraph(text("a\t"), { type: "hardBreak" }, text("\tb")));
  expect(result.warningDetails.map(({ code }) => code)).toEqual([]);
  expect(readBack(result.markdown)).toEqual([text("a\t"), { type: "hardBreak" }, text("\tb")]);
});

for (const value of ["\tindent", "end\t", "end  ", "  start", "a\tb", " both "]) {
  test(`leading, trailing and inner whitespace is exact: ${JSON.stringify(value)}`, () => {
    const result = written(paragraph(text(value)));
    expect(result.warningDetails.map(({ code }) => code)).toEqual([]);
    expect(readBack(result.markdown)).toEqual([text(value)]);
  });
}

test("a byte-order mark that cannot be kept is named, not reported as a generic structure change", () => {
  const result = written(paragraph(text("﻿start")));
  expect(result.warningDetails.map(({ code }) => code)).toEqual(["whitespace-simplified"]);
  expect(result.warningDetails[0]!.message).toContain("byte-order mark");
});

// The wording of what could not be kept is part of the contract: each category is named in plain words.
import { whitespaceChanges } from "../src/rich-markdown";
const docOf = (...content: unknown[]) => paragraph(...content);
test("whitespaceChanges names each category of lost whitespace", () => {
  expect(whitespaceChanges(docOf(text("a\tb")), docOf(text("a b")))).toBe("tabs");
  expect(whitespaceChanges(docOf(text("a ")), docOf(text("a")))).toBe("spaces at the start or end of a line");
  expect(whitespaceChanges(docOf(text(" a")), docOf(text("a")))).toBe("spaces at the start or end of a line");
  expect(whitespaceChanges(docOf(text("﻿a")), docOf(text("a")))).toBe("an invisible byte-order mark");
  expect(whitespaceChanges(docOf(text("a"), { type: "hardBreak" }, text("b")), docOf(text("a b")))).toBe("a hard break became a plain newline");
  expect(whitespaceChanges(docOf(text("a  b")), docOf(text("a b")))).toBe("runs of spaces");
  expect(whitespaceChanges(docOf(text("a b")), docOf(text("a b")))).toBeNull();
  // Several categories are all named.
  expect(whitespaceChanges(docOf(text("\ta ")), docOf(text("a")))).toBe("tabs, spaces at the start or end of a line");
});

test("a lost byte-order mark is reported with the code and the named category, once", () => {
  const result = written(paragraph(text("﻿start")));
  expect(result.warningDetails.filter(({ code }) => code === "whitespace-simplified")).toEqual([
    { code: "whitespace-simplified", message: "Some whitespace was simplified (an invisible byte-order mark). The words and links are unchanged." },
  ]);
});
