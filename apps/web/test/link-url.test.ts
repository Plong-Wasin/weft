import { expect, test } from "bun:test";
import { normalizeLinkUrl } from "../src/link-url";

test("a link typed without a scheme gets https://", () => {
  expect(normalizeLinkUrl("www.example.com")).toBe("https://www.example.com");
  expect(normalizeLinkUrl("  example.com/path?q=1 ")).toBe("https://example.com/path?q=1");
  expect(normalizeLinkUrl("//example.com")).toBe("https://example.com");
  expect(normalizeLinkUrl("localhost:3000/app")).toBe("https://localhost:3000/app");
});

test("a link that already names a scheme is kept as typed", () => {
  expect(normalizeLinkUrl("http://example.com")).toBe("http://example.com");
  expect(normalizeLinkUrl("https://example.com")).toBe("https://example.com");
  expect(normalizeLinkUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
});

test("empty text stays empty so Save does nothing", () => {
  expect(normalizeLinkUrl("   ")).toBe("");
});
