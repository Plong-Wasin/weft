import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/markdown";

const html = (text: string) => renderToStaticMarkup(React.createElement(Markdown, { text }));

test("renders headings, lists, tables, emphasis and code blocks", () => {
  const out = html("## Title\n\n- one\n- two\n\n1. a\n\n| h | v |\n|---|---|\n| x | y |\n\n**bold** *it*\n\n```\nlet a  = 1\n```");
  expect(out).toContain("<h2");
  expect(out).toContain("<ul");
  expect(out).toContain("<ol");
  expect(out).toContain("<table");
  expect(out).toContain("<strong>bold</strong>");
  expect(out).toContain("<pre");
  expect(out).not.toContain("##");
});

test("renders unfinished streaming Markdown without raw markers", () => {
  const out = html("## Plan\n\n- first\n- sec");
  expect(out).toContain("<h2");
  expect(out).toContain("<li>sec</li>");
});

test("raw HTML is not rendered", () => {
  const out = html('<script>alert(1)</script><b onclick="x()">hi</b><img src="https://evil.test/a.png">');
  expect(out).not.toContain("<script");
  expect(out).not.toContain("<b ");
  expect(out).not.toContain("<img");
  expect(out).toContain("&lt;script&gt;");
});

test("external images are not loaded, local ones are", () => {
  expect(html("![alt](https://evil.test/a.png?q=secret)")).not.toContain("<img");
  expect(html("![alt](//evil.test/a.png)")).not.toContain("<img");
  expect(html("![alt](data:image/png;base64,AAAA)")).not.toContain("<img");
  expect(html("![alt](/uploads/a.png)")).toContain('<img src="/uploads/a.png"');
});

test("links open in a new tab with noopener noreferrer and javascript: links are dropped", () => {
  const out = html("[x](https://example.test)");
  expect(out).toContain('target="_blank"');
  expect(out).toContain('rel="noopener noreferrer"');
  expect(html("[x](javascript:alert(1))")).not.toContain("javascript:");
});
