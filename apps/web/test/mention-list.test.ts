import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translate } from "@weft/shared";
import { mentionGroup, mentionNotes, nextSelection } from "../src/suggest-list";

const src = (name: string) => readFileSync(join(import.meta.dir, "..", "src", name), "utf8");

test("ArrowDown and ArrowUp wrap at both ends of the list", () => {
  expect(nextSelection(0, 3, "ArrowDown")).toBe(1);
  expect(nextSelection(2, 3, "ArrowDown")).toBe(0);
  expect(nextSelection(0, 3, "ArrowUp")).toBe(2);
  expect(nextSelection(2, 3, "ArrowUp")).toBe(1);
});

test("an Agent row shows only Code-capable as its note, never a second Agent", () => {
  const agent = { id: "a", label: "Atlas", isAgent: true, codeCapable: true };
  expect(mentionNotes(agent).note).toBe(translate("mention.codeCapable"));
  expect(mentionNotes(agent).note).not.toContain(translate("comments.agent"));
  expect(mentionNotes({ ...agent, codeCapable: false }).note).toBeNull();
  expect(mentionNotes({ id: "p", label: "Dana" }).note).toBeNull();
});

test("an unavailable Agent shows why it cannot be picked", () => {
  expect(mentionNotes({ id: "a", label: "Atlas", isAgent: true, unavailable: true, unavailableReason: "Ask the owner" }).reason).toBe("Ask the owner");
  expect(mentionNotes({ id: "a", label: "Atlas", isAgent: true, unavailableReason: "Ask the owner" }).reason).toBeNull();
});

test("people and Agents fall under the People and Agents headings", () => {
  expect(translate(mentionGroup({ id: "p", label: "Dana" }))).toBe("People");
  expect(translate(mentionGroup({ id: "a", label: "Atlas", isAgent: true }))).toBe("Agents");
});

test("the Wiki and comment mention lists and the emoji list all come from the shared renderer", () => {
  for (const name of ["wiki.tsx", "comments-panel.tsx"]) {
    const text = src(name);
    expect(text).toContain('from "./suggest-list"');
    expect(text).not.toContain('"listbox"');
    expect(text).not.toContain("◉");
  }
  expect(src("editor-extensions.ts")).toContain("suggestRender<");
});
