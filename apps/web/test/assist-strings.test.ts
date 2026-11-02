import { expect, test } from "bun:test";
import { resources } from "@weft/shared";

test("every AI assist string exists in English and Thai", () => {
  const keys = Object.keys(resources.en).filter((key) => key.startsWith("assist."));
  expect(keys.length).toBeGreaterThan(10);
  for (const key of keys) expect((resources.th as Record<string, string>)[key]).toBeTruthy();
});
