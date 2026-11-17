import { expect, test } from "bun:test";
import { applyQuickPick, isOverdue, pickDay, quickPickDate, todayKey } from "../src/date-picker-logic";

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
  expect(isOverdue("2026-11-16", "2026-11-17", "unstarted")).toBe(true);
  expect(isOverdue(null, "2026-11-17", "started")).toBe(false);
});
