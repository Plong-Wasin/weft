import { access, chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
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
  /** Test seam for an atomic config replacement failing on the host filesystem. */
  replaceConfig?: (temporaryPath: string, configPath: string) => Promise<void>;
  webSocket?: (url: string, options?: DaemonWebSocketOptions) => WebSocket;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  heartbeatMs?: number;
  reprobeMs?: number;
  /** How often to register again even when the CLIs did not change, so workspaces joined later get Runtimes. */
  reregisterMs?: number;
  /** Test override for an Agent's server-provided Run timeout (default 1800 s when an older server omits it). */
  runTimeoutMs?: number;
  /** Test override for the root that holds the stable Session folders (default: `~/.cache/weft/sessions`). */
  sessionsRoot?: string;
  safetyPollMs?: number;
  backgroundSpawn?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => { pid: number; unref(): void };
}

interface DaemonWebSocketOptions { headers: Record<string, string> }

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
  const temporary = join(directory, `.daemon-credential-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, credential);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
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
  const config = await readCliConfig(env);
  const apiUrl = daemonApiUrl(env, config);
  assertDaemonCredentialServer(env, config, apiUrl);
  const token = env.WEFT_TOKEN ?? config.token;
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

/** Keep a first-login identity stable across processes without changing the installed credential config. */
async function cliDeviceId(env: Record<string, string | undefined>, config: CliConfig) {
  return withCliConfigLock(env, async () => {
    const saved = await readCliConfig(env);
    if (saved.deviceId) return saved.deviceId;
    const identityPath = `${settingsPath(env)}.device-id`;
    try {
      const identity = (await readFile(identityPath, "utf8")).trim();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity)) return identity;
    } catch { /* first sign-in for this config directory */ }
    const identity = config.deviceId ?? crypto.randomUUID();
    await writeFile(identityPath, `${identity}\n`, { mode: 0o600 });
    await chmod(identityPath, 0o600);
    return identity;
  });
}

export async function readCliConfig(env: Record<string, string | undefined>) {
  try { return JSON.parse(await readFile(settingsPath(env), "utf8")) as CliConfig; }
  catch { return {}; }
}

/** The server used by a Daemon, with an explicit environment selection ahead of saved config. */
export function daemonApiUrl(env: Record<string, string | undefined>, config: CliConfig) {
  return validatedAuthApiUrl(env.WEFT_API_URL ?? config.apiUrl ?? "http://localhost:3000");
}

/** A saved credential may only be sent to the Weft installation that issued it. */
export function assertDaemonCredentialServer(env: Record<string, string | undefined>, config: CliConfig, apiUrl: string) {
  if (env.WEFT_TOKEN) return; // an explicit token is supplied for this invocation
  assertSavedCredentialServer(config, apiUrl);
}

function sameOrigin(left: string, right: string) {
  return new URL(validatedAuthApiUrl(left)).origin === new URL(validatedAuthApiUrl(right)).origin;
}

function assertSavedCredentialServer(config: CliConfig, apiUrl: string) {
  if (!config.token) return;
  const pending = config.pendingCredential;
  if (pending && config.apiUrl && !sameOrigin(pending.apiUrl, config.apiUrl)) {
    throw new Error(`A sign-in for ${pending.apiUrl} is still awaiting server confirmation while your saved credential belongs to ${config.apiUrl}. Run weft login --api-url ${config.apiUrl} to recover it before selecting another server. No saved credential was sent.`);
  }
  if (!config.apiUrl) {
    throw new Error(`Your saved legacy Weft sign-in has no recorded server, so its identity cannot be verified safely. Run weft login --api-url ${apiUrl} to approve a sign-in there, or provide a server-specific token with --token or WEFT_TOKEN. The saved sign-in was not sent.`);
  }
  const savedServer = validatedAuthApiUrl(config.apiUrl);
  if (!sameOrigin(savedServer, apiUrl)) {
    throw new Error(`Your saved Weft sign-in is for ${savedServer}, but this command targets ${apiUrl}. Run weft login --api-url ${apiUrl} to sign in there, or set WEFT_TOKEN to a token for that server. Your saved sign-in was not sent.`);
  }
}

type PendingCredential = { token: string; exchangeId: string; apiUrl: string; deviceId: string };
type CliConfig = { token?: string; apiUrl?: string; deviceId?: string; pendingRenewal?: string; pendingCredential?: PendingCredential };

async function saveCliConfig(env: Record<string, string | undefined>, value: CliConfig, replace: (temporaryPath: string, configPath: string) => Promise<void> = rename) {
  const config = settingsPath(env);
  const directory = join(config, "..");
  const temporary = join(directory, `.config-${crypto.randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await replace(temporary, config);
    await chmod(config, 0o600);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** SQLite's process-safe transaction lock is released by the OS if a CLI process crashes. */
export async function withCliConfigLock<T>(env: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const directory = daemonPaths(env).directory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockDbPath = `${settingsPath(env)}.lockdb`;
  const lockDb = new Database(lockDbPath);
  await chmod(lockDbPath, 0o600);
  lockDb.exec("PRAGMA busy_timeout = 0");
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      try { lockDb.exec("BEGIN IMMEDIATE"); acquired = true; break; }
      catch (error) {
        if (!String(error).includes("SQLITE_BUSY") && !String(error).includes("database is locked")) throw error;
        await Bun.sleep(25);
      }
    }
    if (!acquired) throw new Error("Timed out waiting for another Weft credential operation.");
    const result = await action();
    lockDb.exec("COMMIT");
    acquired = false;
    return result;
  } finally {
    if (acquired) { try { lockDb.exec("ROLLBACK"); } catch { /* transaction already ended */ } }
    lockDb.close();
  }
}

