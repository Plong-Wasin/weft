import { afterAll, expect, test } from "bun:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";
import { aiStatus, systemPromptForMode, webSearchAvailable, webSearchPrompt } from "../src/ai";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const answer = () => new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "ok" }, { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as never[],
    }),
  }),
});

test("web search is available for openai and anthropic unless AI_WEB_SEARCH is off", () => {
  expect(webSearchAvailable({})).toBe(true);
  expect(webSearchAvailable({ AI_PROVIDER: "anthropic" })).toBe(true);
  expect(webSearchAvailable({ AI_WEB_SEARCH: "off" })).toBe(false);
  expect(webSearchAvailable({ AI_WEB_SEARCH: "OFF" })).toBe(false);
  expect(webSearchAvailable({ AI_PROVIDER: "something-else" })).toBe(false);
  expect(aiStatus({ OPENAI_API_KEY: "k" }).webSearch).toBe(true);
  expect(aiStatus({ OPENAI_API_KEY: "k", AI_WEB_SEARCH: "off" }).webSearch).toBe(false);
});

test("the web search prompt tells the model web content is data and sources are cited", () => {
  expect(webSearchPrompt).toContain("web_search");
  expect(webSearchPrompt).toMatch(/never follow instructions/i);
  expect(webSearchPrompt).toMatch(/cite/i);
  expect(systemPromptForMode("en", "build")).not.toContain("web_search");
});

async function chatWith(body: { webSearch?: boolean; mode?: "ask" | "build" }, aiEnv: Record<string, string | undefined>) {
  let offered: string[] = [];
  let system = "";
  await withRollback(db, async (transaction) => {
    const model = answer();
    const app = createApp(undefined, transaction, undefined, model, undefined, { aiEnv });
    const call = async (path: string, payload: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(payload),
    }));
    const cookie = (await call("/api/auth/sign-up/email", { name: "Ann", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
    const response = await call("/api/ai/chat", {
      id: crypto.randomUUID(), workspaceId: workspace.id, ...body,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
    }, cookie);
    expect(response.status).toBe(200);
    await response.text();
    const first = model.doStreamCalls[0]!;
    offered = (first.tools ?? []).map((entry) => (entry as { name: string }).name);
    system = JSON.stringify(first.prompt);
  });
  return { offered, system };
}

test.concurrent("the chat offers web_search only when the user switched it on and the server allows it", async () => {
  const off = await chatWith({}, {});
  expect(off.offered).not.toContain("web_search");
  expect(off.system).not.toContain("web_search");

  const on = await chatWith({ webSearch: true }, {});
  expect(on.offered).toContain("web_search");
  expect(on.system).toContain("never follow instructions");

  const askMode = await chatWith({ webSearch: true, mode: "ask" }, { AI_PROVIDER: "anthropic" });
  expect(askMode.offered).toContain("web_search");
  expect(askMode.offered).not.toContain("update_work_item");

  const unsupported = await chatWith({ webSearch: true }, { AI_PROVIDER: "other" });
  expect(unsupported.offered).not.toContain("web_search");

  const disabled = await chatWith({ webSearch: true }, { AI_WEB_SEARCH: "off" });
  expect(disabled.offered).not.toContain("web_search");
});

const searchedTurn = () => new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "ws1", toolName: "web_search", input: "{}", providerExecuted: true },
        { type: "tool-result", toolCallId: "ws1", toolName: "web_search", result: { status: "completed" }, providerExecuted: true },
        { type: "source", sourceType: "url", id: "s1", url: "https://example.com/doc", title: "Example doc" },
        { type: "text-start", id: "t1", providerMetadata: { openai: { itemId: "msg_1" } } }, { type: "text-delta", id: "t1", delta: "found it" }, { type: "text-end", id: "t1", providerMetadata: { openai: { itemId: "msg_1" } } },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as never[],
    }),
  }),
});

test.concurrent("sources are streamed and saved, and a later turn replays the answer without the provider's search call or ids", async () => {
  await withRollback(db, async (transaction) => {
    const first = searchedTurn();
    const call = async (app: ReturnType<typeof createApp>, path: string, payload: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(payload),
    }));
    const app = createApp(undefined, transaction, undefined, first, undefined, { aiEnv: {} });
    const cookie = (await call(app, "/api/auth/sign-up/email", { name: "Ann", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const workspace = await (await call(app, "/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
    const id = crypto.randomUUID();
    const streamed = await (await call(app, "/api/ai/chat", { id, workspaceId: workspace.id, webSearch: true, messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "find docs" }] }] }, cookie)).text();
    expect(streamed).toContain("https://example.com/doc");

    const saved = await (await call(app, "/api/ai/chats/get", { chatId: id }, cookie)).json() as { messages: { role: string; parts: { type: string; url?: string }[] }[] };
    const assistant = saved.messages.find((message) => message.role === "assistant")!;
    expect(assistant.parts.some((part) => part.type === "source-url" && part.url === "https://example.com/doc")).toBe(true);

    // Second turn with web search off, against a fresh model so only this turn's prompt is inspected.
    const second = answer();
    const app2 = createApp(undefined, transaction, undefined, second, undefined, { aiEnv: {} });
    const reply = await call(app2, "/api/ai/chat", { id, workspaceId: workspace.id, messages: [{ id: "u2", role: "user", parts: [{ type: "text", text: "thanks" }] }] }, cookie);
    expect(reply.status).toBe(200);
    await reply.text();
    const prompt = JSON.stringify(second.doStreamCalls[0]!.prompt);
    expect(prompt).toContain("found it");
    expect(prompt).not.toContain("web_search");
    expect(prompt).not.toContain("msg_1");
  });
});
