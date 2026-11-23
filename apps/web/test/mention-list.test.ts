import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import { translate } from "@weft/shared";
import { mentionExtension } from "../src/mention-extension";
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

test("the shared rich-text mention extension filters, groups and marks inaccessible Agents", async () => {
  const people = { current: [
    { userId: "agent-z", name: "Atlas", isAgent: true, codeCapable: true, hasAccess: false, accessReason: "Ask the owner" },
    { userId: "person-z", name: "Alex" },
    { userId: "agent-a", name: "Albert", isAgent: true, codeCapable: false, hasAccess: true },
    { userId: "person-a", name: "Bob" },
  ] };
  const extension = mentionExtension(people);
  const suggestion = extension.options.suggestion;
  const items = await suggestion.items?.({ query: "a", editor: {} as Editor, signal: new AbortController().signal }) ?? [];
  expect(items.map((item) => item.id)).toEqual(["person-z", "agent-a", "agent-z"]);
  expect(items.at(-1)).toMatchObject({ isAgent: true, codeCapable: true, unavailable: true, unavailableReason: "Ask the owner" });
  expect(suggestion.render).toBeDefined();
});

test("structured mentions render with an at sign and shared styling while plain at text stays ordinary", () => {
  const extension = mentionExtension({ current: [] });
  const html = extension.options.renderHTML({
    options: extension.options,
    node: { attrs: { id: "person-1", label: "Ada" } } as never,
    suggestion: { char: "@" } as never,
  });
  expect(html).toEqual(["span", expect.objectContaining({ class: "mention" }), "@Ada"]);

  const styles = src("style.css");
  expect(styles).toMatch(/\.mention\s*\{[^}]*color:\s*var\(--txt-accent-primary\)[^}]*font-weight:\s*600/s);
  expect(styles).not.toMatch(/(?:\.ProseMirror\s+)?\.mention[^}]*cursor:\s*pointer/);
  expect(src("comments-panel.tsx")).toContain('Mention.configure({ HTMLAttributes: { class: "mention" } })');
});

test("Wiki and rich-text editors use the shared mention popup behavior", () => {
  const wiki = src("wiki.tsx");
  expect(wiki).toContain("render: mentionRender(\"wiki.mentionMembers\", pluginKey)");
  expect(wiki).toContain('HTMLAttributes: { class: "mention" }');
  for (const name of ["comments-panel.tsx", "description-editor.tsx"]) {
    const text = src(name);
    expect(text).toContain('from "./mention-extension"');
    expect(text).toContain("mention: mentionExtension(peopleRef)");
  }
  expect(src("mention-extension.ts")).toContain("render: mentionRender(\"wiki.mentionMembers\", pluginKey)");
  expect(src("editor-extensions.ts")).toContain("suggestRender<");
});
