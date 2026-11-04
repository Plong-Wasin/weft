import { expect, test } from "bun:test";
import { isContinuationRequest, shouldContinueAfterConfirmations } from "../src/ai-chat";

const now = new Date("2026-01-01T00:00:00Z");
const live = "2026-01-01T01:00:00Z";
const past = "2025-12-31T23:00:00Z";
const card = (status: string, expiresAt = live) => ({ status, expiresAt });

test("Build continues once every card is decided", () => {
  expect(shouldContinueAfterConfirmations("build", [card("confirmed"), card("rejected"), card("failed")], now)).toBe(true);
});

test("a card still pending, or sent back as changed, keeps the chat waiting", () => {
  expect(shouldContinueAfterConfirmations("build", [card("confirmed"), card("pending")], now)).toBe(false);
});

test("an expired card is not waiting", () => {
  expect(shouldContinueAfterConfirmations("build", [card("confirmed"), card("pending", past)], now)).toBe(true);
});

test("Ask and Autopilot never continue", () => {
  expect(shouldContinueAfterConfirmations("ask", [card("confirmed")], now)).toBe(false);
  expect(shouldContinueAfterConfirmations("autopilot", [card("confirmed")], now)).toBe(false);
});

test("a submit ending on the assistant turn is a continuation; a user message or Regenerate is not", () => {
  expect(isContinuationRequest("submit-message", [{ role: "user" }, { role: "assistant" }])).toBe(true);
  expect(isContinuationRequest("submit-message", [{ role: "assistant" }, { role: "user" }])).toBe(false);
  expect(isContinuationRequest("regenerate-message", [{ role: "user" }])).toBe(false);
});
