import { expect, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import { createChatTransport, createContinuationGate, isContinuationRequest, shouldContinueAfterConfirmations } from "../src/ai-chat";

const now = new Date("2026-01-01T00:00:00Z");
const live = "2026-01-01T01:00:00Z";
const past = "2025-12-31T23:00:00Z";
const card = (status: string, expiresAt = live) => ({ status, expiresAt });

test("Build continues once every card is decided", () => {
  expect(shouldContinueAfterConfirmations("build", [card("confirmed"), card("rejected"), card("failed")], now)).toBe(true);
});

test("a card still pending keeps the chat waiting", () => {
  expect(shouldContinueAfterConfirmations("build", [card("confirmed"), card("pending")], now)).toBe(false);
});

test("an expired card is not waiting", () => {
  expect(shouldContinueAfterConfirmations("build", [card("confirmed"), card("pending", past)], now)).toBe(true);
});

test("Ask and Autopilot never continue", () => {
  expect(shouldContinueAfterConfirmations("ask", [card("confirmed")], now)).toBe(false);
  expect(shouldContinueAfterConfirmations("autopilot", [card("confirmed")], now)).toBe(false);
});

test("a submit ending on the assistant turn is a continuation; a user message or Regenerate is not", () => {
  expect(isContinuationRequest("submit-message", [{ role: "user" }, { role: "assistant" }])).toBe(true);
  expect(isContinuationRequest("submit-message", [{ role: "assistant" }, { role: "user" }])).toBe(false);
  expect(isContinuationRequest("regenerate-message", [{ role: "user" }])).toBe(false);
});

test("resolving the last card sends no user message: the request is a bare continuation without skill or mode", async () => {
  const bodies: Array<{ messages: Array<{ role: string }>; [key: string]: unknown }> = [];
  const transport = createChatTransport({
    api: "http://api.test/api/ai/chat", workspaceId: "w1", mode: "build", skillId: "s1", webSearch: false,
    fetch: (async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }); }) as unknown as typeof fetch,
  });
  const chat = new Chat({ id: "c1", transport, messages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Rename it" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Proposed." }] },
  ] });
  await chat.sendMessage();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.continuation).toBe(true);
  expect(bodies[0]).not.toHaveProperty("skillId");
  expect(bodies[0]).not.toHaveProperty("mode");
  expect(bodies[0]!.messages.every((message) => message.role === "assistant")).toBe(true);
  expect(chat.messages.filter((message) => message.role === "user")).toHaveLength(1);
});

test("a typed message sends the mode and skill and is not a continuation", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const transport = createChatTransport({
    api: "http://api.test/api/ai/chat", workspaceId: "w1", mode: "build", skillId: "s1", webSearch: false,
    fetch: (async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }); }) as unknown as typeof fetch,
  });
  await new Chat({ id: "c2", transport, messages: [] }).sendMessage({ text: "hi" });
  expect(bodies[0]).toMatchObject({ mode: "build", skillId: "s1" });
  expect(bodies[0]).not.toHaveProperty("continuation");
});

test("the continuation's answer joins the same assistant message: decided cards stay and the new card appears after them", async () => {
  const sse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
  const transport = createChatTransport({
    api: "http://api.test/api/ai/chat", workspaceId: "w1", mode: "build", webSearch: false,
    fetch: (async () => sse([
      { type: "start", messageId: "a1" },
      { type: "tool-input-available", toolCallId: "call-2", toolName: "create_page", input: {} },
      { type: "tool-output-available", toolCallId: "call-2", output: JSON.stringify({ confirmationId: "card-2" }) },
      { type: "finish" },
    ])) as unknown as typeof fetch,
  });
  const chat = new Chat({ id: "c3", transport, messages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Make a page and link it" }] },
    { id: "a1", role: "assistant", parts: [{ type: "tool-create_work_item", toolCallId: "call-1", state: "output-available", input: {}, output: JSON.stringify({ confirmationId: "card-1" }) }] },
  ] as never });
  await chat.sendMessage();
  expect(chat.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
  const toolOutputs = chat.messages[1]!.parts.filter((part) => part.type.startsWith("tool-")).map((part) => String((part as { output?: unknown }).output));
  expect(toolOutputs).toEqual([JSON.stringify({ confirmationId: "card-1" }), JSON.stringify({ confirmationId: "card-2" })]);
});

test("a continuation requested while the answer streams waits and fires once when the chat is idle", () => {
  let sent = 0;
  let busy = true;
  const gate = createContinuationGate(() => { sent += 1; }, () => busy);
  gate.request();
  expect(sent).toBe(0);
  gate.settle(true);
  expect(sent).toBe(0);
  busy = false;
  gate.settle(false);
  expect(sent).toBe(1);
  gate.settle(false);
  expect(sent).toBe(1);
});

test("a continuation requested while idle fires immediately", () => {
  let sent = 0;
  const gate = createContinuationGate(() => { sent += 1; }, () => false);
  gate.request();
  expect(sent).toBe(1);
  gate.settle(false);
  expect(sent).toBe(1);
});

test("a stream that ends between the click and the request does not drop the continuation", () => {
  let sent = 0;
  let busy = true;
  const gate = createContinuationGate(() => { sent += 1; }, () => busy);
  busy = false;
  gate.settle(false);
  gate.request();
  expect(sent).toBe(1);
});
