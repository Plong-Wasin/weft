import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { PhrasingContent, Root, RootContent } from "mdast";

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Mark[] };

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
      case "text": return node.value ? [{ type: "text", text: node.value, ...(marks.length ? { marks } : {}) }] : [];
      case "strong": return inline(node.children, withMarks({ type: "bold" }));
      case "emphasis": return inline(node.children, withMarks({ type: "italic" }));
      case "delete": return inline(node.children, withMarks({ type: "strike" }));
      case "inlineCode": return node.value ? [{ type: "text", text: node.value, marks: withMarks({ type: "code" }) }] : [];
      case "link": return inline(node.children, withMarks({ type: "link", attrs: { href: node.url } }));
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
      case "blockquote": return [{ type: "blockquote", content: blocks(node.children) }];
      case "thematicBreak": return [{ type: "horizontalRule" }];
      case "list": {
        const items = node.children.map((item) => ({ type: "listItem", content: blocks(item.children).length ? blocks(item.children) : [{ type: "paragraph" }] }));
        return [node.ordered ? { type: "orderedList", attrs: { start: node.start ?? 1 }, content: items } : { type: "bulletList", content: items }];
      }
      // Tables, raw HTML and anything else the editor lacks: its text, one paragraph per row/line.
      case "table": return node.children.map((row) => paragraph([{ type: "text", value: row.children.map(plain).join(" | ") }]));
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
