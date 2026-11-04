import { expect, test } from "bun:test";
import { shouldContinueAfterConfirmations } from "../src/ai-chat";

test("only Build continues after the last pending Confirmation is decided", () => {
  expect(shouldContinueAfterConfirmations("build", 0)).toBe(true);
  expect(shouldContinueAfterConfirmations("build", 1)).toBe(false);
  expect(shouldContinueAfterConfirmations("ask", 0)).toBe(false);
  expect(shouldContinueAfterConfirmations("autopilot", 0)).toBe(false);
});
