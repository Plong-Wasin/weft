/** A stored transcript row, as far as the pure helpers need it. */
export interface StoredRunMessage {
  seq: number;
  type: string;
  toolName: string | null;
  toolCallId: string | null;
  input: unknown;
  output: unknown;
}

export type RunDisplayStep =
  | { seq: number; kind: "thought"; text: string }
  | { seq: number; kind: "tool_call"; toolName: string; input: unknown; result: unknown; failed: boolean }
  | { seq: number; kind: "answer"; text: string }
  | { seq: number; kind: "question"; text: string }
  | { seq: number; kind: "error"; text: string };

const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value ?? "");

/** Unwraps a result delimited as retrieved data and reports whether it carries an `error` field. */
function isErrorResult(output: unknown): boolean {
  let value = output;
  if (typeof value === "string") {
    const inner = /^<<<RETRIEVED_DATA[^>]*>>>\n([\s\S]*)\n<<<END_RETRIEVED_DATA[^>]*>>>$/.exec(value)?.[1] ?? value;
    try { value = JSON.parse(inner); } catch { return false; }
  }
  return typeof value === "object" && value !== null && "error" in value;
}

/** Turns stored messages into the steps a person reads: ordered by sequence, each tool result folded into its call. */
export function toDisplaySteps(rows: StoredRunMessage[]): RunDisplayStep[] {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const results = new Map(ordered.filter((row) => row.type === "tool_result" && row.toolCallId).map((row) => [row.toolCallId!, row.output]));
  const steps: RunDisplayStep[] = [];
  for (const row of ordered) {
    if (row.type === "thought") steps.push({ seq: row.seq, kind: "thought", text: text(row.output) });
    else if (row.type === "action") {
      const has = row.toolCallId !== null && results.has(row.toolCallId);
      const result = has ? results.get(row.toolCallId!) : null;
      steps.push({ seq: row.seq, kind: "tool_call", toolName: row.toolName ?? "", input: row.input, result: result ?? null, failed: has && isErrorResult(result) });
    } else if (row.type === "response") steps.push({ seq: row.seq, kind: "answer", text: text(row.output) });
    else if (row.type === "elicitation") steps.push({ seq: row.seq, kind: "question", text: text(row.output) });
    else if (row.type === "error") steps.push({ seq: row.seq, kind: "error", text: text(row.output) });
  }
  return steps;
}

export type RunModelMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string | null; toolCalls: Array<{ id: string; name: string; input: unknown }> }
  | { role: "tool"; toolCallId: string; name: string; output: string };

/** Rebuilds the conversation after the first prompt from stored rows, so a resumed Run needs no worker memory. */
export function buildModelMessages(rows: StoredRunMessage[]): RunModelMessage[] {
  const messages: RunModelMessage[] = [];
  let pending: Extract<RunModelMessage, { role: "assistant" }> | null = null;
  const flush = () => { if (pending) { messages.push(pending); pending = null; } };
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.type === "thought") { flush(); pending = { role: "assistant", text: text(row.output), toolCalls: [] }; }
    else if (row.type === "action") {
      pending ??= { role: "assistant", text: null, toolCalls: [] };
      pending.toolCalls.push({ id: row.toolCallId ?? "", name: row.toolName ?? "", input: row.input });
    } else if (row.type === "tool_result") {
      flush();
      messages.push({ role: "tool", toolCallId: row.toolCallId ?? "", name: row.toolName ?? "", output: text(row.output) });
    }
  }
  flush();
  return messages;
}
