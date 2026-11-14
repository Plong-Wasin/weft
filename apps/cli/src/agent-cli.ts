export type AgentCliKind = "claude" | "codex";
export type TranscriptEvent = { type: "thought" | "response" | "action"; text: string };

/**
 * Token counts one CLI line reports. `total` means the line carries the whole run's counts (Claude's result line);
 * otherwise the counts are one step and add up over the run (Codex prints one `turn.completed` per turn).
 */
export type CliUsage = {
  /** Fresh input tokens only: cache reads and cache creation are in their own fields because they are priced differently. */
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  /** The total cost in USD the CLI itself printed (Claude `total_cost_usd`), or null. */
  reportedCostUsd: number | null;
  total: boolean;
};

/** One adapter owns CLI invocation flags and converts its JSON stream to transcript events, usage and the model name. */
export interface AgentCliAdapter {
  command(input: { model: string | null; prompt: string }): string[];
  parse(line: string): TranscriptEvent[];
  final(line: string): string | null;
  usage(line: string): CliUsage | null;
  model(line: string): string | null;
}

const numberField = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

const claude: AgentCliAdapter = {
  command: ({ model, prompt }) => ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", ...(model ? ["--model", model] : [])],
  parse(line) {
    let item: Record<string, unknown>; try { item = JSON.parse(line); } catch { return []; }
    if (item.type === "assistant") {
      const content = ((item.message as { content?: unknown } | undefined)?.content);
      if (!Array.isArray(content)) return [];
      return content.flatMap((block: Record<string, unknown>): TranscriptEvent[] => {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) return [{ type: "thought", text: block.text }];
        if (block.type === "tool_use") return [{ type: "thought", text: `Tool ${String(block.name)}: ${JSON.stringify(block.input ?? {}).slice(0, 500)}` }];
        return [];
      });
    }
    if (item.type === "result") return [{ type: "response", text: String(item.result ?? "") }];
    return [];
  },
  final(line) { try { const item = JSON.parse(line); return item.type === "result" ? String(item.result ?? "") : null; } catch { return null; } },
  // The result line totals the session. Cache reads and creation stay apart from input: they count toward the budget but are priced on their own.
  usage(line) {
    let item: Record<string, unknown>; try { item = JSON.parse(line); } catch { return null; }
    if (item.type !== "result" || !item.usage || typeof item.usage !== "object") return null;
    const usage = item.usage as Record<string, unknown>;
    const input = numberField(usage.input_tokens), output = numberField(usage.output_tokens);
    if (input === null || output === null) return null;
    const cost = typeof item.total_cost_usd === "number" && Number.isFinite(item.total_cost_usd) && item.total_cost_usd >= 0 ? item.total_cost_usd : null;
    return { inputTokens: input, outputTokens: output, cacheReadTokens: numberField(usage.cache_read_input_tokens) ?? 0, cacheCreationTokens: numberField(usage.cache_creation_input_tokens) ?? 0, reportedCostUsd: cost, total: true };
  },
  model(line) {
    let item: Record<string, unknown>; try { item = JSON.parse(line); } catch { return null; }
    if (item.type === "system" && item.subtype === "init" && typeof item.model === "string") return item.model;
    const message = item.type === "assistant" ? item.message as Record<string, unknown> | undefined : undefined;
    return typeof message?.model === "string" ? message.model : null;
  },
};
const codex: AgentCliAdapter = {
  command: ({ model, prompt }) => ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", ...(model ? ["--model", model] : []), prompt],
  parse(line) {
    let item: Record<string, unknown>; try { item = JSON.parse(line); } catch { return []; }
    if (item.type === "item.completed") {
      const itemData = item.item as Record<string, unknown> | undefined;
      return itemData?.type === "agent_message" ? [{ type: "response", text: String(itemData.text ?? "") }] : [];
    }
    if (item.type === "item.started") {
      const data = (item.item ?? {}) as Record<string, unknown>;
      const what = typeof data.command === "string" ? data.command : typeof data.type === "string" ? data.type : "step";
      return [{ type: "thought", text: `Running ${what}`.slice(0, 500) }];
    }
    return [];
  },
  final(line) { try { const event = JSON.parse(line); const item = event.item as Record<string, unknown> | undefined; return event.type === "item.completed" && item?.type === "agent_message" ? String(item.text ?? "") : null; } catch { return null; } },
  // Codex reports one usage block per completed turn. Its input_tokens already include cached_input_tokens, so the cached part is moved
  // out of the fresh input here: the two never add up to more than the provider billed.
  usage(line) {
    let event: Record<string, unknown>; try { event = JSON.parse(line); } catch { return null; }
    if (event.type !== "turn.completed" || !event.usage || typeof event.usage !== "object") return null;
    const usage = event.usage as Record<string, unknown>;
    const input = numberField(usage.input_tokens), output = numberField(usage.output_tokens);
    if (input === null || output === null) return null;
    const cached = Math.min(numberField(usage.cached_input_tokens) ?? 0, input);
    return { inputTokens: input - cached, outputTokens: output, cacheReadTokens: cached, cacheCreationTokens: 0, reportedCostUsd: null, total: false };
  },
  model(line) {
    let event: Record<string, unknown>; try { event = JSON.parse(line); } catch { return null; }
    const item = event.item as Record<string, unknown> | undefined;
    if (typeof event.model === "string") return event.model;
    if (typeof item?.model === "string") return item.model;
    // Codex only exposes its effective model in session metadata when that event is present in stdout.
    const info = event.type === "session.meta" ? event.payload as Record<string, unknown> | undefined : undefined;
    return typeof info?.model === "string" ? info.model : null;
  },
};

export const agentCliAdapters: Record<AgentCliKind, AgentCliAdapter> = { claude, codex };
