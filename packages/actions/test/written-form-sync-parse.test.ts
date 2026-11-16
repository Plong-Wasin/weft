import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "../../..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? (name === "node_modules" || name === "test" ? [] : walk(path)) : /\.tsx?$/.test(name) ? [path] : [];
});

// A stored row or a request body parses through the worker pool (storedDocumentOf / storedDocumentWithWarnings / parseMarkdownGuarded / prepareRichTextGuarded) so a heavy one cannot hold the event loop.
// Only these files may call the synchronous parsers: the parser itself, the pool and its worker, the verified serialiser (reached only through the guard, or in-process for text of at most 2 KB),
// the Outlink helper that the guard calls for text of at most 2 KB, and the one-off migrations.
const allowed = [
  "packages/actions/src/markdown-doc.ts", "packages/actions/src/written-form-pool.ts", "packages/actions/src/written-form-worker.ts",
  "packages/actions/src/rich-markdown.ts", "packages/actions/src/outlinks.ts",
];
const allowedPrefixes = ["packages/actions/src/migrations/"];

test("no synchronous Markdown parse remains on a request path outside the pool, the serialiser and the migrations", () => {
  const offenders: string[] = [];
  for (const base of ["packages/actions/src", "apps/api/src", "apps/live/src", "apps/mcp/src"]) {
    for (const file of walk(join(root, base))) {
      const name = relative(root, file);
      if (allowed.includes(name) || allowedPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/^\s*(import|export)\b.*\bfrom\b/.test(line)) return;
        if (/\b(markdownToDoc|markdownToDocWithWarnings|storedMarkdownToDoc)\(/.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  }
  expect(offenders).toEqual([]);
});

// A handler that converts N rows submits ONE batched job (storedDocumentsWithWarnings), never N jobs from a Promise.all over the rows: a burst of N jobs from one caller is what the per-caller limits refuse.
test("no request path converts rows with a Promise.all over a conversion call", () => {
  const conversion = /\b(storedDocument\w*|writtenFormOf|readWrittenFormOf|prepareRichTextGuarded|parseMarkdownGuarded|runInWorker)\(/;
  const offenders: string[] = [];
  for (const base of ["packages/actions/src", "apps/api/src", "apps/live/src", "apps/mcp/src"]) {
    for (const file of walk(join(root, base))) {
      const name = relative(root, file);
      if (name.startsWith("packages/actions/src/migrations/") || name === "packages/actions/src/written-form-pool.ts") continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/Promise\.all\(/.test(line) || !/\.map\(/.test(lines.slice(index, index + 2).join(" "))) return;
        if (conversion.test(lines.slice(index, index + 8).join("\n"))) offenders.push(`${name}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  }
  expect(offenders).toEqual([]);
});

// The verified serialisers parse the text back, which is quadratic on some shapes: only the pool, its worker and the one-off migrations call them directly (writtenFormOfSync, richTextMarkdown).
// plainTextWrittenForm is a linear serialise with no parse-back (measured 12 ms for a 197 KB document), so it is allowed in the places listed here, each for the reason given.
const serialiserAllowed: Record<string, string[]> = {
  writtenFormOfSync: ["packages/actions/src/rich-markdown.ts", "packages/actions/src/written-form-pool.ts", "packages/actions/src/written-form-worker.ts"],
  richTextMarkdown: ["packages/actions/src/rich-markdown.ts", "packages/actions/src/written-form.ts"],
  plainTextWrittenForm: [
    "packages/actions/src/rich-markdown.ts", "packages/actions/src/written-form-pool.ts",
    // Legacy rows with no stored Markdown yet (the backfill converts them): linear fallback.
    "packages/actions/src/comments.ts", "packages/actions/src/work-items.ts", "packages/actions/src/intake.ts",
    // A live save whose verified conversion failed without a limit: best-effort linear fallback.
    "apps/live/src/server.ts",
  ],
};

test("serialiser calls on a request path are limited to the listed files", () => {
  const offenders: string[] = [];
  for (const base of ["packages/actions/src", "apps/api/src", "apps/live/src", "apps/mcp/src"]) {
    for (const file of walk(join(root, base))) {
      const name = relative(root, file);
      if (allowedPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/^\s*(import|export)\b.*\bfrom\b/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        for (const [serialiser, files] of Object.entries(serialiserAllowed)) {
          if (new RegExp(`\\b${serialiser}\\(`).test(line) && !files.includes(name)) offenders.push(`${name}:${index + 1}: ${serialiser}`);
        }
      });
    }
  }
  expect(offenders).toEqual([]);
});
