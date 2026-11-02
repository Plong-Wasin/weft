import { expect, test } from "bun:test";
import { buildModelMessages, toDisplaySteps, type StoredRunMessage } from "../src/run-steps";

const row = (seq: number, type: string, extra: Partial<StoredRunMessage> = {}): StoredRunMessage => ({ seq, type, toolName: null, toolCallId: null, input: null, output: null, ...extra });

test("display steps keep sequence order and pair a tool result with its call", () => {
  const steps = toDisplaySteps([
    row(3, "tool_result", { toolName: "get_work_item", toolCallId: "c1", output: { ok: true } }),
    row(1, "thought", { output: "Let me look." }),
    row(2, "action", { toolName: "get_work_item", toolCallId: "c1", input: { displayId: "ALP-1" } }),
    row(4, "response", { output: "All done." }),
  ]);
  expect(steps).toEqual([
    { seq: 1, kind: "thought", text: "Let me look." },
    { seq: 2, kind: "tool_call", toolName: "get_work_item", input: { displayId: "ALP-1" }, result: { ok: true }, failed: false },
    { seq: 4, kind: "answer", text: "All done." },
  ]);
});

test("a tool result carrying an error marks its call failed, and a call without a result has none", () => {
  const steps = toDisplaySteps([
    row(1, "action", { toolName: "a", toolCallId: "c1", input: {} }),
    row(2, "tool_result", { toolName: "a", toolCallId: "c1", output: { error: "Forbidden" } }),
    row(3, "action", { toolName: "b", toolCallId: "c2", input: {} }),
    row(4, "error", { output: "tool_call_limit" }),
  ]);
  expect(steps[0]).toMatchObject({ kind: "tool_call", failed: true });
  expect(steps[1]).toMatchObject({ kind: "tool_call", toolName: "b", result: null, failed: false });
  expect(steps[2]).toEqual({ seq: 4, kind: "error", text: "tool_call_limit" });
});

test("model messages rebuild the conversation from stored rows", () => {
  const messages = buildModelMessages([
    row(1, "thought", { output: "Checking." }),
    row(2, "action", { toolName: "a", toolCallId: "c1", input: { x: 1 } }),
    row(3, "action", { toolName: "b", toolCallId: "c2", input: {} }),
    row(4, "tool_result", { toolName: "a", toolCallId: "c1", output: "ra" }),
    row(5, "tool_result", { toolName: "b", toolCallId: "c2", output: "rb" }),
  ]);
  expect(messages).toEqual([
    { role: "assistant", text: "Checking.", toolCalls: [{ id: "c1", name: "a", input: { x: 1 } }, { id: "c2", name: "b", input: {} }] },
    { role: "tool", toolCallId: "c1", name: "a", output: "ra" },
    { role: "tool", toolCallId: "c2", name: "b", output: "rb" },
  ]);
});
