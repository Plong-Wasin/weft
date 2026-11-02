import { expect, test } from "bun:test";
import { apiBaseUrl, liveUrl } from "../src/api";

test("an empty configured API URL keeps requests relative", () => {
  expect(apiBaseUrl("")).toBe("");
});

test("the development API URL remains the default", () => {
  expect(apiBaseUrl(undefined)).toBe("http://localhost:3000");
});

test("a configured API URL is preserved", () => {
  expect(apiBaseUrl("https://api.example.test")).toBe("https://api.example.test");
});

test("an empty live URL resolves to the page origin under /live", () => {
  expect(liveUrl("", { protocol: "https:", host: "weft.example" })).toBe("wss://weft.example/live");
  expect(liveUrl("", { protocol: "http:", host: "localhost:8080" })).toBe("ws://localhost:8080/live");
});

test("the live URL keeps its development default and configured value", () => {
  expect(liveUrl(undefined, { protocol: "https:", host: "x" })).toBe("ws://localhost:3002");
  expect(liveUrl("wss://live.example", { protocol: "https:", host: "x" })).toBe("wss://live.example");
});
