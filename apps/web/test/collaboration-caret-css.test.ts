import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../src/style.css"), "utf8");
const rule = (selector: string) => css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";

// Without these rules the collaboration caret's name is plain inline text that paints a whole line in the other editor's colour.
test("another editor's caret name floats above a thin caret instead of flowing in the text", () => {
  expect(rule(".collaboration-carets__caret")).toContain("position: relative");
  expect(rule(".collaboration-carets__label")).toContain("position: absolute");
  expect(rule(".collaboration-carets__label")).toContain("pointer-events: none");
  // The name fades after a moment so it does not sit over the text.
  expect(rule(".collaboration-carets__label")).toContain("animation: caret-name-fade");
  expect(css).toContain("@keyframes caret-name-fade");
});
