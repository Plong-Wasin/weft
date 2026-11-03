export type AgentCliKind = "claude" | "codex";
export type TranscriptEvent = { type: "thought" | "response" | "action"; text: string };

/** One adapter owns CLI invocation flags and converts its JSON stream to transcript events. */
export interface AgentCliAdapter {
  command(input: { model: string | null; prompt: string }): string[];
  parse(line: string): TranscriptEvent[];
  final(line: string): string | null;
}

const claude: AgentCliAdapter = {
  command: ({ model, prompt }) => ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", ...(model ? ["--model", model] : [])],
  parse(line) {
    let item: Record<string, unknown>; try { item = JSON.parse(line); } catch { return []; }
    if (item.type === "assistant") return [{ type: "thought", text: JSON.stringify(item.message ?? item) }];
    if (item.type === "result") return [{ type: "response", text: String(item.result ?? "") }];
    return [];
  },
  final(line) { try { const item = JSON.parse(line); return item.type === "result" ? String(item.result ?? "") : null; } catch { return null; } },
};
const codex: AgentCliAdapter = {
  command: ({ model, prompt }) => ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", ...(model ? ["--model", model] : []), prompt],
  parse(line) {
    let item: Record<string, unknown>; try { item = JSON.parse(line); } catch { return []; }
    if (item.type === "item.completed") {
      const itemData = item.item as Record<string, unknown> | undefined;
      return itemData?.type === "agent_message" ? [{ type: "response", text: String(itemData.text ?? "") }] : [];
    }
    if (item.type === "item.started") return [{ type: "action", text: JSON.stringify(item.item ?? item) }];
    return [];
  },
  final(line) { try { const event = JSON.parse(line); const item = event.item as Record<string, unknown> | undefined; return event.type === "item.completed" && item?.type === "agent_message" ? String(item.text ?? "") : null; } catch { return null; } },
};

export const agentCliAdapters: Record<AgentCliKind, AgentCliAdapter> = { claude, codex };