export function validatedAuthApiUrl(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`Invalid Weft server URL: ${value}. Use an HTTPS URL, or HTTP on localhost for development.`); }
  if (url.username || url.password || url.search || url.hash) throw new Error("The Weft server URL must not contain credentials, a query, or a fragment.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Weft requests that send credentials require HTTPS. HTTP is allowed only on localhost for development.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The Weft server URL must use HTTPS (or HTTP on localhost for development).");
  return url.toString().replace(/\/$/, "");
}

async function finalizePendingCredential(env: Record<string, string | undefined>, saved: CliConfig, fetcher: FetchLike, replace?: (temporaryPath: string, configPath: string) => Promise<void>, signal?: AbortSignal): Promise<CliConfig> {
  const pending = saved.pendingCredential;
  if (!pending) return saved;
  const finalized = await fetcher(`${pending.apiUrl}/api/cli/device-authorization/finalize`, {
    method: "POST", headers: { authorization: `Bearer ${pending.token}`, "content-type": "application/json" }, body: JSON.stringify({ exchangeId: pending.exchangeId }),
    redirect: "error",
    ...(signal ? { signal } : {}),
  }).catch(() => null);
  if (finalized?.status === 410) {
    const { pendingCredential: _pending, ...previous } = saved;
    await saveCliConfig(env, previous, replace);
    return previous;
  }
  if (!finalized?.ok) return saved;
  const { pendingCredential: _pending, pendingRenewal: _legacyPending, ...rest } = saved;
  const committed = { ...rest, token: pending.token, apiUrl: pending.apiUrl, deviceId: pending.deviceId };
  await saveCliConfig(env, committed, replace);
  return committed;
}

type DeviceCancellation = "cancelled" | "completed" | null;

async function cancelDeviceAuthorization(fetcher: FetchLike, apiUrl: string, deviceSecret: string): Promise<DeviceCancellation> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetcher(`${apiUrl}/api/cli/device-authorization/cancel`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceSecret }), signal: AbortSignal.timeout(3000), redirect: "error",
    }).catch(() => null);
    if (response?.ok) {
      const result = await response.json().catch(() => null) as { status?: string } | null;
      if (result?.status === "cancelled" || result?.status === "completed") return result.status;
    }
    if (attempt < 2) await Bun.sleep(25);
  }
  return null;
}

/** Renew an enrolled device while retaining the last committed config until finalize succeeds. */
export async function renewCliCredential(environment: DaemonEnvironment = {}, requestedApiUrl?: string) {
  const env = environment.env ?? Bun.env;
  if (env.WEFT_TOKEN) return undefined; // Explicit Personal API tokens are never enrolled or rotated.
  const fetcher = environment.fetch ?? fetch;
  return withCliConfigLock(env, async () => {
    let saved = await readCliConfig(env);
    // Legacy configs do not record an issuing server. Keep them available to callers,
    // but never guess an origin or send the token during renewal.
    if (saved.token && !saved.apiUrl && !saved.pendingCredential) return saved.token;
    const apiUrl = validatedAuthApiUrl(requestedApiUrl ?? env.WEFT_API_URL ?? saved.apiUrl ?? saved.pendingCredential?.apiUrl ?? "http://localhost:3000");
    if (saved.pendingCredential) {
      if (!sameOrigin(saved.pendingCredential.apiUrl, apiUrl)) {
        throw new Error(`A sign-in for ${saved.pendingCredential.apiUrl} is awaiting server confirmation. Recover it there before selecting ${apiUrl}. No saved credential was sent.`);
      }
      saved = await finalizePendingCredential(env, saved, fetcher, environment.replaceConfig);
      if (saved.pendingCredential) throw new Error(`A sign-in for ${saved.pendingCredential.apiUrl} is awaiting server confirmation. Retry there with weft login --api-url ${saved.pendingCredential.apiUrl}; the prior credential was not sent.`);
    }
    assertSavedCredentialServer(saved, apiUrl);
    if (saved.pendingRenewal) {
      // Recover configurations written by earlier CLI versions, which stored the candidate as token.
      const finalized = await fetcher(`${apiUrl}/api/cli/device-authorization/finalize`, {
        method: "POST", headers: { authorization: `Bearer ${saved.token}`, "content-type": "application/json" }, body: JSON.stringify({ exchangeId: saved.pendingRenewal }), redirect: "error",
      }).catch(() => null);
      if (finalized?.ok) { const { pendingRenewal: _pending, ...clean } = saved; saved = clean; await saveCliConfig(env, saved, environment.replaceConfig); }
      else return saved.token;
    }
    if (!saved.token || !saved.deviceId) return saved.token;
    const renewed = await fetcher(`${apiUrl}/api/cli/device-credentials/renew`, {
      method: "POST", headers: { authorization: `Bearer ${saved.token}`, "content-type": "application/json" }, body: "{}", redirect: "error",
    }).catch(() => null);
    if (!renewed?.ok) return saved.token;
    const result = await renewed.json().catch(() => null) as { status?: string; token?: string; exchangeId?: string } | null;
    if (result?.status !== "rotated" || !result.token || !result.exchangeId) return saved.token;
    const replacementToken = result.token;
    saved = { ...saved, pendingCredential: { token: replacementToken, exchangeId: result.exchangeId, apiUrl, deviceId: saved.deviceId } };
    try { await saveCliConfig(env, saved, environment.replaceConfig); }
    catch { return saved.token; }
    saved = await finalizePendingCredential(env, saved, fetcher, environment.replaceConfig);
    return saved.token;
  });
}

