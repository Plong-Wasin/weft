import { access, chmod, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { daemonPaths, daemonStatus, detectedClis, readDaemonRecord, processExists, startDaemonBackground, stopDaemon, type DaemonEnvironment, type DaemonRecord } from "./daemon";

type Env = Record<string, string | undefined>;
export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
export type ProcessRunner = (argv: string[], options?: { env?: Env; timeoutMs?: number }) => Promise<ProcessResult>;

/** Runs a short command and captures its output. A command that outlives its budget is killed and reported as timed out. */
export const runCapture: ProcessRunner = async (argv, options = {}) => {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try { child = Bun.spawn(argv, { env: options.env ?? Bun.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
  catch (error) { return { exitCode: null, stdout: "", stderr: (error as Error).message, timedOut: false }; }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 10_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, stdout, stderr, timedOut };
  } finally { clearTimeout(timer); }
};

// ---------------------------------------------------------------- logs

const TAIL_BYTES = 256 * 1024;
/** Personal tokens (weft_), Daemon credentials (weft_daemon_) and Run tokens (weft_run_): a prefix and a long random tail. */
const TOKEN_PATTERN = /\bweft_(?:daemon_|run_)?[A-Za-z0-9_-]{16,}/g;

/** Hides any Weft token in text before it is shown. Log lines can contain one; output must never show it. */
export function redactSecrets(text: string) {
  return text.replace(TOKEN_PATTERN, "[redacted token]");
}

/** The last `count` lines of the Daemon log, or undefined when no log exists yet. */
export async function readLogTail(path: string, count: number): Promise<string[] | undefined> {
  let size: number;
  try { size = (await stat(path)).size; } catch { return undefined; }
  const start = Math.max(0, size - TAIL_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    // A cut-off first line is partial when the read did not start at the beginning of the file.
    if (start > 0) lines.shift();
    return lines.slice(-count).map(redactSecrets);
  } finally { await handle.close(); }
}

/**
 * Writes each line appended to the log after this is called, until the signal aborts. Handles log truncation.
 * Only whole lines are redacted and written, so a token split across two reads is still hidden.
 */
export async function followLog(path: string, options: { write: (text: string) => void; signal?: AbortSignal; intervalMs?: number }) {
  let offset = await stat(path).then((info) => info.size, () => 0);
  let pending = "";
  const emit = (text: string, final = false) => {
    pending += text;
    const cut = final ? pending.length : pending.lastIndexOf("\n") + 1;
    if (cut === 0) return;
    const complete = pending.slice(0, cut);
    pending = pending.slice(cut);
    options.write(redactSecrets(complete));
  };
  while (!options.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (info.size < offset) { offset = 0; pending = ""; } // the file was truncated or replaced
    if (info.size === offset) continue;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(info.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      emit(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally { await handle.close(); }
  }
  emit("", true);
}

// ---------------------------------------------------------------- probe

export type CliProbe = { name: "claude" | "codex"; usable: boolean; path?: string; version?: string; reason?: string };

async function findExecutable(name: string, path: string) {
  for (const directory of path.split(process.platform === "win32" ? ";" : delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* not in this PATH entry */ }
  }
  return undefined;
}

/** Says for each agent CLI whether a Run can use it, and if not, what to do. */
export async function probeAgentClis(options: { env: Env; run?: ProcessRunner; timeoutMs?: number }): Promise<CliProbe[]> {
  const run = options.run ?? runCapture;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const results: CliProbe[] = [];
  for (const name of ["claude", "codex"] as const) {
    const path = await findExecutable(name, options.env.PATH ?? "");
    if (!path) { results.push({ name, usable: false, reason: `Not found on this computer's PATH. Install ${name}, open a new terminal, then run \`weft daemon probe\` again.` }); continue; }
    const result = await run([path, "--version"], { env: options.env, timeoutMs });
    if (result.timedOut) { results.push({ name, usable: false, path, reason: `\`${name} --version\` did not answer within ${Math.round(timeoutMs / 1000)} seconds. Check the installation, then run \`weft daemon probe\` again.` }); continue; }
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().split("\n")[0] || `exit code ${result.exitCode}`;
      results.push({ name, usable: false, path, reason: `Found, but \`${name} --version\` failed: ${detail}. Reinstall or repair ${name}, then run \`weft daemon probe\` again.` });
      continue;
    }
    results.push({ name, usable: true, path, version: (result.stdout || result.stderr).trim().split("\n")[0] });
  }
  return results;
}

// ---------------------------------------------------------------- autostart

export const SYSTEMD_UNIT = "weft-daemon.service";
export const LAUNCH_LABEL = "com.weft.daemon";

export type AutostartOptions = DaemonEnvironment & { platform?: NodeJS.Platform; run?: ProcessRunner; uid?: number; execPath?: string; scriptPath?: string };
export type AutostartPlatform = "linux" | "darwin" | "unsupported";

const platformOf = (platform: NodeJS.Platform): AutostartPlatform => platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : "unsupported";
const unsupported = "Autostart is not available on this computer yet. Start the Daemon yourself with `weft daemon start` after you sign in.";

export function autostartFile(env: Env, platform: AutostartPlatform) {
  if (platform === "linux") return join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "systemd", "user", SYSTEMD_UNIT);
  if (platform === "darwin") return join(env.HOME ?? homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
  return undefined;
}

/** Whether autostart is on for this user. Off unless `weft daemon autostart enable` wrote the unit or agent file. */
export async function autostartStatus(options: AutostartOptions = {}) {
  const env = options.env ?? Bun.env;
  const platform = platformOf(options.platform ?? process.platform);
  const file = autostartFile(env, platform);
  const enabled = file ? await stat(file).then(() => true, () => false) : false;
  return { enabled, platform, file, logPath: daemonPaths(env).log };
}

const systemdQuote = (argument: string) => `"${argument.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Environment the service needs: the agent CLIs' PATH (services get a short default one), and the server and host name. Never the token. */
function serviceEnvironment(env: Env) {
  const names = ["PATH", "XDG_CONFIG_HOME", "WEFT_API_URL", "WEFT_HOSTNAME"] as const;
  const values = Object.fromEntries(names.flatMap((name) => env[name] ? [[name, env[name]!]] : []));
  // Belt and braces: no value may carry a Weft token, whatever the shell exported.
  for (const [name, value] of Object.entries(values)) if (/\bweft_/.test(value)) delete values[name];
  return values;
}

export function systemdUnit(options: { execPath: string; scriptPath: string; env: Env; logPath: string }) {
  const variables = { ...serviceEnvironment(options.env), WEFT_DAEMON_CHILD: "1", WEFT_DAEMON_SERVICE: "1" };
  return [
    "[Unit]",
    "Description=Weft Daemon: runs the agent CLIs for your Weft Runs",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${[options.execPath, options.scriptPath, "daemon", "start", "--foreground"].map(systemdQuote).join(" ")}`,
    ...Object.entries(variables).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    `StandardOutput=append:${options.logPath}`,
    `StandardError=append:${options.logPath}`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function launchAgentPlist(options: { execPath: string; scriptPath: string; env: Env; logPath: string }) {
  const variables = { ...serviceEnvironment(options.env), WEFT_DAEMON_CHILD: "1", WEFT_DAEMON_SERVICE: "1" };
  const dict = Object.entries(variables).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n");
  const args = [options.execPath, options.scriptPath, "daemon", "start", "--foreground"].map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${dict}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(options.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.logPath)}</string>
</dict>
</plist>
`;
}


/** Turns autostart on: a systemd user unit on Linux, a LaunchAgent on macOS. Per user, no administrator rights. */
export async function enableAutostart(options: AutostartOptions = {}): Promise<string> {
  const env = options.env ?? Bun.env;
  const platform = platformOf(options.platform ?? process.platform);
  if (platform === "unsupported") throw new Error(unsupported);
  const run = options.run ?? runCapture;
  const file = autostartFile(env, platform)!;
  const running = await daemonStatus(options);
  if (running.running && !(await autostartStatus(options)).enabled) throw new Error(`A Daemon is already running in the background (process ${running.pid}). Stop it with \`weft daemon stop\`, then run \`weft daemon autostart enable\` again.`);
  const execPath = options.execPath ?? process.execPath;
  const scriptPath = options.scriptPath ?? process.argv[1]!;
  const logPath = daemonPaths(env).log;
  const text = platform === "linux" ? systemdUnit({ execPath, scriptPath, env, logPath }) : launchAgentPlist({ execPath, scriptPath, env, logPath });
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  const uid = options.uid ?? process.getuid?.() ?? 501;
  const started = platform === "linux"
    ? await run(["systemctl", "--user", "daemon-reload"], { env }).then(async () => run(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT], { env }))
    : await run(["launchctl", "bootout", `gui/${uid}/${LAUNCH_LABEL}`], { env }).then(async () => run(["launchctl", "bootstrap", `gui/${uid}`, file], { env }));
  if (started.exitCode !== 0) {
    await rm(file, { force: true });
    if (platform === "linux") await run(["systemctl", "--user", "daemon-reload"], { env });
    const detail = (started.stderr || started.stdout).trim() || "the service manager did not answer";
    throw new Error(`Could not turn on autostart: ${detail}. Autostart needs a signed-in user session. Nothing was changed; the Daemon is still off at login.`);
  }
  return `Autostart is on. The Daemon starts when you sign in and restarts after a crash. Unit: ${file}. It uses the PATH from this shell, so run \`weft daemon probe\` to check the agent CLIs. Turn it off with \`weft daemon autostart disable\`.`;
}

