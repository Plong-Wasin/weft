import { expect, test } from "bun:test";

test("database package source has no converter imports from actions", async () => {
  const files = new Bun.Glob("packages/db/src/**/*.{ts,tsx}").scan({ cwd: process.cwd() });
  for await (const file of files) {
    const source = await Bun.file(file).text();
    expect(source, file).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*(?:actions\/src|@weft\/actions)[^"']*["']/);
  }
});
