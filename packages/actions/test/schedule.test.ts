import { describe, expect, test } from "bun:test";
import { nextScheduleOccurrence, parseCron } from "../src/schedules";

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
});
