import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { PhrasingContent, Root, RootContent } from "mdast";

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Mark[] };

/** Only web, mail and relative links reach the wiki; a `javascript:` or `data:` URL from an injected answer is dropped. */
const safeHref = (url: string) => /^(https?:|mailto:|\/|#)/i.test(url.trim());

const parser = unified().use(remarkParse).use(remarkGfm);

/** Plain text of a Markdown subtree, markers dropped. */
function plain(node: RootContent | PhrasingContent): string {
  if ("value" in node) return node.value;
  if ("alt" in node && node.type === "image") return node.alt ?? "";
  return "children" in node ? (node.children as RootContent[]).map(plain).join("") : "";
}

function inline(nodes: PhrasingContent[], marks: Mark[] = []): Node[] {
  return nodes.flatMap((node): Node[] => {
    const withMarks = (extra: Mark): Mark[] => [...marks, extra];
    switch (node.type) {
      case "text": {
        const parts: Node[] = [];
        const matcher = /@\{([^{}]+)\}/g;
        let start = 0;
        for (const match of node.value.matchAll(matcher)) {
          const index = match.index!;
          if (index > start) parts.push({ type: "text", text: node.value.slice(start, index), ...(marks.length ? { marks } : {}) });
          const token = match[1]!.trim();
          if (token) parts.push({ type: "mention", attrs: { id: token, label: token } });
          start = index + match[0].length;
        }
        if (start < node.value.length) parts.push({ type: "text", text: node.value.slice(start), ...(marks.length ? { marks } : {}) });
        return parts;
      }
      case "strong": return inline(node.children, withMarks({ type: "bold" }));
      case "emphasis": return inline(node.children, withMarks({ type: "italic" }));
      case "delete": return inline(node.children, withMarks({ type: "strike" }));
      // The editor's code mark excludes every other mark, so code inside bold or a link keeps only `code`.
      case "inlineCode": return node.value ? [{ type: "text", text: node.value, marks: [{ type: "code" }] }] : [];
      case "link": return safeHref(node.url) ? inline(node.children, withMarks({ type: "link", attrs: { href: node.url } })) : inline(node.children, marks);
      case "break": return [{ type: "hardBreak" }];
      default: { const text = plain(node); return text ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }] : []; }
    }
  });
}

function paragraph(nodes: PhrasingContent[]): Node {
  const content = inline(nodes);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

function blocks(nodes: RootContent[]): Node[] {
  return nodes.flatMap((node): Node[] => {
    switch (node.type) {
      case "paragraph": return [paragraph(node.children)];
      case "heading": return [{ type: "heading", attrs: { level: Math.min(node.depth, 4) }, content: inline(node.children) }];
      case "code": return [{ type: "codeBlock", attrs: { language: node.lang ?? null }, ...(node.value ? { content: [{ type: "text", text: node.value }] } : {}) }];
      case "blockquote": { const inner = blocks(node.children); return [{ type: "blockquote", content: inner.length ? inner : [{ type: "paragraph" }] }]; }
      case "thematicBreak": return [{ type: "horizontalRule" }];
      case "list": {
        // A list item is a paragraph followed by blocks, so an item that starts with a list, code or heading gets an empty paragraph first.
        const groups: Array<{ task: boolean; items: typeof node.children }> = [];
        for (const item of node.children) {
          const task = item.checked !== null && item.checked !== undefined;
          const group = groups.at(-1);
          if (group?.task === task) group.items.push(item); else groups.push({ task, items: [item] });
        }
        return groups.map(({ task, items: source }) => {
          const items = source.map((item) => { const inner = blocks(item.children); return { type: task ? "taskItem" : "listItem", ...(task ? { attrs: { checked: item.checked === true } } : {}), content: inner[0]?.type === "paragraph" ? inner : [{ type: "paragraph" }, ...inner] }; });
          return task ? { type: "taskList", content: items } : node.ordered ? { type: "orderedList", attrs: { start: node.start ?? 1 }, content: items } : { type: "bulletList", content: items };
        });
      }
      case "table": {
        const columnCount = Math.max(1, ...node.children.map((row) => row.children.length));
        return [{ type: "table", content: node.children.map((row, rowIndex) => ({
          type: "tableRow",
          content: Array.from({ length: columnCount }, (_, columnIndex) => {
            const cell = row.children[columnIndex];
            return {
              type: rowIndex === 0 ? "tableHeader" : "tableCell",
              content: cell ? [paragraph(cell.children)] : [{ type: "paragraph" }],
            };
          }),
        })) }];
      }
      // Raw HTML and anything else the editor lacks: its text, one paragraph per row/line.
      default: { const text = plain(node); return text.trim() ? text.split(/\n+/).filter((l) => l.trim()).map((l) => paragraph([{ type: "text", value: l }])) : []; }
    }
  });
}

/** AI answer Markdown to the wiki editor's (TipTap) document JSON. Never throws on unsupported nodes. */
export function markdownToDoc(text: string): { type: "doc"; content: Node[] } {
  const tree = parser.parse(text) as Root;
  const content = blocks(tree.children);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/** First non-empty line of the answer without Markdown markers, capped at 120 characters. */
export function markdownTitle(text: string): string {
  const tree = parser.parse(text) as Root;
  const first = tree.children.map((n) => plain(n).split("\n").find((l) => l.trim())?.trim() ?? "").find(Boolean) ?? "";
  return first.slice(0, 120);
}
