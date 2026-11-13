import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPasswordPolicy } from "../src/password-policy";
import { translate } from "@weft/shared";
import { minimumPasswordLength } from "../src/auth";

const sha1 = (value: string) => createHash("sha1").update(value).digest("hex").toUpperCase();

test("password policy refuses a breached password through an injected HIBP range response", async () => {
  const password = "a-safe-example-password";
  let sentPrefix = "";
  const check = createPasswordPolicy({ minimum: 10, online: true, rangeChecker: async (prefix) => { sentPrefix = prefix; return `${sha1(password).slice(5)}:23\n`; } });
  await expect(check(password)).rejects.toMatchObject({ body: { code: "PASSWORD_COMPROMISED" } });
  expect(sentPrefix).toBe(sha1(password).slice(0, 5));
  expect(sentPrefix).toHaveLength(5);
});

test("password policy falls back to the common-password list when HIBP fails or is disabled", async () => {
  const outageCheck = createPasswordPolicy({ minimum: 8, online: true, rangeChecker: async () => { throw new Error("offline"); } });
  const disabledCheck = createPasswordPolicy({ minimum: 8, online: false, rangeChecker: async () => { throw new Error("must not call range service"); } });
  await expect(outageCheck("password")).rejects.toMatchObject({ body: { code: "PASSWORD_COMPROMISED" } });
  await expect(disabledCheck("password")).rejects.toMatchObject({ body: { code: "PASSWORD_COMPROMISED" } });
});

test("password policy falls back to the common-password list when the range service times out", async () => {
  const check = createPasswordPolicy({ minimum: 8, online: true, rangeChecker: () => new Promise<string>(() => {}) });
  await expect(check("password")).rejects.toMatchObject({ body: { code: "PASSWORD_COMPROMISED" } });
});

test("password policy refuses identity matches and one repeated character", async () => {
  const check = createPasswordPolicy({ minimum: 4, online: false });
  await expect(check("person@example.com", { email: "Person@Example.com" })).rejects.toMatchObject({ body: { code: "PASSWORD_PERSONAL" } });
  await expect(check("ada lovelace", { name: "Ada Lovelace" })).rejects.toMatchObject({ body: { code: "PASSWORD_PERSONAL" } });
  await expect(check("zzzzzzzz")).rejects.toMatchObject({ body: { code: "PASSWORD_REPEATED" } });
});

test("password policy accepts Thai and other Unicode, spaces and 64 character passwords", async () => {
  const check = createPasswordPolicy({ minimum: 10, online: false });
  await expect(check("แมว 🐈 วิ่งไว" )).resolves.toBeUndefined();
  await expect(check("Abcdefghijklmnopqrstuvwxyz0123456789 !@#$%^&*()_+-=[]{};:,.?/<>~" )).resolves.toBeUndefined();
});

test("breach refusal is clear in English and Thai", () => {
  expect(translate("auth.passwordError.PASSWORD_COMPROMISED", "en")).toContain("known data breaches");
  expect(translate("auth.passwordError.PASSWORD_COMPROMISED", "th")).toContain("ข้อมูลรั่วไหล");
});

test("password minimum defaults to 10 and ignores invalid configuration with a startup warning", () => {
  expect(minimumPasswordLength(undefined)).toBe(10);
  expect(minimumPasswordLength("12")).toBe(12);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(minimumPasswordLength("nope")).toBe(10);
    expect(warning).toHaveBeenCalledWith("Ignoring invalid MIN_PASSWORD_LENGTH=nope; expected an integer from 1 to 256.");
  } finally { warning.mockRestore(); }
});
