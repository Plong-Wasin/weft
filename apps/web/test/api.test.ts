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

test("an Action that returns null (an empty 200 body) reads as null, not a JSON error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  try {
    const { action, actionResult } = await import("../src/api");
    expect(await action("get_estimate", { projectId: "p" })).toBeNull();
    expect(await actionResult("get_estimate", { projectId: "p" })).toEqual({ data: null });
  } finally {
    globalThis.fetch = original;
  }
});

test("API base resolves relative configured paths against the page origin", () => {
  expect(apiBaseUrl("/api", "https://weft.example/app")).toBe("https://weft.example/api");
  expect(apiBaseUrl("https://api.example.test/", "https://weft.example")).toBe("https://api.example.test/");
  expect(apiBaseUrl("", "https://weft.example")).toBe("");
});

test("action converts network rejection into retryable null", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  try {
    const { action } = await import("../src/api");
    expect(await action("list_member_accounts", {})).toBeNull();
  } finally { globalThis.fetch = original; }
});
