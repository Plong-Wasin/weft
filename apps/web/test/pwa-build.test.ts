import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";

test("production build ships a manifest, offline page, and a service worker that precaches them", async () => {
  const outDir = join(import.meta.dir, "..", ".test-dist");
  await build({ root: join(import.meta.dir, ".."), logLevel: "silent", build: { outDir, emptyOutDir: true } });
  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.webmanifest"), "utf8"));
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBeGreaterThan(0);
  expect(readFileSync(join(outDir, "offline.html"), "utf8")).toContain("You are offline");
  expect(existsSync(join(outDir, "sw.js"))).toBe(true);
  const sw = readFileSync(join(outDir, "sw.js"), "utf8");
  expect(sw).toContain("offline.html");
  expect(sw).toContain("index.html");
}, 60000);