export async function login(environment: DaemonEnvironment = {}) {
  const env = environment.env ?? Bun.env;
  const config = settingsPath(env);
  const previous = await readCliConfig(env);
  const apiUrl = validatedAuthApiUrl(env.WEFT_API_URL ?? previous.apiUrl ?? previous.pendingCredential?.apiUrl ?? "http://localhost:3000");
  // Complete a previously saved exchange before beginning another login. This also
  // recovers a finalize response that was lost after the server committed it.
  if (previous.pendingCredential && !sameOrigin(previous.pendingCredential.apiUrl, apiUrl)) {
    throw new Error(`A sign-in for ${previous.pendingCredential.apiUrl} is awaiting server confirmation. Recover it there before starting a sign-in for ${apiUrl}.`);
  }
  if (previous.token && previous.apiUrl && sameOrigin(previous.apiUrl, apiUrl)) await renewCliCredential(environment, apiUrl);
  const deviceId = await cliDeviceId(env, previous);
  const fetcher = environment.fetch ?? fetch;
  const start = await fetcher(`${apiUrl}/api/cli/device-authorization`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, hostname: env.WEFT_HOSTNAME ?? hostname() }),
    redirect: "error",
  });
  if (!start.ok) throw new Error(`Could not start sign-in with ${apiUrl} (${start.status}). Check the server address and try again.`);
  const request = await start.json() as { deviceSecret: string; userCode: string; verificationUrl: string; expiresAt: string; interval: number };
  output(environment, `To sign in, open ${request.verificationUrl}\nEnter code: ${request.userCode}\nThe browser must be able to reach this Weft server. If it cannot, use a Personal API token with --token or WEFT_TOKEN. This request expires in 5 minutes.\n`);
  const open = environment.openBrowser ?? (async (url: string) => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    Bun.spawn(process.platform === "win32" ? [command, "/c", "start", "", url] : [command, url], { stdout: "ignore", stderr: "ignore" });
  });
  try { await open(request.verificationUrl); }
  catch { output(environment, "Could not open a browser here. Use the URL and code above on another device.\n"); }
  output(environment, "Waiting for approval… Press Ctrl+C to cancel.\n");
  const sleep = environment.sleep ?? wait;
  const deadline = Date.now() + 5 * 60_000;
  let status = "pending";
  const cancelIfRequested = async () => {
    if (!environment.signal?.aborted) return false;
    const cancellation = await cancelDeviceAuthorization(fetcher, apiUrl, request.deviceSecret);
    if (cancellation === "completed") {
      output(environment, "Sign-in completed before cancellation reached the server.\n");
      return false;
    }
    if (cancellation === "cancelled") output(environment, "Sign-in cancelled. Your previous sign-in is unchanged.\n");
    else output(environment, "Cancellation could not be confirmed. The previous sign-in is unchanged; the request will expire automatically.\n");
    return true;
  };
  while (status === "pending" && Date.now() < deadline) {
    if (await cancelIfRequested()) return;
    await sleep(Math.max(500, request.interval * 1000));
    if (await cancelIfRequested()) return;
    let response: Response;
    try {
      response = await fetcher(`${apiUrl}/api/cli/device-authorization/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceSecret: request.deviceSecret }), signal: environment.signal, redirect: "error" });
    } catch (error) {
      if (await cancelIfRequested()) return;
      throw error;
    }
    if (await cancelIfRequested()) return;
    if (!response.ok) throw new Error(`Could not check sign-in status (${response.status}). Your previous sign-in is unchanged; run \`weft login\` to try again.`);
    status = ((await response.json()) as { status: string }).status;
    if (await cancelIfRequested()) return;
  }
  if (status === "pending") status = "expired";
  if (status === "denied") throw new Error("Sign-in was denied. Your previous sign-in is unchanged.");
  if (status === "cancelled") throw new Error("Sign-in was cancelled. Your previous sign-in is unchanged.");
  if (status === "expired") throw new Error("Sign-in request expired. Run `weft login` to get a new code. Your previous sign-in is unchanged.");
  if (status !== "approved") throw new Error("Sign-in request could not be completed. Your previous sign-in is unchanged; run `weft login` to try again.");
  if (await cancelIfRequested()) return;
  let exchanged: Response;
  try {
    exchanged = await fetcher(`${apiUrl}/api/cli/device-authorization/exchange`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceSecret: request.deviceSecret }), signal: environment.signal, redirect: "error",
    });
  } catch (error) {
    const cancellation = await cancelDeviceAuthorization(fetcher, apiUrl, request.deviceSecret);
    if (environment.signal?.aborted) {
      if (cancellation === "cancelled") output(environment, "Sign-in cancelled. Your previous sign-in is unchanged.\n");
      else if (cancellation === "completed") output(environment, "Sign-in completed before cancellation reached the server.\n");
      else output(environment, "Cancellation could not be confirmed. Your previous sign-in is unchanged; the request will expire automatically.\n");
      return;
    }
    if (cancellation === "cancelled") throw new Error("Credential exchange response was lost; the unused credential was revoked and your previous sign-in is unchanged. Run `weft login` to try again.");
    throw new Error("Credential exchange response was lost and cancellation could not be confirmed. Your previous sign-in is unchanged; wait for the request to expire, then run `weft login` again.");
  }
  if (await cancelIfRequested()) return;
  if (!exchanged.ok) {
    const cancellation = await cancelDeviceAuthorization(fetcher, apiUrl, request.deviceSecret);
    if (cancellation === "cancelled") throw new Error("Sign-in was approved, but credential exchange failed. The unused credential was revoked and your previous sign-in is unchanged; run `weft login` to try again.");
    throw new Error("Sign-in was approved, but credential exchange failed and cancellation could not be confirmed. Your previous sign-in is unchanged; wait for the request to expire, then run `weft login` again.");
  }
  let credential: { token: string; exchangeId: string };
  try { credential = await exchanged.json() as { token: string; exchangeId: string }; }
  catch (error) {
    // A lost or malformed exchange body can leave a server-side, unfinalized credential.
    if (await cancelDeviceAuthorization(fetcher, apiUrl, request.deviceSecret) === "cancelled") {
      throw new Error("Credential exchange response was lost; the unused credential was revoked and your previous sign-in is unchanged. Run `weft login` to try again.");
    }
    throw new Error("Credential exchange response was lost and cancellation could not be confirmed. Your previous sign-in is unchanged; wait for the request to expire, then run `weft login` again.");
  }
  if (environment.signal?.aborted) {
    const cancellation = await cancelDeviceAuthorization(fetcher, apiUrl, request.deviceSecret);
    if (cancellation === "cancelled") { output(environment, "Sign-in cancelled. Your previous sign-in is unchanged.\n"); return; }
    if (cancellation === "completed") { output(environment, "Sign-in completed before cancellation reached the server.\n"); return; }
    output(environment, "Cancellation could not be confirmed. Your previous sign-in is unchanged; the request will expire automatically.\n");
    return;
  }
  try {
    const finalized = await withCliConfigLock(env, async () => {
      const saved = await readCliConfig(env);
      const pending: CliConfig = {
        ...saved,
        pendingCredential: { token: credential.token, exchangeId: credential.exchangeId, apiUrl, deviceId },
      };
      await saveCliConfig(env, pending, environment.replaceConfig);
      if (environment.signal?.aborted) {
        const cancellation = await cancelDeviceAuthorization(fetcher, apiUrl, request.deviceSecret);
        if (cancellation === "cancelled") {
          const { pendingCredential: _pending, ...rest } = pending;
          await saveCliConfig(env, rest, environment.replaceConfig);
          return false;
        }
        if (cancellation === "completed") {
          const completed = await finalizePendingCredential(env, pending, fetcher, environment.replaceConfig);
          return !completed.pendingCredential;
        }
        return false;
      }
      const completed = await finalizePendingCredential(env, pending, fetcher, environment.replaceConfig, environment.signal);
      if (!completed.pendingCredential && completed.token !== credential.token) {
        throw new Error("This sign-in exchange expired before it was finalized. Your previous sign-in is unchanged; run `weft login` again.");
      }
      if (environment.signal?.aborted) {
        const cancellation = await cancelDeviceAuthorization(fetcher, apiUrl, request.deviceSecret);
        if (cancellation === "cancelled") {
          const { pendingCredential: _pending, ...rest } = pending;
          await saveCliConfig(env, rest, environment.replaceConfig);
          return false;
        }
        if (cancellation === "completed") {
          const recovered = await finalizePendingCredential(env, pending, fetcher, environment.replaceConfig);
          return !recovered.pendingCredential;
        }
      }
      return !completed.pendingCredential;
    });
    if (!finalized) {
      if (environment.signal?.aborted) {
        const saved = await readCliConfig(env);
        if (saved.pendingCredential?.exchangeId === credential.exchangeId) throw new Error("Sign-in cancellation could not be confirmed. The pending credential remains saved for safe recovery; run `weft login` again when the server is reachable.");
        output(environment, "Sign-in cancelled. Your previous sign-in is unchanged.\n");
        return;
      }
      throw new Error("Sign-in was approved, but the server did not confirm the credential. Your existing config and the pending credential remain saved; run `weft login` again when the server is reachable to recover the sign-in.");
    }
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("Sign-in was approved, but the server did not confirm") || error.message.startsWith("This sign-in exchange expired"))) throw error;
    throw new Error("Sign-in was approved, but the credential could not be saved or confirmed. Your existing config and any pending credential were preserved for recovery; check the config directory permissions and run `weft login` again.");
  }
  output(environment, `Signed in to ${apiUrl}. Token saved to ${config}\n`);
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

