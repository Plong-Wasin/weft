import { expect, test } from "bun:test";
import { resources } from "@weft/shared";
import { runFailureText } from "../src/run-failure";

test("each failureReason code the server writes has an English and Thai message", () => {
  for (const reason of ["sandbox_unavailable", "spawn_failed", "timeout", "cli_exit", "budget_exceeded", "worker_crashed", "daemon_stopped"]) {
    expect(runFailureText(reason, "en"), reason).toBeTruthy();
    expect(runFailureText(reason, "th"), reason).toBeTruthy();
    expect(runFailureText(reason, "th")).not.toBe(runFailureText(reason, "en"));
  }
});

test("a missing or unknown reason says nothing instead of showing a raw code", () => {
  expect(runFailureText(null)).toBeNull();
  expect(runFailureText("mystery_code")).toBeNull();
  expect(resources.en["runs.failureDetail"]).toContain("{detail}");
});
