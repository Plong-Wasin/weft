import { expect, test } from "bun:test";
import { resources } from "@weft/shared";

test("every Runtime settings string has an English and Thai translation", () => {
  const keys = Object.keys(resources.en).filter((key) => key.startsWith("runtimes."));
  expect(keys.length).toBeGreaterThan(8);
  for (const key of keys) expect((resources.th as Record<string, string>)[key], `${key} is missing in Thai`).toBeTruthy();
});
