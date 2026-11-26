import React from "react";
import { Link } from "react-router";
import { displayIdPattern } from "./ai-results";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** An image is loaded only when it lives on this origin; anything with a scheme or `//` could leak data through its URL. */
export function isLocalImage(src: unknown) {
  return typeof src === "string" && src.startsWith("/") && !src.startsWith("//");
}

const components: Components = {
  // `data-display-id` is set only by `linkDisplayIds`: raw HTML is never parsed, so an answer cannot fake it.
  a: ({ node, href, children }) => node?.properties.dataDisplayId ? <Link to={href!} className="text-foreground underline">{children}</Link> : <a href={href} target="_blank" rel="noopener noreferrer" className="text-foreground underline">{children}</a>,
  img: ({ node: _node, src, alt }) => isLocalImage(src) ? <img src={src as string} alt={alt ?? ""} /> : <span>{alt}</span>,
  h1: ({ node: _node, children }) => <h1 className="mb-2 mt-4 text-20 font-semibold">{children}</h1>,
  h2: ({ node: _node, children }) => <h2 className="mb-2 mt-4 text-18 font-semibold">{children}</h2>,
  h3: ({ node: _node, children }) => <h3 className="mb-1 mt-3 text-16 font-semibold">{children}</h3>,
  h4: ({ node: _node, children }) => <h4 className="mb-1 mt-3 text-16 font-semibold">{children}</h4>,
  p: ({ node: _node, children }) => <p className="my-2">{children}</p>,
  ul: ({ node: _node, children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
  ol: ({ node: _node, children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
  pre: ({ node: _node, children }) => <pre className="my-2 overflow-x-auto whitespace-pre rounded-lg bg-card p-3 font-mono text-14">{children}</pre>,
  code: ({ node: _node, className, children }) => <code className={className ?? "rounded bg-card px-1 font-mono text-14"}>{children}</code>,
  table: ({ node: _node, children }) => <div className="my-2 overflow-x-auto"><table className="border-collapse text-14">{children}</table></div>,
  th: ({ node: _node, children }) => <th className="border border-border px-3 py-1 text-left font-semibold">{children}</th>,
  td: ({ node: _node, children }) => <td className="border border-border px-3 py-1">{children}</td>,
};

type MdNode = { type: string; value?: string; url?: string; data?: unknown; children?: MdNode[] };

/** Turns the display ids that resolved for this viewer into links inside the app; code and existing links stay as written. */
const linkDisplayIds = (links: ReadonlyMap<string, string>) => () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text") { walk(child); return [child]; }
      const text = child.value!;
      const out: MdNode[] = [];
      let from = 0;
      for (const match of text.matchAll(displayIdPattern)) {
        const url = links.get(match[0]);
        if (!url) continue;
        out.push({ type: "text", value: text.slice(from, match.index) }, { type: "link", url, data: { hProperties: { "data-display-id": match[0] } }, children: [{ type: "text", value: match[0] }] });
        from = match.index + match[0].length;
      }
      return from === 0 ? [child] : [...out, { type: "text", value: text.slice(from) }];
    });
  };
  walk(tree);
};

/** An AI answer as safe Markdown: GFM, raw HTML dropped (react-markdown never parses it), external images and script links neutralised. */
export function Markdown({ text, links }: { text: string; links?: ReadonlyMap<string, string> }) {
  return <div className="min-w-0 [overflow-wrap:anywhere] [&_table]:[overflow-wrap:normal] text-16 leading-7 text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"><ReactMarkdown remarkPlugins={links?.size ? [remarkGfm, linkDisplayIds(links)] : [remarkGfm]} components={components}>{text}</ReactMarkdown></div>;
}
