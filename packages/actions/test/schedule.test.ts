import { describe, expect, test } from "bun:test";
import { nextCalendarOccurrence, nextScheduleOccurrence, parseCron, type CalendarSchedule } from "../src/schedules";

describe("schedule expressions", () => {
  test("computes daily, weekly, monthly and cron occurrences from an injected clock", () => {
    const now = new Date("2026-11-03T09:30:00.000Z");
    expect(nextScheduleOccurrence("daily", null, now).toISOString()).toBe("2026-11-04T09:30:00.000Z");
    expect(nextScheduleOccurrence("weekly", null, now).toISOString()).toBe("2026-11-10T09:30:00.000Z");
    expect(nextScheduleOccurrence("monthly", null, now).toISOString()).toBe("2026-12-03T09:30:00.000Z");
    expect(nextScheduleOccurrence("cron", "0 9 * * 1", now).toISOString()).toBe("2026-11-09T09:00:00.000Z");
  });

  test("accepts five cron fields and reports a readable validation error", () => {
    expect(parseCron("*/15 9-17 * * 1,3,5")).toBeDefined();
    expect(() => parseCron("0 0 * *")).toThrow("Cron must have five fields");
    expect(() => parseCron("99 * * * *")).toThrow("Cron minute must be between 0 and 59");
  });

  test("skips missed schedule intervals and returns only the next future occurrence", () => {
    expect(nextScheduleOccurrence("daily", null, new Date("2026-11-10T12:00:00Z")).toISOString()).toBe("2026-11-11T12:00:00.000Z");
  });

  test("computes timezone-aware calendar schedules with intervals and weekday selection", () => {
    const base = { interval: 1, time: "09:00", timezone: "America/New_York", anchorDate: "2026-11-01" } as const;
    const schedule = (unit: CalendarSchedule["unit"], overrides: Partial<CalendarSchedule> = {}): CalendarSchedule => ({ ...base, unit, ...overrides });
    expect(nextCalendarOccurrence(schedule("day"), new Date("2026-11-02T14:00:00Z")).toISOString()).toBe("2026-11-03T14:00:00.000Z");
    expect(nextCalendarOccurrence(schedule("week", { weekdays: [1, 3] }), new Date("2026-11-03T15:00:00Z")).toISOString()).toBe("2026-11-04T14:00:00.000Z");
    expect(nextCalendarOccurrence(schedule("week", { interval: 2, weekdays: [1], anchorDate: "2026-11-02" }), new Date("2026-11-09T15:00:00Z")).toISOString()).toBe("2026-11-16T14:00:00.000Z");
  });

  test("keeps local wall-clock time across DST and clamps monthly and yearly dates", () => {
    const common = { interval: 1, time: "09:00", timezone: "America/New_York", anchorDate: "2026-03-01" } as const;
    expect(nextCalendarOccurrence({ ...common, unit: "day" }, new Date("2026-03-07T15:00:00Z")).toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(nextCalendarOccurrence({ ...common, unit: "month", dayOfMonth: 31 }, new Date("2026-02-01T00:00:00Z")).toISOString()).toBe("2026-03-31T13:00:00.000Z");
    expect(nextCalendarOccurrence({ ...common, unit: "year", month: 2, day: 29 }, new Date("2027-01-01T00:00:00Z")).toISOString()).toBe("2027-02-28T14:00:00.000Z");
  });
});
