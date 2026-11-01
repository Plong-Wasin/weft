import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "src");
const files = (readdirSync(dir, { recursive: true }) as string[]).filter((name) => /\.tsx?$/.test(name));

test("web source has no literal user-facing text in JSX or accessible attributes", () => {
  const offenders: string[] = [];
  for (const name of files.filter((file) => file.endsWith(".tsx"))) {
    readFileSync(join(dir, name), "utf8").split("\n").forEach((line, index) => {
      const jsxText = /<(?:h\d|p|small|strong|label|button|legend|span|li|a|option|summary|th|td)\b[^>]*>([^<>{}]*[A-Za-z฀-๿]{2,}[^<>{}]*)</.test(line);
      const attribute = /\b(?:placeholder|title|alt|aria-label|aria-description)="[^"{]*[A-Za-z]/.test(line);
      if (jsxText || attribute) offenders.push(`${name}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  expect(offenders).toEqual([]);
});

test("dates are formatted through the shared locale-aware formatter", () => {
  const offenders = files.filter((name) => /toLocale(?:Date|Time)?String\(/.test(readFileSync(join(dir, name), "utf8")));
  expect(offenders).toEqual([]);
});
