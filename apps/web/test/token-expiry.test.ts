import { expect, test } from "bun:test";
import { hasValidTokenExpiry } from "../src/token-expiry";

test("token expiry is required unless never expires is selected", () => {
  expect(hasValidTokenExpiry("", false)).toBe(false);
  expect(hasValidTokenExpiry("2030-01-01", false)).toBe(true);
  expect(hasValidTokenExpiry("", true)).toBe(true);
});
