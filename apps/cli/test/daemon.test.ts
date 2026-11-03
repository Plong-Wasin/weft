import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, startDaemon } from "../src/daemon";
import { agentCliAdapters } from "../src/agent-cli";

const scratch: string[] = [];
afterAll(async () => { await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true }))); });

test("weft login accepts a state-matched browser callback and stores the Personal API token", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-login-")); scratch.push(configHome);
  const logs: string[] = [];
  const apiFetch = async (input: string | URL | Request) => {
    const auth = new URL(input.toString());
    const callback = new URL(auth.searchParams.get("callback")!);
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    callback.searchParams.set("token", "weft_test_token");
    return Response.redirect(callback, 302);
  };
  await login({ env: { WEFT_API_URL: "https://weft.example", XDG_CONFIG_HOME: configHome, WEFT_HOSTNAME: "devbox" }, fetch: apiFetch, stdout: (text) => logs.push(text), openBrowser: async (url) => {
    const redirect = await apiFetch(url);
    await fetch(redirect.headers.get("location")!);
  } });
  const saved = JSON.parse(await readFile(join(configHome, "weft/config.json"), "utf8"));
  expect(saved).toEqual({ token: "weft_test_token", apiUrl: "https://weft.example" });
  expect(logs.join("")).toContain("Signed in to https://weft.example");
});

test("Claude and Codex adapters build non-interactive commands and extract streamed final output", () => {
  expect(agentCliAdapters.claude.command({ model: "sonnet", prompt: "do it" })).toContain("bypassPermissions");
  expect(agentCliAdapters.claude.final('{"type":"result","result":"done"}')).toBe("done");
  expect(agentCliAdapters.codex.command({ model: null, prompt: "do it" })).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(agentCliAdapters.codex.final('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')).toBe("done");
});

test("daemon detects Claude and Codex on the injected PATH, registers them, and heartbeats", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-path-")); scratch.push(path);
  const configHome = await mkdtemp(join(tmpdir(), "weft-config-")); scratch.push(configHome);
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft/config.json"), JSON.stringify({ token: "weft_daemon", apiUrl: "https://weft.example" }));
  await Promise.all(["claude", "codex"].map(async (name) => { const file = join(path, name); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o755); }));
  const controller = new AbortController();
  let registration: unknown;
  const frames: string[] = [];
  class FakeSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
    send(frame: string) { frames.push(frame); controller.abort(); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, PATH: path, WEFT_HOSTNAME: "devbox" },
    fetch: async (input, init) => { expect(new URL(String(input)).origin).toBe("https://weft.example"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer weft_daemon"); registration = JSON.parse(String(init?.body)); return Response.json({ daemonId: "daemon-id", runtimes: [] }); },
    webSocket: (url) => { expect(url).toContain("weft.example"); expect(url).toContain("token=weft_daemon"); return new FakeSocket() as unknown as WebSocket; },
    signal: controller.signal, heartbeatMs: 5,
  });
  expect(registration).toMatchObject({ hostname: "devbox", version: "1.0.0", agentClis: ["claude", "codex"] });
  expect(JSON.parse(frames[0]!)).toMatchObject({ type: "heartbeat", daemonId: "daemon-id" });
});

test("daemon reconnects with exponential backoff after dropped WebSockets", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  let registrations = 0;
  class DroppedSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); setTimeout(() => { this.readyState = 3; this.dispatchEvent(new Event("close")); }, 0); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async () => { registrations++; return Response.json({ daemonId: "daemon-id", runtimes: [] }); },
    webSocket: () => new DroppedSocket() as unknown as WebSocket,
    signal: controller.signal,
    sleep: async (ms) => { waits.push(ms); if (waits.length === 2) controller.abort(); },
  });
  expect(registrations).toBe(2);
  expect(waits).toEqual([1_000, 2_000]);
});

test("the daemon claims work on its three-minute safety poll when no WebSocket work signal arrives", async () => {
  const controller = new AbortController();
  let claims = 0;
  class QuietSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async (input) => {
      if (String(input).endsWith("/api/daemon/runs/claim")) { claims++; controller.abort(); return Response.json([]); }
      return Response.json({ daemonId: "daemon-id", runtimes: [] });
    },
    webSocket: () => new QuietSocket() as unknown as WebSocket,
    signal: controller.signal, safetyPollMs: 5,
  });
  expect(claims).toBe(1);
});

