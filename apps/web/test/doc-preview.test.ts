import { expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownToDoc } from "../../../packages/actions/src/markdown-doc";
import { DocPreview } from "../src/doc-preview";

const html = (doc: unknown) => renderToStaticMarkup(React.createElement(DocPreview, { doc }));

test("renders headings, marks, lists and code from the editor document", () => {
  const out = html(markdownToDoc("## Plan\n\nA **bold** and [site](https://x.test)\n\n- one\n- two\n\n```\ncode\n```"));
  expect(out).toContain("<h2>Plan</h2>");
  expect(out).toContain("<strong>bold</strong>");
  expect(out).toContain('<a href="https://x.test"');
  expect(out).toContain("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
  expect(out).toContain("<pre><code>code</code></pre>");
});

test("never renders unsafe links and tolerates unknown nodes", () => {
  const out = html({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }, { type: "mystery", content: [{ type: "text", text: "kept" }] }] });
  expect(out).not.toContain("javascript:");
  expect(out).toContain("kept");
});

test("an empty or missing document renders nothing", () => {
  expect(html(null)).toBe("");
  expect(html("not a doc")).toBe("");
});
