import { expect, test } from "bun:test";
import { filterPickerOptions, groupPickerOptions, isPickable, isSearchable, moveActive } from "../src/picker-search";

const names = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `o${index}`, name: `Option ${index}` }));

test("a picker shows its search field only above six options", () => {
  expect(isSearchable(names(6))).toBe(false);
  expect(isSearchable(names(7))).toBe(true);
  expect(isSearchable([])).toBe(false);
});

test("filtering matches names case-insensitively and ignores surrounding spaces", () => {
  const options = [{ id: "a", name: "Charlie" }, { id: "b", name: "Bravo" }, { id: "c", name: "Charcoal" }];
  expect(filterPickerOptions(options, "  CHAR ").map((option) => option.id)).toEqual(["a", "c"]);
});

test("an empty query keeps every option, and a query with no match keeps none", () => {
  const options = names(7);
  expect(filterPickerOptions(options, "   ")).toEqual(options);
  expect(filterPickerOptions(options, "zzz")).toEqual([]);
});

test("people are listed before agents and each group keeps its order", () => {
  const options = [
    { id: "agent-1", name: "Bot", isAgent: true },
    { id: "person-1", name: "Ann" },
    { id: "agent-2", name: "Helper", isAgent: true },
    { id: "person-2", name: "Ben", isAgent: false },
  ];
  expect(groupPickerOptions(options).map((option) => option.id)).toEqual(["person-1", "person-2", "agent-1", "agent-2"]);
});

test("an Agent without access is not pickable, and everything else is", () => {
  expect(isPickable({ name: "Bot", isAgent: true, hasAccess: false })).toBe(false);
  expect(isPickable({ name: "Bot", isAgent: true, hasAccess: true })).toBe(true);
  expect(isPickable({ name: "Ann" })).toBe(true);
});

test("ArrowDown and ArrowUp move the highlight and stop at both ends", () => {
  expect(moveActive(0, 1, 3)).toBe(1);
  expect(moveActive(2, 1, 3)).toBe(2);
  expect(moveActive(0, -1, 3)).toBe(0);
  expect(moveActive(1, -1, 3)).toBe(0);
  expect(moveActive(0, 1, 0)).toBe(-1);
});
