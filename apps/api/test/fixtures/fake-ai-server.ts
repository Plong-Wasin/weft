// The API with a scripted model instead of a provider, for browser flows: no key, no network. Run as `bun apps/api/test/fixtures/fake-ai-server.ts` with PORT set.
// A user message of the form `create <projectId> <title> | <title>` makes one create_work_item call per title; after the tool results the model answers with their display ids.
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createApp } from "../../src/app";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (chunks: unknown[]) => ({ stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...chunks] as never[] }) });
const finish = (reason: "stop" | "tool-calls") => ({ type: "finish", finishReason: { unified: reason, raw: undefined }, usage });
const answer = (text: string) => stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, finish("stop")]);

const model = new MockLanguageModelV4({
  doStream: async ({ prompt }) => {
    const last = prompt.at(-1)!;
    // The display ids of everything the tools of this chat have made, including an approved proposal's outcome.
    const made = () => [...new Set(JSON.stringify(prompt.filter((message) => message.role === "tool")).match(/\b[A-Z][A-Z0-9]+-\d+\b/g))];
    const done = (otherwise: string) => answer(made().length ? `Done: **${made().join("**, **")}**.` : otherwise);
    if (last.role === "tool") return done("I proposed the work item. Confirm it to create it.");
    const text = last.role === "user" ? last.content.map((part) => part.type === "text" ? part.text : "").join("") : "";
    const command = /^create ([0-9a-f-]{36}) (.+)$/.exec(text);
    if (!command) return done("Nothing else to change.");
    return stream([
      ...command[2]!.split("|").map((title) => ({ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: "create_work_item", input: JSON.stringify({ projectId: command[1], title: title.trim() }) })),
      finish("tool-calls"),
    ]);
  },
});

createApp(undefined, undefined, undefined, model, undefined, undefined, undefined, undefined, undefined, undefined, { ai: true }).listen(Number(Bun.env.PORT));
