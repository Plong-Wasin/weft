import * as React from "react";

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = { type?: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Mark[] };

/** Same rule as the Markdown converter: only web, mail and relative links are clickable. */
const safeHref = (url: unknown) => typeof url === "string" && /^(https?:|mailto:|\/|#)/i.test(url.trim());

function marked(text: string, marks: Mark[] = []): React.ReactNode {
  return marks.reduce<React.ReactNode>((child, mark) => {
    switch (mark.type) {
      case "bold": return <strong>{child}</strong>;
      case "italic": return <em>{child}</em>;
      case "strike": return <s>{child}</s>;
      case "code": return <code>{child}</code>;
      case "link": return safeHref(mark.attrs?.href) ? <a href={String(mark.attrs!.href)} target="_blank" rel="noreferrer noopener">{child}</a> : child;
      default: return child;
    }
  }, text);
}

function nodes(list: Node[] | undefined): React.ReactNode {
  return (list ?? []).map((node, index) => <React.Fragment key={index}>{block(node)}</React.Fragment>);
}

function block(node: Node): React.ReactNode {
  switch (node.type) {
    case "text": return marked(node.text ?? "", node.marks);
    case "hardBreak": return <br />;
    case "paragraph": return <p>{nodes(node.content)}</p>;
    case "heading": { const Tag = `h${Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6)}` as "h1"; return <Tag>{nodes(node.content)}</Tag>; }
    case "bulletList": return <ul>{nodes(node.content)}</ul>;
    case "orderedList": return <ol>{nodes(node.content)}</ol>;
    case "listItem": return <li>{nodes(node.content)}</li>;
    case "blockquote": return <blockquote>{nodes(node.content)}</blockquote>;
    case "horizontalRule": return <hr />;
    case "codeBlock": return <pre><code>{nodes(node.content)}</code></pre>;
    case "table": return <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-left text-13"><thead>{block(node.content?.[0] ?? {})}</thead><tbody>{nodes(node.content?.slice(1))}</tbody></table></div>;
    case "tableRow": return <tr>{nodes(node.content)}</tr>;
    case "tableHeader": return <th className="border border-subtle bg-layer-1 px-2 py-1 text-left font-medium">{nodes(node.content)}</th>;
    case "tableCell": return <td className="border border-subtle px-2 py-1">{nodes(node.content)}</td>;
    // Anything else the preview does not know (mentions…) still shows its text.
    default: return nodes(node.content);
  }
}

/** Read-only view of an editor (Tiptap) document, so a Confirmation card shows what the page will hold. Renders nothing for a value that is not a document. */
export function DocPreview({ doc }: { doc: unknown }) {
  if (typeof doc !== "object" || doc === null || (doc as Node).type !== "doc") return null;
  return <div className="doc-preview grid gap-2 text-14 text-primary">{nodes((doc as Node).content)}</div>;
}
