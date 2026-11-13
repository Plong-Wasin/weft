import { access, chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentCliAdapters, type AgentCliKind } from "./agent-cli";
import { prepareSandbox, type SandboxProfile } from "./sandbox";
import { CLI_VERSION } from "./version";

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
  /** How often to register again even when the CLIs did not change, so workspaces joined later get Runtimes. */
  reregisterMs?: number;
  /** Test override for an Agent's server-provided Run timeout (default 1800 s when an older server omits it). */
  runTimeoutMs?: number;
  safetyPollMs?: number;
  backgroundSpawn?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => { pid: number; unref(): void };
}

export interface DaemonRecord { pid: number; startedAt: string; apiUrl: string; agentClis: string[]; logPath: string }

export function daemonPaths(env: Record<string, string | undefined>) {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? process.env.HOME ?? ".", ".config");
  const directory = join(base, "weft");
  return { directory, record: join(directory, "daemon.json"), lock: join(directory, "daemon.starting"), log: join(directory, "daemon.log"), credential: join(directory, "daemon-credential.json") };
}

/** The Daemon credential the server issued at registration; it reaches /api/daemon/* only. */
export async function readDaemonCredential(env: Record<string, string | undefined>) {
  try { return (JSON.parse(await readFile(daemonPaths(env).credential, "utf8")) as { token?: string }).token; }
  catch { return undefined; }
}

async function writeDaemonCredential(env: Record<string, string | undefined>, token: string) {
  const { directory, credential } = daemonPaths(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(credential, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  await chmod(credential, 0o600);
}

export async function readDaemonRecord(env: Record<string, string | undefined>) {
  const { record } = daemonPaths(env);
  try { return JSON.parse(await readFile(record, "utf8")) as DaemonRecord; } catch { return undefined; }
}

export function processExists(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function daemonStatus(environment: DaemonEnvironment = {}) {
  const env = environment.env ?? Bun.env;
  const paths = daemonPaths(env);
  const record = await readDaemonRecord(env);
  if (!record || !processExists(record.pid)) {
    if (record) await rm(paths.record, { force: true });
    return { running: false as const, logPath: paths.log };
  }
  return { running: true as const, pid: record.pid, uptimeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(record.startedAt)) / 1000)), agentClis: record.agentClis, server: record.apiUrl, logPath: record.logPath };
}