/** Turns autostart off and removes the unit or agent file. Stops the service-run Daemon too. */
export async function disableAutostart(options: AutostartOptions = {}): Promise<string> {
  const env = options.env ?? Bun.env;
  const platform = platformOf(options.platform ?? process.platform);
  if (platform === "unsupported") throw new Error(unsupported);
  const run = options.run ?? runCapture;
  const file = autostartFile(env, platform)!;
  if (!(await autostartStatus(options)).enabled) return "Autostart is already off. The Daemon does not start when you sign in.";
  const uid = options.uid ?? process.getuid?.() ?? 501;
  if (platform === "linux") await run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT], { env });
  else await run(["launchctl", "bootout", `gui/${uid}/${LAUNCH_LABEL}`], { env });
  await rm(file, { force: true });
  if (platform === "linux") await run(["systemctl", "--user", "daemon-reload"], { env });
  return "Autostart is off. The Daemon no longer starts when you sign in. A Daemon that was running under autostart has been stopped; start it with `weft daemon start`.";
}

// ---------------------------------------------------------------- start and restart through autostart

/** `weft daemon start`: with autostart on, the service starts the Daemon so two Daemons never run; otherwise a background Daemon. */
export async function startDaemonForUser(options: AutostartOptions = {}) {
  const env = options.env ?? Bun.env;
  const status = await autostartStatus(options);
  if (!status.enabled) return startDaemonBackground(options);
  const running = await daemonStatus(options);
  if (running.running) throw new Error(`Daemon is already running (process ${running.pid}). Run \`weft daemon status\` or \`weft daemon stop\`.`);
  const run = options.run ?? runCapture;
  const uid = options.uid ?? process.getuid?.() ?? 501;
  const result = status.platform === "linux"
    ? await run(["systemctl", "--user", "start", SYSTEMD_UNIT], { env })
    : await run(["launchctl", "kickstart", `gui/${uid}/${LAUNCH_LABEL}`], { env });
  if (result.exitCode !== 0) throw new Error(`Could not start the autostart service: ${(result.stderr || result.stdout).trim()}. Run \`weft daemon autostart status\`.`);
  return { pid: (await waitForRecord(env))?.pid, managedBy: "autostart" as const };
}

