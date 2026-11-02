import { expect, test } from "bun:test";
import { apiBaseUrl } from "../src/api";

test("an empty configured API URL keeps requests relative", () => {
  expect(apiBaseUrl("")).toBe("");
});

test("the development API URL remains the default", () => {
  expect(apiBaseUrl(undefined)).toBe("http://localhost:3000");
});

test("a configured API URL is preserved", () => {
  expect(apiBaseUrl("https://api.example.test")).toBe("https://api.example.test");
});
