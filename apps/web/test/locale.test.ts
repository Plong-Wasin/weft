import { afterEach, expect, test } from "bun:test";
import { getLocale, setLocale } from "@weft/shared";
import { applyLocale, detectLocale } from "../src/locale";

afterEach(() => setLocale("en"));

test("a stored choice wins over the browser language", () => {
  expect(detectLocale("en", "th-TH")).toBe("en");
  expect(detectLocale("th", "en-US")).toBe("th");
});

test("without a stored choice the browser language decides, English otherwise", () => {
  expect(detectLocale(null, "th-TH")).toBe("th");
  expect(detectLocale(null, "th")).toBe("th");
  expect(detectLocale(null, "en-GB")).toBe("en");
  expect(detectLocale(null, "fr-FR")).toBe("en");
  expect(detectLocale("fr", undefined)).toBe("en");
});

test("a configured instance default applies without a saved choice, while a saved choice wins", () => {
  expect(detectLocale(null, "en-US", "th")).toBe("th");
  expect(detectLocale("en", "th-TH", "th")).toBe("en");
  expect(detectLocale(null, "th-TH", null)).toBe("th");
});

test("applyLocale switches the shared locale and the document language", () => {
  const root = { lang: "en" };
  applyLocale("th", root);
  expect(getLocale()).toBe("th");
  expect(root.lang).toBe("th");
});