async function waitForRecord(env: Env, timeoutMs = 10_000): Promise<DaemonRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await daemonStatus({ env });
    if (status.running) return { pid: status.pid, startedAt: "", apiUrl: status.server, agentClis: status.agentClis, logPath: status.logPath };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}

/** `weft daemon restart`: stops a running Daemon (or restarts the autostart service) and starts it again. */
export async function restartDaemon(options: AutostartOptions = {}) {
  const env = options.env ?? Bun.env;
  const before = await daemonStatus(options);
  const previousPid = before.running ? before.pid : undefined;
  const status = await autostartStatus(options);
  if (status.enabled) {
    const run = options.run ?? runCapture;
    const uid = options.uid ?? process.getuid?.() ?? 501;
    const result = status.platform === "linux"
      ? await run(["systemctl", "--user", "restart", SYSTEMD_UNIT], { env })
      : await run(["launchctl", "kickstart", "-k", `gui/${uid}/${LAUNCH_LABEL}`], { env });
    if (result.exitCode !== 0) throw new Error(`Could not restart the autostart service: ${(result.stderr || result.stdout).trim()}. Run \`weft daemon autostart status\`.`);
    const record = await waitForRecord(env);
    return { previousPid, pid: record?.pid, managedBy: "autostart" as const };
  }
  if (before.running) await stopDaemon({ ...options, stdout: () => {} });
  const record = await startDaemonBackground({ ...options, stdout: () => {} });
  return { previousPid, pid: record.pid, managedBy: "background" as const };
}

/** Lets the autostart service run the Daemon in the foreground and record its own process, so status and stop find it. */
export async function recordServiceDaemon(options: DaemonEnvironment & { apiUrl: string }) {
  const env = options.env ?? Bun.env;
  const existing = await readDaemonRecord(env);
  if (existing && processExists(existing.pid) && existing.pid !== process.pid) throw new Error(`Daemon is already running (process ${existing.pid}).`);
  const paths = daemonPaths(env);
  const record: DaemonRecord = { pid: process.pid, startedAt: new Date().toISOString(), apiUrl: options.apiUrl, agentClis: await detectedClis(env.PATH ?? ""), logPath: paths.log };
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await writeFile(paths.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return async () => { await rm(paths.record, { force: true }); };
}

