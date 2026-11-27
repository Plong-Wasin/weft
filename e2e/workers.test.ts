import { expect, test } from "bun:test";
import { defaultWorkers, memAvailableMiB, threeWorkerMiB } from "./workers";

test("the default is three workers only when that much memory is available", () => {
  expect(defaultWorkers(threeWorkerMiB)).toBe(3);
  expect(defaultWorkers(threeWorkerMiB - 1)).toBe(2);
});

test("unknown memory gives two workers", () => {
  expect(defaultWorkers(undefined)).toBe(2);
});

test("MemAvailable is read from /proc/meminfo text", () => {
  expect(memAvailableMiB("MemTotal:       28000000 kB\nMemAvailable:   12582912 kB\n")).toBe(12288);
  expect(memAvailableMiB("MemTotal: 1 kB\n")).toBeUndefined();
});