test("the running Daemon re-probes PATH and registers a newly installed CLI", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-reprobe-")); scratch.push(path);
  const claude = join(path, "claude");
  await writeFile(claude, "#!/bin/sh\nexit 0\n"); await chmod(claude, 0o755);
  const controller = new AbortController();
  const registrations: unknown[] = [];
  class ConnectedSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: path },
    fetch: async (_input, init) => {
      const registration = JSON.parse(String(init?.body)) as { agentClis: string[] };
      registrations.push(registration.agentClis);
      if (registrations.length === 1) { await writeFile(join(path, "codex"), "#!/bin/sh\nexit 0\n"); await chmod(join(path, "codex"), 0o755); }
      else controller.abort();
      return Response.json({ daemonId: "daemon-id", runtimes: [] });
    },
    webSocket: () => new ConnectedSocket() as unknown as WebSocket,
    signal: controller.signal, reprobeMs: 10, heartbeatMs: 10_000,
  });
  expect(registrations).toEqual([["claude"], ["claude", "codex"]]);
});

test("a long Run streams every transcript message with a unique, increasing seq and the agent receives its work item", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-long-")); scratch.push(path);
  const seen = join(path, "seen.txt");
  await writeFile(join(path, "claude"), `#!/bin/sh\necho "$WEFT_WORK_ITEM_ID|$WEFT_WORK_ITEM_DISPLAY_ID|$WEFT_PROJECT_ID|$WEFT_WORKSPACE_ID|$2" > "${seen}"\ni=0\nwhile [ $i -lt 60 ]; do echo '{"type":"assistant","message":{"content":[{"type":"text","text":"step"}]}}'; i=$((i+1)); done\necho '{"type":"result","result":"all done"}'\n`);
  await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  const sequences: number[] = [];
  let finished: { finalOutput?: string } | undefined;
  let claimed = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) {
        if (claimed) return Response.json([]);
        claimed = true;
        return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "Request", model: null, token: "weft_run_x", workspaceId: "ws-1", projectId: "pr-1", workItemId: "wi-1", workItemDisplayId: "ALP-7", skills: [] }]);
      }
      if (url.endsWith("/api/daemon/runs/messages")) for (const message of JSON.parse(String(init?.body)).messages) sequences.push(message.seq);
      if (url.endsWith("/api/daemon/runs/finish")) { finished = JSON.parse(String(init?.body)); setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(8_000)]);
  controller.abort();
  expect(finished?.finalOutput).toBe("all done");
  expect(sequences).toHaveLength(61);
  expect(sequences).toEqual(Array.from({ length: 61 }, (_, index) => index + 1));
  const [itemId, displayId, projectId, workspaceId, prompt] = (await readFile(seen, "utf8")).trim().split("|");
  expect([itemId, displayId, projectId, workspaceId]).toEqual(["wi-1", "ALP-7", "pr-1", "ws-1"]);
  expect(prompt).toContain("wi-1");
});

test("the running Daemon registers again on a timer so workspaces joined later get Runtimes", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-rereg-")); scratch.push(path);
  await writeFile(join(path, "claude"), "#!/bin/sh\nexit 0\n"); await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  let registrations = 0;
  class ConnectedSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: path },
    fetch: async () => { registrations++; if (registrations >= 2) controller.abort(); return Response.json({ daemonId: "daemon-id", runtimes: [] }); },
    webSocket: () => new ConnectedSocket() as unknown as WebSocket,
    signal: controller.signal, reprobeMs: 10, reregisterMs: 20, heartbeatMs: 10_000,
  });
  expect(registrations).toBeGreaterThanOrEqual(2);
});

