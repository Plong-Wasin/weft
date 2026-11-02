import { expect, test } from "bun:test";
import { requestPql } from "../src/ai-pql";

const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test("returns the generated query", async () => {
  expect(await requestPql({ projectId: "p" }, "bugs", reply(200, { query: "label = bug" }))).toEqual({ query: "label = bug" });
});

test("sends scope and request, and returns the server's error text", async () => {
  let sent: unknown;
  const fetcher = async (_url: string, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ error: "limit", code: "rate_limited" }), { status: 429 }); };
  expect(await requestPql({ workspaceId: "w" }, "bugs", fetcher)).toEqual({ error: "limit" });
  expect(sent).toEqual({ workspaceId: "w", request: "bugs" });
});

test("an offline or malformed answer is an error with no text, never a query", async () => {
  expect(await requestPql({}, "x", async () => { throw new Error("offline"); })).toEqual({ error: "" });
  expect(await requestPql({}, "x", reply(200, { nope: 1 }))).toEqual({ error: "" });
});