async function post(fetcher: FetchLike, apiUrl: string, token: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const secureApiUrl = validatedAuthApiUrl(apiUrl);
  const response = await fetcher(`${secureApiUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-weft-source": "cli", ...extraHeaders }, body: JSON.stringify(body), redirect: "error" });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()) || response.statusText}`);
  return response.json();
}

type ClaimedRun = { runId: string; runtimeId: string; agentCli: AgentCliKind; timeoutSeconds?: number; instructions: string; request: string; model: string | null; token: string;
  /** Runtime-owner configured variables, delivered only to the Daemon claim endpoint. */
  environment?: Record<string, string>;
  /** Values classified as secret, used only for output redaction. */
  secretEnvironment?: Record<string, string>;
  workspaceId?: string; projectId?: string | null; workItemId?: string | null; workItemDisplayId?: string | null; commentId?: string | null; triggerId?: string | null;
  skills?: Array<{ name: string; description: string; instructions: string }>; sandbox?: SandboxProfile;
  /** The stable folder and the CLI Session to resume, as planned by the server; null for a Run without a work item. */
  session?: SessionPlan | null };

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

export function childEnvironment(run: ClaimedRun, apiUrl: string, hostEnv: Record<string, string | undefined> = Bun.env): Record<string, string> {
  const selectsClaudeConfig = run.agentCli === "claude" && Boolean(run.environment?.CLAUDE_CONFIG_DIR?.trim());
  const explicitlySelectsApiKey = Boolean(run.environment?.ANTHROPIC_API_KEY?.trim());
  const inherited = Object.fromEntries(CHILD_ENV_ALLOWLIST.flatMap((key) => {
    if (key === "ANTHROPIC_API_KEY" && selectsClaudeConfig && !explicitlySelectsApiKey) return [];
    return hostEnv[key] === undefined ? [] : [[key, hostEnv[key]!]];
  }));
  const configured = Object.fromEntries(Object.entries(run.environment ?? {}).filter(([key, value]) => !key.startsWith("WEFT_") && !["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "GIT_ASKPASS", "SSH_AUTH_SOCK"].includes(key) && !(key === "ANTHROPIC_API_KEY" && !value.trim())));
  return {
    ...inherited,
    ...configured,
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

/** Redact literal configured values and their exact JSON.stringify-escaped forms plus inherited API and Run tokens. This cannot catch arbitrary derived encodings. */
export function redactRuntimeEnvironment(text: string, environment: Record<string, string> | undefined, childEnv: Record<string, string> = {}) {
  let safe = text;
  const values = [...Object.values(environment ?? {}), childEnv.ANTHROPIC_API_KEY, childEnv.OPENAI_API_KEY, childEnv.WEFT_TOKEN]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  for (const value of new Set(values)) safe = safe.replaceAll(value, "[REDACTED]");
  return safe;
}

/** Reassemble text chunks into complete JSONL records before redacting, so values split across stream reads are caught. */
export async function consumeRedactedOutput(stream: ReadableStream<Uint8Array>, environment: Record<string, string> | undefined, childEnv: Record<string, string>, consumeLine: (line: string) => Promise<void>) {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n"); pending = lines.pop() ?? "";
    for (const line of lines) await consumeLine(redactRuntimeEnvironment(line, environment, childEnv));
  }
  pending += decoder.decode();
  if (pending.trim()) await consumeLine(redactRuntimeEnvironment(pending, environment, childEnv));
}

/** Sends one Daemon request with the current credential; a rotation during a long Run must not strand its status posts. */
type DaemonCall = (path: string, body: unknown) => Promise<unknown>;

/** The stable folder and the CLI Session to resume, as the server planned them at claim (ADR 0014). */
export type SessionPlan = { folder: string; resumeSessionId: string | null; reason: string };
/** A Session folder unused for this long is removed by the sweep (ADR 0014). */
export const SESSION_FOLDER_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MARKER = ".weft-session.json";
const SESSION_FOLDER_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Session folders a Run is working in right now, in this Daemon process: the sweep never removes them. */
const activeSessionFolders = new Set<string>();

/** Where the stable Session folders live: outside `~/.config/weft`, which the sandbox denies reading, and inside the user's cache. */
export function sessionsRootPath(env: Record<string, string | undefined>) {
  return join(env.XDG_CACHE_HOME ?? join(env.HOME ?? process.env.HOME ?? ".", ".cache"), "weft", "sessions");
}

/** What the Daemon decided for a Run's Session: resume the CLI's Session id, or start a new one for `reason`. */
export type SessionDecision = { mode: "resumed" | "new"; reason: string; resume: string | null };

/** Turns the server's plan into what this Daemon can do: a missing folder, or a CLI that cannot resume, always starts a new Session. */
export function decideSession(adapter: { resumable: boolean }, plan: SessionPlan | null | undefined, folderExisted: boolean): SessionDecision {
  if (!plan) return { mode: "new", reason: "no_work_item", resume: null };
  if (!plan.resumeSessionId) return { mode: "new", reason: plan.reason, resume: null };
  if (!folderExisted) return { mode: "new", reason: "folder_missing", resume: null };
  if (!adapter.resumable) return { mode: "new", reason: "cli_without_resume", resume: null };
  return { mode: "resumed", reason: "resumed", resume: plan.resumeSessionId };
}

async function touchSessionFolder(folder: string, plan: SessionPlan, workItemId: string | null | undefined, now: number) {
  await writeFile(join(folder, SESSION_MARKER), `${JSON.stringify({ folder: plan.folder, workItemId: workItemId ?? null, lastUsedAt: new Date(now).toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Removes Session folders that are not in use and either were retired by the server (their work item is closed) or have not been used
 * for seven days. Returns the names removed. A folder in `active` is never removed.
 */
export async function pruneSessionFolders(root: string, options: { now: number; active: ReadonlySet<string>; retired: ReadonlySet<string> }) {
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const removed: string[] = [];
  for (const name of names) {
    if (!SESSION_FOLDER_NAME.test(name) || options.active.has(name)) continue;
    const folder = join(root, name);
    let lastUsed: number;
    try { lastUsed = Date.parse((JSON.parse(await readFile(join(folder, SESSION_MARKER), "utf8")) as { lastUsedAt?: string }).lastUsedAt ?? "") || (await stat(folder)).mtimeMs; }
    catch { lastUsed = (await stat(folder).catch(() => null))?.mtimeMs ?? options.now; }
    if (options.retired.has(name) || options.now - lastUsed > SESSION_FOLDER_MAX_IDLE_MS) {
      await rm(folder, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

/** Asks the server which of this Daemon's Session folders belong to closed work items, then removes those and the idle ones. */
async function sweepSessionFolders(root: string, call: DaemonCall, now = Date.now()) {
  let names: string[];
  try { names = (await readdir(root)).filter((name) => SESSION_FOLDER_NAME.test(name)); } catch { return; }
  if (names.length === 0) return;
  let retired: string[] = [];
  try { const answer = await call("/api/daemon/session-folders/check", { folders: names }) as { retired?: unknown }; if (Array.isArray(answer?.retired)) retired = answer.retired.map(String); }
  catch { /* the next sweep asks again */ }
  await pruneSessionFolders(root, { now, active: activeSessionFolders, retired: new Set(retired) });
}

export async function executeRun(environment: DaemonEnvironment, call: DaemonCall, apiUrl: string, run: ClaimedRun, cancellations: Map<string, () => void>, pendingCancellationIds: Set<string> = new Set()) {
  const adapter = agentCliAdapters[run.agentCli];
  // A session folder comes from the server only when the Run has a work item; the name must be a UUID so the path stays inside the root.
  const plan = run.session && SESSION_FOLDER_NAME.test(run.session.folder) ? run.session : undefined;
  const sessionsRoot = environment.sessionsRoot ?? sessionsRootPath(environment.env ?? Bun.env);
  const folder = plan ? join(sessionsRoot, plan.folder) : undefined;
  const folderExisted = folder ? await stat(folder).then((info) => info.isDirectory(), () => false) : false;
  const directory = folder ?? await mkdtemp(join(tmpdir(), "weft-run-"));
  if (folder && plan) { await mkdir(folder, { recursive: true, mode: 0o700 }); activeSessionFolders.add(plan.folder); await touchSessionFolder(folder, plan, run.workItemId, Date.now()); }
  let decision = decideSession(adapter, plan, folderExisted);
  const sessionReport = (sessionId: string | null) => plan ? { id: sessionId, mode: decision.mode, reason: decision.reason } : undefined;
  let sandboxCleanup = async () => {};
  let sandboxPrefix: string[] = [];
  try {
    const prompt = `${run.instructions}${run.skills?.length ? `\n\nSkills:\n${run.skills.map((skill) => `## ${skill.name}\n${skill.description}\n${skill.instructions}`).join("\n\n")}` : ""}\n\n${runContext(run)}\n\nRequest:\n${run.request}`;
    const childEnv = childEnvironment(run, apiUrl, environment.env ?? Bun.env);
    // A restricted profile always fails closed. Enforcement makes that owner policy explicit in settings and the transcript.
    if (run.sandbox && (run.sandbox.mode !== "full" || run.sandbox.enforce)) {
      try {
        const prepared = await prepareSandbox(run.sandbox, directory, apiUrl, environment.env ?? Bun.env);
        sandboxCleanup = prepared.cleanup;
        sandboxPrefix = prepared.command;
        // childEnvironment is an allowlist and intentionally never forwards host proxy bypass variables.
      } catch (error) {
        const reason = (error as Error).message;
        await call("/api/daemon/runs/finish", { runId: run.runId, status: "failed", finalOutput: reason, failureReason: "sandbox_unavailable" });
        return;
      }
    }
    try {
      await call("/api/daemon/runs/start", { runId: run.runId, runtimeId: run.runtimeId, ...(plan ? { session: { mode: decision.mode, reason: decision.reason } } : {}) });
    } catch (error) {
      // The server rechecks current Runtime policy at this boundary. A stale claim is terminalized through the normal
      // finish path so notifications, cancellation state and work-item follow-ups behave like other failed Runs.
      if (/^409:.*sandbox policy changed/i.test(String((error as Error).message))) {
        return;
      }
      throw error;
    }
    const messages: Array<{ seq: number; type: string; output: unknown }> = [];
    let finalOutput = "";
    let seq = 0;
    let reportedSessionId: string | null = null;
    // What the CLI printed about its own usage and model; stays null when the CLI printed none, so the server keeps the Run's usage unknown.
    let reportedUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; reportedCostUsd: number | null } | null = null;
    let reportedModel: string | null = null;
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => { flushing = flushing.catch(() => {}).then(async () => { if (!messages.length) return; const batch = messages.splice(0); try { await call("/api/daemon/runs/messages", { runId: run.runId, messages: batch }); } catch (error) { if (/^409:/.test(String((error as Error).message))) { inactive = true; stopCurrent(); return; } messages.unshift(...batch); throw error; } }); return flushing; };
    let inactive = false;
    let stopCurrent = () => {};
    /** Starts the CLI once, with or without the resume argument, and streams its output until it exits. */
    const attempt = async (resume: string | null, promptText = prompt) => {
      const command = adapter.command({ model: run.model, prompt: promptText, resume });
      let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try { child = Bun.spawn([...sandboxPrefix, ...command], { cwd: directory, env: childEnv, stdout: "pipe", stderr: "pipe" }); }
      catch (error) {
        await call("/api/daemon/runs/finish", { runId: run.runId, status: "failed", finalOutput: `Could not start ${run.agentCli}: ${(error as Error).message}`, failureReason: "spawn_failed", session: sessionReport(null) });
        return { spawnFailed: true, code: 0, cancelled: false, timedOut: false };
      }
      let cancelled = false;
      let timedOut = false;
      const stop = () => { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 10_000).unref(); };
      stopCurrent = stop;
      const runTimer = setTimeout(() => { timedOut = true; stop(); }, environment.runTimeoutMs ?? (run.timeoutSeconds ?? 1800) * 1000);
      cancellations.set(run.runId, () => { if (cancelled) return; cancelled = true; child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 10_000).unref(); });
      if (pendingCancellationIds.has(run.runId)) cancellations.get(run.runId)?.();
      const flushTimer = setInterval(() => { void flush().catch(() => {}); }, 1_000);
      const consume = async (stream: ReadableStream<Uint8Array>) => {
        await consumeRedactedOutput(stream, run.secretEnvironment ?? run.environment, childEnv, async (line) => {
          const final = adapter.final(line); if (final !== null) finalOutput = final;
          const usage = adapter.usage(line);
          if (usage) {
            const { total, ...counts } = usage;
            reportedUsage = total || !reportedUsage ? counts : {
              inputTokens: reportedUsage.inputTokens + counts.inputTokens, outputTokens: reportedUsage.outputTokens + counts.outputTokens,
              cacheReadTokens: reportedUsage.cacheReadTokens + counts.cacheReadTokens, cacheCreationTokens: reportedUsage.cacheCreationTokens + counts.cacheCreationTokens,
              reportedCostUsd: reportedUsage.reportedCostUsd === null && counts.reportedCostUsd === null ? null : (reportedUsage.reportedCostUsd ?? 0) + (counts.reportedCostUsd ?? 0),
            };
          }
          reportedModel = adapter.model(line) ?? reportedModel;
          reportedSessionId = adapter.sessionId(line) ?? reportedSessionId;
          for (const event of adapter.parse(line)) messages.push({ seq: ++seq, type: event.type, output: event.text });
          if (messages.length >= 25) await flush().catch(() => {});
        });
      };
      try { await Promise.all([consume(child.stdout), consume(child.stderr)]); } finally { clearInterval(flushTimer); }
      const code = await child.exited;
      clearTimeout(runTimer);
      return { spawnFailed: false, code, cancelled, timedOut };
    };
    let outcome = await attempt(decision.resume);
    // A CLI that refuses the resume before it printed anything (no output, no Session id) is not a failed Run: the same folder starts a new Session.
    if (!outcome.spawnFailed && decision.resume && outcome.code !== 0 && seq === 0 && reportedSessionId === null && !outcome.cancelled && !outcome.timedOut && !inactive) {
      finalOutput = ""; reportedUsage = null; reportedModel = null; reportedSessionId = null;
      decision = { mode: "new", reason: "cli_rejected_resume", resume: null };
      outcome = await attempt(null);
    }
    if (outcome.spawnFailed) return;
    const { code, cancelled, timedOut } = outcome;
    if (inactive && !reportedUsage && !reportedModel) { cancellations.delete(run.runId); pendingCancellationIds.delete(run.runId); return; }
    const acknowledgeCancellation = async () => {
      while (!environment.signal?.aborted) {
        try {
          await call("/api/daemon/runs/cancel-ack", { runId: run.runId, usage: reportedUsage, model: reportedModel ?? run.model ?? null });
          pendingCancellationIds.delete(run.runId);
          break;
        }
        catch { await (environment.sleep ?? wait)(1_000); }
      }
      cancellations.delete(run.runId);
    };
    if (cancelled) { await acknowledgeCancellation(); return; }
    await flush().catch(() => flush()).catch(() => {});
    const submitFinish = async (body: Record<string, unknown>) => {
      for (let attemptNo = 0; ; attemptNo++) {
        try {
          const result = await call("/api/daemon/runs/finish", body) as { correctionRequired?: unknown; message?: unknown };
          return result?.correctionRequired === true ? { correctionRequired: true, message: typeof result.message === "string" ? result.message : "The Agent's final output was withheld because it contained a configured Runtime secret. Revise your final output without the secret." } : null;
        }
        // A 401 is not final here: the credential may have been rotated, and `call` has already re-read it and retried once.
        catch (error) { const message = String((error as Error).message); if (/^409:/.test(message)) return null; if (attemptNo >= 4 || (/^4\d\d:/.test(message) && !/^401:/.test(message))) throw error; await (environment.sleep ?? wait)(1_000 * (attemptNo + 1)); }
      }
    };
    const finishBody = (result: { status: "completed" | "failed"; finalOutput: string; failureReason?: string; usage?: typeof reportedUsage }) => ({
      runId: run.runId, ...result, usage: result.usage === undefined ? reportedUsage : result.usage, model: reportedModel ?? run.model ?? null, session: sessionReport(reportedSessionId),
    });
    const originalCompletion = { status: code === 0 && !timedOut ? "completed" as const : "failed" as const, finalOutput, failureReason: timedOut ? "timeout" : code === 0 ? undefined : "cli_exit" };
    const firstFinish = await submitFinish(finishBody(originalCompletion));
    if (firstFinish?.correctionRequired) {
      // The CLI has exited, but its Session id lets the Daemon ask the same Agent to revise only its final output.
      // The response deliberately contains no matched secret value.
      if (!reportedSessionId || !adapter.resumable) {
        await submitFinish(finishBody({ status: "failed", finalOutput: "", failureReason: "runtime_secret_output", usage: null }));
      } else {
        reportedUsage = null; // The server stored the withheld attempt's usage when it requested this correction.
        finalOutput = "";
        const correctionPrompt = `${prompt}\n\n${firstFinish.message}\nThe Run's work is complete. Correct only your final output. If this Run has a Work item, make it a safe replacement Comment; otherwise return a safe final answer. Do not repeat any secret value, and do not repeat or undo completed actions.`;
        const correction = await attempt(reportedSessionId, correctionPrompt);
        if (correction.cancelled) { await acknowledgeCancellation(); return; }
        if (correction.spawnFailed) { cancellations.delete(run.runId); return; }
        cancellations.delete(run.runId);
        await flush().catch(() => flush()).catch(() => {});
        if (correction.code !== 0 || correction.timedOut) {
          await submitFinish(finishBody({ status: "failed", finalOutput: "", failureReason: "runtime_secret_output" }));
        } else {
          const correctionFinish = await submitFinish(finishBody({ status: "completed", finalOutput, usage: reportedUsage }));
          if (correctionFinish?.correctionRequired) {
            // One correction is safe to automate; a second protected result fails closed for a human rerun.
            await submitFinish(finishBody({ status: "failed", finalOutput: "", failureReason: "runtime_secret_output", usage: null }));
          }
        }
      }
    }
    cancellations.delete(run.runId);
  } finally {
    await sandboxCleanup();
    if (folder && plan) {
      activeSessionFolders.delete(plan.folder);
      await touchSessionFolder(folder, plan, run.workItemId, Date.now()).catch(() => {});
      await sweepSessionFolders(sessionsRoot, call).catch(() => {});
    } else {
      await rm(directory, { recursive: true, force: true });
    }
  }
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
  const apiUrl = daemonApiUrl(env, config);
  assertDaemonCredentialServer(env, config, apiUrl);
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
  const fetcher = environment.fetch ?? fetch;
  const sleep = environment.sleep ?? wait;
  const makeSocket = environment.webSocket ?? ((url, options) => {
    // Bun supports custom client handshake headers; the standard DOM WebSocket type does not expose Bun's options object.
    const BunWebSocket = WebSocket as unknown as new (url: string, options: DaemonWebSocketOptions) => WebSocket;
    return new BunWebSocket(url, options!);
  });
  let backoffMs = 1_000;
  let authBackoffMs = AUTH_RETRY_MIN_MS;
  let registeredClis = "";
  /** The Runtime ids this Daemon holds, from its latest registration. A heartbeat names them; the server answers with those it deleted. */
  let heldRuntimeIds = new Set<string>();
  // Lives across reconnects: a cancel arriving on a new socket must still reach Runs claimed on an old one.
  const cancellations = new Map<string, () => void>();
  // Cancellation ids survive a registration outage until the corresponding local process
  // appears and acknowledges its stop.
  const pendingCancellationIds = new Set<string>();
  const recoverPendingCancellations = async () => {
    const daemonCredential = currentCredential();
    if (!daemonCredential) return;
    try {
      const result = await post(fetcher, apiUrl, daemonCredential, "/api/daemon/runs/cancellations", {}) as { runIds?: unknown };
      if (!Array.isArray(result.runIds)) return;
      for (const runId of result.runIds) if (typeof runId === "string") {
        pendingCancellationIds.add(runId);
        cancellations.get(runId)?.();
      }
    } catch { /* only a revoked credential can use this recovery endpoint */ }
  };
  /** Registers this Daemon; asks for a new credential when none is held or the last one was refused. */
  const register = async (agentClis: string[]) => {
    let registration: { daemonId: string; daemonToken?: string; runtimes?: Array<{ id: string }> };
    // Read at every attempt: `weft login` while the Daemon runs replaces the CLI token, and the next retry must use it.
    const personalToken = env.WEFT_TOKEN ?? await renewCliCredential(environment, apiUrl) ?? (await readCliConfig(env)).token ?? "";
    try {
      registration = await post(fetcher, apiUrl, personalToken, "/api/daemon/register", { hostname: env.WEFT_HOSTNAME ?? hostname(), version: CLI_VERSION, agentClis, rotate: !credential || rotateNext }, { "x-weft-capabilities": "runtime_environment,runtime_sandbox" }) as { daemonId: string; daemonToken?: string; runtimes?: Array<{ id: string }> };
    } catch (error) {
      if (isUnauthorized(error)) throw new RegistrationUnauthorized((error as Error).message);
      throw error;
    }
    // Registration may finish after shutdown has already been requested. Do not persist its
    // credential or let startup continue into WebSocket setup in that case.
    if (signal.aborted) return registration;
    await adoptCredential(registration);
    rotateNext = false;
    heldRuntimeIds = new Set((registration.runtimes ?? []).map((runtime) => runtime.id));
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
      if (signal.aborted) return;
      const signature = agentClis.join(",");
      const registration = await register(agentClis);
      if (signal.aborted) return;
      authBackoffMs = AUTH_RETRY_MIN_MS;
      if (!credential) throw new Error("Daemon credential was not issued. Run `weft login` to sign in again.");
      registeredClis = signature;
      let lastRegisteredAt = Date.now();
      const openedWith = currentCredential();
      const wsUrl = new URL(`${apiUrl.replace(/^http/, "ws")}/api/daemon`);
      await new Promise<void>((resolve, reject) => {
        const socket = makeSocket(wsUrl.toString(), { headers: { Authorization: `Bearer ${openedWith}` } });
        let settled = false;
        let connectedAt: number | undefined;
        let claiming = false;
        const claim = async () => {
          if (claiming) return;
          claiming = true;
          try {
            const response = await callDaemon("/api/daemon/runs/claim", {}) as ClaimedRun[];
            // Each Run runs in its own task so a long Run never blocks the next claim.
            for (const run of response) void executeRun(runtimeEnvironment, callDaemon, apiUrl, run, cancellations, pendingCancellationIds).catch((error) => output(environment, `Run ${run.runId} failed: ${(error as Error).message}\n`));
          } catch { /* the next work signal or safety poll retries the claim */ }
          finally { claiming = false; }
        };
        let safetyPoll: ReturnType<typeof setInterval>;
        const done = () => { if (!settled) { settled = true; clearInterval(heartbeat); clearInterval(probe); clearInterval(safetyPoll); if (connectedAt && Date.now() - connectedAt >= 60_000) backoffMs = 1_000; reject(new Error("Daemon WebSocket closed")); } };
        const fail = (error: Error) => { if (!settled) { settled = true; clearInterval(heartbeat); clearInterval(probe); clearInterval(safetyPoll); reject(error); } };
        const heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat", daemonId: registration.daemonId, runtimeIds: [...heldRuntimeIds] }));
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
            const message = JSON.parse(String(event.data)) as { type?: string; runId?: string; goneRuntimeIds?: unknown };
            if (message.type === "work_available") void claim();
            // A Runtime deleted on the server is forgotten here; the Session folders it used stay for the sweep, and the other Runtimes keep running.
            if (message.type === "heartbeat_ack" && Array.isArray(message.goneRuntimeIds)) {
              for (const id of message.goneRuntimeIds) if (typeof id === "string" && heldRuntimeIds.delete(id)) output(environment, `Runtime ${id} was deleted on the server; the Daemon forgets it and keeps running.\n`);
            }
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
        await recoverPendingCancellations();
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
