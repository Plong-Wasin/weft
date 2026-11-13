import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnvironment, daemonStatus, login, startDaemon, startDaemonBackground, stopDaemon } from "../src/daemon";
import { agentCliAdapters } from "../src/agent-cli";
import { main } from "../src/program";

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

test("daemon status reports a live record and removes a stale record", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-status-")); scratch.push(configHome);
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  const recordPath = join(directory, "daemon.json");
  await writeFile(recordPath, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 65_000).toISOString(), apiUrl: "https://weft.example", agentClis: ["claude"], logPath: join(directory, "daemon.log") }));
  expect(await daemonStatus({ env: { XDG_CONFIG_HOME: configHome } })).toMatchObject({ running: true, pid: process.pid, agentClis: ["claude"], server: "https://weft.example" });
  await writeFile(recordPath, JSON.stringify({ pid: 2_000_000_000, startedAt: new Date().toISOString(), apiUrl: "https://weft.example", agentClis: [], logPath: join(directory, "daemon.log") }));
  expect(await daemonStatus({ env: { XDG_CONFIG_HOME: configHome } })).toMatchObject({ running: false, logPath: join(directory, "daemon.log") });
  await expect(readFile(recordPath, "utf8")).rejects.toThrow();
});

test("daemon status has clear human output and machine-readable JSON", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-status-output-")); scratch.push(configHome);
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "daemon.json"), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 61_000).toISOString(), apiUrl: "https://weft.example", agentClis: ["claude", "codex"], logPath: join(directory, "daemon.log") }));
  const invoke = async (args: string[]) => {
    const out: string[] = [];
    await main(["bun", "weft", "daemon", "status", ...args], { env: { XDG_CONFIG_HOME: configHome }, stdout: (text) => out.push(text), stderr: () => {} });
    return out.join("");
  };
  const human = await invoke([]);
  expect(human).toContain(`Daemon is running as process ${process.pid}`);
  expect(human).toContain("Agent CLIs: claude, codex");
  expect(human).toContain("Signed in to: https://weft.example");
  expect(JSON.parse(await invoke(["--json"]))).toMatchObject({ running: true, pid: process.pid, agentClis: ["claude", "codex"], server: "https://weft.example" });
});

test("a second stop explains that the Daemon is not running and how to start it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-stop-empty-")); scratch.push(configHome);
  const output: string[] = [];
  expect(await stopDaemon({ env: { XDG_CONFIG_HOME: configHome }, stdout: (text) => output.push(text) })).toBe(false);
  expect(output.join("")).toContain("Daemon is not running");
  expect(output.join("")).toContain("weft daemon start");
});

test("background start records a private log and process file, and refuses a second start", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-background-")); scratch.push(configHome);
  const outputs: string[] = [];
  const env = { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "daemon-test-token", WEFT_API_URL: "https://weft.example", PATH: Bun.env.PATH };
  let spawnedArgs: string[] = [];
  let detached = false;
  const fakeSpawn = (argv: string[], options?: { detached?: boolean }) => { spawnedArgs = argv; detached = Boolean(options?.detached); return { pid: process.pid, unref() {} }; };
  const record = await startDaemonBackground({ env, stdout: (text) => outputs.push(text), backgroundSpawn: fakeSpawn });
  expect(spawnedArgs.slice(-2)).toEqual(["start", "--foreground"]);
  expect(detached).toBe(true);
  expect((await daemonStatus({ env })).running).toBe(true);
  await expect(startDaemonBackground({ env, stdout: () => {}, backgroundSpawn: fakeSpawn })).rejects.toThrow(`process ${record.pid}`);
  const file = await readFile(join(configHome, "weft", "daemon.json"), "utf8");
  const log = await readFile(join(configHome, "weft", "daemon.log"), "utf8");
  expect(file).not.toContain("daemon-test-token");
  expect(log).not.toContain("daemon-test-token");
  await expect((await import("node:fs/promises")).stat(join(configHome, "weft", "daemon.json")).then((stat) => stat.mode & 0o777)).resolves.toBe(0o600);
  await expect((await import("node:fs/promises")).stat(join(configHome, "weft", "daemon.log")).then((stat) => stat.mode & 0o777)).resolves.toBe(0o600);
  expect(outputs.join("")).toContain(record.logPath);
  await rm(join(configHome, "weft"), { recursive: true, force: true });
});

