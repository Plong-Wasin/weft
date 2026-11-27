import { afterEach, expect, test } from "bun:test";
import { gridKeyTarget, monthCells, weekdayOrder } from "../src/date-picker-logic";
import { readWeekStart, storeWeekStart } from "../src/week-start";
import { calendarPlacement, ganttPlacement } from "../src/work-item-layout";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
function useStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  } });
}
afterEach(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });

test("the week starts on Sunday until the browser stores Monday", () => {
  useStorage();
  expect(readWeekStart()).toBe("sunday");
  storeWeekStart("monday");
  expect(readWeekStart()).toBe("monday");
  storeWeekStart("sunday");
  expect(readWeekStart()).toBe("sunday");
  useStorage({ "weft.weekStart": "friday" });
  expect(readWeekStart()).toBe("sunday");
});

test("unavailable storage falls back to Sunday", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
  expect(readWeekStart()).toBe("sunday");
  expect(() => storeWeekStart("monday")).not.toThrow();
});

test("weekday headers follow the first day of the week", () => {
  expect(weekdayOrder("sunday")).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(weekdayOrder("monday")).toEqual([1, 2, 3, 4, 5, 6, 0]);
});

// August 2026 starts on a Saturday, November 2026 on a Sunday, June 2026 on a Monday.
const months = [
  { month: "2026-08", length: 31, sunday: { lead: 6, first: "2026-07-26" }, monday: { lead: 5, first: "2026-07-27" } },
  { month: "2026-11", length: 30, sunday: { lead: 0, first: "2026-11-01" }, monday: { lead: 6, first: "2026-10-26" } },
  { month: "2026-06", length: 30, sunday: { lead: 1, first: "2026-05-31" }, monday: { lead: 0, first: "2026-06-01" } },
];

for (const { month, length, ...expected } of months) for (const weekStart of ["sunday", "monday"] as const) {
  test(`${month} with weeks from ${weekStart}: calendar grid and date picker cells`, () => {
    const { lead, first } = expected[weekStart];
    const [year, index] = month.split("-").map(Number);
    const grid = calendarPlacement([], new Date(year!, index! - 1, 1), weekStart).days;
    expect(grid).toHaveLength(42);
    expect(grid[0]!.date).toBe(first);
    expect(grid[lead]!.date).toBe(`${month}-01`);
    const cells = monthCells(month, weekStart);
    expect(cells).toHaveLength(lead + length);
    expect(cells.slice(0, lead).every((cell) => cell === null)).toBe(true);
    expect(cells[lead]).toBe(`${month}-01`);
  });

  test(`${month} with weeks from ${weekStart}: Gantt week zoom starts one week back`, () => {
    const [year, index] = month.split("-").map(Number);
    const placement = ganttPlacement([], new Date(year!, index! - 1, 1), "week", new Date(year!, index! - 1, 1), weekStart);
    const weekBefore = new Date(`${expected[weekStart].first}T00:00:00Z`);
    weekBefore.setUTCDate(weekBefore.getUTCDate() - 7);
    expect(placement.days).toHaveLength(14);
    expect(placement.start).toBe(weekBefore.toISOString().slice(0, 10));
    expect(placement.today).toBe(7 + expected[weekStart].lead);
  });
}

test("Home and End go to the ends of the chosen week", () => {
  expect(gridKeyTarget("2026-11-26", "Home")).toBe("2026-11-22"); // Thursday -> Sunday by default
  expect(gridKeyTarget("2026-11-26", "End")).toBe("2026-11-28");
  expect(gridKeyTarget("2026-11-26", "Home", false, "monday")).toBe("2026-11-23");
  expect(gridKeyTarget("2026-11-26", "End", false, "monday")).toBe("2026-11-29");
  expect(gridKeyTarget("2026-11-29", "Home", false, "sunday")).toBe("2026-11-29"); // a Sunday is the first day
  expect(gridKeyTarget("2026-11-29", "Home", false, "monday")).toBe("2026-11-23"); // ...and the last one
});
