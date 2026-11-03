import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentCliAdapters, type AgentCliKind } from "./agent-cli";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface DaemonEnvironment {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  openBrowser?: (url: string) => Promise<void> | void;
  webSocket?: (url: string) => WebSocket;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  heartbeatMs?: number;
  reprobeMs?: number;
  safetyPollMs?: number;
}

const wait = (ms: number) => Bun.sleep(ms);
const output = (environment: DaemonEnvironment, text: string) => (environment.stdout ?? ((value) => process.stdout.write(value)))(text);

function settingsPath(env: Record<string, string | undefined>) {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? process.env.HOME ?? ".", ".config");
  return join(base, "weft", "config.json");
}

export async function readCliConfig(env: Record<string, string | undefined>) {
  try { return JSON.parse(await readFile(settingsPath(env), "utf8")) as { token?: string; apiUrl?: string }; }
  catch { return {}; }
}

export async function login(environment: DaemonEnvironment = {}) {
  const env = environment.env ?? Bun.env;
  const apiUrl = (env.WEFT_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const state = crypto.randomUUID();
  let finishCallback: ((token: string) => void) | undefined;
  const tokenPromise = new Promise<string>((resolve) => { finishCallback = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== state || !url.searchParams.get("token")) return new Response("Invalid sign-in callback", { status: 400 });
      finishCallback?.(url.searchParams.get("token")!);
      return new Response("Sign-in complete. You can close this browser tab.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    },
  });
  try {
    const callback = `http://127.0.0.1:${server.port}/callback`;
    const auth = new URL(`${apiUrl}/api/cli/login`);
    auth.searchParams.set("callback", callback);
    auth.searchParams.set("state", state);
    auth.searchParams.set("hostname", env.WEFT_HOSTNAME ?? hostname());
    const open = environment.openBrowser ?? (async (url: string) => {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      Bun.spawn(process.platform === "win32" ? [command, "/c", "start", "", url] : [command, url], { stdout: "ignore", stderr: "ignore" });
    });
    await open(auth.toString());
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error("Sign-in timed out")), 5 * 60_000); });
    const token = await Promise.race([tokenPromise, timeout]);
    if (timeoutId) clearTimeout(timeoutId);
    const config = settingsPath(env);
    await mkdir(join(config, ".."), { recursive: true, mode: 0o700 });
    await writeFile(config, `${JSON.stringify({ token, apiUrl }, null, 2)}\n`, { mode: 0o600 });
    await chmod(config, 0o600);
    output(environment, `Signed in to ${apiUrl}. Token saved to ${config}\n`);
  } finally {
    server.stop(true);
  }
}

async function detectedClis(path = Bun.env.PATH ?? "") {
  const found: Array<"claude" | "codex"> = [];
  for (const name of ["claude", "codex"] as const) {
    for (const directory of path.split(process.platform === "win32" ? ";" : ":")) {
      if (!directory) continue;
      try { await access(join(directory, name), constants.X_OK); found.push(name); break; } catch { /* not installed in this PATH entry */ }
    }
  }
  return found;
}

async function post(fetcher: FetchLike, apiUrl: string, token: string, path: string, body: unknown) {
  const response = await fetcher(`${apiUrl.replace(/\/$/, "")}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-weft-source": "cli" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()) || response.statusText}`);
  return response.json();
}

type ClaimedRun = { runId: string; runtimeId: string; agentCli: AgentCliKind; instructions: string; request: string; model: string | null; token: string;
  workspaceId?: string; projectId?: string | null; workItemId?: string | null; workItemDisplayId?: string | null; commentId?: string | null; triggerId?: string | null;
  skills?: Array<{ name: string; description: string; instructions: string }> };

function runContext(run: ClaimedRun) {
  const lines = [`Weft run: ${run.runId}`, `Workspace id: ${run.workspaceId ?? ""}`];
  if (run.projectId) lines.push(`Project id: ${run.projectId}`);
  if (run.workItemId) lines.push(`Work item: ${run.workItemDisplayId ?? ""} (id ${run.workItemId})`);
  if (run.commentId) lines.push(`Request comment id: ${run.commentId}`);
  if (run.triggerId) lines.push(`Trigger id: ${run.triggerId}`);
  return `${lines.join("\n")}\nUse the \`weft\` CLI (WEFT_API_URL and WEFT_TOKEN are set) to read and change Weft.`;
}

