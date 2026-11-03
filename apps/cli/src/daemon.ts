import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

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
        const done = () => { if (!settled) { settled = true; clearInterval(heartbeat); clearInterval(probe); if (connectedAt && Date.now() - connectedAt >= 60_000) backoffMs = 1_000; reject(new Error("Daemon WebSocket closed")); } };
        const fail = (error: Error) => { if (!settled) { settled = true; clearInterval(heartbeat); clearInterval(probe); reject(error); } };
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
        socket.addEventListener("open", () => { connectedAt = Date.now(); });
        socket.addEventListener("close", done, { once: true });
        socket.addEventListener("error", () => fail(new Error("Daemon WebSocket connection failed")), { once: true });
        environment.signal?.addEventListener("abort", () => { if (!settled) { settled = true; clearInterval(heartbeat); clearInterval(probe); socket.close(); resolve(); } }, { once: true });
      });
    } catch (error) {
      if (environment.signal?.aborted) return;
      output(environment, `Daemon connection lost; retrying in ${backoffMs / 1000}s\n`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}