test("background start returns while a separate Daemon registers with a fake server, and stop ends it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-daemon-blackbox-")); scratch.push(configHome);
  let registrations = 0;
  let stopRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, instance) {
      const path = new URL(request.url).pathname;
      if (path === "/api/daemon") return instance.upgrade(request) ? undefined : new Response("WebSocket required", { status: 400 });
      if (path === "/api/daemon/register") { registrations++; return Response.json({ daemonId: "fake-daemon", runtimes: [] }); }
      if (path === "/api/daemon/stop") { stopRequests++; return Response.json({ ok: true }); }
      if (path === "/api/daemon/runs/claim") return Response.json([]);
      return Response.json({ ok: true });
    },
    websocket: { open() {}, message() {}, close() {} },
  });
  const configDir = join(configHome, "weft"); await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ token: "fake-daemon-token", apiUrl: `http://127.0.0.1:${server.port}` }));
  const oldEntry = process.argv[1];
  let daemonPid: number | undefined;
  try {
    process.argv[1] = join(import.meta.dir, "../src/index.ts");
    const record = await startDaemonBackground({ env: { XDG_CONFIG_HOME: configHome, PATH: "" }, stdout: () => {} });
    daemonPid = record.pid;
    expect((await daemonStatus({ env: { XDG_CONFIG_HOME: configHome } })).running).toBe(true);
    const deadline = Date.now() + 5_000;
    while (registrations === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(registrations).toBeGreaterThan(0);
    await stopDaemon({ env: { XDG_CONFIG_HOME: configHome }, stdout: () => {} });
    daemonPid = undefined;
    expect(stopRequests).toBe(1);
    expect((await daemonStatus({ env: { XDG_CONFIG_HOME: configHome } })).running).toBe(false);
  } finally {
    process.argv[1] = oldEntry!;
    if (daemonPid) { try { process.kill(daemonPid, "SIGKILL"); } catch {} }
    server.stop(true);
  }
});

test("Claude and Codex adapters build non-interactive commands and extract streamed final output", () => {
  expect(agentCliAdapters.claude.command({ model: "sonnet", prompt: "do it" })).toContain("bypassPermissions");
  expect(agentCliAdapters.claude.final('{"type":"result","result":"done"}')).toBe("done");
  expect(agentCliAdapters.codex.command({ model: null, prompt: "do it" })).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(agentCliAdapters.codex.final('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')).toBe("done");
});

test("Run child environment includes its allowlisted host and provider variables only", () => {
  const allowlisted = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GIT_ASKPASS", "SSH_AUTH_SOCK"];
  const hostEnv = Object.fromEntries([...allowlisted.map((key) => [key, `host-${key}`]), ["WEFT_TOKEN", "daemon-token"], ["DATABASE_URL", "postgres://secret"], ["OTHER_TOKEN", "unlisted-token"], ["APP_SECRET", "unlisted-secret"]]);
  const child = childEnvironment({ runId: "run", runtimeId: "rt", agentCli: "claude", instructions: "", request: "", model: null, token: "run-token", workspaceId: "ws" }, "https://weft.example", hostEnv);
  expect(Object.keys(child).sort()).toEqual([...allowlisted, "WEFT_API_URL", "WEFT_COMMENT_ID", "WEFT_PROJECT_ID", "WEFT_RUN_ID", "WEFT_TOKEN", "WEFT_TRIGGER_ID", "WEFT_WORKSPACE_ID", "WEFT_WORK_ITEM_DISPLAY_ID", "WEFT_WORK_ITEM_ID"].sort());
  expect(child).toMatchObject({ HOME: "host-HOME", PATH: "host-PATH", ANTHROPIC_API_KEY: "host-ANTHROPIC_API_KEY", WEFT_TOKEN: "run-token", WEFT_API_URL: "https://weft.example" });
  expect(child).not.toHaveProperty("DATABASE_URL");
  expect(child).not.toHaveProperty("OTHER_TOKEN");
  expect(child).not.toHaveProperty("APP_SECRET");
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
    fetch: async (input, init) => { expect(new URL(String(input)).origin).toBe("https://weft.example"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer weft_daemon"); if (String(input).endsWith("/api/daemon/register")) registration = JSON.parse(String(init?.body)); return Response.json({ daemonId: "daemon-id", runtimes: [] }); },
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
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", timeoutSeconds: mode === "timeout" ? 1 : 1800, instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
        if (url.endsWith("/api/daemon/runs/messages") && mode === "inactive") { ended = true; setTimeout(() => controller.abort(), 1_500); return new Response("not active", { status: 409 }); }
        if (url.endsWith("/api/daemon/runs/finish")) { finish = JSON.parse(String(init?.body)) as { failureReason?: string }; setTimeout(() => controller.abort(), 0); }
        return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true });
      },
      webSocket: () => new WorkSocket() as unknown as WebSocket,
      sleep: async () => {},
      signal: controller.signal, safetyPollMs: 60_000,
      stdout: () => {},
    });
    await Promise.race([daemon, Bun.sleep(6_000)]);
    controller.abort();
    return { ended, finish };
  };
  const inactive = await run("inactive");
  expect(inactive.ended).toBe(true);
  expect(inactive.finish).toBeUndefined();
  expect((await run("timeout")).finish).toMatchObject({ failureReason: "timeout" });
});
