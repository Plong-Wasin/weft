import { expect, test } from "bun:test";
import { translate } from "@weft/shared";
import { limitMessage } from "../src/auth-limit-message";

test("a sign-in lock says how many minutes to wait, in plain words", () => {
  const message = limitMessage(429, { code: "SIGN_IN_LOCKED", retryAfterSeconds: 900 });
  expect(message).toBe(translate("auth.signInLocked").replace("{minutes}", "15"));
  expect(message).toContain("15 minutes");
});

test("each refusal code gets its own message with the wait filled in and no placeholder left", () => {
  expect(limitMessage(429, { code: "SIGN_IN_WAIT", retryAfterSeconds: 2 })).toBe(translate("auth.signInWait").replace("{seconds}", "2"));
  expect(limitMessage(429, { code: "SIGN_UP_LIMITED", retryAfterSeconds: 120 })).toBe(translate("auth.signUpLimited").replace("{minutes}", "2"));
  expect(limitMessage(429, { code: "PASSWORD_RESET_LIMITED", retryAfterSeconds: 120 })).toBe(translate("auth.resetLimited").replace("{minutes}", "2"));
  for (const code of ["SIGN_IN_WAIT", "SIGN_IN_LOCKED", "SIGN_UP_LIMITED", "PASSWORD_RESET_LIMITED"]) {
    expect(limitMessage(429, { code, retryAfterSeconds: 2 })).not.toContain("{");
  }
});

test("a 429 without a known code, or a wait only in the header, still gets a plain message", () => {
  expect(limitMessage(429, null, "120")).toBe(translate("auth.tooMany"));
  expect(limitMessage(429, { code: "SIGN_IN_LOCKED" }, "120")).toContain("2 minutes");
});

test("answers that are not 429 are not limit messages", () => {
  expect(limitMessage(401, { code: "SIGN_IN_LOCKED", retryAfterSeconds: 900 })).toBeNull();
  expect(limitMessage(undefined, null)).toBeNull();
});

test("every limit message exists in English and Thai with its placeholder", () => {
  for (const key of ["auth.signInLocked", "auth.signInWait", "auth.signUpLimited", "auth.resetLimited", "auth.tooMany", "auth.signUpFailed"]) {
    expect(translate(key as never, "en")).toBeString();
    expect(translate(key as never, "th")).not.toBe(key);
  }
  for (const key of ["auth.signInLocked", "auth.signUpLimited", "auth.resetLimited"]) {
    expect(translate(key as never, "en")).toContain("{minutes}");
    expect(translate(key as never, "th")).toContain("{minutes}");
  }
  expect(translate("auth.signInWait" as never, "th")).toContain("{seconds}");
});
