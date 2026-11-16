import { expect, test } from "bun:test";
import { toolPressed } from "../src/toolbar-state";

test("toggle tools follow the editor, the insert-table button never reports pressed", () => {
  const active = () => true;
  expect(toolPressed("bold", active)).toBe(true);
  expect(toolPressed("bold", () => false)).toBe(false);
  expect(toolPressed("table", active)).toBeUndefined();
});
