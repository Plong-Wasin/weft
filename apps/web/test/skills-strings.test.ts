import { expect, test } from "bun:test";
import { resources } from "@weft/shared";

test("every Skills settings string has an English and Thai translation", () => {
  const keys = Object.keys(resources.en).filter((key) => key.startsWith("skills.") || key === "settings.skills");
  expect(keys.length).toBeGreaterThan(15);
  for (const key of keys) {
    expect((resources.th as Record<string, string>)[key], `${key} is missing in Thai`).toBeTruthy();
  }
});
