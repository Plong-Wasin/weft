import { test, expect } from "bun:test";
import { acceptsSuggestionOnTab } from "../src/suggest-list";

const tab = (overrides: Partial<KeyboardEvent> = {}) => ({ key: "Tab", shiftKey: false, isComposing: false, keyCode: 9, ...overrides }) as KeyboardEvent;

test("Tab accepts an available suggestion and leaves other navigation native", () => {
  expect(acceptsSuggestionOnTab(tab(), true)).toBe(true);
  expect(acceptsSuggestionOnTab(tab({ shiftKey: true }), true)).toBe(false);
  expect(acceptsSuggestionOnTab(tab({ isComposing: true }), true)).toBe(false);
  expect(acceptsSuggestionOnTab(tab({ keyCode: 229 }), true)).toBe(false);
  expect(acceptsSuggestionOnTab(tab(), false)).toBe(false);
  expect(acceptsSuggestionOnTab(tab({ key: "Enter" }), true)).toBe(false);
});
