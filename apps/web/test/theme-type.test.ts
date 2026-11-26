import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const src = join(import.meta.dir, "../src");
const style = readFileSync(join(src, "style.css"), "utf8");
const files = (readdirSync(src, { recursive: true }) as string[]).filter((name) => /\.tsx?$/.test(name)).map((name) => join(src, name));
const used = (pattern: RegExp) => files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(pattern)].map((match) => ({ file: relative(src, file), name: match[1]! })));

// A utility whose theme value does not exist produces no CSS at all, silently.
test("every numbered text size used in src is defined in the theme", () => {
  expect(used(/(?<![\w-])text-(\d+)(?![\w-])/g).filter(({ name }) => !style.includes(`--text-${name}:`))).toEqual([]);
});

test("every sidebar colour utility used in src is mapped to its role", () => {
  expect(used(/(?<![\w-])(?:bg|text|border(?:-[trblxy])?|ring)-(sidebar(?:-[a-z]+)*)(?![\w-])/g).filter(({ name }) => !style.includes(`--color-${name}: var(--${name});`))).toEqual([]);
});

test("the Thai face is bundled, covers Thai only, is enlarged to the Latin size and follows Inter in the body stack", () => {
  const face = style.match(/@font-face\s*{[^}]*"Weft Thai"[^}]*}/)?.[0] ?? "";
  const url = face.match(/url\("([^"]+)"\)/)?.[1] ?? "";
  expect(url).not.toMatch(/^https?:/);
  expect(existsSync(join(dirname(join(src, "style.css")), url))).toBe(true);
  expect(face).toContain("unicode-range: U+0E01-0E5B");
  expect(face).toContain("size-adjust: 108%");
  expect(style).toMatch(/--font-body: "Inter Variable", "Weft Thai",/);
});

test("no font or stylesheet comes from a CDN", () => {
  const html = readFileSync(join(src, "../index.html"), "utf8");
  expect(`${style}${html}`).not.toMatch(/fonts\.(googleapis|gstatic)|jsdelivr|unpkg|url\(["']?https?:/);
});