export async function startDaemonBackground(environment: DaemonEnvironment = {}) {
  const env = environment.env ?? Bun.env;
  const token = env.WEFT_TOKEN ?? (await readCliConfig(env)).token;
  if (!token) throw new Error("You are not signed in. Run `weft login`, then try `weft daemon start` again.");
  const prior = await readDaemonRecord(env);
  if (prior && processExists(prior.pid)) throw new Error(`Daemon is already running (process ${prior.pid}). Run \`weft daemon status\` or \`weft daemon stop\`.`);
  const paths = daemonPaths(env);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  if (prior) await rm(paths.record, { force: true });
  let lock;
  try { lock = await open(paths.lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Daemon start is already in progress. Run \`weft daemon status\` in a moment.`);
  }
  try {
    const config = await readCliConfig(env);
    const apiUrl = (env.WEFT_API_URL ?? config.apiUrl ?? "http://localhost:3000").replace(/\/$/, "");
    const agentClis = await detectedClis(env.PATH ?? "");
    const fd = await open(paths.log, "a", 0o600);
    await fd.close();
    await chmod(paths.log, 0o600);
    const argv = [process.execPath, process.argv[1]!, "daemon", "start", "--foreground"];
    const child = (environment.backgroundSpawn ?? Bun.spawn)(argv, { cwd: paths.directory, env: { ...env, WEFT_DAEMON_CHILD: "1" }, stdin: "ignore", stdout: Bun.file(paths.log), stderr: Bun.file(paths.log), detached: true });
    child.unref();
    const record: DaemonRecord = { pid: child.pid, startedAt: new Date().toISOString(), apiUrl, agentClis, logPath: paths.log };
    await writeFile(paths.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(paths.record, 0o600);
    output(environment, `Daemon started in the background (process ${child.pid}). It will register its Runtimes. Run \`weft daemon status\` to check it or \`weft daemon stop\` to stop it; log: ${paths.log}\n`);
    return record;
  } finally { await lock.close(); await rm(paths.lock, { force: true }); }
}

export async function stopDaemon(environment: DaemonEnvironment = {}) {
  const env = environment.env ?? Bun.env;
  const status = await daemonStatus(environment);
  if (!status.running) { output(environment, "Daemon is not running. Run `weft daemon start` to start it.\n"); return false; }
  try { process.kill(status.pid, "SIGTERM"); } catch { /* it exited between status and signal */ }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && processExists(status.pid)) await Bun.sleep(100);
  if (processExists(status.pid)) throw new Error(`Daemon process ${status.pid} did not stop. Check ${status.logPath} and try again.`);
  await rm(daemonPaths(env).record, { force: true });
  output(environment, `Daemon stopped (process ${status.pid}). In-flight Runs were asked to stop. Run \`weft daemon start\` to reconnect.\n`);
  return true;
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
    await chmod(join(config, ".."), 0o700);
    await writeFile(config, `${JSON.stringify({ token, apiUrl }, null, 2)}\n`, { mode: 0o600 });
    await chmod(config, 0o600);
    output(environment, `Signed in to ${apiUrl}. Token saved to ${config}\n`);
  } finally {
    server.stop(true);
  }
}

export async function detectedClis(path = Bun.env.PATH ?? "") {
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

type ClaimedRun = { runId: string; runtimeId: string; agentCli: AgentCliKind; timeoutSeconds?: number; instructions: string; request: string; model: string | null; token: string;
  workspaceId?: string; projectId?: string | null; workItemId?: string | null; workItemDisplayId?: string | null; commentId?: string | null; triggerId?: string | null;
  skills?: Array<{ name: string; description: string; instructions: string }>; sandbox?: SandboxProfile };

function runContext(run: ClaimedRun) {
  const lines = [`Weft run: ${run.runId}`, `Workspace id: ${run.workspaceId ?? ""}`];
  if (run.projectId) lines.push(`Project id: ${run.projectId}`);
  if (run.workItemId) lines.push(`Work item: ${run.workItemDisplayId ?? ""} (id ${run.workItemId})`);
  if (run.commentId) lines.push(`Request comment id: ${run.commentId}`);
  if (run.triggerId) lines.push(`Trigger id: ${run.triggerId}`);
  return `${lines.join("\n")}\nUse the \`weft\` CLI (WEFT_API_URL and WEFT_TOKEN are set) to read and change Weft.`;
}

const CHILD_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "GIT_ASKPASS", "SSH_AUTH_SOCK",
] as const;

export function childEnvironment(run: ClaimedRun, apiUrl: string, hostEnv: Record<string, string | undefined> = Bun.env) {
  const inherited = Object.fromEntries(CHILD_ENV_ALLOWLIST.flatMap((key) => hostEnv[key] === undefined ? [] : [[key, hostEnv[key]!]]));
  return {
    ...inherited,
    WEFT_API_URL: apiUrl,
    WEFT_TOKEN: run.token,
    WEFT_RUN_ID: run.runId,
    WEFT_WORKSPACE_ID: run.workspaceId ?? "",
    WEFT_PROJECT_ID: run.projectId ?? "",
    WEFT_WORK_ITEM_ID: run.workItemId ?? "",
    WEFT_WORK_ITEM_DISPLAY_ID: run.workItemDisplayId ?? "",
    WEFT_COMMENT_ID: run.commentId ?? "",
    WEFT_TRIGGER_ID: run.triggerId ?? "",
  };
}