async function executeRun(environment: DaemonEnvironment, fetcher: FetchLike, apiUrl: string, daemonToken: string, run: ClaimedRun, cancellations: Map<string, () => void>) {
  const directory = await mkdtemp(join(tmpdir(), "weft-run-"));
  try {
    const command = agentCliAdapters[run.agentCli].command({ model: run.model, prompt: `${run.instructions}${run.skills?.length ? `\n\nSkills:\n${run.skills.map((skill) => `## ${skill.name}\n${skill.description}\n${skill.instructions}`).join("\n\n")}` : ""}\n\n${runContext(run)}\n\nRequest:\n${run.request}` });
    await post(fetcher, apiUrl, daemonToken, "/api/daemon/runs/start", { runId: run.runId, runtimeId: run.runtimeId });
    const childEnv = Object.fromEntries(Object.entries({ ...Bun.env, ...(environment.env ?? {}), WEFT_API_URL: apiUrl, WEFT_TOKEN: run.token, WEFT_RUN_ID: run.runId, WEFT_WORKSPACE_ID: run.workspaceId ?? "", WEFT_PROJECT_ID: run.projectId ?? "", WEFT_WORK_ITEM_ID: run.workItemId ?? "", WEFT_WORK_ITEM_DISPLAY_ID: run.workItemDisplayId ?? "", WEFT_COMMENT_ID: run.commentId ?? "", WEFT_TRIGGER_ID: run.triggerId ?? "" }).map(([key, value]) => [key, String(value)]));
    const child = Bun.spawn(command, { cwd: directory, env: childEnv, stdout: "pipe", stderr: "pipe" });
    let cancelled = false;
    cancellations.set(run.runId, () => { if (cancelled) return; cancelled = true; child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 10_000).unref(); });
    const messages: Array<{ seq: number; type: string; output: unknown }> = [];
    let finalOutput = "";
    let seq = 0;
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => { flushing = flushing.then(async () => { if (messages.length) await post(fetcher, apiUrl, daemonToken, "/api/daemon/runs/messages", { runId: run.runId, messages: messages.splice(0) }); }); return flushing; };
    const flushTimer = setInterval(() => { void flush().catch(() => {}); }, 1_000);
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        for (const line of lines) {
          const final = agentCliAdapters[run.agentCli].final(line); if (final !== null) finalOutput = final;
          for (const event of agentCliAdapters[run.agentCli].parse(line)) messages.push({ seq: ++seq, type: event.type, output: event.text });
          if (messages.length >= 25) await flush();
        }
      }
    };
    try { await Promise.all([consume(child.stdout), consume(child.stderr)]); } finally { clearInterval(flushTimer); }
    const code = await child.exited;
    if (cancelled) {
      while (!environment.signal?.aborted) {
        try { await post(fetcher, apiUrl, daemonToken, "/api/daemon/runs/cancel-ack", { runId: run.runId }); break; }
        catch { await (environment.sleep ?? wait)(1_000); }
      }
      cancellations.delete(run.runId);
      return;
    }
    cancellations.delete(run.runId);
    await flush();
    for (let attempt = 0; ; attempt++) {
      try { await post(fetcher, apiUrl, daemonToken, "/api/daemon/runs/finish", { runId: run.runId, status: code === 0 ? "completed" : "failed", finalOutput, failureReason: code === 0 ? undefined : "cli_exit" }); break; }
      catch (error) { if (attempt >= 4 || /^4\d\d:/.test(String((error as Error).message))) throw error; await (environment.sleep ?? wait)(1_000 * (attempt + 1)); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Runs the registration and heartbeat loop; the single WebSocket owns reconnect/backoff. */
export async function startDaemon(environment: DaemonEnvironment = {}) {
  const env = environment.env ?? Bun.env;
  const config = await readCliConfig(env);
  const token = env.WEFT_TOKEN ?? config.token;
  if (!token) throw new Error("No Daemon token: run `weft login` first");
  const apiUrl = (env.WEFT_API_URL ?? config.apiUrl ?? "http://localhost:3000").replace(/\/$/, "");
  const fetcher = environment.fetch ?? fetch;
  const sleep = environment.sleep ?? wait;
  const makeSocket = environment.webSocket ?? ((url) => new WebSocket(url));
  let backoffMs = 1_000;
  let registeredClis = "";
  while (!environment.signal?.aborted) {
    try {
      const agentClis = await detectedClis(env.PATH ?? "");
      const signature = agentClis.join(",");
      const registration = await post(fetcher, apiUrl, token, "/actions/register_daemon", { hostname: env.WEFT_HOSTNAME ?? hostname(), version: "1.0.0", agentClis }) as { daemonId: string };
      registeredClis = signature;
      const wsUrl = new URL(`${apiUrl.replace(/^http/, "ws")}/api/daemon`);
      wsUrl.searchParams.set("token", token);
      await new Promise<void>((resolve, reject) => {
        const socket = makeSocket(wsUrl.toString());
        let settled = false;
        let connectedAt: number | undefined;
        let claiming = false;
        const cancellations = new Map<string, () => void>();
        const claim = async () => {
          if (claiming) return;
          claiming = true;
          try {
            const response = await post(fetcher, apiUrl, token, "/api/daemon/runs/claim", {}) as ClaimedRun[];
            // Each Run runs in its own task so a long Run never blocks the next claim.
            for (const run of response) void executeRun(environment, fetcher, apiUrl, token, run, cancellations).catch((error) => output(environment, `Run ${run.runId} failed: ${(error as Error).message}\n`));
          } catch { /* the next work signal or safety poll retries the claim */ }
          finally { claiming = false; }
        };
        let safetyPoll: ReturnType<typeof setInterval>;
        const done = () => { if (!settled) { settled = true; clearInterval(heartbeat); clearInterval(probe); clearInterval(safetyPoll); if (connectedAt && Date.now() - connectedAt >= 60_000) backoffMs = 1_000; reject(new Error("Daemon WebSocket closed")); } };
        const fail = (error: Error) => { if (!settled) { settled = true; clearInterval(heartbeat); clearInterval(probe); clearInterval(safetyPoll); reject(error); } };
        const heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat", daemonId: registration.daemonId }));
        }, environment.heartbeatMs ?? 15_000);
        const probe = setInterval(async () => {
          const next = await detectedClis(env.PATH ?? "");
          const nextSignature = next.join(",");
          if (nextSignature !== registeredClis) {
            try {
              await post(fetcher, apiUrl, token, "/actions/register_daemon", { hostname: env.WEFT_HOSTNAME ?? hostname(), version: "1.0.0", agentClis: next });
              registeredClis = nextSignature;
            } catch { /* the socket reconnect loop retries registration */ }
          }
        }, environment.reprobeMs ?? 60_000);
        safetyPoll = setInterval(() => { void claim(); }, environment.safetyPollMs ?? 180_000);
        socket.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { type?: string; runId?: string };
            if (message.type === "work_available") void claim();
            if (message.type === "cancel" && message.runId) cancellations.get(message.runId)?.();
          } catch { /* ignore unrelated frames */ }
        });
        socket.addEventListener("open", () => { connectedAt = Date.now(); });
        socket.addEventListener("close", done, { once: true });
        socket.addEventListener("error", () => fail(new Error("Daemon WebSocket connection failed")), { once: true });
        environment.signal?.addEventListener("abort", () => { if (!settled) { settled = true; clearInterval(heartbeat); clearInterval(probe); clearInterval(safetyPoll); socket.close(); resolve(); } }, { once: true });
      });
    } catch (error) {
      if (environment.signal?.aborted) return;
      output(environment, `Daemon connection lost; retrying in ${backoffMs / 1000}s\n`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}
