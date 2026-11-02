import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** An image is loaded only when it lives on this origin; anything with a scheme or `//` could leak data through its URL. */
export function isLocalImage(src: unknown) {
  return typeof src === "string" && src.startsWith("/") && !src.startsWith("//");
}

const components: Components = {
  a: ({ node: _node, href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-primary underline">{children}</a>,
  img: ({ node: _node, src, alt }) => isLocalImage(src) ? <img src={src as string} alt={alt ?? ""} /> : <span>{alt}</span>,
  h1: ({ node: _node, children }) => <h1 className="mb-2 mt-4 text-20 font-semibold">{children}</h1>,
  h2: ({ node: _node, children }) => <h2 className="mb-2 mt-4 text-18 font-semibold">{children}</h2>,
  h3: ({ node: _node, children }) => <h3 className="mb-1 mt-3 text-16 font-semibold">{children}</h3>,
  h4: ({ node: _node, children }) => <h4 className="mb-1 mt-3 text-16 font-semibold">{children}</h4>,
  p: ({ node: _node, children }) => <p className="my-2">{children}</p>,
  ul: ({ node: _node, children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
  ol: ({ node: _node, children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
  pre: ({ node: _node, children }) => <pre className="my-2 overflow-x-auto whitespace-pre rounded-lg bg-layer-2 p-3 font-mono text-14">{children}</pre>,
  code: ({ node: _node, className, children }) => <code className={className ?? "rounded bg-layer-2 px-1 font-mono text-14"}>{children}</code>,
  table: ({ node: _node, children }) => <div className="my-2 overflow-x-auto"><table className="border-collapse text-14">{children}</table></div>,
  th: ({ node: _node, children }) => <th className="border border-subtle px-3 py-1 text-left font-semibold">{children}</th>,
  td: ({ node: _node, children }) => <td className="border border-subtle px-3 py-1">{children}</td>,
};

/** An AI answer as safe Markdown: GFM, raw HTML dropped (react-markdown never parses it), external images and script links neutralised. */
export function Markdown({ text }: { text: string }) {
  return <div className="text-16 leading-7 text-primary [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown></div>;
}
