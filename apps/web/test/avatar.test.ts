import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_PALETTE, Avatar, avatarColor, avatarColorIndex, avatarLetter } from "../src/avatar";

const html = (props: Parameters<typeof Avatar>[0]) => renderToStaticMarkup(React.createElement(Avatar, props));

/** WCAG relative luminance and contrast ratio for a #rrggbb colour. */
function contrastWithWhite(hex: string) {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05);
}

test("the letter is the first letter or digit; emoji, symbols and leading Thai vowels are skipped", () => {
  expect(avatarLetter("alice")).toBe("A");
  expect(avatarLetter("  bob")).toBe("B");
  expect(avatarLetter("@team")).toBe("T");
  expect(avatarLetter("3M crew")).toBe("3");
  expect(avatarLetter("👍 Dana")).toBe("D");
  expect(avatarLetter("ไพศาล")).toBe("พ");
  expect(avatarLetter("เอก")).toBe("อ");
  expect(avatarLetter("ใจดี")).toBe("จ");
  expect(avatarLetter("โชค")).toBe("ช");
});

test("an empty name, or one with no letter or digit, has no letter", () => {
  expect(avatarLetter("")).toBeNull();
  expect(avatarLetter("   ")).toBeNull();
  expect(avatarLetter(null)).toBeNull();
  expect(avatarLetter("👍🎉")).toBeNull();
  expect(avatarLetter("เ แ")).toBeNull();
});

test("the same person id always gets the same palette colour, and the palette has eight colours", () => {
  expect(AVATAR_PALETTE.length).toBe(8);
  expect(avatarColor("user-42", "Alice")).toBe(avatarColor("user-42", "Renamed"));
  expect(avatarColorIndex("user-42")).toBe(avatarColorIndex("user-42"));
  const used = new Set(Array.from({ length: 300 }, (_, index) => avatarColorIndex(`user-${index}`)));
  expect(used.size).toBe(8);
});

test("every palette colour keeps white text above WCAG AA contrast (4.5:1)", () => {
  for (const colour of AVATAR_PALETTE) expect(contrastWithWhite(colour)).toBeGreaterThanOrEqual(4.5);
});

test("a person renders a round letter avatar in the palette colour", () => {
  const out = html({ name: "Alice", id: "user-42" });
  expect(out).toContain(">A</span>");
  expect(out).toContain("rounded-full");
  expect(out).toContain(`background-color:${avatarColor("user-42", "Alice")}`);
});

test("an agent renders a rounded square with a bot mark and no letter", () => {
  const out = html({ name: "Reviewer", id: "agent-1", agent: true });
  expect(out).toContain("rounded-md");
  expect(out).not.toContain("rounded-full");
  expect(out).not.toContain(">R</span>");
  expect(out).toContain("<svg");
});

test("a person with no letter shows a person icon, not an empty circle", () => {
  const out = html({ name: "", id: "user-7" });
  expect(out).toContain("<svg");
  expect(out).not.toContain("background-color");
});

test("a profile picture is used when the user has one", () => {
  const out = html({ name: "Alice", id: "user-42", image: "https://example.test/a.png" });
  expect(out).toContain('<img src="https://example.test/a.png"');
  expect(out).not.toContain(">A</span>");
});

test("no screen draws its own initials circle: person initials come from the shared Avatar", () => {
  const src = join(import.meta.dir, "..", "src");
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((name) => name.endsWith(".tsx") && name !== "avatar.tsx");
  // The workspace tile is a square workspace mark, not a person, so it keeps its own initial.
  const exempt = new Set(["shell/workspace-switcher.tsx"]);
  const handMade = /\{[^}]*\.(?:charAt\(0\)|slice\(0, ?1\))\.toUpperCase\(\)\}/;
  const offenders = files.filter((name) => !exempt.has(name) && handMade.test(readFileSync(join(src, name), "utf8")));
  expect(offenders).toEqual([]);
});
