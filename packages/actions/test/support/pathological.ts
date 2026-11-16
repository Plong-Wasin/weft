/** Inputs the review measured as quadratic inside remark/micromark: none is caught by the raw-text pre-scans. */
export const pathologicalTexts: Record<string, string> = {
  "www.a_ x4000 (24 KB, unspaced)": "www.a_".repeat(4_000),
  "www.a_ x8000 (48 KB, unspaced)": "www.a_".repeat(8_000),
  "```\\n x10000 (40 KB)": "```\n".repeat(10_000),
  "```\\\\ x10000 (40 KB)": "```\\".repeat(10_000),
  "=\\\\\\n x13333 (40 KB)": "=\\\n".repeat(13_333),
  "[^1]:1.  x5000 (40 KB)": "[^1]:1. ".repeat(5_000),
};
/** Text nodes whose escaped Written form is still slow to parse back. */
export const pathologicalDocumentTexts: Record<string, string> = {
  "[[ x30000": "[[".repeat(30_000),
  "=\\n x30000": "=\n".repeat(30_000),
};
export const tableDocument = (rows: number, cells = 2) => ({ type: "doc", content: [{ type: "table", content: Array.from({ length: rows }, (_, row) => ({ type: "tableRow", content: Array.from({ length: cells }, () => ({ type: row === 0 ? "tableHeader" : "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] })) })) }] });
