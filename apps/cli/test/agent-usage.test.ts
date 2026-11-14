import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCliAdapters } from "../src/agent-cli";
import { startDaemon } from "../src/daemon";

// claude-stream-json-recorded.jsonl: the real `claude -p --output-format stream-json --verbose` output of one tiny prompt on 2026-11-13
// (init, assistant and result lines kept as printed; hook and tool lists dropped). codex-exec-usage-limit-recorded.jsonl: the real
// `codex exec --json` output when the account hit its usage limit, so no turn completed. codex-exec-two-turns-synthetic.jsonl is
// written from the documented `turn.completed` shape because no successful Codex recording was possible at the time: replace it
// with a recording once the quota is back.
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const linesOf = async (name: string) => (await readFile(fixture(name), "utf8")).split("\n").filter(Boolean);

const scratch: string[] = [];
afterAll(async () => { await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true }))); });

test("claude's result line gives the session's input (cache included) and output tokens; its init line names the model", async () => {
  const lines = await linesOf("claude-stream-json-recorded.jsonl");
  const claude = agentCliAdapters.claude;
  const usage = lines.flatMap((line) => { const found = claude.usage(line); return found ? [found] : []; });
  expect(usage).toEqual([{ inputTokens: 2, outputTokens: 4, cacheReadTokens: 7368, cacheCreationTokens: 18845, reportedCostUsd: 0.0761608, total: true }]);
  expect(lines.map((line) => claude.model(line)).filter(Boolean)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
});

test("a Codex run that hit its usage limit reports no usage, so its tokens stay unknown", async () => {
  const lines = await linesOf("codex-exec-usage-limit-recorded.jsonl");
  expect(lines.map((line) => agentCliAdapters.codex.usage(line))).toEqual([null, null, null, null]);
});

test("Codex turns add up: each turn.completed carries one step of the run's usage", async () => {
  const lines = await linesOf("codex-exec-two-turns-synthetic.jsonl");
  const usage = lines.flatMap((line) => { const found = agentCliAdapters.codex.usage(line); return found ? [found] : []; });
  expect(usage).toEqual([
    { inputTokens: 400, outputTokens: 30, cacheReadTokens: 800, cacheCreationTokens: 0, reportedCostUsd: null, total: false },
    { inputTokens: 300, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, reportedCostUsd: null, total: false },
  ]);
  expect(lines.every((line) => agentCliAdapters.codex.model(line) === null)).toBe(true);
});

test("Codex reads an effective model from session metadata without guessing", () => {
  // This synthetic event verifies parsing only; it does not prove real Codex stdout includes session metadata.
  expect(agentCliAdapters.codex.model(JSON.stringify({ type: "session.meta", payload: { model: "codex-provided-model" } }))).toBe("codex-provided-model");
  expect(agentCliAdapters.codex.model('{"type":"turn.completed"}')).toBeNull();
});

/** Runs the Daemon once against a fake CLI that prints `output`, and returns the body it sent to /api/daemon/runs/finish. */
async function finishBodyOf(agentCli: "claude" | "codex", output: string[], model: string | null, trailingNewline = true) {
  const path = await mkdtemp(join(tmpdir(), "weft-usage-")); scratch.push(path);
  await writeFile(join(path, "printed.jsonl"), output.join("\n") + (trailingNewline ? "\n" : ""));
  await writeFile(join(path, agentCli), `#!/bin/sh\ncat "${join(path, "printed.jsonl")}"\n`);
  await chmod(join(path, agentCli), 0o755);
  const controller = new AbortController();
  let finished: Record<string, unknown> | undefined;
  let claimed = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { XDG_CONFIG_HOME: join(path, "config"), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) {
        if (claimed) return Response.json([]);
        claimed = true;
        return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli, instructions: "Do it", request: "Request", model, token: "weft_run_x", workspaceId: "ws-1", projectId: "pr-1", workItemId: "wi-1", workItemDisplayId: "ALP-7", skills: [] }]);
      }
      if (url.endsWith("/api/daemon/runs/finish")) { finished = JSON.parse(String(init?.body)); setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true, daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(8_000)]);
  controller.abort();
  return finished;
}

test("the Daemon reports the Claude run's counts and the model the CLI printed", async () => {
  const finished = await finishBodyOf("claude", await linesOf("claude-stream-json-recorded.jsonl"), null);
  expect(finished).toMatchObject({ status: "completed", usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 7368, cacheCreationTokens: 18845, reportedCostUsd: 0.0761608 }, model: "claude-sonnet-5-5" });
}, 15_000);

test("the Daemon processes a trailing JSON usage record without a newline", async () => {
  const line = JSON.stringify({ type: "result", result: "done", usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.01 });
  const finished = await finishBodyOf("claude", [line], null, false);
  expect(finished).toMatchObject({ status: "completed", finalOutput: "done", usage: { inputTokens: 7, outputTokens: 2 } });
}, 15_000);

test("the Daemon sums a Codex run's turns and sends the Run's own model when the CLI names none", async () => {
  const finished = await finishBodyOf("codex", await linesOf("codex-exec-two-turns-synthetic.jsonl"), "gpt-test");
  expect(finished).toMatchObject({ status: "completed", usage: { inputTokens: 700, outputTokens: 35, cacheReadTokens: 800, cacheCreationTokens: 0, reportedCostUsd: null }, model: "gpt-test" });
}, 15_000);

test("a Run whose CLI printed no usage is finished with usage null, so the server keeps it unknown", async () => {
  const finished = await finishBodyOf("codex", await linesOf("codex-exec-usage-limit-recorded.jsonl"), null);
  expect(finished).toMatchObject({ status: "completed", usage: null, model: null });
}, 15_000);
