import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { sourcesOf } from "../src/ai-chat";

const message = (parts: unknown[]) => ({ id: "m", role: "assistant", parts }) as UIMessage;

test("lists each cited web page once and falls back to the url for a missing title", () => {
  expect(sourcesOf(message([
    { type: "text", text: "answer" },
    { type: "source-url", sourceId: "1", url: "https://example.com/a", title: "Page A" },
    { type: "source-url", sourceId: "2", url: "https://example.com/a", title: "Page A again" },
    { type: "source-url", sourceId: "3", url: "https://example.com/b" },
  ]))).toEqual([{ url: "https://example.com/a", title: "Page A" }, { url: "https://example.com/b", title: "https://example.com/b" }]);
});

test("drops links that are not http(s), such as javascript: urls", () => {
  expect(sourcesOf(message([{ type: "source-url", sourceId: "1", url: "javascript:alert(1)", title: "x" }]))).toEqual([]);
});
