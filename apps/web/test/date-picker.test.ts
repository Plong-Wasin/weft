import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@weft/shared";
import { applyQuickPick, calendarTabStop, displayYear, gridKeyTarget, isOverdue, monthTitle, pickDay, quickPickDate, shortDay, storedYear, todayKey } from "../src/date-picker-logic";

test("today key is the local calendar day, not the UTC day", () => {
  expect(todayKey(new Date(2026, 10, 17, 23, 30))).toBe("2026-11-17");
  expect(todayKey(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
});

test("quick picks: Today and Tomorrow cross month and year ends", () => {
  expect(quickPickDate("today", "2026-11-17")).toBe("2026-11-17");
  expect(quickPickDate("tomorrow", "2026-11-17")).toBe("2026-11-18");
  expect(quickPickDate("tomorrow", "2026-12-31")).toBe("2027-01-01");
  expect(quickPickDate("tomorrow", "2028-02-28")).toBe("2028-02-29");
});

test("quick pick Next week is the Monday after today, never today", () => {
  expect(quickPickDate("nextWeek", "2026-11-17")).toBe("2026-11-23"); // Tuesday -> next Monday
  expect(quickPickDate("nextWeek", "2026-11-22")).toBe("2026-11-23"); // Sunday -> next day
  expect(quickPickDate("nextWeek", "2026-11-23")).toBe("2026-11-30"); // Monday -> a week on
  expect(quickPickDate("nextWeek", "2026-12-30")).toBe("2027-01-04"); // across the year end
});

test("picking a Start after the Due moves the Due to the same day", () => {
  expect(pickDay({ startDate: null, dueDate: "2026-11-20" }, "start", "2026-11-25")).toEqual({ startDate: "2026-11-25", dueDate: "2026-11-25" });
  expect(pickDay({ startDate: null, dueDate: "2026-11-20" }, "start", "2026-11-18")).toEqual({ startDate: "2026-11-18", dueDate: "2026-11-20" });
});

test("picking a Due before the Start moves the Start to the same day", () => {
  expect(pickDay({ startDate: "2026-11-20", dueDate: null }, "due", "2026-11-18")).toEqual({ startDate: "2026-11-18", dueDate: "2026-11-18" });
  expect(pickDay({ startDate: "2026-11-20", dueDate: null }, "due", "2026-11-24")).toEqual({ startDate: "2026-11-20", dueDate: "2026-11-24" });
});

test("a range is picked in one calendar: Start then Due keeps both", () => {
  const start = pickDay({ startDate: null, dueDate: null }, "start", "2026-11-20");
  expect(pickDay(start, "due", "2026-11-24")).toEqual({ startDate: "2026-11-20", dueDate: "2026-11-24" });
});

test("applyQuickPick sets only the active field; No date clears both", () => {
  const range = { startDate: "2026-11-01", dueDate: "2026-11-05" };
  expect(applyQuickPick(range, "due", "tomorrow", "2026-11-17")).toEqual({ startDate: "2026-11-01", dueDate: "2026-11-18" });
  expect(applyQuickPick(range, "start", "today", "2026-11-17")).toEqual({ startDate: "2026-11-17", dueDate: "2026-11-17" });
  expect(applyQuickPick(range, "due", "none", "2026-11-17")).toEqual({ startDate: null, dueDate: null });
});

test("overdue: a Due before today, unless the State is completed", () => {
  expect(isOverdue("2026-11-16", "2026-11-17", "started")).toBe(true);
  expect(isOverdue("2026-11-17", "2026-11-17", "started")).toBe(false);
  expect(isOverdue("2026-11-16", "2026-11-17", "completed")).toBe(false);
  expect(isOverdue("2026-11-16", "2026-11-17", "cancelled")).toBe(false);
  expect(isOverdue("2026-11-16", "2026-11-17", "unstarted")).toBe(true);
  expect(isOverdue(null, "2026-11-17", "started")).toBe(false);
});

test("the calendar year follows the locale: Thai shows and takes the Buddhist-era year the rest of the app shows", () => {
  const before = getLocale();
  try {
    setLocale("th");
    expect(displayYear("2030-05")).toBe(2573);
    // The same year the date text shows elsewhere (shortDay prints it for a year other than now).
    expect(shortDay("2030-05-06", new Date(2026, 0, 1))).toContain(String(displayYear("2030-05")));
    expect(monthTitle("2030-05")).toContain("2573");
    expect(storedYear("2574", "2030-05")).toBe(2031);
    expect(storedYear("257", "2030-05")).toBeNull();
    setLocale("en");
    expect(displayYear("2030-05")).toBe(2030);
    expect(monthTitle("2030-05")).toBe("May 2030");
    expect(storedYear("2031", "2030-05")).toBe(2031);
    expect(storedYear("20", "2030-05")).toBeNull();
  } finally {
    setLocale(before);
  }
});

test("the calendar keeps one Tab stop on a pickable day when the 1st is out of bounds", () => {
  // Due with min = Start on the 15th: the 1st-14th are out of bounds.
  expect(calendarTabStop("2026-11", { today: "2026-11-03", min: "2026-11-15" })).toBe("2026-11-15");
  expect(calendarTabStop("2026-11", { today: "2026-11-20", min: "2026-11-15" })).toBe("2026-11-20");
  expect(calendarTabStop("2026-11", { selected: "2026-11-22", today: "2026-11-20", min: "2026-11-15" })).toBe("2026-11-22");
  expect(calendarTabStop("2026-11", { focusDay: "2026-11-10", today: "2026-11-20", min: "2026-11-15" })).toBe("2026-11-20");
  expect(calendarTabStop("2026-11", { max: "2026-11-05", today: "2026-11-20" })).toBe("2026-11-01");
  expect(calendarTabStop("2026-12", { today: "2026-11-20" })).toBe("2026-12-01");
});

test("calendar keys move by day, week, month, year and to the week's ends", () => {
  expect(gridKeyTarget("2026-11-26", "ArrowRight")).toBe("2026-11-27");
  expect(gridKeyTarget("2026-11-26", "ArrowUp")).toBe("2026-11-19");
  expect(gridKeyTarget("2026-01-31", "PageDown")).toBe("2026-02-28");
  expect(gridKeyTarget("2026-03-31", "PageUp")).toBe("2026-02-28");
  expect(gridKeyTarget("2028-02-29", "PageDown", true)).toBe("2029-02-28");
  expect(gridKeyTarget("2026-11-26", "Home")).toBe("2026-11-22"); // Thursday -> Sunday
  expect(gridKeyTarget("2026-11-26", "End")).toBe("2026-11-28"); // -> Saturday
  expect(gridKeyTarget("2026-11-26", "Enter")).toBeNull();
});
