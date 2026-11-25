import { expect, test } from "bun:test";
import { readDetailsPanelOpen, writeDetailsPanelOpen } from "../src/details-panel";

test("details panel state persists independently for each kind", () => {
  const values = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });

  expect(readDetailsPanelOpen("cycle")).toBe(true);
  writeDetailsPanelOpen("cycle", false);
  expect(readDetailsPanelOpen("cycle")).toBe(false);
  expect(readDetailsPanelOpen("module")).toBe(true);
  writeDetailsPanelOpen("work-item", false);
  expect(values.get("weft:details-panel:work-item")).toBe("false");
});

test("details panel state defaults open and remains usable when storage throws", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("storage blocked"); } });
  expect(readDetailsPanelOpen("module")).toBe(true);
  expect(() => writeDetailsPanelOpen("module", false)).not.toThrow();
  expect(readDetailsPanelOpen("module")).toBe(false);
});
