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
