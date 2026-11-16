/** Seeded generator of nested container documents: quotes, lists, task lists, tables and callouts holding headings, rules, images and code, up to four levels deep. */
export function containerDocuments(seed: number, runs: number) {
  let state = seed;
  const random = () => { state = state + 0x6d2b79f5 | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const pick = <T,>(a: T[]) => a[Math.floor(random() * a.length)]!;
  let n = 0;
  const text = () => "w" + (n++);
  const para = () => ({ type: "paragraph", content: [{ type: "text", text: text() }] });
  const leaf = (): any => pick([para, para, () => ({ type: "heading", attrs: { level: 1 + Math.floor(random() * 6) }, content: [{ type: "text", text: text() }] }), () => ({ type: "horizontalRule" }), () => ({ type: "assetImage", attrs: { assetId: "a" + n++, alt: random() < 0.5 ? "alt" + n : null } }), () => ({ type: "codeBlock", attrs: { language: random() < 0.5 ? "json" : null }, content: [{ type: "text", text: text() }] })])();
  const container = (depth: number): any => {
    const kinds = ["blockquote", "bulletList", "orderedList", "taskList", "table", "callout"];
    const kind = pick(kinds);
    const kids = () => Array.from({ length: 1 + Math.floor(random() * 3) }, () => block(depth + 1));
    if (kind === "blockquote") return { type: "blockquote", content: kids() };
    if (kind === "callout") return { type: "callout", attrs: { type: "note" }, content: kids() };
    if (kind === "table") return { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: kids() }, { type: "tableHeader", content: [para()] }] }, { type: "tableRow", content: [{ type: "tableCell", content: kids() }, { type: "tableCell", content: kids() }] }] };
    const itemType = kind === "taskList" ? "taskItem" : "listItem";
    const items = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ type: itemType, ...(kind === "taskList" ? { attrs: { checked: random() < 0.5 } } : {}), content: [random() < 0.8 ? para() : block(depth + 1), ...Array.from({ length: Math.floor(random() * 3) }, () => block(depth + 1))] }));
    return { type: kind, ...(kind === "orderedList" ? { attrs: { start: 1 + Math.floor(random() * 9) } } : {}), content: items };
  };
  const block = (depth: number): any => depth >= 4 || random() < 0.35 ? leaf() : container(depth);
  
  const documents: unknown[] = [];
  for (let i = 0; i < runs; i++) documents.push({ type: "doc", content: Array.from({ length: 1 + Math.floor(random() * 3) }, () => container(0)) });
  return documents;
}
