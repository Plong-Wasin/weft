import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, tool, type LanguageModel, type ModelMessage } from "ai";
import type { RunModel, RunModelMessage } from "@weft/actions";

/** Same configuration as the API's chat: `AI_PROVIDER` (openai | anthropic), `AI_MODEL`, and each SDK's own key variable. Null when no key is set. */
export function resolveWorkerModel(env: Record<string, string | undefined> = Bun.env): LanguageModel | null {
  const provider = (env.AI_PROVIDER ?? "openai").toLowerCase();
  const modelId = env.AI_MODEL ?? "gpt-6-luna";
  if (provider === "openai") return env.OPENAI_API_KEY?.trim() ? createOpenAI({ apiKey: env.OPENAI_API_KEY })(modelId) : null;
  if (provider === "anthropic") return env.ANTHROPIC_API_KEY?.trim() ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId) : null;
  throw new Error(`Unsupported AI_PROVIDER "${provider}" (use openai or anthropic)`);
}

function toModelMessages(messages: RunModelMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === "user") return { role: "user", content: message.text };
    if (message.role === "assistant") {
      return { role: "assistant", content: [
        ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
        ...message.toolCalls.map((call) => ({ type: "tool-call" as const, toolCallId: call.id, toolName: call.name, input: call.input })),
      ] };
    }
    return { role: "tool", content: [{ type: "tool-result", toolCallId: message.toolCallId, toolName: message.name, output: { type: "text", value: message.output } }] };
  });
}

/** One model step per call; the Run's own loop executes the tools, so none carries an `execute`. */
export function createRunModel(model: LanguageModel): RunModel {
  return {
    async step(request) {
      const result = await generateText({
        model, system: request.system, messages: toModelMessages(request.messages),
        tools: Object.fromEntries(request.tools.map((entry) => [entry.name, tool({ description: entry.description, inputSchema: jsonSchema(entry.inputSchema as never) })])),
      });
      return {
        text: result.text || null,
        toolCalls: result.toolCalls.map((call) => ({ id: call.toolCallId, name: call.toolName, input: call.input })),
        usage: { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 },
      };
    },
  };
}
