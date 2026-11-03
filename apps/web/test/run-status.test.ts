import { expect, test } from "bun:test";
import { canCancelRun, canRerunRun, isActiveRun, latestRun, runStatusKey } from "../src/run-status";

const run = (status: string, createdAt = "2026-01-01T00:00:00Z") => ({ id: status + createdAt, status, createdAt });

test("active statuses are the ones a Run can still change from", () => {
  for (const status of ["queued", "dispatched", "running", "waiting_confirmation", "awaiting_input", "stopping"]) expect(isActiveRun(run(status))).toBe(true);
  for (const status of ["completed", "failed", "cancelled", "stale", "skipped"]) expect(isActiveRun(run(status))).toBe(false);
});

test("cancel is offered for active Runs except one already stopping; rerun for failed, cancelled and stale", () => {
  expect(canCancelRun(run("running"))).toBe(true);
  expect(canCancelRun(run("waiting_confirmation"))).toBe(true);
  expect(canCancelRun(run("stopping"))).toBe(false);
  expect(canCancelRun(run("completed"))).toBe(false);
  expect(["failed", "cancelled", "stale"].map((status) => canRerunRun(run(status)))).toEqual([true, true, true]);
  expect(["queued", "completed", "skipped"].map((status) => canRerunRun(run(status)))).toEqual([false, false, false]);
});

test("the latest Run is the newest by creation time", () => {
  expect(latestRun([run("failed", "2026-01-01T00:00:00Z"), run("running", "2026-01-02T00:00:00Z")])?.status).toBe("running");
  expect(latestRun([])).toBeNull();
});

test("every status maps to a message key", () => {
  expect(runStatusKey("waiting_confirmation")).toBe("runs.status.waiting_confirmation");
});
