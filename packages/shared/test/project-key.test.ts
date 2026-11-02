import { expect, test } from "bun:test";
import { sanitizeProjectKey } from "../src";

test("project key suggestions are uppercase and keep only letters and digits", () => {
  expect(sanitizeProjectKey("Mobile App")).toBe("MOBILEAPP");
  expect(sanitizeProjectKey("my-project! v2")).toBe("MYPROJECTV");
});

test("project key suggestions drop leading digits and digits-only names", () => {
  expect(sanitizeProjectKey("123Mobile")).toBe("MOBILE");
  expect(sanitizeProjectKey("12345")).toBe("");
  expect(sanitizeProjectKey("X")).toBe("X");
});

test("project key suggestions leave Thai-only and empty names empty", () => {
  expect(sanitizeProjectKey("โครงการ")).toBe("");
  expect(sanitizeProjectKey("")).toBe("");
});

test("project key suggestions are limited to 10 characters", () => {
  expect(sanitizeProjectKey("Long project name")).toBe("LONGPROJEC");
});