/** Sends one Daemon request with the current credential; a rotation during a long Run must not strand its status posts. */
type DaemonCall = (path: string, body: unknown) => Promise<unknown>;

async function executeRun(environment: DaemonEnvironment, call: DaemonCall, apiUrl: string, run: ClaimedRun, cancellations: Map<string, () => void>) {
  const directory = await mkdtemp(join(tmpdir(), "weft-run-"));
  let sandboxCleanup = async () => {};
  try {
    const command = agentCliAdapters[run.agentCli].command({ model: run.model, prompt: `${run.instructions}${run.skills?.length ? `\n\nSkills:\n${run.skills.map((skill) => `## ${skill.name}\n${skill.description}\n${skill.instructions}`).join("\n\n")}` : ""}\n\n${runContext(run)}\n\nRequest:\n${run.request}` });
    const childEnv = childEnvironment(run, apiUrl, environment.env ?? Bun.env);
    let launchCommand = command;
    // A restricted profile always fails closed. Enforcement makes that owner policy explicit in settings and the transcript.
    if (run.sandbox && (run.sandbox.mode !== "full" || run.sandbox.enforce)) {
      try {
        const prepared = await prepareSandbox(run.sandbox, directory, apiUrl, environment.env ?? Bun.env);
        sandboxCleanup = prepared.cleanup;
        launchCommand = [...prepared.command, ...command];
        // childEnvironment is an allowlist and intentionally never forwards host proxy bypass variables.
      } catch (error) {
        const reason = (error as Error).message;
        await call("/api/daemon/runs/finish", { runId: run.runId, status: "failed", finalOutput: reason, failureReason: "sandbox_unavailable" });
        return;
      }
    }
    await call("/api/daemon/runs/start", { runId: run.runId, runtimeId: run.runtimeId });
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try { child = Bun.spawn(launchCommand, { cwd: directory, env: childEnv, stdout: "pipe", stderr: "pipe" }); }
    catch (error) {
      await call("/api/daemon/runs/finish", { runId: run.runId, status: "failed", finalOutput: `Could not start ${run.agentCli}: ${(error as Error).message}`, failureReason: "spawn_failed" });
      return;
    }
    let cancelled = false;
    let inactive = false;
    let timedOut = false;
    const stop = () => { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 10_000).unref(); };
    const runTimer = setTimeout(() => { timedOut = true; stop(); }, environment.runTimeoutMs ?? (run.timeoutSeconds ?? 1800) * 1000);
    cancellations.set(run.runId, () => { if (cancelled) return; cancelled = true; child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 10_000).unref(); });
    const messages: Array<{ seq: number; type: string; output: unknown }> = [];
    let finalOutput = "";
    let seq = 0;
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => { flushing = flushing.catch(() => {}).then(async () => { if (!messages.length) return; const batch = messages.splice(0); try { await call("/api/daemon/runs/messages", { runId: run.runId, messages: batch }); } catch (error) { if (/^409:/.test(String((error as Error).message))) { inactive = true; stop(); return; } messages.unshift(...batch); throw error; } }); return flushing; };
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
          if (messages.length >= 25) await flush().catch(() => {});
        }
      }
    };
    try { await Promise.all([consume(child.stdout), consume(child.stderr)]); } finally { clearInterval(flushTimer); }
    const code = await child.exited;
    clearTimeout(runTimer);
    if (inactive) { cancellations.delete(run.runId); return; }
    if (cancelled) {
      while (!environment.signal?.aborted) {
        try { await call("/api/daemon/runs/cancel-ack", { runId: run.runId }); break; }
        catch { await (environment.sleep ?? wait)(1_000); }
      }
      cancellations.delete(run.runId);
      return;
    }
    cancellations.delete(run.runId);
    await flush().catch(() => flush()).catch(() => {});
    for (let attempt = 0; ; attempt++) {
      try { await call("/api/daemon/runs/finish", { runId: run.runId, status: code === 0 && !timedOut ? "completed" : "failed", finalOutput, failureReason: timedOut ? "timeout" : code === 0 ? undefined : "cli_exit" }); break; }
      // A 401 is not final here: the credential may have been rotated, and `call` has already re-read it and retried once.
      catch (error) { const message = String((error as Error).message); if (/^409:/.test(message)) break; if (attempt >= 4 || (/^4\d\d:/.test(message) && !/^401:/.test(message))) throw error; await (environment.sleep ?? wait)(1_000 * (attempt + 1)); }
    }
  } finally { await sandboxCleanup(); await rm(directory, { recursive: true, force: true }); }
}

