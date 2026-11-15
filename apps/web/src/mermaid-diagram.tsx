import React from "react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { translate } from "@weft/shared";

const allowedElements = new Set(["svg", "g", "path", "rect", "line", "polyline", "polygon", "circle", "ellipse", "text", "tspan", "defs", "marker", "clipPath", "foreignObject", "div", "span", "p", "br", "strong", "em", "style", "title", "desc"]);
const allowedAttributes = new Set(["xmlns", "viewBox", "preserveAspectRatio", "class", "id", "d", "x", "y", "dy", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "points", "transform", "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "alignment-baseline", "marker-start", "marker-mid", "marker-end", "clip-path", "style", "role", "aria-label"]);
const unsafeCss = /javascript:|https?:|data:|@import|expression|url\s*\(\s*(?!#)[^)]+\)/i;

/** Keep Mermaid's generated SVG geometry while removing every active or resource-loading feature. */
export function sanitizeMermaidSvg(source: string): string {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) throw new Error("Mermaid produced invalid SVG");
  const visit = (element: Element) => {
    for (const child of [...element.children]) {
      if (!allowedElements.has(child.localName)) { child.remove(); continue; }
      visit(child);
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name;
      const value = attribute.value;
      if (!allowedAttributes.has(name) || /^on/i.test(name) || unsafeCss.test(value)) {
        element.removeAttribute(name);
      }
    }
    if (element.localName === "style" && unsafeCss.test(element.textContent ?? "")) element.remove();
  };
  visit(root);
  if (!root.querySelector("path, rect, line, polyline, polygon, circle, ellipse, text, tspan, foreignObject")) throw new Error("Mermaid produced no safe visible content");
  if (![...root.querySelectorAll("text, tspan, foreignObject")].some((label) => (label.textContent ?? "").trim())) throw new Error("Mermaid produced no safe readable labels");
  return new XMLSerializer().serializeToString(root);
}

/** Mermaid init/config directives can inject document-wide themeCSS, so they never reach the renderer. */
export function stripMermaidDirectives(source: string): string {
  source = source.replace(/^\uFEFF?\s*---[^\r\n]*\r?\n[\s\S]*?\r?\n---[^\r\n]*(?:\r?\n|$)/, "");
  const directiveStart = /%%\{\s*(?:init|initialize|config)\s*:/gi;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = directiveStart.exec(source))) {
    const start = match.index;
    let depth = 0;
    let quote: "'" | '"' | null = null;
    let escaped = false;
    let end = source.length;
    for (let index = start + 2; index < source.length; index += 1) {
      const char = source[index]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0 && source.slice(index + 1, index + 3) === "%%") { end = index + 3; break; }
      }
    }
    output += source.slice(cursor, start);
    cursor = end;
    directiveStart.lastIndex = end;
  }
  return output + source.slice(cursor);
}

let rendererPromise: Promise<typeof import("mermaid")> | undefined;
let renderSequence = 0;
let renderQueue: Promise<void> = Promise.resolve();

function MermaidDiagram({ code, onFailureChange }: { code: string; onFailureChange?: (failed: boolean) => void }) {
  const [svg, setSvg] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  const [theme, setTheme] = React.useState<"default" | "dark">("default");
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const update = () => setTheme(root.getAttribute("data-theme") === "dark" ? "dark" : "default");
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    let active = true;
    setSvg("");
    setFailed(false);
    rendererPromise ??= import("mermaid").then((module) => {
      module.default.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false }, sequence: { useMaxWidth: true } });
      return module;
    }).catch((error) => { rendererPromise = undefined; throw error; });
    void rendererPromise.then(async ({ default: mermaid }) => {
      try {
        let svgResult: { svg: string } | undefined;
        renderQueue = renderQueue.then(async () => {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, htmlLabels: false, theme, flowchart: { htmlLabels: false }, sequence: { useMaxWidth: true } });
          svgResult = await mermaid.render(`weft-mermaid-${++renderSequence}`, stripMermaidDirectives(code));
        });
        await renderQueue;
        const result = svgResult!;
        const safe = sanitizeMermaidSvg(result.svg);
        if (active) setSvg(safe);
      } catch {
        if (active) setFailed(true);
      }
    });
    return () => { active = false; };
  }, [code, theme]);
  React.useEffect(() => { onFailureChange?.(failed); }, [failed, onFailureChange]);
  if (failed) return <div className="mermaid-error" role="status">{translate("editor.mermaidError")}</div>;
  if (!svg) return <div className="mermaid-loading" role="status">{translate("editor.mermaidLoading")}</div>;
  return <div className="mermaid-diagram" data-testid="mermaid-diagram"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={translate("editor.mermaidAlt")} /></div>;
}

/** Local rendering is only requested for a Mermaid code block; source stays available without crowding the diagram. */
export const MermaidCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(function CodeBlockView({ node }) {
      const isDiagram = node.attrs.language === "mermaid";
      const [failed, setFailed] = React.useState(false);
      const onFailureChange = React.useCallback((value: boolean) => setFailed(value), []);
      const isDiff = node.attrs.language === "diff";
      return <NodeViewWrapper as="div" className={isDiagram ? "mermaid-code-block" : "code-block-node"}>
        {isDiagram && <MermaidDiagram code={node.textContent} onFailureChange={onFailureChange} />}
        {!isDiagram && isDiff && <><p className="diff-caption">{translate("editor.diffCaption")}</p><p className="diff-legend">{translate("editor.diffLegend")}</p></>}
        {isDiagram
          ? <details className="mermaid-source" open={failed}><summary>{translate("editor.mermaidSource")}</summary><pre><NodeViewContent /></pre></details>
          : <pre><NodeViewContent /></pre>}
      </NodeViewWrapper>;
    }, { contentDOMElementTag: "code" });
  },
});

export function MermaidPreview({ code }: { code: string }) {
  const [failed, setFailed] = React.useState(false);
  const onFailureChange = React.useCallback((value: boolean) => setFailed(value), []);
  return <div className="mermaid-preview"><MermaidDiagram code={code} onFailureChange={onFailureChange} /><details className="mermaid-source" open={failed}><summary>{translate("editor.mermaidSource")}</summary><pre><code>{code}</code></pre></details></div>;
}
