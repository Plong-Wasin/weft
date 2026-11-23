// Checks for the design review baseline (ticket 11). Each test names one acceptance checkbox.
// Inputs: DESIGN.md at the repo root and the repo's git ignore rules. The findings report and the screenshots live under .local/, which is untracked and absent in CI, so they are not asserted here.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { root } from "./lib";

const designPath = join(root, "DESIGN.md");
function shippedCss(): string {
  const dir = join(root, "apps", "web", "src");
  return readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

describe("DESIGN.md exists and describes the shipped system", () => {
  test("DESIGN.md exists at the repo root", () => {
    expect(existsSync(designPath)).toBe(true);
  });

  test("DESIGN.md covers tokens, type, spacing, components and patterns", () => {
    const text = readFileSync(designPath, "utf8");
    for (const topic of ["token", "type", "spacing", "component", "pattern"]) {
      expect(text.toLowerCase()).toContain(topic);
    }
    expect(text.split("\n").filter((line) => line.startsWith("## ")).length).toBeGreaterThanOrEqual(5);
  });

  test("every CSS custom property DESIGN.md names is defined in the shipped stylesheets", () => {
    const text = readFileSync(designPath, "utf8");
    const named = [...new Set([...text.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]!))];
    expect(named.length).toBeGreaterThan(0);
    const css = shippedCss();
    const missing = named.filter((name) => !css.includes(`${name}:`));
    expect(missing).toEqual([]);
  });
});

describe("nothing captured is tracked by git", () => {
  test("captures are git-ignored and no file under .local is tracked", () => {
    const sample = join(".local", "visual", "weft", "workspace-home-1440.png");
    const ignored = Bun.spawnSync(["git", "check-ignore", "-q", sample], { cwd: root });
    expect(ignored.exitCode).toBe(0);
    const tracked = Bun.spawnSync(["git", "ls-files", ".local"], { cwd: root }).stdout.toString().trim();
    expect(tracked).toBe("");
  });
});