const AUTH_RETRY_MIN_MS = 15_000;
const AUTH_RETRY_MAX_MS = 5 * 60_000;
/** The Personal token was refused at registration: only `weft login` can renew it. */
class RegistrationUnauthorized extends Error {}
const isUnauthorized = (error: unknown) => /^401:/.test(String((error as Error).message));
const errorOutput = (environment: DaemonEnvironment, text: string) => (environment.stderr ?? ((value: string) => process.stderr.write(value)))(text);

/** Runs the registration and heartbeat loop; the single WebSocket owns reconnect/backoff. */
export async function startDaemon(environment: DaemonEnvironment = {}) {
  const shutdown = new AbortController();
  const signal = environment.signal ?? shutdown.signal;
  const runtimeEnvironment = { ...environment, signal };
  const env = environment.env ?? Bun.env;
  const config = await readCliConfig(env);
  // The CLI token only registers the Daemon; /api/daemon/* uses the Daemon credential from its own file.
  if (!(env.WEFT_TOKEN ?? config.token)) throw new Error("You are not signed in. Run `weft login`, then try `weft daemon start` again.");
  let credential = await readDaemonCredential(env);
  // Set when the server refused the credential (a 401, or a WebSocket closed with 1008): the next registration asks for a new one.
  let rotateNext = false;
  const currentCredential = () => credential ?? "";
  const adoptCredential = async (registration: { daemonToken?: string }) => {
    if (!registration.daemonToken) return;
    credential = registration.daemonToken;
    await writeDaemonCredential(env, registration.daemonToken);
  };
  const apiUrl = (env.WEFT_API_URL ?? config.apiUrl ?? "http://localhost:3000").replace(/\/$/, "");
  const fetcher = environment.fetch ?? fetch;
  const sleep = environment.sleep ?? wait;
  const makeSocket = environment.webSocket ?? ((url) => new WebSocket(url));
  let backoffMs = 1_000;
  let authBackoffMs = AUTH_RETRY_MIN_MS;
  let registeredClis = "";
  // Lives across reconnects: a cancel arriving on a new socket must still reach Runs claimed on an old one.
  const cancellations = new Map<string, () => void>();
  /** Registers this Daemon; asks for a new credential when none is held or the last one was refused. */
  const register = async (agentClis: string[]) => {
    let registration: { daemonId: string; daemonToken?: string };
    // Read at every attempt: `weft login` while the Daemon runs replaces the CLI token, and the next retry must use it.
    const personalToken = env.WEFT_TOKEN ?? (await readCliConfig(env)).token ?? "";
    try {
      registration = await post(fetcher, apiUrl, personalToken, "/api/daemon/register", { hostname: env.WEFT_HOSTNAME ?? hostname(), version: CLI_VERSION, agentClis, rotate: !credential || rotateNext }) as { daemonId: string; daemonToken?: string };
    } catch (error) {
      if (isUnauthorized(error)) throw new RegistrationUnauthorized((error as Error).message);
      throw error;
    }
    await adoptCredential(registration);
    rotateNext = false;
    return registration;
  };
  /** One Daemon request with the current credential. A 401 marks the credential for rotation, then retries once with the credential on disk, which may have been rotated. */
  const callDaemon: DaemonCall = async (path, body) => {
    try { return await post(fetcher, apiUrl, currentCredential(), path, body); }
    catch (error) {
      if (!isUnauthorized(error)) throw error;
      rotateNext = true;
      output(environment, `Daemon credential refused on ${path}; the next registration asks for a new one.\n`);
      const onDisk = await readDaemonCredential(env);
      if (onDisk) credential = onDisk;
      return post(fetcher, apiUrl, currentCredential(), path, body);
    }
  };
  const stopFromSignal = async () => {
    try { await post(fetcher, apiUrl, currentCredential(), "/api/daemon/stop", {}); } catch { /* the server may be unavailable; stop local work anyway */ }
    for (const cancel of cancellations.values()) cancel();
    const deadline = Date.now() + 12_000;
    while (cancellations.size && Date.now() < deadline) await Bun.sleep(100);
    shutdown.abort();
  };
  if (env.WEFT_DAEMON_CHILD === "1" && !environment.signal) process.once("SIGTERM", () => { void stopFromSignal(); });
  while (!signal.aborted) {
    try {
      const agentClis = await detectedClis(env.PATH ?? "");
      const signature = agentClis.join(",");
      const registration = await register(agentClis);
      authBackoffMs = AUTH_RETRY_MIN_MS;
      if (!credential) throw new Error("Daemon credential was not issued. Run `weft login` to sign in again.");
      registeredClis = signature;
      let lastRegisteredAt = Date.now();
      const openedWith = currentCredential();
      const wsUrl = new URL(`${apiUrl.replace(/^http/, "ws")}/api/daemon`);
      wsUrl.searchParams.set("token", openedWith);
      await new Promise<void>((resolve, reject) => {
        const socket = makeSocket(wsUrl.toString());
        let settled = false;
        let connectedAt: number | undefined;
        let claiming = false;
        const claim = async () => {
          if (claiming) return;
          claiming = true;
          try {
            const response = await callDaemon("/api/daemon/runs/claim", {}) as ClaimedRun[];
            // Each Run runs in its own task so a long Run never blocks the next claim.
            for (const run of response) void executeRun(runtimeEnvironment, callDaemon, apiUrl, run, cancellations).catch((error) => output(environment, `Run ${run.runId} failed: ${(error as Error).message}\n`));
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
          if (nextSignature !== registeredClis || Date.now() - lastRegisteredAt >= (environment.reregisterMs ?? 300_000)) {
            try {
              await register(next);
              registeredClis = nextSignature; lastRegisteredAt = Date.now();
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
        socket.addEventListener("close", (event) => {
          const { code, reason } = event as CloseEvent;
          if (code !== undefined) output(environment, `Daemon WebSocket closed with code ${code}${reason ? `: ${reason}` : ""}\n`);
          // 1008: the server refused the credential. 4001: the server replaced it; the file still holds that one only when nothing newer was adopted.
          if (code === 1008 || (code === 4001 && openedWith === currentCredential())) rotateNext = true;
          done();
        }, { once: true });
        socket.addEventListener("error", () => fail(new Error("Daemon WebSocket connection failed")), { once: true });
        signal.addEventListener("abort", () => { if (!settled) { settled = true; clearInterval(heartbeat); clearInterval(probe); clearInterval(safetyPoll); socket.close(); resolve(); } }, { once: true });
      });
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof RegistrationUnauthorized) {
        const hint = "Your weft sign-in was refused, so the Daemon cannot register. Run `weft login` to sign in again. The Daemon keeps retrying, less often each time.";
        output(environment, `${hint}\n`);
        errorOutput(environment, `${hint}\n`);
        await sleep(authBackoffMs);
        authBackoffMs = Math.min(authBackoffMs * 2, AUTH_RETRY_MAX_MS);
        continue;
      }
      output(environment, `Daemon connection lost (${(error as Error).message}); retrying in ${backoffMs / 1000}s\n`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}