test("a failed transcript upload does not orphan the agent: the batch is retried and the Run still finishes", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-flush-")); scratch.push(path);
  await writeFile(join(path, "claude"), `#!/bin/sh\ni=0\nwhile [ $i -lt 30 ]; do echo '{"type":"assistant","message":{"content":[{"type":"text","text":"step"}]}}'; i=$((i+1)); done\necho '{"type":"result","result":"fine"}'\n`);
  await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  const sequences: number[] = [];
  let failures = 0; let finished = false; let claimed = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
      if (url.endsWith("/api/daemon/runs/messages")) {
        if (failures++ === 0) return new Response("boom", { status: 500 });
        for (const message of JSON.parse(String(init?.body)).messages) sequences.push(message.seq);
      }
      if (url.endsWith("/api/daemon/runs/finish")) { finished = true; setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    sleep: async () => {},
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(8_000)]);
  controller.abort();
  expect(finished).toBe(true);
  expect(sequences).toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
});

test("a CLI that cannot be spawned fails the Run instead of leaving it running", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-spawnfail-")); scratch.push(path);
  const controller = new AbortController();
  let finish: { status?: string; failureReason?: string } | undefined; let claimed = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: path },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
      if (url.endsWith("/api/daemon/runs/finish")) { finish = JSON.parse(String(init?.body)); setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(5_000)]);
  controller.abort();
  expect(finish).toMatchObject({ status: "failed", failureReason: "spawn_failed" });
});

test("adapters turn Claude and Codex streams into readable transcript text", () => {
  const claudeEvents = agentCliAdapters.claude.parse(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking at it" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }));
  expect(claudeEvents).toEqual([{ type: "thought", text: "Looking at it" }, { type: "thought", text: 'Tool Bash: {"command":"ls"}' }]);
  expect(agentCliAdapters.codex.parse(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "git status" } }))).toEqual([{ type: "thought", text: "Running git status" }]);
});

test("a cancel arriving on a new WebSocket after a reconnect still kills the Run and acknowledges it", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-reconnect-")); scratch.push(path);
  await writeFile(join(path, "claude"), "#!/bin/sh\nexec sleep 30\n"); await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  let claimed = false; let acked = false; let sockets = 0;
  class Socket extends EventTarget {
    readyState = 0;
    constructor(private readonly index: number) { super(); setTimeout(() => {
      this.readyState = 1; this.dispatchEvent(new Event("open"));
      if (index === 1) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); setTimeout(() => this.close(), 400); }
      else setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "cancel", runId: "run-1" }) })), 100);
    }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
      if (url.endsWith("/api/daemon/runs/cancel-ack")) { acked = true; setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true });
    },
    webSocket: () => new Socket(++sockets) as unknown as WebSocket,
    sleep: async () => {},
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(8_000)]);
  controller.abort();
  expect(sockets).toBeGreaterThanOrEqual(2);
  expect(acked).toBe(true);
});

test("the Daemon kills a Run's CLI when the server says the Run is no longer active, and when its own time limit passes", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-inactive-")); scratch.push(path);
  await writeFile(join(path, "claude"), `#!/bin/sh\nwhile true; do echo '{"type":"assistant","message":{"content":[{"type":"text","text":"tick"}]}}'; sleep 0.1; done\n`); await chmod(join(path, "claude"), 0o755);
  const run = async (mode: "inactive" | "timeout") => {
    const controller = new AbortController();
    let claimed = false; let finish: { failureReason?: string } | undefined; let ended = false;
    class WorkSocket extends EventTarget {
      readyState = 0;
      constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
      send() {}
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    }
    const daemon = startDaemon({
      env: { WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
        if (url.endsWith("/api/daemon/runs/messages") && mode === "inactive") { ended = true; setTimeout(() => controller.abort(), 1_500); return new Response("not active", { status: 409 }); }
        if (url.endsWith("/api/daemon/runs/finish")) { finish = { failureReason: "seen" }; setTimeout(() => controller.abort(), 0); }
        return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true });
      },
      webSocket: () => new WorkSocket() as unknown as WebSocket,
      sleep: async () => {},
      signal: controller.signal, safetyPollMs: 60_000, runTimeoutMs: mode === "timeout" ? 300 : undefined,
      stdout: () => {},
    });
    await Promise.race([daemon, Bun.sleep(6_000)]);
    controller.abort();
    return { ended, finish };
  };
  const inactive = await run("inactive");
  expect(inactive.ended).toBe(true);
  expect(inactive.finish).toBeUndefined();
  expect((await run("timeout")).finish).toBeDefined();
});
