import { afterEach, expect, test } from "bun:test";
import { getLocale, setLocale } from "@weft/shared";
import { applyLocale, detectLocale, resolveSessionLocale } from "../src/locale";

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

test("a saved account language wins after sign-in", () => {
  expect(resolveSessionLocale({ locale: "en", localeSaved: true }, "th")).toEqual({ apply: "en", persist: false });
  expect(resolveSessionLocale({ locale: "th", localeSaved: true }, "en")).toEqual({ apply: "th", persist: false });
});

test("with no saved account language the language chosen before sign-in stays and is saved to the account", () => {
  // The server fills an unsaved language with the instance default or English; that must not replace what the person used on the sign-up screen.
  expect(resolveSessionLocale({ locale: "en", localeSaved: false }, "th")).toEqual({ apply: "th", persist: true });
});

test("a response without the saved flag counts as saved, and an unknown language is ignored", () => {
  expect(resolveSessionLocale({ locale: "th" }, "en")).toEqual({ apply: "th", persist: false });
  expect(resolveSessionLocale({ locale: "fr", localeSaved: true }, "th")).toEqual({ apply: "th", persist: false });
});
