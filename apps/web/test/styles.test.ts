import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "..", "src");
const read = (name: string) => readFileSync(join(src, name), "utf8");

test("tokens are defined once, for light and dark, and Tailwind maps them", () => {
  const tokens = read("tokens.css");
  for (const name of ["--bg-canvas", "--bg-surface-1", "--txt-primary", "--border-subtle", "--bg-accent-primary"]) {
    expect(tokens.match(new RegExp(`^\\s*${name}:`, "gm"))?.length).toBe(2); // once per theme
  }
  expect(tokens).toContain(':root[data-theme="dark"]');
  const style = read("style.css");
  expect(style).toContain('@import "tailwindcss"');
  expect(style).toContain("--color-canvas: var(--bg-canvas)");
});

test("the app stylesheet has no unlayered element selectors that fight Tailwind", () => {
  const css = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const stripAtRule = (source: string, pattern: RegExp) => {
    let result = source;
    for (let match; (match = pattern.exec(result));) {
      const open = result.indexOf("{", match.index);
      let depth = 1, end = open + 1;
      while (depth && end < result.length) { if (result[end] === "{") depth++; else if (result[end] === "}") depth--; end++; }
      result = result.slice(0, match.index) + result.slice(end);
      pattern.lastIndex = 0;
    }
    return result;
  };
  const unlayered = stripAtRule(stripAtRule(css, /@layer\s+\w+\s*\{/g), /@theme\s*\{/g);
  const selectors = [...unlayered.matchAll(/(^|\})\s*([^@{}\n][^{}]*)\{/g)].map((match) => match[2]!.trim());
  expect(selectors).toEqual([]);
});
