import { afterEach, expect, test } from "bun:test";
import { formatDate, formatNumber, getLocale, isLocale, resources, setLocale, translate } from "../src";

afterEach(() => setLocale("en"));

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("Thai has exactly the keys English has, all non-empty", () => {
  expect(Object.keys(resources.th).sort()).toEqual(Object.keys(resources.en).sort());
  for (const [key, value] of Object.entries(resources.th)) expect(value.trim(), key).not.toBe("");
});

test("Thai strings keep the placeholders of the English string", () => {
  for (const key of Object.keys(resources.en) as Array<keyof typeof resources.en>) {
    expect(placeholders(resources.th[key]), key).toEqual(placeholders(resources.en[key]));
  }
});

test("Thai strings are actually translated (contain Thai script) except brand, language name, acronym and format-only strings", () => {
  const untranslated = (Object.keys(resources.en) as Array<keyof typeof resources.en>)
    .filter((key) => !/[฀-๿]/.test(resources.th[key]) && resources.th[key] === resources.en[key]);
  expect(untranslated.sort()).toEqual(["activity.source.ai", "activity.source.cli", "activity.source.mcp", "app.title", "language.en", "rail.ai", "workItems.activity.by"]);
});

test("translate follows the current locale and an explicit locale wins", () => {
  expect(translate("auth.signIn")).toBe(resources.en["auth.signIn"]);
  setLocale("th");
  expect(getLocale()).toBe("th");
  expect(translate("auth.signIn")).toBe(resources.th["auth.signIn"]);
  expect(translate("auth.signIn", "en")).toBe(resources.en["auth.signIn"]);
});

test("isLocale only accepts shipped locales", () => {
  expect(isLocale("th")).toBe(true);
  expect(isLocale("en")).toBe(true);
  expect(isLocale("fr")).toBe(false);
  expect(isLocale(null)).toBe(false);
});

test("dates and numbers are formatted per locale", () => {
  const date = "2026-03-05T10:00:00Z";
  expect(formatDate(date, "en", "UTC")).toContain("2026");
  expect(formatDate(date, "th", "UTC")).toContain("2569"); // Buddhist era
  expect(formatNumber(1234567.5, "en")).toBe("1,234,567.5");
  expect(formatNumber(1234567.5, "th")).toBe("1,234,567.5");
  setLocale("th");
  expect(formatDate(date, undefined, "UTC")).toBe(formatDate(date, "th", "UTC"));
});
