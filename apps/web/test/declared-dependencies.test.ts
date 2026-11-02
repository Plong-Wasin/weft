import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The Docker build installs from the lockfile without hoisting every workspace's packages into the web app, so a bare import
// the web package does not declare passes locally and fails `vite build` in the image.
test("every package the web app imports is declared in apps/web/package.json", () => {
  const root = join(import.meta.dir, "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
  const missing = new Set<string>();
  for (const file of (readdirSync(join(root, "src"), { recursive: true }) as string[]).filter((name) => /\.tsx?$/.test(name))) {
    for (const match of readFileSync(join(root, "src", file), "utf8").matchAll(/from\s+"([^."/][^"]*)"/g)) {
      const name = match[1]!.startsWith("@") ? match[1]!.split("/").slice(0, 2).join("/") : match[1]!.split("/")[0]!;
      if (!name.startsWith("node:") && !name.startsWith("virtual:") && !declared.has(name)) missing.add(`${name} (${file})`);
    }
  }
  expect([...missing]).toEqual([]);
});
