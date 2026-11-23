// Checks for the design review baseline (ticket 11). Each test names one acceptance checkbox.
// Inputs: DESIGN.md at the repo root, .local/design-baseline/findings.md, .local/visual/ captures.
// Run with `bun run test:isolated tools/visual/design-baseline.test.ts` after the capture (`bun tools/visual/cli.ts weft`).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadRoutes, root } from "./lib";

const designPath = join(root, "DESIGN.md");
const findingsPath = join(root, ".local", "design-baseline", "findings.md");
const shotsDir = join(root, ".local", "visual", "weft");

const AREAS = ["entry and home", "work item surfaces", "planning surfaces", "wiki and analytics and chat", "settings"];
const SEVERITIES = ["P0", "P1", "P2", "P3"];

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

describe("findings report lists every route with severity and area group", () => {
  const { routes } = loadRoutes();

  test("findings report exists under .local/", () => {
    expect(existsSync(findingsPath)).toBe(true);
  });

  test("every manifest route has a row with a severity and one of the five area groups", () => {
    const rows = readFileSync(findingsPath, "utf8").split("\n").filter((line) => line.startsWith("|"));
    const problems: string[] = [];
    for (const route of routes) {
      const row = rows.find((line) => line.split("|")[1]?.trim() === `\`${route.name}\``);
      if (!row) { problems.push(`${route.name}: no row`); continue; }
      const cells = row.split("|").map((c) => c.trim());
      if (!SEVERITIES.includes(cells[2] ?? "")) problems.push(`${route.name}: severity "${cells[2]}"`);
      if (!AREAS.includes(cells[3] ?? "")) problems.push(`${route.name}: area "${cells[3]}"`);
    }
    expect(problems).toEqual([]);
  });

  test("findings report names the five area groups as headings", () => {
    const text = readFileSync(findingsPath, "utf8");
    for (const area of AREAS) expect(text).toContain(`## ${area}`);
  });
});

describe("screenshots under .local/visual; nothing captured is tracked by git", () => {
  const { routes, viewports } = loadRoutes();

  test("every manifest route has a screenshot at 1440px and at 390px", () => {
    const missing: string[] = [];
    for (const route of routes) for (const v of viewports) {
      const file = join(shotsDir, `${route.name}-${v.suffix}.png`);
      if (!existsSync(file)) missing.push(`${route.name}-${v.suffix}`);
    }
    expect(missing).toEqual([]);
  });

  test("captures are git-ignored and no file under .local is tracked", () => {
    const sample = join(".local", "visual", "weft", "workspace-home-1440.png");
    const ignored = Bun.spawnSync(["git", "check-ignore", "-q", sample], { cwd: root });
    expect(ignored.exitCode).toBe(0);
    const tracked = Bun.spawnSync(["git", "ls-files", ".local"], { cwd: root }).stdout.toString().trim();
    expect(tracked).toBe("");
  });
});
