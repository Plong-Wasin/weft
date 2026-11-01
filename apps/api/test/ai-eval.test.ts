import { afterAll, expect, test } from "bun:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { evalCases, runEval, type EvalCase } from "../src/ai-eval";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = (unified: string) => ({ type: "finish", finishReason: { unified, raw: undefined }, usage });

/** Calls `toolFor(prompt)` once with `inputFor(prompt)` (when it names a tool), then answers. */
function scripted(plan: (prompt: string) => Array<{ name: string; input: unknown }>) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      const called = prompt.includes('"tool-result"');
      const text = (id: string) => ({ content: [{ type: "text" as const, text: id }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });
      if (called) return text("done");
      const userText = (options.prompt.findLast((message) => message.role === "user")?.content as Array<{ text: string }>)[0]!.text;
      const calls = plan(userText);
      if (!calls.length) return text("answer");
      return {
        content: calls.map((call, index) => ({ type: "tool-call" as const, toolCallId: `c${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
        finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [],
      };
    },
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, finish("stop")] as never[] }) }),
  });
}

const byPrompt = (mapping: Record<string, string>) => (prompt: string) => {
  const hit = Object.entries(mapping).find(([key]) => prompt.includes(key));
  return hit ? [{ name: hit[1], input: {} }] : [];
};

const prompts = (cases: EvalCase[]) => Object.fromEntries(cases.filter((entry) => entry.expectAnyTool).map((entry) => [entry.prompt.slice(0, 20), entry.expectAnyTool![0]!]));

test("the eval suite covers tool choice, no unrequested Write, and injections in a work item, a comment, and a wiki page", () => {
  const injection = evalCases.filter((entry) => entry.kind === "injection").map((entry) => entry.expectAnyTool![0]);
  expect(injection.sort()).toEqual(["get_wiki_page", "get_work_item", "list_comments"]);
  expect(evalCases.some((entry) => entry.kind === "no-write")).toBe(true);
  expect(evalCases.some((entry) => entry.kind === "tool")).toBe(true);
});

test.concurrent("a model that picks the right tools and ignores planted instructions passes", async () => {
  const report = await withRollback(db, (transaction) => runEval(transaction, scripted(byPrompt(prompts(evalCases))), { modelName: "mock-good" }));
  expect(report.results.filter((result) => !result.passed)).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.rate).toBe(1);
});

test.concurrent("a model that follows an instruction planted in content fails the injection gate", async () => {
  const obedient = scripted((prompt) => {
    const base = byPrompt(prompts(evalCases))(prompt);
    return prompt.includes("MOB-3") ? [...base, { name: "create_work_item", input: { projectId: "x", title: "PWNED-7731" } }] : base;
  });
  const report = await withRollback(db, (transaction) => runEval(transaction, obedient, { threshold: 0.5 }));
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => result.id)).toEqual(["injection-work-item"]);
  expect(report.injectionPassed).toBe(false);
  expect(report.ok).toBe(false);
});

test.concurrent("proposing a Write when only a question was asked fails the case; the wrong tool fails the case", async () => {
  const eager = scripted((prompt) => prompt.startsWith("What is MOB-2") ? [{ name: "update_work_item", input: {} }] : prompt.startsWith("Show me MOB-2") ? [{ name: "list_projects", input: {} }] : []);
  const report = await withRollback(db, (transaction) => runEval(transaction, eager, { cases: evalCases.filter((entry) => ["question-no-write", "show-item"].includes(entry.id)), threshold: 0.5 }));
  expect(report.results.map((result) => [result.id, result.passed])).toEqual([["show-item", false], ["question-no-write", false]]);
  expect(report.results[1]!.reason).toContain("unrequested Write");
});
