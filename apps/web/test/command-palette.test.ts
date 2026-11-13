import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resources } from "@weft/shared";
import { modalDialogOpen, paletteToolAllowed, formatShortcut, isMacPlatform, isPaletteToggle, matchesQuery, nextActive, openPaletteShortcut, pageLocation, paletteKeys, shortcuts } from "../src/command-palette-model";

const event = (key: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

test("a Cmd+K an editor already handled (the Link shortcut) does not also open the palette", () => {
  expect(isPaletteToggle({ ...event("k", { metaKey: true }), defaultPrevented: true })).toBe(false);
  expect(isPaletteToggle({ ...event("k", { ctrlKey: true }), defaultPrevented: false })).toBe(true);
});

test("Cmd+K on Mac and Ctrl+K elsewhere toggle the palette; other combinations do not", () => {
  expect(isPaletteToggle(event("k", { metaKey: true }))).toBe(true);
  expect(isPaletteToggle(event("k", { ctrlKey: true }))).toBe(true);
  expect(isPaletteToggle(event("K", { ctrlKey: true }))).toBe(true);
  expect(isPaletteToggle(event("k"))).toBe(false);
  expect(isPaletteToggle(event("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(isPaletteToggle(event("k", { metaKey: true, altKey: true }))).toBe(false);
  expect(isPaletteToggle(event("j", { ctrlKey: true }))).toBe(false);
});

test("the shortcut is shown with Command on Mac and Ctrl elsewhere", () => {
  expect(isMacPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe(true);
  expect(isMacPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  expect(formatShortcut(openPaletteShortcut.keys, true)).toBe("⌘ K");
  expect(formatShortcut(openPaletteShortcut.keys, false)).toBe("Ctrl K");
});

test("the shortcuts page lists exactly the keys the palette answers to", () => {
  // The page and the palette read the same registry; this checks the palette rows match the keys its key handler accepts.
  // Esc appears twice on purpose: it closes an open menu (global) and the palette (palette row).
  expect(new Set(shortcuts.flatMap((row) => row.keys))).toEqual(new Set(["Mod", "K", "\\", "Esc", "↓", "↑", "Enter", "B", "I", "Shift", "S", "E", "8", "7"]));
  // Mod+K appears twice on purpose: the palette outside editors, the Link shortcut inside them.
  expect(shortcuts.filter((row) => row.keys.join("+") === "Mod+K").map((row) => row.describe)).toEqual(["shortcuts.openPalette", "shortcuts.editorLink"]);
  expect(shortcuts.some((row) => row.describe === "shortcuts.toggleSidebar" && formatShortcut(row.keys, false) === "Ctrl \\")).toBe(true);
  for (const entry of Object.values(paletteKeys)) expect(shortcuts.some((row) => row.keys.length === 1 && row.keys[0] === entry.key)).toBe(true);
  expect(Object.values(paletteKeys).map((entry) => entry.action).sort()).toEqual(["close", "next", "previous", "run"]);
  expect(shortcuts[0]).toBe(openPaletteShortcut);
  const source = readFileSync(join(import.meta.dir, "..", "src", "command-palette.tsx"), "utf8");
  expect(source).toContain("paletteKeys[event.key");
  expect(source).toContain("isPaletteToggle(event)");
});

test("every shortcut row has a translated description in both languages", () => {
  for (const row of shortcuts) {
    expect(resources.en[row.describe].length).toBeGreaterThan(0);
    expect(resources.th[row.describe].length).toBeGreaterThan(0);
  }
});

test("the query matches every typed word, ignoring case, in the label or its hint", () => {
  expect(matchesQuery("Settings: General", "")).toBe(true);
  expect(matchesQuery("Settings: General", "gen SET")).toBe(true);
  expect(matchesQuery("Members", "members extra")).toBe(false);
  expect(matchesQuery("MOB-12 Fix login", "mob-12")).toBe(true);
});

test("arrow keys wrap around the result list", () => {
  expect(nextActive(0, -1, 3)).toBe(2);
  expect(nextActive(2, 1, 3)).toBe(0);
  expect(nextActive(1, 1, 3)).toBe(2);
  expect(nextActive(0, 1, 0)).toBe(0);
});

test("a Pages hit opens its project Page under the project key, or a wiki page in the Wiki", () => {
  const projects = [{ id: "p1", key: "MOB" }];
  expect(pageLocation(null, projects)).toEqual({ kind: "wiki" });
  expect(pageLocation("p1", projects)).toEqual({ kind: "project", key: "MOB" });
  // A project not in the palette's list yet is not guessed as a wiki page.
  expect(pageLocation("p2", projects)).toEqual({ kind: "unavailable" });
});

test("the palette lists Invites only for Admins and the other tools only for Admins and Members, and nothing while the role is unknown", () => {
  expect(paletteToolAllowed("invites", "Admin")).toBe(true);
  expect(paletteToolAllowed("invites", "Member")).toBe(false);
  for (const tool of ["runtimes", "ai", "exports", "tokens"] as const) {
    expect(paletteToolAllowed(tool, "Admin")).toBe(true);
    expect(paletteToolAllowed(tool, "Member")).toBe(true);
    expect(paletteToolAllowed(tool, "Guest")).toBe(false);
    expect(paletteToolAllowed(tool, null)).toBe(false);
  }
});

test("the palette does not open over another modal dialog", () => {
  expect(modalDialogOpen({ querySelector: (selector: string) => (selector === '[aria-modal="true"]' ? {} as Element : null) })).toBe(true);
  expect(modalDialogOpen({ querySelector: () => null })).toBe(false);
});
