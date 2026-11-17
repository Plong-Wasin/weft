import { expect, test } from "bun:test";
import { passwordFieldMinLength } from "../src/auth-password-rule";

test("sign-in accepts a password of any length the person types; sign-up keeps the server minimum", () => {
  expect(passwordFieldMinLength("sign-in", 10)).toBe(1);
  expect(passwordFieldMinLength("sign-up", 10)).toBe(10);
  expect(passwordFieldMinLength("sign-up", 14)).toBe(14);
});

test("the sign-in screen uses that rule for the password field", async () => {
  const source = await Bun.file(new URL("../src/layouts/auth-screen.tsx", import.meta.url)).text();
  expect(source).toContain("minLength={passwordFieldMinLength(mode, minPasswordLength)}");
  expect(source).not.toContain("minLength={minPasswordLength}");
});
